import { describe, expect, it, vi } from 'vitest';
import { awaitTransformation } from '../src/lib/await-transformation.js';

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('', { status, headers });
}

/** A fake `now`/`sleep` pair that advances a shared virtual clock instantly, so tests exercising the timeout/backoff paths don't actually wait. */
function fakeClock() {
  let time = 0;
  const sleepCalls: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      time += ms;
    },
    sleepCalls,
  };
}

describe('awaitTransformation', () => {
  it('returns ready immediately on a plain 200 with no intermediate marker', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { 'content-type': 'image/jpeg' }));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.jpg?tr=w-100', { fetchImpl, now, sleep });

    expect(result).toEqual({ status: 'ready', url: 'https://ik.example/img.jpg?tr=w-100', attempts: 1, contentType: 'image/jpeg' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://ik.example/img.jpg?tr=w-100', { redirect: 'manual' });
  });

  it('treats `is-intermediate-response: true` (any status) as not-ready and retries until a real 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'content-type': 'image/png' }));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.png', { fetchImpl, now, sleep });

    expect(result.status).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats a 202 as not-ready and retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202))
      .mockResolvedValueOnce(jsonResponse(200, { 'content-type': 'image/png' }));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.png', { fetchImpl, now, sleep });

    expect(result.status).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a 302 (video not-ready-yet redirect to the original) as not-ready and retries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(302, { location: 'https://ik.example/original.mp4' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'content-type': 'video/mp4' }));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/video.mp4?tr=f-webm', { fetchImpl, now, sleep });

    expect(result.status).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Confirms the request was issued with `redirect: 'manual'` -- if we'd
    // let fetch auto-follow the 302, we would never observe it as a status
    // at all and this test would be indistinguishable from a bug that
    // silently treats "redirected to the original" as "done".
    expect(fetchImpl).toHaveBeenCalledWith(expect.anything(), { redirect: 'manual' });
  });

  it('returns an error result (not a thrown exception) on a 4xx, surfacing the ik-error header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { 'ik-error': 'Unsupported transformation parameter.' }));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.jpg?tr=bogus', { fetchImpl, now, sleep });

    expect(result).toMatchObject({ status: 'error', httpStatus: 400, message: 'Unsupported transformation parameter.' });
  });

  it('returns a network-error result if fetch itself throws, without retrying', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { now, sleep } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.jpg', { fetchImpl, now, sleep });

    expect(result).toMatchObject({ status: 'error', message: 'ECONNRESET' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up with status "timeout" (not an exception) once the time budget is exhausted', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { 'is-intermediate-response': 'true' }));
    const { now, sleep, sleepCalls } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.jpg', {
      fetchImpl,
      now,
      sleep,
      timeoutMs: 10_000,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
    });

    expect(result.status).toBe('timeout');
    expect(sleepCalls.length).toBeGreaterThan(0);
    // Every sleep should be capped at the remaining time budget.
    expect(sleepCalls.every((ms) => ms <= 10_000)).toBe(true);
  });

  it('backs off exponentially up to the configured ceiling (checked via the jitter-free bounds: delay/2 <= sleep <= delay)', async () => {
    // Not-ready 5 times, then ready -- so the loop terminates via a real
    // "ready" result and every recorded sleep reflects the backoff formula,
    // with none capped short by an approaching timeout budget.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }))
      .mockResolvedValueOnce(jsonResponse(200, { 'content-type': 'image/png' }));
    const { now, sleep, sleepCalls } = fakeClock();

    const result = await awaitTransformation('https://ik.example/img.jpg', {
      fetchImpl,
      now,
      sleep,
      timeoutMs: 1_000_000,
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
    });

    expect(result.status).toBe('ready');
    // Expected un-jittered ceilings before hitting maxDelayMs: 1000, 2000, 4000, 8000, 8000.
    const expectedCeilings = [1000, 2000, 4000, 8000, 8000];
    expect(sleepCalls).toHaveLength(expectedCeilings.length);
    sleepCalls.forEach((actual, i) => {
      const ceiling = expectedCeilings[i];
      expect(actual).toBeLessThanOrEqual(ceiling);
      expect(actual).toBeGreaterThanOrEqual(ceiling * 0.5);
    });
  });

  it('lets checkExternalResolution short-circuit polling entirely (the webhook-assisted-wait seam)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { 'is-intermediate-response': 'true' }));
    const { now, sleep } = fakeClock();
    const checkExternalResolution = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ status: 'ready' as const, url: 'https://ik.example/video.mp4', attempts: 0, contentType: 'video/mp4' });

    const result = await awaitTransformation('https://ik.example/video.mp4', {
      fetchImpl,
      now,
      sleep,
      checkExternalResolution,
    });

    expect(result.status).toBe('ready');
    // First check found nothing yet, so exactly one real poll happened; the
    // second check resolved it, short-circuiting before a second poll.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checkExternalResolution).toHaveBeenCalledTimes(2);
  });
});
