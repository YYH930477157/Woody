import { z } from 'zod';
import { relativePathSchema } from '../validation';

export const MAX_MERGE_BYTES = 2 * 1024 * 1024;
export const mergePathSchema = relativePathSchema
  .refine((file) => file.length > 0)
  .refine(
    (file) =>
      !file
        .split(/[\\/]/)
        .some(
          (part) =>
            !part ||
            part === '.' ||
            /^\.git$/i.test(part) ||
            /:|[. ]$/.test(part) ||
            [...part].some((char) => char.charCodeAt(0) < 32)
        ),
    'Unsafe merge path'
  );
const text = z
  .string()
  .max(MAX_MERGE_BYTES)
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <= MAX_MERGE_BYTES &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
    'Invalid or oversized UTF-8 text'
  );
const position = z.number().int().min(0).max(MAX_MERGE_BYTES);
export const progressSchema = z
  .object({
    lines: z.array(text).max(100_000),
    states: z
      .array(
        z
          .object({
            start: position,
            end: position,
            resolvedLeft: z.boolean(),
            resolvedRight: z.boolean(),
            oneside: z.boolean(),
          })
          .strict()
      )
      .max(100_000),
    contentModified: z.boolean(),
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_MERGE_BYTES * 4, 'Merge progress is too large');
const identity = { file: mergePathSchema, version: z.string().regex(/^[a-f0-9]{64}$/) };
export const saveSchema = z.object({ ...identity, result: text, progress: progressSchema.optional() }).strict();
export const finishSchema = z
  .object({
    ...identity,
    resolution: z.enum(['result', 'ours', 'theirs', 'delete']),
    result: text.optional(),
    reviewedManual: z.boolean().optional(),
    confirmed: z.literal(true),
  })
  .strict();
