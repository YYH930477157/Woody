import { z } from 'zod';

const project = z.string().min(1).max(32768);
const session = { projectPath: project, sessionId: z.string().min(1).max(128) };
export const gdbRequestSchema = z.union([
  z.object({ projectPath: project, operation: z.enum(['start', 'status']) }).strict(),
  z
    .object({
      ...session,
      operation: z.enum(['stop', 'pause', 'continue', 'next', 'step', 'finish', 'stack', 'locals']),
    })
    .strict(),
  z.object({ ...session, operation: z.literal('breakpointAdd'), location: z.string().min(1).max(4096) }).strict(),
  z
    .object({ ...session, operation: z.literal('breakpointRemove'), number: z.string().regex(/^\d+(?:\.\d+)?$/) })
    .strict(),
  z.object({ ...session, operation: z.literal('evaluate'), expression: z.string().min(1).max(512) }).strict(),
  z
    .object({
      ...session,
      operation: z.literal('memory'),
      address: z.string().regex(/^0x[0-9a-fA-F]{1,16}$/),
      count: z.number().int().min(1).max(256),
    })
    .strict(),
]);
