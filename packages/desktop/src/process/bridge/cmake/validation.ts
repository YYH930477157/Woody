import { z } from 'zod';

export const projectSchema = z.object({ projectPath: z.string().min(1).max(32768) });
export const jobSchema = z.object({ jobId: z.string().min(1).max(128) });
export const startSchema = projectSchema
  .extend({
    action: z.enum(['check', 'configure', 'build', 'test', 'run']),
    selection: z.record(z.string().max(256), z.string().max(256)).optional(),
  })
  .strict();
