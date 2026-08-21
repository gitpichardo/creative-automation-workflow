import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { campaignsRouter } from './routes/campaigns.js';
import { webhooksRouter } from './routes/webhooks.js';
import { env } from '../lib/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();

  // Webhook routes need the raw body for signature verification, so they're
  // mounted before the global express.json() middleware -- see
  // routes/webhooks.ts for why.
  app.use(webhooksRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(campaignsRouter);

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Minimal static demo UI -- see src/ui/README for what it does.
  app.use(express.static(path.join(__dirname, '..', 'ui')));

  // Express 5 forwards rejected promises from async route handlers here
  // automatically, so this alone is enough to turn e.g. a Key Value
  // connection failure into a clean JSON 500 instead of Express's default
  // HTML error page (which would otherwise leak a stack trace).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error.', message: err instanceof Error ? err.message : String(err) });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createServer();
  app.listen(env.port, () => {
    console.log(`imagekit-render-creative-automation api listening on :${env.port}`);
    console.log(`Webhook URL to register in the ImageKit dashboard: ${env.publicBaseUrl}/webhooks/imagekit`);
  });
}
