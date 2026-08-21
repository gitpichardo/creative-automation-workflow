import ImageKit from '@imagekit/nodejs';
import { env } from './env.js';

let client: ImageKit | undefined;

/**
 * Shared `@imagekit/nodejs` client, lazily constructed so importing this
 * module doesn't itself require env vars to be set (useful for tests that
 * only import types/pure functions from sibling modules).
 */
export function getImageKitClient(): ImageKit {
  if (!client) {
    client = new ImageKit({
      privateKey: env.imagekitPrivateKey,
      webhookSecret: env.imagekitWebhookSecret,
    });
  }
  return client;
}

export interface TransformationSpec {
  /** ImageKit transformation object, e.g. `{ width: 1080, height: 1080, aiChangeBackground: '...' }`. */
  transformation: Record<string, unknown>;
}

/**
 * Builds an on-demand ImageKit transformation URL for an existing DAM asset.
 * This is a GET URL -- ImageKit doesn't "build" anything until the URL is
 * first requested (see await-transformation.ts), so this function itself
 * never triggers processing or spends AI-extension credits.
 */
export function buildTransformationUrl(filePath: string, transformation: Record<string, unknown>[]): string {
  const client = getImageKitClient();
  return client.helper.buildSrc({
    src: filePath,
    urlEndpoint: env.imagekitUrlEndpoint,
    transformation,
  });
}
