import { task } from '@renderinc/sdk/workflows';
import { getImageKitClient } from '../../lib/imagekit.js';
import { env } from '../../lib/env.js';
import type { CampaignBrief, ResolvedAsset } from '../types.js';

/**
 * Resolves a campaign brief's `folder`/`assetSearchQuery` into the concrete
 * set of source assets to render variants of. Capped at
 * `MAX_ASSETS_PER_CAMPAIGN` (default 200, see .env.example) -- without a
 * cap, a mistyped `folder` (e.g. "/" instead of "/campaigns/summer-2026")
 * could fan out thousands of `renderVariant` subtask runs from a single
 * typo.
 */
export const resolveAssets = task(
  { name: 'resolveAssets', timeoutSeconds: 60 },
  async function resolveAssets(brief: CampaignBrief): Promise<ResolvedAsset[]> {
    const client = getImageKitClient();
    const maxAssets = env.maxAssetsPerCampaign;

    // `type: 'file'` combined with `searchQuery` resolves to the broader
    // `Array<File | Folder>` overload (the SDK's narrower `Array<File>`
    // overload only applies when `searchQuery` is omitted), so filter out
    // folders explicitly rather than trusting the request-time `type`
    // filter to exclude them.
    const results = await client.assets.list({
      type: 'file',
      path: brief.folder,
      searchQuery: brief.assetSearchQuery,
      fileType: 'all',
      limit: maxAssets,
      sort: 'ASC_NAME',
    });

    return results
      .filter((asset): asset is Extract<typeof asset, { fileId?: string }> => 'fileId' in asset)
      .slice(0, maxAssets)
      .map((file) => ({
        fileId: file.fileId ?? '',
        fileName: file.name ?? file.filePath ?? 'unknown',
        filePath: file.filePath ?? '',
        fileType: file.fileType === 'image' ? 'image' : 'non-image',
      }));
  },
);
