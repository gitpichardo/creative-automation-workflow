import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { campaignBriefSchema } from '../campaign-brief-schema.js';
import { startCampaignRun } from '../../lib/render-workflows.js';
import { saveCampaign, getCampaign, recordCampaignId, listRecentCampaignIds, type CampaignState } from '../../lib/state.js';
import { asyncHandler } from '../async-handler.js';

export const campaignsRouter = Router();

campaignsRouter.post('/campaigns', asyncHandler(async (req, res) => {
  const parsed = campaignBriefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid campaign brief.', details: parsed.error.issues });
    return;
  }
  const brief = parsed.data;
  const id = randomUUID();
  const now = new Date().toISOString();

  const initialState: CampaignState = {
    id,
    brief,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    variants: [],
  };

  try {
    await saveCampaign(initialState);
    await recordCampaignId(id);
    const { taskRunId } = await startCampaignRun(id, brief);
    res.status(202).json({ id, taskRunId, statusUrl: `/campaigns/${id}` });
  } catch (err) {
    // Distinguish "we couldn't even start the run" (config/Render API
    // problem -- the campaign never began) from mid-run failures, which
    // instead show up as `status: 'failed'` on the campaign itself.
    await saveCampaign({ ...initialState, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    res.status(502).json({ error: 'Failed to start campaign run.', message: err instanceof Error ? err.message : String(err) });
  }
}));

campaignsRouter.get('/campaigns', asyncHandler(async (_req, res) => {
  const ids = await listRecentCampaignIds();
  const campaigns = (await Promise.all(ids.map((id) => getCampaign(id)))).filter((c): c is CampaignState => Boolean(c));
  res.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.brief.name,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      total: c.variants.length,
      ready: c.variants.filter((v) => v.status === 'ready').length,
      failed: c.variants.filter((v) => v.status === 'error' || v.status === 'timeout').length,
    })),
  });
}));

campaignsRouter.get('/campaigns/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const campaign = await getCampaign(id);
  if (!campaign) {
    res.status(404).json({ error: `No campaign found with id "${id}".` });
    return;
  }
  res.json(campaign);
}));

campaignsRouter.get('/campaigns/:id/manifest.csv', asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const campaign = await getCampaign(id);
  if (!campaign) {
    res.status(404).json({ error: `No campaign found with id "${id}".` });
    return;
  }
  if (!campaign.manifestCsv) {
    res.status(409).json({ error: 'Manifest is not ready yet -- campaign is still running.', status: campaign.status });
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${campaign.id}-manifest.csv"`);
  res.send(campaign.manifestCsv);
}));
