import { task } from '@renderinc/sdk/workflows';
import { getCampaign, updateCampaign } from '../../lib/state.js';

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
}

/**
 * Builds the final CSV manifest for a campaign from whatever variant
 * results are in Key Value at the time it runs (called by `runCampaign`
 * after all `renderVariant` subtask runs have settled) and marks the
 * campaign `completed`/`failed`. Kept as its own task -- rather than inline
 * in `runCampaign` -- so it's independently retryable if writing the final
 * state hits a transient Key Value error.
 */
export const buildManifest = task(
  { name: 'buildManifest', timeoutSeconds: 30 },
  async function buildManifest(campaignId: string): Promise<{ manifestCsv: string; failedCount: number }> {
    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`No campaign state found for id "${campaignId}".`);
    }

    const header = ['fileId', 'fileName', 'variant', 'status', 'url', 'error'];
    const rows = campaign.variants.map((v) => [v.fileId, v.fileName, v.variant, v.status, v.url ?? '', v.error ?? '']);
    const manifestCsv = toCsv([header, ...rows]);
    const failedCount = campaign.variants.filter((v) => v.status === 'error' || v.status === 'timeout').length;

    await updateCampaign(campaignId, (current) => ({
      ...current,
      status: failedCount === current.variants.length && current.variants.length > 0 ? 'failed' : 'completed',
      manifestCsv,
    }));

    return { manifestCsv, failedCount };
  },
);
