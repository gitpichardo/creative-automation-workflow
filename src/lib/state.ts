import { createClient, WatchError, type RedisClientType } from 'redis';
import { createHash } from 'node:crypto';
import { env } from './env.js';
import type { AwaitTransformationResult } from './await-transformation.js';

/**
 * Thin wrapper around the Render Key Value instance (`state` in
 * render.yaml). Render's own `@renderinc/sdk` ships an experimental Key
 * Value client (`render.experimental.keyValue.newClient()`) that adds
 * auto-provisioning on top of the same underlying `redis` package -- see
 * https://github.com/render-oss/sdk/blob/main/typescript/README.md, "Key
 * Value". This project connects directly with `redis` via a plain
 * `REDIS_URL` instead, so the exact same code works against *any*
 * Redis/Valkey-compatible endpoint (a local Docker container in dev, the
 * Render Key Value instance in production) without requiring
 * Render-account context (`RENDER_WORKSPACE_ID`, etc.) that's only present
 * once actually deployed on Render.
 */

let client: RedisClientType | undefined;
let connecting: Promise<RedisClientType> | undefined;

async function getClient(): Promise<RedisClientType> {
  if (client) return client;
  if (!connecting) {
    const created = createClient({
      url: env.redisUrl,
      socket: {
        connectTimeout: 5_000,
        // node-redis's default `reconnectStrategy` retries forever with
        // growing backoff, so a genuine outage would otherwise make every
        // route hang indefinitely instead of failing fast with a 500 (see
        // asyncHandler / server.ts's error middleware). Cap it instead: give
        // up after 3 attempts within the initial `connect()` call.
        reconnectStrategy: (retries) => (retries >= 3 ? new Error('Redis reconnect attempts exhausted.') : Math.min(retries * 100, 1_000)),
      },
    }) as RedisClientType;
    // node-redis emits its own 'error' event for connection-level failures
    // (including background reconnect attempts) *independently* of the
    // promise `connect()` returns. An EventEmitter's 'error' event with no
    // listener is a Node.js fatal error -- attach one so a Key Value outage
    // surfaces as a normal rejected promise (caught by callers below /
    // asyncHandler in the api routes) instead of crashing the process.
    created.on('error', (err) => {
      console.error('Redis client error:', err instanceof Error ? err.message : err);
    });
    connecting = created.connect().then(() => {
      client = created;
      return created;
    });
    connecting.catch(() => {
      // Allow a future call to retry a fresh connection instead of being
      // permanently stuck on this one rejected promise.
      connecting = undefined;
    });
  }
  return connecting;
}

export async function closeState(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
    connecting = undefined;
  }
}

/**
 * Test-only seam: injects a fake client (see test/fakes/fake-redis.ts)
 * instead of connecting to a real Redis/Valkey instance, since this repo's
 * CI/dev sandbox has no Redis server available. Not exported from any
 * public entry point -- only imported directly by test files.
 */
export function __setClientForTests(fake: RedisClientType): void {
  client = fake;
  connecting = Promise.resolve(fake);
}

function urlKey(prefix: string, url: string): string {
  // Keys must be bounded-length and free of arbitrary characters; hash the
  // (potentially long, signed) transformation URL rather than using it
  // verbatim as part of the Redis key.
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 32);
  return `${prefix}:${hash}`;
}

const WEBHOOK_WAIT_TTL_SECONDS = 60 * 30; // 30 minutes -- generous vs. the ~2min default await timeout
const WEBHOOK_EVENT_DEDUPE_TTL_SECONDS = 60 * 60 * 24; // 24 hours

/**
 * Called by the webhook route when a `video.transformation.ready` or
 * `video.transformation.error` event arrives, keyed by the transformation
 * URL the event echoes back in `request.url` (ImageKit's webhook payload has
 * no other correlation id we control -- see README, "Async transformation
 * protocol"). Whoever is awaiting that URL (see `waitForWebhookResolution`)
 * will see it on their next poll of this Key Value entry, typically within
 * the ~1s poll interval used there -- much cheaper than re-hitting
 * ImageKit's CDN every time.
 */
export async function resolveWebhookWait(url: string, result: AwaitTransformationResult): Promise<void> {
  const redis = await getClient();
  await redis.set(urlKey('webhook-wait', url), JSON.stringify(result), { EX: WEBHOOK_WAIT_TTL_SECONDS });
}

export async function checkWebhookWait(url: string): Promise<AwaitTransformationResult | undefined> {
  const redis = await getClient();
  const raw = await redis.get(urlKey('webhook-wait', url));
  if (!raw) return undefined;
  return JSON.parse(raw) as AwaitTransformationResult;
}

/**
 * Idempotency guard for webhook delivery: ImageKit (like most webhook
 * senders) may redeliver an event, and a naive handler would double-resolve
 * or double-count. Returns `true` the first time a given event `id` is seen
 * (caller should process it), `false` on any redelivery (caller should just
 * 200 and skip). Implemented with `SET ... NX` so the check-and-mark is a
 * single atomic Redis operation, not a separate GET-then-SET race.
 */
export async function markWebhookEventProcessed(eventId: string): Promise<boolean> {
  const redis = await getClient();
  const result = await redis.set(`webhook-event:${eventId}`, '1', {
    NX: true,
    EX: WEBHOOK_EVENT_DEDUPE_TTL_SECONDS,
  });
  return result === 'OK';
}

export type VariantStatus = 'queued' | 'rendering' | 'ready' | 'error' | 'timeout';

export interface VariantState {
  fileId: string;
  fileName: string;
  variant: string;
  status: VariantStatus;
  url?: string;
  error?: string;
  attempts?: number;
}

export interface CampaignState {
  id: string;
  brief: {
    name: string;
    folder: string;
    variants: Array<{ name: string; transformation: Record<string, unknown>[] }>;
  };
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  variants: VariantState[];
  manifestCsv?: string;
  error?: string;
}

const CAMPAIGN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function campaignKey(id: string): string {
  return `campaign:${id}`;
}

export async function saveCampaign(state: CampaignState): Promise<void> {
  const redis = await getClient();
  await redis.set(campaignKey(state.id), JSON.stringify(state), { EX: CAMPAIGN_TTL_SECONDS });
}

export async function getCampaign(id: string): Promise<CampaignState | undefined> {
  const redis = await getClient();
  const raw = await redis.get(campaignKey(id));
  if (!raw) return undefined;
  return JSON.parse(raw) as CampaignState;
}

const RECENT_CAMPAIGNS_KEY = 'campaigns:recent';
const RECENT_CAMPAIGNS_LIMIT = 50;

/** Appends to a capped recency list so the demo UI has something to list without a real database. */
export async function recordCampaignId(id: string): Promise<void> {
  const redis = await getClient();
  await redis.lPush(RECENT_CAMPAIGNS_KEY, id);
  await redis.lTrim(RECENT_CAMPAIGNS_KEY, 0, RECENT_CAMPAIGNS_LIMIT - 1);
}

export async function listRecentCampaignIds(): Promise<string[]> {
  const redis = await getClient();
  return redis.lRange(RECENT_CAMPAIGNS_KEY, 0, RECENT_CAMPAIGNS_LIMIT - 1);
}

const UPDATE_MAX_ATTEMPTS = 10;

/**
 * Read-modify-write helper for campaign state. `runCampaign` fans a
 * campaign's (asset, variant) pairs out into *parallel* `renderVariant`
 * subtask runs (see `campaign.ts`), and every one of them calls this to
 * record its own progress into the *same* `campaign:<id>` key -- so, unlike
 * the single-writer assumption this originally shipped with, concurrent
 * writers are the common case, not an edge case.
 *
 * A plain GET-then-SET is a lost-update race here: if run A's GET happens
 * before run B's SET, and run A's SET happens after run B's SET, A's write
 * clobbers B's with a stale copy of the variants array that doesn't include
 * B's update. This was caught by an actual live campaign run (two real
 * `renderVariant` runs against real Key Value), not a review: one variant's
 * ImageKit transformation genuinely succeeded (confirmed by fetching the
 * resulting URL directly -- HTTP 200, real transformed bytes) while its
 * recorded status in Key Value stayed stuck at the interim `"rendering"`
 * value, because the *other* concurrent variant's write raced it and won.
 *
 * Fixed with optimistic locking: WATCH the key, re-read it, apply `patch`,
 * then MULTI/SET/EXEC -- Redis aborts the transaction if the watched key
 * changed in between. node-redis v6's `.exec()` surfaces that abort by
 * *throwing* a `WatchError` (confirmed against a real conflict in this
 * exact codepath -- v4's docs describe EXEC returning `null` instead, which
 * is no longer what actually happens), so this catches `WatchError`
 * specifically and retries with a fresh read; any other error propagates.
 * WATCH/MULTI/EXEC state is tracked per connection, so this runs on a
 * short-lived `duplicate()`d connection rather than the shared singleton
 * from `getClient()` -- otherwise two concurrent callers' WATCH/MULTI pairs
 * would interleave on the same socket and corrupt each other's transaction,
 * defeating the whole point.
 */
export async function updateCampaign(
  id: string,
  patch: (current: CampaignState) => CampaignState,
): Promise<CampaignState> {
  const base = await getClient();
  const key = campaignKey(id);
  const isolated = base.duplicate();
  await isolated.connect();
  try {
    for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt++) {
      await isolated.watch(key);
      const raw = await isolated.get(key);
      if (!raw) {
        await isolated.unwatch();
        throw new Error(`No campaign state found for id "${id}".`);
      }
      const current = JSON.parse(raw) as CampaignState;
      const next = patch(current);
      next.updatedAt = new Date().toISOString();

      try {
        await isolated
          .multi()
          .set(key, JSON.stringify(next), { EX: CAMPAIGN_TTL_SECONDS })
          .exec();
        return next;
      } catch (err) {
        if (!(err instanceof WatchError)) throw err;
        // Another writer touched `key` after our WATCH -- back off briefly
        // (jittered, to avoid every retrier retrying in lockstep) and retry
        // with a fresh read.
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 40)));
      }
    }
    throw new Error(`Failed to update campaign "${id}" after ${UPDATE_MAX_ATTEMPTS} attempts due to concurrent writes.`);
  } finally {
    await isolated.quit();
  }
}
