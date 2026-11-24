import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

const list = vi.fn();
const upload = vi.fn();

vi.mock('../src/lib/imagekit.js', () => ({
  getImageKitClient: () => ({ assets: { list }, files: { upload } }),
}));

describe('sample assets', () => {
  let app: Express;

  beforeAll(async () => {
    const { createServer } = await import('../src/api/server.js');
    app = createServer();
  });

  beforeEach(() => {
    list.mockReset();
    upload.mockReset().mockResolvedValue({});
  });

  it('uploads the bundled images into /campaigns/demo, skipping ones already there', async () => {
    list.mockResolvedValue([{ type: 'file', name: 'falcon-running-shoe-signal-red.jpg' }]);

    const res = await request(app).post('/samples/upload');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folder: '/campaigns/demo',
      uploaded: ['falcon-running-shoe-black-and-white.jpg', 'falcon-running-shoe-slate-blue.jpg'],
      skipped: ['falcon-running-shoe-signal-red.jpg'],
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0][0]).toMatchObject({
      fileName: 'falcon-running-shoe-black-and-white.jpg',
      folder: '/campaigns/demo',
      useUniqueFileName: false,
    });
  });

  it('serves the sample variants files the UI presets load', async () => {
    const res = await request(app).get('/samples/variants.json');
    expect(res.status).toBe(200);
    expect(res.body.map((v: { name: string }) => v.name)).toEqual(['square-1080', 'story-1080x1920', 'thumb-320']);
  });

  it('keeps samples/brief.json a valid campaign brief', async () => {
    const { campaignBriefSchema } = await import('../src/api/campaign-brief-schema.js');
    const brief = (await import('../samples/brief.json', { with: { type: 'json' } })).default;
    expect(campaignBriefSchema.safeParse(brief).success).toBe(true);
  });
});
