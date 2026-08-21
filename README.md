# imagekit-render-creative-automation

Agentic creative automation, built on [Render Workflows](https://render.com/docs/workflows): submit one campaign brief (a DAM folder + a list of transformation "variants"), and it fans out one ImageKit transformation per (asset x variant) pair as independent, parallel, retryable [Render Workflows](https://render.com/docs/workflows) tasks -- 40 assets x 4 variants is 160 units of work, not one loop that dies as a whole on the 137th item.

The part that makes this non-trivial: ImageKit transformations are **not** synchronous. A computationally expensive transformation (an AI edit, a video re-encode) can take longer than a single HTTP request wants to block for, so ImageKit's real behavior is an async, poll-or-webhook protocol -- not "call an API, get a URL back, done." This project exists to get that protocol right in a system that's actually fanning out hundreds of these at once, which a single Cloud Function or one long `for` loop handles badly (no per-item retry, no fan-out concurrency control, a crash 3/4 of the way through takes the whole batch with it).

## Architecture

```
┌──────────────┐      ┌──────────────────┐      ┌─────────────────────────────┐
│  Demo UI      │─────▶│  api (Express)   │─────▶│  Render Workflows            │
│  (static)     │◀─────│                  │◀─────│                              │
└──────────────┘      │  POST /campaigns │      │  runCampaign                 │
                       │  GET  /campaigns │      │   ├─ resolveAssets           │
      ImageKit ───────▶│  /webhooks/      │      │   ├─ renderVariant (xN, ‖)   │
      (webhooks)       │    imagekit      │      │   └─ buildManifest          │
                       └────────┬─────────┘      └───────────────┬─────────────┘
                                │                                  │
                                ▼                                  ▼
                       ┌──────────────────────────────────────────────┐
                       │  state (Render Key Value / Redis)             │
                       │  campaign progress, webhook <-> wait          │
                       │  correlation, webhook event idempotency       │
                       └──────────────────────────────────────────────┘
```

1. The **demo UI** (a static page served by the `api` service) submits a campaign brief -- a DAM folder, an optional [search query](https://imagekit.io/docs/api-reference/media-api/list-and-search-files#search-query), and a list of variants (name + ImageKit transformation chain).
2. The **api** service validates the brief with Zod, writes initial campaign state to Key Value, and triggers a `runCampaign` run on the workflow service via the [Render SDK](https://github.com/render-oss/sdk) (`workflows.startTask`), returning immediately (`202`) with a campaign id to poll.
3. **`runCampaign`** resolves the brief into concrete assets (`resolveAssets`), then calls `renderVariant` once per (asset, variant) pair. Each call becomes its own independently-tracked, independently-retried Workflows task run (see [Chaining tasks](https://render.com/docs/workflows-defining#chaining-tasks)) -- this fan-out is the actual point of building this on Workflows instead of a script.
4. Each **`renderVariant`** run builds the on-demand transformation URL and runs the [async transformation protocol](#async-transformation-protocol) against it: poll with backoff, or (for video) let a correlated webhook resolve it early. It writes its outcome back to Key Value as it goes, so campaign progress is visible in real time, not just at the end.
5. Once every `renderVariant` run has settled, **`buildManifest`** writes a CSV manifest (one row per asset x variant, with final URL or error) and marks the campaign `completed`/`failed`.
6. The **demo UI** polls `GET /campaigns/:id` every 2s and renders progress live, then offers the manifest and a grid of finished renders once done.

### Why three services

- **`api`** -- a normal, always-on web service. Owns the HTTP surface: brief validation, triggering runs, status/manifest reads, and the ImageKit webhook receiver (which needs a stable public URL to register in the ImageKit dashboard).
- **`campaign-workflow`** -- a [Render Workflows](https://render.com/docs/workflows) service. Owns the actual fan-out: it's what gives each `renderVariant` call its own tracked run, timeout, and retry policy, instead of it being an anonymous `await` inside a bigger request handler that a redeploy or a crash would silently drop.
- **`state`** (Render Key Value) -- the one piece of state both of the above need to share: campaign progress (written by the workflow, read by the api), the webhook <-> in-flight-wait correlation map, and webhook event-id idempotency records.

Splitting api and workflow into separate services isn't just taste -- see [Deploying the workflow service](#deploying-the-workflow-service) for why Render currently requires it.

## Async transformation protocol

This is the part of the spec that most needed verifying against the real API rather than guessed, so [`await-transformation.ts`](src/lib/await-transformation.ts) was written by first hitting a real ImageKit demo account and reading the actual response headers, then encoding what came back. Summary:

| Signal | Meaning | Source |
|---|---|---|
| `is-intermediate-response: true` response header (any 2xx) | Not ready yet -- ImageKit is still preparing the asset. Keep polling. | [AI transformations docs](https://imagekit.io/docs/ai-transformations#limitations-and-considerations), and the general [async processing for long-running requests](https://imagekit.io/docs/transformations#limits) behavior |
| `302` redirect back to the *original*, untransformed asset | Video-only: cache miss, still encoding in the background. Not ready yet. | [Video transformation: first-time request and cache](https://imagekit.io/docs/video-transformation#first-time-request-and-cache) |
| `ik-error` response header on a non-2xx | A real, terminal failure (invalid transformation parameter, etc). Stop polling. | [Troubleshooting invalid transformations](https://imagekit.io/docs/transformations#troubleshooting-invalid-transformation) |
| Plain `2xx`, no intermediate marker | Done. | -- |
| `202` | Not documented for these endpoints today, but treated defensively as "not ready" anyway -- costs nothing to handle and covers a future/undocumented use of the conventional "accepted" status. | This project's own defensive choice |

`awaitTransformation()` polls the built transformation URL with `redirect: 'manual'` (so a video's 302 is observable instead of being silently followed) and jittered exponential backoff (1s → 30s ceiling, full jitter to avoid a thundering herd when a campaign starts 160 of these at once), up to a configurable timeout (`AWAIT_TRANSFORMATION_TIMEOUT_MS`, default 2 minutes). It never throws -- callers get a `{ status: 'ready' | 'timeout' | 'error', ... }` result and decide what that means for their task.

**Webhook-assisted waiting, for video only.** ImageKit's webhooks cover `video.transformation.ready` / `video.transformation.error` -- there is no image/AI equivalent (confirmed against the real `@imagekit/nodejs` webhook event union, not assumed). When `IMAGEKIT_WEBHOOK_SECRET` is set and the asset is a video, `renderVariant` passes a `checkExternalResolution` hook into `awaitTransformation` that checks Key Value (keyed by the transformation URL) before every poll -- so a webhook delivered mid-wait short-circuits the loop instead of the code re-hitting ImageKit's CDN every backoff interval. Without the webhook secret set, video variants just fall back to plain polling; nothing breaks, it's just less efficient.

## Features

- **Parallel fan-out with per-item retries.** Each (asset, variant) render is its own Workflows task run with its own retry policy (2 retries, exponential backoff) -- one failed variant doesn't take down the campaign's manifest (`Promise.allSettled`, not `Promise.all`).
- **Real-time progress**, not just a final result: `GET /campaigns/:id` reflects each variant's status (`queued` → `rendering` → `ready`/`error`/`timeout`) as subtask runs settle out of order.
- **CSV manifest** per campaign: `fileId, fileName, variant, status, url, error` -- one row per rendered variant.
- **Idempotent webhook receiver**, correctly verifying ImageKit's HMAC signature (via `@imagekit/nodejs`'s `webhooks.unwrap()`) and de-duplicating redelivered events with an atomic `SET NX` in Key Value.
- **Safety caps**: `MAX_ASSETS_PER_CAMPAIGN` (default 200) bounds how many `renderVariant` runs one brief can fan out to (so a typo'd `folder: "/"` doesn't fan out thousands of runs); at most 20 variants per brief.
- **A small static demo UI**: submit a brief (with two one-click presets -- basic resizes, and an AI background+upscale chain), watch progress, and view/download the finished grid and manifest.

## Use cases

- **Campaign localization/resizing at scale**: one brief, N source assets, M output variants (square/story/thumb crops, or region-specific aspect ratios) -- the kind of job that's naturally "many independent small tasks," which is exactly what Workflows fan-out is for.
- **AI creative variations**: background swaps, upscales, or other AI transformations across a whole campaign's asset folder, where each individual AI edit can be slow enough that a naive script would need to handle timeouts and partial failure by hand.
- **Video variant rendering**: multiple output formats/qualities per source video, using the webhook-assisted wait so the workflow isn't stuck polling for the (slower) video encode path.

## Quick start (local development)

### Prerequisites

- Node.js 20+ (or use the same portable-Node approach as the rest of this repo's siblings if you don't want a system install)
- A Redis or [Valkey](https://valkey.io/) instance for local `state` (`docker run -p 6379:6379 valkey/valkey`, or point `REDIS_URL` at any instance you already have)
- An [ImageKit account](https://imagekit.io/registration/) with API keys and a URL endpoint
- A [Render account](https://dashboard.render.com) + [API key](https://render.com/docs/api#1-create-an-api-key) -- only needed once you actually want to trigger real workflow runs; everything else (server, routes, webhook handling, unit tests) runs without one

### Setup

```sh
cd imagekit-render-creative-automation
npm install
cp .env.example .env
# fill in IMAGEKIT_PRIVATE_KEY / IMAGEKIT_PUBLIC_KEY / IMAGEKIT_URL_ENDPOINT at minimum
```

Run the test suite and start the API:

```sh
npm test          # 34 unit/integration tests, no external services required
npm run dev:api    # starts on :3000 (needs a reachable REDIS_URL)
```

Open `http://localhost:3000` for the demo UI. Submitting a brief needs `RENDER_API_KEY` + `WORKFLOW_SLUG` set (see [Deploying the workflow service](#deploying-the-workflow-service)) -- without them, `POST /campaigns` returns a clear `502` explaining exactly that, instead of hanging or crashing.

To run workflow tasks locally against the [Render CLI](https://render.com/docs/cli)'s local dev server (`render workflows dev`), see Render's own docs on [testing workflows locally](https://render.com/docs/workflows-local-development) -- the task functions in `src/workflow/` are plain `task()`-wrapped functions and don't need any code changes to run that way; `npm run dev:workflow` (`tsx src/workflow/campaign.ts`) also works standalone for registering/inspecting the task definitions.

## Deploying to Render

Deployment happens in two parts, in order, the same split [Render's own Workflows example](https://github.com/render-examples/blog-thumbnails-workflows) uses:

1. **`api` + `state`** deploy from the included [Blueprint](https://render.com/docs/infrastructure-as-code) (`render.yaml`).
2. **`campaign-workflow`** deploys separately through the Dashboard, because [Render Blueprints do not yet support creating or managing Workflow services](https://render.com/docs/workflows).

Do them in this order -- the workflow service needs to exist before `api` can call it, and `api` needs the workflow's slug.

### 1. Deploy `api` + `state` (Blueprint)

1. Push this repo to GitHub/GitLab/Bitbucket.
2. In the [Render Dashboard](https://dashboard.render.com), create a new Blueprint from your repo (or use the Deploy-to-Render flow if you've set one up).
3. Fill in the `sync: false` env vars the Blueprint leaves blank: `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_URL_ENDPOINT`, `IMAGEKIT_WEBHOOK_SECRET` (optional). `REDIS_URL` is wired automatically from the `state` Key Value instance the Blueprint also creates.
4. Leave `RENDER_API_KEY` and `WORKFLOW_SLUG` blank for now -- both depend on step 2.

### 2. Deploy the workflow service (Dashboard)

1. In the Render Dashboard, click **New > Workflow**.
2. Connect the same repository.
3. Configure:

   | Field | Value |
   |---|---|
   | Language | Node |
   | Root Directory | `imagekit-render-creative-automation` (or repo root, if this is the whole repo) |
   | Build Command | `npm ci && npm run build` |
   | Start Command | `npm run start:workflow` |

4. Set this service's own env vars -- it needs `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_URL_ENDPOINT`, and `REDIS_URL` too (copy `REDIS_URL` from the `api` service's environment, or from the `state` Key Value instance's connection string directly -- the Blueprint only wires it into `api`, not into a service it doesn't manage).
5. Deploy, and note the workflow's **slug** (shown in its service URL / dashboard page, e.g. `creative-automation-workflow`). Tasks are addressed as `<slug>/<task-name>` -- e.g. `<slug>/runCampaign`.

### 3. Connect `api` to the workflow

Back on the `api` service, set:

| Variable | Value |
|---|---|
| `RENDER_API_KEY` | An [API key](https://render.com/docs/api#1-create-an-api-key) for your workspace |
| `WORKFLOW_SLUG` | The slug from step 2.5 |

Redeploy `api` (or it'll pick these up on next restart). Then register the webhook URL printed in `api`'s boot log (`<PUBLIC_BASE_URL>/webhooks/imagekit`) in the [ImageKit dashboard's webhook settings](https://imagekit.io/dashboard/developer/webhooks), copy the `whsec_...` signing secret it gives you into `IMAGEKIT_WEBHOOK_SECRET` on `api`, and redeploy once more.

### Keeping both services up to date after the first deploy

If you provisioned `api` through the Dashboard's Blueprint/"New Web Service" flow and connected your GitHub account via its OAuth prompt, pushes to your linked branch auto-deploy natively -- no further setup needed.

If instead you (or an automation) provisioned either service via the [Render API](https://api-docs.render.com) or [CLI](https://render.com/docs/cli) using a **plain repository URL** rather than that OAuth flow -- which is how this project's own `api` and `campaign-workflow` services were actually stood up, since Workflow services in particular can't be created any other way non-interactively (`render workflows create --repo <url> ...`) -- pushes to `main` will *not* auto-deploy. This isn't a misconfiguration to fix on either service; per [Render's docs](https://render.com/docs/deploys#automatic-deploys), "auto-deploys require a connected GitHub, GitLab, or Bitbucket account. Services that use... a public Git repository URL must be deployed manually."

The fix Render documents for exactly this case is CI-triggered deploys via the [Render CLI](https://render.com/docs/cli#example-github-actions) or a [Deploy Hook](https://render.com/docs/deploy-hooks) -- this repo ships [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) using the CLI approach: on every push to `main`, it runs the test suite, then (only if that passes) redeploys `creative-automation-api` and releases a new `creative-automation-workflow` version, authenticated with `RENDER_API_KEY` (no OAuth needed). To use it:

1. Add a `RENDER_API_KEY` repo secret (Settings > Secrets and variables > Actions > New repository secret) -- the same key already in `.env.local`.
2. Update `API_SERVICE_ID` / `WORKFLOW_ID` in the workflow file if your service ids differ (find them with `render services list -o json` / `render workflows list -o json`).

### Environment variables

#### `api` service

| Variable | Description | Set by |
|---|---|---|
| `IMAGEKIT_PRIVATE_KEY` / `IMAGEKIT_PUBLIC_KEY` / `IMAGEKIT_URL_ENDPOINT` | [ImageKit API keys](https://imagekit.io/dashboard/developer/api-keys) and [URL endpoint](https://imagekit.io/dashboard/url-endpoints) | You |
| `IMAGEKIT_WEBHOOK_SECRET` | `whsec_...` from the ImageKit webhook dashboard. Optional -- without it, video variants poll instead of using webhook-assisted waiting. | You (step 3) |
| `REDIS_URL` | Connection string for `state` | Blueprint |
| `RENDER_API_KEY` / `WORKFLOW_SLUG` | For triggering `campaign-workflow` runs | You (step 3) |
| `MAX_ASSETS_PER_CAMPAIGN` | Safety cap, default `200` | Blueprint |
| `AWAIT_TRANSFORMATION_TIMEOUT_MS` | Per-variant poll budget, default `120000` | Blueprint |
| `PUBLIC_BASE_URL` | This service's own public URL (for printing the webhook URL to register) | Blueprint (self-reference via `RENDER_EXTERNAL_URL`) |

#### `campaign-workflow` service

Set all of these yourself in the Dashboard -- the Blueprint doesn't manage this service (see [why three services](#why-three-services)):

| Variable | Description |
|---|---|
| `IMAGEKIT_PRIVATE_KEY` / `IMAGEKIT_PUBLIC_KEY` / `IMAGEKIT_URL_ENDPOINT` | Same ImageKit credentials as `api` |
| `REDIS_URL` | Same `state` connection string as `api` |
| `MAX_ASSETS_PER_CAMPAIGN` / `AWAIT_TRANSFORMATION_TIMEOUT_MS` | Same safety caps as `api` (both services read the same env var names via `src/lib/env.ts`) |

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `POST /campaigns` returns `502` with a message about `RENDER_API_KEY`/`WORKFLOW_SLUG` | Workflow service not connected yet | Finish step 3 above |
| Campaign stays `queued` for every variant forever | `campaign-workflow`'s own `REDIS_URL`/ImageKit env vars aren't set (Blueprint doesn't reach this service) | Set them by hand in the Dashboard (step 2.4) |
| Video variants use polling even with a webhook secret set | Webhook not registered with ImageKit, or `IMAGEKIT_WEBHOOK_SECRET` doesn't match | Re-check the URL printed in `api`'s boot log matches what's registered, and the secret matches exactly (starts with `whsec_`) |
| `GET /campaigns/:id/manifest.csv` returns `409` | Campaign is still running | Poll `GET /campaigns/:id` until `status` is `completed`/`failed` |
| Every route returns a `500` immediately (not a hang) | `state`/Redis unreachable | Check `REDIS_URL` on whichever service is failing; see the "Redis client error" log line for the underlying cause |

## API reference

| Route | Description |
|---|---|
| `POST /campaigns` | Submit a brief (`{ name, folder, assetSearchQuery?, variants: [{ name, transformation }] }`). Returns `202 { id, taskRunId, statusUrl }`, or `400` (invalid brief) / `502` (couldn't start the run). |
| `GET /campaigns` | Recent campaigns (up to 50) with computed ready/failed counts, for the demo UI's history list. |
| `GET /campaigns/:id` | Full campaign state: brief, status, and per-variant progress. `404` if unknown. |
| `GET /campaigns/:id/manifest.csv` | The CSV manifest. `409` while still running, `404` if unknown. |
| `POST /webhooks/imagekit` | ImageKit webhook receiver (signature-verified, idempotent). Not meant to be called directly -- register this URL in the ImageKit dashboard. |
| `GET /health` | Liveness check. |

## Limits

- **`MAX_ASSETS_PER_CAMPAIGN`** (default 200) caps how many source assets one brief resolves to, and therefore how many `renderVariant` runs (`assets x variants`) one `runCampaign` fans out.
- **At most 20 variants per brief** (enforced by `campaignBriefSchema`).
- **`AWAIT_TRANSFORMATION_TIMEOUT_MS`** (default 2 minutes) is the poll budget per variant, after which it's reported `timeout` rather than blocking the campaign forever.
- Workflow task timeouts: `resolveAssets` 60s, `renderVariant` 300s (with 2 retries, exponential backoff), `buildManifest` 30s, `runCampaign` 3600s overall.

## Verification

Claims above that were actually run, not just asserted:

- **`awaitTransformation`'s protocol was verified against a real ImageKit demo account**, not guessed from docs alone: built a real transformation URL, requested it, and read the actual `is-intermediate-response` / `ik-error` headers back, for both a normal successful transformation and a deliberately invalid one, before writing the polling logic around what came back.
- **`npm test`: 34/34 passing** -- `awaitTransformation` (intermediate-marker/202/302 handling, `redirect: 'manual'` behavior confirmed via a mock that would otherwise auto-follow, error surfacing via `ik-error`, network-error handling, exponential backoff bounds, timeout, and the `checkExternalResolution` webhook short-circuit seam), ImageKit webhook signature verification using the real `@imagekit/nodejs`/`standardwebhooks` machinery (valid signature, wrong secret, tampered payload all correctly accepted/rejected), webhook idempotency (redelivery acknowledged but not reprocessed), `buildManifest`'s CSV generation (including quote/comma escaping) and campaign completed/failed classification, `campaignBriefSchema` validation edge cases, and the full `/campaigns` HTTP surface (create/list/get/manifest, including the 502-on-trigger-failure path) against a fake in-memory Key Value client.
- **`npm run typecheck` / `typecheck:test`**: 0 errors across `src/` and `test/`.
- **The API's error handling was verified against a real failure, not just code-reviewed**: ran the built server with `REDIS_URL` pointing at nothing listening, and confirmed the actual HTTP response is a clean `500 {"error": "...", "message": "Redis reconnect attempts exhausted."}` -- not Express's default HTML error page. This caught two real bugs during development: an unhandled `'error'` event on the redis client (Node treats an EventEmitter's unlistened `'error'` event as fatal) and node-redis's default `reconnectStrategy` retrying forever, which made every request during an outage hang indefinitely instead of failing fast. Both are fixed in `src/lib/state.ts`.
- **Not verified**: an actual end-to-end `runCampaign` run against a deployed `campaign-workflow` service on Render (no Render account/deploy access in this environment), and an actual `video.transformation.ready` webhook delivery from ImageKit's real servers (would need a deployed public webhook URL and a real video asset large/slow enough to trigger async processing). Everything up to those points -- the protocol logic, the signature verification, the HTTP surface, the state machine -- is verified above against the real building blocks each of those would use.

## Out of scope

- An actual media asset picker/browser UI -- the demo UI takes a DAM folder path and search query as text, not a visual picker.
- Multi-tenant auth on the `api` service -- there's no user/auth model here; add one before exposing this beyond a demo.

## License

MIT
