import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createGitExecutor, type GitExecutor } from './executor';

const defaultGit = createGitExecutor();
const repositoryIdentity = async (root: string, git: GitExecutor): Promise<string> => {
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  const canonical = await realpath(path.resolve(root, common.stdout.trim()));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

/** Serialize top-level operations across worktrees sharing refs. Internal commands use the owned executor. */
export function createRepositoryCoordinator(
  identity?: (root: string) => Promise<string>,
  git: GitExecutor = defaultGit
) {
  const queues = new Map<string, Promise<void>>();
  const ownership = new AsyncLocalStorage<{ key: string; active: boolean }>();
  const resolveIdentity = identity ?? ((root: string) => repositoryIdentity(root, git));
  return {
    async run<T>(root: string, operation: () => Promise<T>): Promise<T> {
      const key = await resolveIdentity(root);
      const owner = ownership.getStore();
      if (owner?.active && owner.key === key) throw new Error('Nested repository coordination is not supported');
      const previous = queues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      queues.set(key, tail);
      await previous;
      const lease = { key, active: true };
      try {
        return await ownership.run(lease, operation);
      } finally {
        lease.active = false;
        release();
        if (queues.get(key) === tail) queues.delete(key);
      }
    },
  };
}

export const repositoryCoordinator = createRepositoryCoordinator(undefined, defaultGit);
