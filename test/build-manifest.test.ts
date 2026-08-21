import { describe, expect, it, beforeEach } from 'vitest';
import { createFakeRedisClient } from './fakes/fake-redis.js';
import { __setClientForTests, saveCampaign, getCampaign, type CampaignState } from '../src/lib/state.js';

function baseCampaign(overrides: Partial<CampaignState> = {}): CampaignState {
  return {
    id: 'camp_1',
    brief: { name: 'Test Campaign', folder: '/campaigns/test', variants: [{ name: 'square', transformation: [{ width: 100 }] }] },
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    variants: [],
    ...overrides,
  };
}

describe('buildManifest task', () => {
  beforeEach(() => {
    __setClientForTests(createFakeRedisClient());
  });

  it('produces a CSV with one row per variant, escaping fields that contain commas or quotes, and marks the campaign completed', async () => {
    await saveCampaign(
      baseCampaign({
        variants: [
          { fileId: 'f1', fileName: 'hero.jpg', variant: 'square-1080', status: 'ready', url: 'https://ik.io/hero.jpg?tr=w-1080' },
          {
            fileId: 'f2',
            fileName: 'banner, v2.jpg',
            variant: 'story',
            status: 'error',
            error: 'ImageKit returned "unsupported transformation".',
          },
        ],
      }),
    );

    const { buildManifest } = await import('../src/workflow/tasks/build-manifest.js');
    const { manifestCsv, failedCount } = await buildManifest('camp_1');

    expect(failedCount).toBe(1);
    const lines = manifestCsv.trim().split('\r\n');
    expect(lines[0]).toBe('fileId,fileName,variant,status,url,error');
    expect(lines[1]).toBe('f1,hero.jpg,square-1080,ready,https://ik.io/hero.jpg?tr=w-1080,');
    expect(lines[2]).toBe('f2,"banner, v2.jpg",story,error,,"ImageKit returned ""unsupported transformation""."');

    const saved = await getCampaign('camp_1');
    expect(saved?.status).toBe('completed');
    expect(saved?.manifestCsv).toBe(manifestCsv);
  });

  it('marks the campaign failed when every variant errored or timed out', async () => {
    await saveCampaign(
      baseCampaign({
        variants: [
          { fileId: 'f1', fileName: 'a.jpg', variant: 'square', status: 'error', error: 'boom' },
          { fileId: 'f2', fileName: 'b.jpg', variant: 'square', status: 'timeout' },
        ],
      }),
    );

    const { buildManifest } = await import('../src/workflow/tasks/build-manifest.js');
    const { failedCount } = await buildManifest('camp_1');

    expect(failedCount).toBe(2);
    const saved = await getCampaign('camp_1');
    expect(saved?.status).toBe('failed');
  });

  it('throws a clear error for an unknown campaign id', async () => {
    const { buildManifest } = await import('../src/workflow/tasks/build-manifest.js');
    await expect(buildManifest('does-not-exist')).rejects.toThrow(/No campaign state found/);
  });
});
