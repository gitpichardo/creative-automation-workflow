import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { Webhook } from 'standardwebhooks';
import request from 'supertest';
import type { Express } from 'express';
import ImageKit from '@imagekit/nodejs';
import { createFakeRedisClient } from './fakes/fake-redis.js';
import { __setClientForTests, checkWebhookWait } from '../src/lib/state.js';

const PRIVATE_KEY = 'private_test_secret_do_not_leak';
const WEBHOOK_SECRET = 'whsec_ZmFrZS10ZXN0LXNlY3JldC1kby1ub3QtdXNl';

function signWebhook(payload: string, msgId = 'msg_test_1') {
  // The SDK base64-encodes the raw `whsec_...` secret before constructing
  // its internal `standardwebhooks` `Webhook` instance (see
  // node_modules/@imagekit/nodejs/resources/webhooks.js) -- reproduced here
  // so this test signs with exactly the key the SDK will verify against.
  const wh = new Webhook(Buffer.from(WEBHOOK_SECRET).toString('base64'));
  const timestamp = new Date();
  const signature = wh.sign(msgId, timestamp, payload);
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': signature,
  };
}

describe('ImageKit webhook signature verification (via the real @imagekit/nodejs SDK)', () => {
  it('unwrap() accepts a correctly signed payload and returns the parsed event', () => {
    const client = new ImageKit({ privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET });
    const payload = JSON.stringify({
      type: 'video.transformation.ready',
      id: 'evt_1',
      created_at: new Date().toISOString(),
      data: { asset: { url: 'https://ik.io/demo/v.mp4' }, transformation: { type: 'video-transformation', output: { url: 'https://ik.io/demo/v.mp4?tr=f-webm' } } },
      request: { url: 'https://ik.io/demo/v.mp4?tr=f-webm', x_request_id: 'req_1' },
    });
    const headers = signWebhook(payload);

    const event = client.webhooks.unwrap(payload, { headers });
    expect(event.type).toBe('video.transformation.ready');
    expect(event.id).toBe('evt_1');
  });

  it('unwrap() throws on a payload signed with the wrong secret', () => {
    const client = new ImageKit({ privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET });
    const payload = JSON.stringify({ type: 'file.created', id: 'evt_2', created_at: new Date().toISOString(), data: {} });
    const wrongWh = new Webhook(Buffer.from('whsec_d3Jvbmctc2VjcmV0').toString('base64'));
    const timestamp = new Date();
    const headers = {
      'webhook-id': 'evt_2',
      'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'webhook-signature': wrongWh.sign('evt_2', timestamp, payload),
    };

    expect(() => client.webhooks.unwrap(payload, { headers })).toThrow();
  });

  it('unwrap() throws on a tampered payload (signature no longer matches)', () => {
    const client = new ImageKit({ privateKey: PRIVATE_KEY, webhookSecret: WEBHOOK_SECRET });
    const originalPayload = JSON.stringify({ type: 'file.created', id: 'evt_3', created_at: new Date().toISOString(), data: { fileId: 'a' } });
    const headers = signWebhook(originalPayload, 'evt_3');
    const tamperedPayload = JSON.stringify({ type: 'file.created', id: 'evt_3', created_at: new Date().toISOString(), data: { fileId: 'b' } });

    expect(() => client.webhooks.unwrap(tamperedPayload, { headers })).toThrow();
  });
});

describe('POST /webhooks/imagekit (idempotency + correlation)', () => {
  let app: Express;

  beforeAll(async () => {
    // Env vars must be set before the first (module-singleton) construction
    // of the ImageKit client -- see lib/imagekit.ts -- so this runs once,
    // before `createServer` is imported.
    process.env.IMAGEKIT_PRIVATE_KEY = PRIVATE_KEY;
    process.env.IMAGEKIT_PUBLIC_KEY = 'public_test';
    process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/demo';
    process.env.IMAGEKIT_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const { createServer } = await import('../src/api/server.js');
    app = createServer();
  });

  afterAll(() => {
    delete process.env.IMAGEKIT_WEBHOOK_SECRET;
  });

  beforeEach(() => {
    // Fresh in-memory Key Value store per test -- avoids cross-test
    // pollution of the webhook-wait / idempotency records without needing
    // to reset the whole module graph (which would also throw away the
    // ImageKit client singleton env vars set above).
    __setClientForTests(createFakeRedisClient());
  });

  function readyPayload(url: string, eventId: string) {
    return JSON.stringify({
      type: 'video.transformation.ready',
      id: eventId,
      created_at: new Date().toISOString(),
      data: {
        asset: { url: 'https://ik.imagekit.io/demo/source.mp4' },
        transformation: { type: 'video-transformation', output: { url } },
      },
      request: { url, x_request_id: 'req_abc' },
    });
  }

  it('accepts a validly signed video.transformation.ready event and records it for the correlated URL', async () => {
    const url = 'https://ik.imagekit.io/demo/source.mp4?tr=f-webm,q-80';
    const payload = readyPayload(url, 'evt_ready_1');
    const headers = signWebhook(payload, 'evt_ready_1');

    const res = await request(app)
      .post('/webhooks/imagekit')
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const resolved = await checkWebhookWait(url);
    expect(resolved).toMatchObject({ status: 'ready', url });
  });

  it('rejects an incorrectly signed request with 400 and does not record anything', async () => {
    const url = 'https://ik.imagekit.io/demo/source.mp4?tr=f-webm';
    const payload = readyPayload(url, 'evt_bad_sig');

    const res = await request(app)
      .post('/webhooks/imagekit')
      .set({ 'webhook-id': 'evt_bad_sig', 'webhook-timestamp': '1700000000', 'webhook-signature': 'v1,bogus==' })
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
    expect(await checkWebhookWait(url)).toBeUndefined();
  });

  it('is idempotent: redelivering the same event id is acknowledged but not reprocessed', async () => {
    const url = 'https://ik.imagekit.io/demo/source.mp4?tr=f-webm,q-50';
    const payload = readyPayload(url, 'evt_dup_1');
    const headers = signWebhook(payload, 'evt_dup_1');

    const first = await request(app).post('/webhooks/imagekit').set(headers).set('Content-Type', 'application/json').send(payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    const second = await request(app).post('/webhooks/imagekit').set(headers).set('Content-Type', 'application/json').send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });
  });

  it('acknowledges but ignores unrelated event types (e.g. file.created)', async () => {
    const payload = JSON.stringify({
      type: 'file.created',
      id: 'evt_file_1',
      created_at: new Date().toISOString(),
      data: { fileId: 'f1', name: 'a.png' },
    });
    const headers = signWebhook(payload, 'evt_file_1');

    const res = await request(app).post('/webhooks/imagekit').set(headers).set('Content-Type', 'application/json').send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
