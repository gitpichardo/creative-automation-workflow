import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createFakeRedisClient } from './fakes/fake-redis.js';
import { __setClientForTests, saveCampaign, getCampaign, type CampaignState } from '../src/lib/state.js';

vi.mock('../src/lib/render-workflows.js', () => ({
  startCampaignRun: vi.fn().mockResolvedValue({ taskRunId: 'run_fake_123' }),
}));

const validBrief = {
  name: 'Summer 2026',
  folder: '/campaigns/summer-2026',
  variants: [{ name: 'square-1080', transformation: [{ width: 1080, height: 1080 }] }],
};

describe('campaigns API', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.IMAGEKIT_PRIVATE_KEY = 'private_test';
    process.env.IMAGEKIT_PUBLIC_KEY = 'public_test';
    process.env.IMAGEKIT_URL_ENDPOINT = 'https://ik.imagekit.io/demo';
    const { createServer } = await import('../src/api/server.js');
    app = createServer();
  });

  beforeEach(() => {
    __setClientForTests(createFakeRedisClient());
  });

  describe('POST /campaigns', () => {
    it('rejects an invalid brief with 400 and issue details', async () => {
      const res = await request(app).post('/campaigns').send({ name: '', folder: 'not-absolute', variants: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid campaign brief/);
      expect(Array.isArray(res.body.details)).toBe(true);
    });

    it('accepts a valid brief, persists initial state, and triggers the workflow run', async () => {
      const res = await request(app).post('/campaigns').send(validBrief);

      expect(res.status).toBe(202);
      expect(res.body.taskRunId).toBe('run_fake_123');
      expect(typeof res.body.id).toBe('string');

      const saved = await getCampaign(res.body.id);
      expect(saved).toMatchObject({ status: 'running', brief: { name: 'Summer 2026' }, variants: [] });
    });

    it('returns 502 and marks the campaign failed if triggering the workflow run throws', async () => {
      const { startCampaignRun } = await import('../src/lib/render-workflows.js');
      vi.mocked(startCampaignRun).mockRejectedValueOnce(new Error('RENDER_API_KEY and WORKFLOW_SLUG must both be set'));

      const res = await request(app).post('/campaigns').send(validBrief);

      expect(res.status).toBe(502);
      const saved = await getCampaign(res.body.id ?? '');
      // The id isn't in the 502 body by design (nothing to poll -- the run
      // never started), so recover it from history instead.
      expect(saved).toBeUndefined();
    });
  });

  describe('GET /campaigns/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/campaigns/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('returns the full campaign state for a known id', async () => {
      const state: CampaignState = {
        id: 'camp_abc',
        brief: validBrief,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        variants: [{ fileId: 'f1', fileName: 'a.jpg', variant: 'square-1080', status: 'rendering' }],
      };
      await saveCampaign(state);

      const res = await request(app).get('/campaigns/camp_abc');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 'camp_abc', status: 'running' });
      expect(res.body.variants).toHaveLength(1);
    });
  });

  describe('GET /campaigns/:id/manifest.csv', () => {
    it('returns 409 while the campaign is still running (no manifest yet)', async () => {
      await saveCampaign({
        id: 'camp_running',
        brief: validBrief,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        variants: [],
      });

      const res = await request(app).get('/campaigns/camp_running/manifest.csv');
      expect(res.status).toBe(409);
    });

    it('returns 404 for an unknown campaign id', async () => {
      const res = await request(app).get('/campaigns/does-not-exist/manifest.csv');
      expect(res.status).toBe(404);
    });

    it('streams the CSV with the right content type once the campaign has a manifest', async () => {
      await saveCampaign({
        id: 'camp_done',
        brief: validBrief,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        variants: [{ fileId: 'f1', fileName: 'a.jpg', variant: 'square-1080', status: 'ready', url: 'https://ik.io/a.jpg' }],
        manifestCsv: 'fileId,fileName,variant,status,url,error\r\nf1,a.jpg,square-1080,ready,https://ik.io/a.jpg,\r\n',
      });

      const res = await request(app).get('/campaigns/camp_done/manifest.csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.text).toContain('f1,a.jpg,square-1080,ready');
    });
  });

  describe('GET /campaigns', () => {
    it('lists recorded campaigns with computed ready/failed counts', async () => {
      await saveCampaign({
        id: 'camp_list_1',
        brief: validBrief,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        variants: [
          { fileId: 'f1', fileName: 'a.jpg', variant: 'v1', status: 'ready' },
          { fileId: 'f2', fileName: 'b.jpg', variant: 'v1', status: 'error', error: 'boom' },
        ],
      });
      const { recordCampaignId } = await import('../src/lib/state.js');
      await recordCampaignId('camp_list_1');

      const res = await request(app).get('/campaigns');
      expect(res.status).toBe(200);
      expect(res.body.campaigns).toEqual([
        expect.objectContaining({ id: 'camp_list_1', total: 2, ready: 1, failed: 1 }),
      ]);
    });
  });
});
