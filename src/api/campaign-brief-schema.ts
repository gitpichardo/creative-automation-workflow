import { z } from 'zod';

const transformationStep = z.record(z.string(), z.unknown());

export const campaignBriefSchema = z.object({
  name: z.string().min(1).max(200),
  folder: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('/'), 'folder must be an absolute DAM path, e.g. "/campaigns/summer-2026".'),
  assetSearchQuery: z.string().max(1000).optional(),
  variants: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .refine((v) => /^[a-zA-Z0-9._-]+$/.test(v), 'variant name must be filename-safe (letters, numbers, ._-).'),
        transformation: z.array(transformationStep).min(1),
      }),
    )
    .min(1, 'at least one variant is required')
    .max(20, 'at most 20 variants per campaign'),
});

export type CampaignBriefInput = z.infer<typeof campaignBriefSchema>;
