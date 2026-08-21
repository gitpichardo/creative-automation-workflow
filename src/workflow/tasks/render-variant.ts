import { task } from '@renderinc/sdk/workflows';
import { buildTransformationUrl } from '../../lib/imagekit.js';
import { awaitTransformation, type AwaitTransformationResult } from '../../lib/await-transformation.js';
import { checkWebhookWait, updateCampaign, type VariantStatus } from '../../lib/state.js';
import { env } from '../../lib/env.js';
import type { ResolvedAsset, VariantSpec } from '../types.js';

export interface RenderVariantInput {
  campaignId: string;
  asset: ResolvedAsset;
  variant: VariantSpec;
}

export interface RenderVariantOutput {
  fileId: string;
  fileName: string;
  variant: string;
  status: AwaitTransformationResult['status'];
  url: string;
  error?: string;
}

/**
 * Renders one (asset, variant) pair: builds the transformation URL, waits
 * for ImageKit to finish processing it (see `awaitTransformation`), and
 * records the outcome into the campaign's Key Value state so
 * `GET /campaigns/:id` reflects progress in real time as subtask runs
 * complete out of order.
 *
 * Registered as its own Workflows task (rather than an inline function
 * called from `runCampaign`) specifically so `campaign.ts` can fan it out
 * across every (asset, variant) pair as parallel, independently retried
 * subtask runs -- see https://render.com/docs/workflows-defining, "Chaining
 * tasks": calling a task function from within another task's execution
 * triggers a tracked, independently-retryable chained run.
 */
export const renderVariant = task(
  {
    name: 'renderVariant',
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 2_000, backoffScaling: 2 },
  },
  async function renderVariant(input: RenderVariantInput): Promise<RenderVariantOutput> {
    const { campaignId, asset, variant } = input;
    const url = buildTransformationUrl(asset.filePath, variant.transformation);

    await markVariantStatus(campaignId, asset.fileId, variant.name, 'rendering', url);

    // Webhook-assisted waiting only exists for video URL transformations --
    // ImageKit's webhook events are `video.transformation.{accepted,ready,
    // error}`; there is no equivalent for on-demand image/AI transformations,
    // which only ever expose the `is-intermediate-response` polling signal.
    // Confirmed against the real @imagekit/nodejs webhook event union
    // (src/resources/webhooks.ts) while building this task, not guessed.
    // See README, "Async transformation protocol".
    const canUseWebhook = asset.fileType === 'non-image' && Boolean(env.imagekitWebhookSecret);

    const result = await awaitTransformation(url, {
      timeoutMs: env.awaitTransformationTimeoutMs,
      checkExternalResolution: canUseWebhook ? () => checkWebhookWait(url) : undefined,
    });

    await markVariantStatus(
      campaignId,
      asset.fileId,
      variant.name,
      result.status,
      url,
      result.status === 'error' ? result.message : undefined,
    );

    return {
      fileId: asset.fileId,
      fileName: asset.fileName,
      variant: variant.name,
      status: result.status,
      url,
      error: result.status === 'error' ? result.message : undefined,
    };
  },
);

async function markVariantStatus(
  campaignId: string,
  fileId: string,
  variantName: string,
  status: VariantStatus,
  url: string,
  error?: string,
): Promise<void> {
  await updateCampaign(campaignId, (current) => {
    const index = current.variants.findIndex((v) => v.fileId === fileId && v.variant === variantName);
    const entry = {
      fileId,
      fileName: current.variants[index]?.fileName ?? fileId,
      variant: variantName,
      status,
      url,
      error,
    };
    const variants = [...current.variants];
    if (index === -1) {
      variants.push(entry);
    } else {
      variants[index] = { ...variants[index], ...entry };
    }
    return { ...current, variants };
  });
}
