import { describe, expect, it } from 'vitest';
import { campaignBriefSchema } from '../src/api/campaign-brief-schema.js';

const validBrief = {
  name: 'Summer 2026',
  folder: '/campaigns/summer-2026',
  variants: [{ name: 'square-1080', transformation: [{ width: 1080, height: 1080 }] }],
};

describe('campaignBriefSchema', () => {
  it('accepts a well-formed brief', () => {
    const result = campaignBriefSchema.safeParse(validBrief);
    expect(result.success).toBe(true);
  });

  it('rejects a folder that is not an absolute DAM path', () => {
    const result = campaignBriefSchema.safeParse({ ...validBrief, folder: 'campaigns/summer-2026' });
    expect(result.success).toBe(false);
  });

  it('rejects zero variants', () => {
    const result = campaignBriefSchema.safeParse({ ...validBrief, variants: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 variants', () => {
    const variants = Array.from({ length: 21 }, (_, i) => ({ name: `v${i}`, transformation: [{ width: 100 }] }));
    const result = campaignBriefSchema.safeParse({ ...validBrief, variants });
    expect(result.success).toBe(false);
  });

  it('rejects a variant name with filesystem-unsafe characters', () => {
    const result = campaignBriefSchema.safeParse({
      ...validBrief,
      variants: [{ name: 'square/1080', transformation: [{ width: 1080 }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a variant with an empty transformation chain', () => {
    const result = campaignBriefSchema.safeParse({ ...validBrief, variants: [{ name: 'square', transformation: [] }] });
    expect(result.success).toBe(false);
  });
});
