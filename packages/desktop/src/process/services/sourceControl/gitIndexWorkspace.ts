import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type TemporaryGitIndex = {
  env: NodeJS.ProcessEnv;
  path: string;
  cleaned: boolean;
  cleanup: () => Promise<void>;
};

export const createTemporaryGitIndex = async (_repoPath: string): Promise<TemporaryGitIndex> => {
  const directory = await mkdtemp(join(tmpdir(), 'woody-git-index-'));
  const path = join(directory, 'index');
  let cleaned = false;

  return {
    env: { ...process.env, GIT_INDEX_FILE: path },
    path,
    get cleaned() {
      return cleaned;
    },
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
};
