import { Render } from '@renderinc/sdk';
import { env } from './env.js';

let render: Render | undefined;

function getRender(): Render {
  if (!render) {
    render = new Render({ token: env.renderApiKey });
  }
  return render;
}

/**
 * Fire-and-forget trigger for a `runCampaign` run: an HTTP request handler
 * has no business blocking on an up-to-one-hour workflow, so this uses
 * `startTask` (returns immediately with a task run id) rather than
 * `runTask` (blocks until completion) -- see
 * https://github.com/render-oss/sdk/blob/main/typescript/README.md,
 * "Workflows Client Methods".
 */
export async function startCampaignRun(campaignId: string, brief: unknown): Promise<{ taskRunId: string }> {
  if (!env.renderApiKey || !env.workflowSlug) {
    throw new Error(
      'RENDER_API_KEY and WORKFLOW_SLUG must both be set to trigger campaign runs. ' +
        'See README, "Deploying the workflow service" -- the workflow service must be deployed first, ' +
        'then its slug and an API key wired into this service.',
    );
  }
  const run = await getRender().workflows.startTask(`${env.workflowSlug}/runCampaign`, [campaignId, brief]);
  return { taskRunId: run.taskRunId };
}
