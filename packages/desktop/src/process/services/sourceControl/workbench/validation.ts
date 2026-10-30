import { z } from 'zod';

export const relativePathSchema = z
  .string()
  .max(32768)
  .refine(
    (value) => !/^[\\/]|^[A-Za-z]:|[\r\n]/.test(value) && !value.includes('\0') && !value.split(/[\\/]/).includes('..'),
    'Invalid repository-relative path'
  );
export const revisionSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('-') && ![...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
    'Invalid Git revision'
  );
export const hashSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i);
export const scopeSchema = z
  .object({
    projectId: z.string().min(1).max(1024),
    peId: z.string().min(1).max(1024),
    relativePath: relativePathSchema,
  })
  .strict();
export const historyQuerySchema = z
  .object({
    skip: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    text: z.string().max(1024).optional(),
    author: z.string().max(1024).optional(),
    ref: revisionSchema.optional(),
    path: relativePathSchema.optional(),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    firstParent: z.boolean().optional(),
    noMerges: z.boolean().optional(),
    snapshot: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const diffAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['worktree', 'index', 'head']) }).strict(),
  z.object({ kind: z.literal('revision'), revision: revisionSchema }).strict(),
]);
export const diffRequestSchema = z
  .object({
    file: relativePathSchema.refine((value) => value.length > 0),
    from: diffAnchorSchema,
    to: diffAnchorSchema,
  })
  .strict();
export const fileHistoryQuerySchema = z
  .object({
    path: relativePathSchema.refine((value) => value.length > 0),
    skip: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
