import { Router, raw } from 'express';
import { getImageKitClient } from '../../lib/imagekit.js';
import { markWebhookEventProcessed, resolveWebhookWait } from '../../lib/state.js';
import type { AwaitTransformationResult } from '../../lib/await-transformation.js';
import { asyncHandler } from '../async-handler.js';

export const webhooksRouter = Router();

/**
 * ImageKit webhook receiver. Only two event types matter for this project's
 * async-transformation protocol -- `video.transformation.ready` and
 * `video.transformation.error` -- since those are the only on-demand
 * transformation events ImageKit's webhooks cover (there is no image/AI
 * equivalent; see render-variant.ts's `canUseWebhook` comment). Every other
 * event type (file.created, upload.pre-transform.*, etc.) is acknowledged
 * with 200 and ignored -- ImageKit's webhook config is account-wide, and a
 * given account may have other integrations relying on those events too.
 *
 * `express.raw` is required here (rather than the app's default
 * `express.json()`) because `client.webhooks.unwrap()` needs the exact raw
 * request body bytes to verify the HMAC signature -- re-serializing a
 * parsed JSON object would not reliably reproduce the original bytes. This
 * mirrors ImageKit's own documented Express example
 * (https://imagekit.io/docs/webhooks, "Verify signature with ImageKit SDK").
 */
webhooksRouter.post('/webhooks/imagekit', raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  const client = getImageKitClient();
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';

  let event;
  try {
    event = client.webhooks.unwrap(rawBody, { headers: req.headers as Record<string, string> });
  } catch (err) {
    res.status(400).json({ error: 'Invalid webhook signature.', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const isNew = await markWebhookEventProcessed(event.id);
  if (!isNew) {
    // Redelivery of an event we already handled -- ack without reprocessing.
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  if (event.type === 'video.transformation.ready') {
    const result: AwaitTransformationResult = {
      status: 'ready',
      url: event.request.url,
      attempts: 0,
      contentType: `video/${event.data.transformation.output?.url.split('.').pop() ?? 'mp4'}`,
    };
    await resolveWebhookWait(event.request.url, result);
  } else if (event.type === 'video.transformation.error') {
    const result: AwaitTransformationResult = {
      status: 'error',
      url: event.request.url,
      attempts: 0,
      message: `ImageKit video transformation failed: ${event.data.transformation.error?.reason ?? 'unknown reason'}.`,
    };
    await resolveWebhookWait(event.request.url, result);
  }

  res.status(200).json({ received: true });
}));
