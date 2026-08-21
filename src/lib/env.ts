/**
 * Centralized, fail-fast environment variable access. Each service entry
 * point (`api/server.ts`, `workflow/campaign.ts`) imports the subset it
 * needs; a misconfigured deployment fails at startup with a clear message
 * instead of an obscure error the first time a route is hit.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  get imagekitPrivateKey() {
    return required('IMAGEKIT_PRIVATE_KEY');
  },
  get imagekitPublicKey() {
    return required('IMAGEKIT_PUBLIC_KEY');
  },
  get imagekitUrlEndpoint() {
    return required('IMAGEKIT_URL_ENDPOINT');
  },
  get imagekitWebhookSecret() {
    return optional('IMAGEKIT_WEBHOOK_SECRET');
  },
  get redisUrl() {
    return process.env.REDIS_URL || 'redis://localhost:6379';
  },
  get renderApiKey() {
    return optional('RENDER_API_KEY');
  },
  get workflowSlug() {
    return optional('WORKFLOW_SLUG');
  },
  get port() {
    return optionalInt('PORT', 3000);
  },
  get publicBaseUrl() {
    return optional('PUBLIC_BASE_URL') || `http://localhost:${optionalInt('PORT', 3000)}`;
  },
  get maxAssetsPerCampaign() {
    return optionalInt('MAX_ASSETS_PER_CAMPAIGN', 200);
  },
  get awaitTransformationTimeoutMs() {
    return optionalInt('AWAIT_TRANSFORMATION_TIMEOUT_MS', 120_000);
  },
};
