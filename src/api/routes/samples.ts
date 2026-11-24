import { Router } from 'express';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFile } from '@imagekit/nodejs';
import { getImageKitClient } from '../../lib/imagekit.js';
import { asyncHandler } from '../async-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root `samples/` -- same relative depth from `src/api/routes` and `dist/api/routes`. */
export const SAMPLES_DIR = path.join(__dirname, '..', '..', '..', 'samples');
export const SAMPLE_FOLDER = '/campaigns/demo';

export const samplesRouter = Router();

/**
 * Copies the images in `samples/images` into the `/campaigns/demo` DAM folder
 * so the prefilled brief works on a fresh ImageKit account. Files already in
 * the folder are skipped. The DAM listing lags uploads by a few seconds, so a
 * quick second call may re-upload instead; `useUniqueFileName: false` makes
 * that a new version of the same file rather than a duplicate.
 */
samplesRouter.post('/samples/upload', asyncHandler(async (_req, res) => {
  const client = getImageKitClient();
  const imagesDir = path.join(SAMPLES_DIR, 'images');
  const fileNames = (await readdir(imagesDir)).filter((name) => /\.(jpe?g|png|webp)$/i.test(name)).sort();

  const existing = await client.assets.list({ type: 'file', path: SAMPLE_FOLDER, limit: 100 });
  const existingNames = new Set(existing.map((asset) => asset.name));

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const fileName of fileNames) {
    if (existingNames.has(fileName)) {
      skipped.push(fileName);
      continue;
    }
    const bytes = await readFile(path.join(imagesDir, fileName));
    await client.files.upload({
      file: await toFile(bytes, fileName),
      fileName,
      folder: SAMPLE_FOLDER,
      useUniqueFileName: false,
      overwriteFile: true,
      tags: ['creative-automation-sample'],
    });
    uploaded.push(fileName);
  }

  res.json({ folder: SAMPLE_FOLDER, uploaded, skipped });
}));
