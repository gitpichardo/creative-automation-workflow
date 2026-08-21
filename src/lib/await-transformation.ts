/**
 * Implements ImageKit's documented async transformation protocol for
 * on-demand (GET-triggered) URL transformations, so a workflow task can
 * `await` a transformation the same way it would await any other I/O,
 * instead of racing a CDN cache fill.
 *
 * Sources (fetched live while building this file, not guessed):
 *
 * - Images / AI transformations: "If the transformation takes longer,
 *   ImageKit may return an intermediate HTML response with the message 'The
 *   asset is currently being prepared' and a 200 status code. ... a special
 *   response header is-intermediate-response:true is included."
 *   https://imagekit.io/docs/ai-transformations#limitations-and-considerations
 *   The same header/behavior is documented generically for any
 *   computationally expensive transformation at
 *   https://imagekit.io/docs/transformations#limits ("Asynchronous
 *   processing for long-running requests").
 *
 * - Videos: on a cache miss, ImageKit either serves a 302 redirect back to
 *   the *original* (untransformed) video (dashboard-configurable, capped at
 *   15s wait server-side) while it keeps encoding in the background, or
 *   blocks briefly and returns the transformed video directly.
 *   https://imagekit.io/docs/video-transformation#first-time-request-and-cache
 *
 * - Invalid/failed transformations return a 400 (or similar 4xx/5xx) with an
 *   `ik-error` response header describing the problem.
 *   https://imagekit.io/docs/transformations#troubleshooting-invalid-transformation
 *
 * Neither doc mentions a 202 for these operations specifically, but this
 * module treats 202 as "not ready yet" too (per this project's spec) since
 * it's the conventional HTTP status for "accepted, not done" and costs
 * nothing to handle defensively if some other ImageKit endpoint or a future
 * change of behavior ever uses it.
 */

export type AwaitTransformationResult =
  | { status: 'ready'; url: string; contentType: string; attempts: number }
  | { status: 'timeout'; url: string; attempts: number }
  | { status: 'error'; url: string; attempts: number; httpStatus?: number; message: string };

export interface AwaitTransformationOptions {
  /** Overall wall-clock budget. Default 120_000ms (2 minutes). */
  timeoutMs?: number;
  /** First backoff delay, before jitter. Default 1_000ms, per spec. */
  initialDelayMs?: number;
  /** Backoff ceiling, before jitter. Default 30_000ms, per spec. */
  maxDelayMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable for tests; defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Checked before each poll. If it resolves to a terminal result, that
   * result wins and no GET is issued this iteration -- this is the seam
   * webhook-assisted waiting plugs into (see
   * workflow/tasks/render-variant.ts), without this module needing to know
   * anything about Redis, webhooks, or ImageKit's webhook event shape.
   */
  checkExternalResolution?: () => Promise<AwaitTransformationResult | undefined>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIntermediateResponse(response: Response): boolean {
  // Header names are case-insensitive in the Fetch API's Headers object.
  return response.headers.get('is-intermediate-response') === 'true';
}

interface PollEvaluation {
  status: 'ready' | 'not-ready' | 'error';
  contentType?: string;
  httpStatus?: number;
  message?: string;
}

function evaluatePollResponse(response: Response): PollEvaluation {
  if (isIntermediateResponse(response)) {
    return { status: 'not-ready' };
  }

  // Video first-request behavior: a 302 back to the original asset means
  // the transformed variant isn't ready yet -- see module doc.
  if (response.status === 302) {
    return { status: 'not-ready' };
  }

  // Not documented for these operations, but handled defensively per spec.
  if (response.status === 202) {
    return { status: 'not-ready' };
  }

  if (response.status >= 200 && response.status < 300) {
    return { status: 'ready', contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
  }

  const ikError = response.headers.get('ik-error');
  return {
    status: 'error',
    httpStatus: response.status,
    message: ikError ?? `ImageKit returned HTTP ${response.status}.`,
  };
}

/**
 * Polls `url` (a transformation URL already built with
 * `buildTransformationUrl`) until ImageKit has finished processing it, it
 * fails, or the timeout budget is exhausted. Never throws -- callers get a
 * discriminated-union result and decide what "failure" means for their task.
 */
export async function awaitTransformation(
  url: string,
  options: AwaitTransformationOptions = {},
): Promise<AwaitTransformationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const start = now();
  let delay = initialDelayMs;
  let attempts = 0;

  while (true) {
    if (options.checkExternalResolution) {
      const resolved = await options.checkExternalResolution();
      if (resolved) return resolved;
    }

    if (now() - start >= timeoutMs) {
      return { status: 'timeout', url, attempts };
    }

    attempts++;
    let response: Response;
    try {
      // `redirect: 'manual'` so a video 302 is observable instead of being
      // silently followed to the original (untransformed) asset -- see
      // evaluatePollResponse().
      response = await fetchImpl(url, { redirect: 'manual' });
    } catch (err) {
      return {
        status: 'error',
        url,
        attempts,
        message: err instanceof Error ? err.message : 'Network error while polling ImageKit.',
      };
    }

    const evaluation = evaluatePollResponse(response);
    if (evaluation.status === 'ready') {
      return { status: 'ready', url, attempts, contentType: evaluation.contentType! };
    }
    if (evaluation.status === 'error') {
      return { status: 'error', url, attempts, httpStatus: evaluation.httpStatus, message: evaluation.message! };
    }

    const remaining = timeoutMs - (now() - start);
    if (remaining <= 0) {
      return { status: 'timeout', url, attempts };
    }

    // Full jitter in [50%, 100%] of the current backoff ceiling -- avoids a
    // thundering herd of retries across many concurrently rendering variants
    // all started at once by the same campaign.
    const jitteredDelay = delay * (0.5 + Math.random() * 0.5);
    await sleep(Math.min(jitteredDelay, remaining));
    delay = Math.min(delay * 2, maxDelayMs);
  }
}
