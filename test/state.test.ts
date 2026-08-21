import { describe, expect, it, beforeEach } from 'vitest';
import { createFakeRedisClient } from './fakes/fake-redis.js';
import { __setClientForTests, saveCampaign, getCampaign, updateCampaign, type CampaignState } from '../src/lib/state.js';

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

describe('updateCampaign concurrency', () => {
  beforeEach(() => {
    __setClientForTests(createFakeRedisClient());
  });

  it('does not lose either update when many writers race on the same campaign', async () => {
    await saveCampaign(baseCampaign());

    // Simulate the `renderVariant` subtask-run fan-out from `runCampaign`'s
    // `Promise.allSettled(jobs.map(...))`: several independent callers
    // updating the same campaign key at once. A naive GET-then-SET (the
    // pre-fix implementation) loses all but one of these updates under real
    // concurrent I/O; the optimistic-lock version must retry until every
    // one of them lands.
    const fileIds = ['f1', 'f2', 'f3', 'f4', 'f5'];
    await Promise.all(
      fileIds.map((fileId) =>
        updateCampaign('camp_1', (current) => ({
          ...current,
          variants: [...current.variants, { fileId, fileName: `${fileId}.jpg`, variant: 'square', status: 'ready' }],
        })),
      ),
    );

    const saved = await getCampaign('camp_1');
    expect(saved?.variants.map((v) => v.fileId).sort()).toEqual(fileIds.slice().sort());
  });

  it('retries when EXEC is aborted by a conflicting write made after WATCH but before EXEC', async () => {
    const client = createFakeRedisClient();
    __setClientForTests(client);
    await saveCampaign(baseCampaign());

    const realDuplicate = client.duplicate.bind(client);
    let duplicateCalls = 0;
    // Force the *first* caller's isolated connection to be slow between its
    // WATCH/GET and its MULTI/EXEC, giving the second caller time to commit
    // first and guaranteeing a real WATCH conflict (not just a hypothetical one).
    client.duplicate = (() => {
      duplicateCalls += 1;
      const isolated = realDuplicate();
      if (duplicateCalls === 1) {
        const mutableIsolated = isolated as unknown as { get: (key: string) => Promise<string | null> };
        const realGet = mutableIsolated.get.bind(isolated);
        mutableIsolated.get = async (key: string) => {
          const value = await realGet(key);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return value;
        };
      }
      return isolated;
    }) as typeof client.duplicate;

    const slow = updateCampaign('camp_1', (current) => ({ ...current, variants: [...current.variants, { fileId: 'slow', fileName: 'slow.jpg', variant: 'square', status: 'ready' }] }));
    const fast = updateCampaign('camp_1', (current) => ({ ...current, variants: [...current.variants, { fileId: 'fast', fileName: 'fast.jpg', variant: 'square', status: 'ready' }] }));

    await Promise.all([slow, fast]);

    const saved = await getCampaign('camp_1');
    const fileIds = saved?.variants.map((v) => v.fileId).sort();
    expect(fileIds).toEqual(['fast', 'slow']);
  });

  it('throws a clear error for an unknown campaign id instead of retrying forever', async () => {
    await expect(updateCampaign('does-not-exist', (c) => c)).rejects.toThrow(/No campaign state found/);
  });
});
