import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { progressSchema, MAX_MERGE_BYTES } from './validation';
import type { GitMergeProgress } from '@/common/types/sourceControl/mergeTypes';

const recoverySchema = z
  .object({
    version: z.string(),
    result: z.string().nullable(),
    progress: progressSchema.optional(),
    resolution: z.enum(['result', 'ours', 'theirs', 'delete']).optional(),
  })
  .strict();
export type MergeRecovery = {
  version: string;
  result: string | null;
  progress?: GitMergeProgress;
  resolution?: 'result' | 'ours' | 'theirs' | 'delete';
};
/** Store recovery outside repositories; the bridge supplies Electron's actual userData directory. */
export function createMergeRecoveryStore(directory: string) {
  const fileFor = (root: string, file: string) =>
    path.join(
      directory,
      createHash('sha256')
        .update(JSON.stringify([root, file]))
        .digest('hex') + '.json'
    );
  return {
    async read(root: string, file: string): Promise<MergeRecovery | undefined> {
      try {
        const data = await readFile(fileFor(root, file));
        if (data.length > MAX_MERGE_BYTES * 6) throw new Error('Merge recovery exceeds size limit');
        return recoverySchema.parse(JSON.parse(data.toString('utf8'))) as MergeRecovery;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async write(root: string, file: string, value: MergeRecovery) {
      const data = JSON.stringify(recoverySchema.parse(value));
      if (Buffer.byteLength(data) > MAX_MERGE_BYTES * 6) throw new Error('Merge recovery exceeds size limit');
      await mkdir(directory, { recursive: true });
      const destination = fileFor(root, file);
      const temporary = destination + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async remove(root: string, file: string) {
      await rm(fileFor(root, file), { force: true });
    },
  };
}
