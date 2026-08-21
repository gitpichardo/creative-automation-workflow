import { task } from '@renderinc/sdk/workflows';
import { resolveAssets } from './tasks/resolve-assets.js';
import { renderVariant } from './tasks/render-variant.js';
import { buildManifest } from './tasks/build-manifest.js';
import { getCampaign, updateCampaign, type VariantState } from '../lib/state.js';
import type { CampaignBrief } from './types.js';

export { resolveAssets, renderVariant, buildManifest };

/**
 * The workflow service's entry point (`npm run start:workflow` /
 * `npm run dev:workflow`). Deployed as a Render *Workflow* service
 * (https://render.com/docs/workflows) -- a distinct service type from the
 * `api` web service, deployed manually since Blueprints don't support
 * Workflows yet (see render.yaml's header comment and README, "Deploying
 * the workflow service").
 *
 * `runCampaign` is the task the `api` service triggers via
 * `render.workflows.runTask('<WORKFLOW_SLUG>/runCampaign', [campaignId, brief])`
 * (see api/routes/campaigns.ts). It:
 *
 * 1. Resolves the brief's `folder`/`assetSearchQuery` into concrete assets.
 * 2. Fans out one `renderVariant` subtask run per (asset, variant) pair --
 *    each becomes its own tracked, independently-retried Workflows task
 *    run, which is the actual payoff of building this on Workflows instead
 *    of a single long-lived process: a campaign with 40 assets x 4 variants
 *    is 160 independent, parallel, retryable units of work, not one giant
 *    loop that dies as a whole on the 137th item.
 * 3. Builds the final manifest once every subtask run has settled
 *    (successfully or not -- `Promise.allSettled`, not `Promise.all`, so
 *    one failed variant doesn't take down the whole campaign's manifest).
 */
export const runCampaign = task(
  { name: 'runCampaign', timeoutSeconds: 3600 },
  async function runCampaign(campaignId: string, brief: CampaignBrief): Promise<{ manifestCsv: string; failedCount: number }> {
    const assets = await resolveAssets(brief);

    await updateCampaign(campaignId, (current) => ({
      ...current,
      variants: assets.flatMap((asset) =>
        brief.variants.map(
          (variant): VariantState => ({
            fileId: asset.fileId,
            fileName: asset.fileName,
            variant: variant.name,
            status: 'queued',
          }),
        ),
      ),
    }));

    const jobs = assets.flatMap((asset) => brief.variants.map((variant) => ({ campaignId, asset, variant })));

    const settled = await Promise.allSettled(jobs.map((job) => renderVariant(job)));

    const failedSubtaskRuns = settled.filter((r) => r.status === 'rejected').length;
    if (failedSubtaskRuns > 0) {
      // A rejected renderVariant means the subtask run itself blew up after
      // exhausting its retries (e.g. an unhandled exception), as opposed to
      // a *handled* ImageKit-side failure, which renderVariant already
      // reports as `status: 'error'` in its own return value and in Key
      // Value -- so this only fires for genuinely unexpected failures.
      const current = await getCampaign(campaignId);
      if (current) {
        await updateCampaign(campaignId, (c) => ({ ...c, error: `${failedSubtaskRuns} renderVariant subtask run(s) failed unexpectedly.` }));
      }
    }

    const { manifestCsv, failedCount } = await buildManifest(campaignId);
    return { manifestCsv, failedCount };
  },
);

console.log('imagekit-render-creative-automation: workflow tasks registered (runCampaign, resolveAssets, renderVariant, buildManifest).');
