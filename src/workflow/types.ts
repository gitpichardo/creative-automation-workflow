/**
 * Shared, JSON-serializable shapes passed between the `api` service and
 * workflow task runs. Render Workflows task arguments and return values
 * must be JSON-serializable (they cross a process boundary as an array of
 * parameters -- see https://render.com/docs/workflows-sdk-typescript,
 * "Task arguments"), so nothing here may be a class instance, `Date`,
 * `Map`, etc.
 */

export interface VariantSpec {
  /** Short label, e.g. "square-1080" or "story-9x16". Used in the manifest and output file naming context. */
  name: string;
  /** ImageKit transformation chain -- each array entry is one chained step. */
  transformation: Record<string, unknown>[];
}

export interface CampaignBrief {
  name: string;
  /** DAM folder to resolve source assets from, e.g. "/campaigns/summer-2026". */
  folder: string;
  /** Optional Lucene-like filter on top of `folder` -- see search-assets skill / ImageKit docs. */
  assetSearchQuery?: string;
  variants: VariantSpec[];
}

export interface ResolvedAsset {
  fileId: string;
  fileName: string;
  filePath: string;
  fileType: 'image' | 'non-image';
}
