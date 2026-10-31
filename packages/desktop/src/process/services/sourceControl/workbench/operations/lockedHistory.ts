import path from 'node:path';
import type { GitExecutor } from '../executor';
import { OperationBlocked } from './engine';
import {
  acquireHistoryLocks,
  createHistoryWorkspace,
  pendingHistoryError,
  preparePublication,
  publishHistory,
  resolveHistoryRef,
} from './historyWorkspace';

/** Git advances private HEAD/index/state while the worktree's real HEAD and index stay locked. */
export async function withIsolatedHistory<T>(
  root: string,
  git: GitExecutor,
  preflight: () => Promise<void>,
  run: (git: GitExecutor) => Promise<T>
): Promise<T> {
  const gitDir = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).stdout.trim());
  const index = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).stdout.trim());
  const release = await acquireHistoryLocks(gitDir, index).catch((error: NodeJS.ErrnoException) => {
    // The path is the actionable part: it tells the user which lock to close or remove.
    if (error.code === 'EEXIST')
      throw new OperationBlocked(
        `Git HEAD or index is locked by another operation; retry after it finishes. ${error.message}`
      );
    throw error;
  });
  try {
    await preflight();
    const { journal, isolated } = await createHistoryWorkspace(root, git, gitDir, index);
    let result: T;
    try {
      result = await run(isolated);
    } catch (error) {
      throw pendingHistoryError(journal, error instanceof Error ? error.message : String(error));
    }
    const resolveRef = resolveHistoryRef(root, isolated);
    await preparePublication(journal, resolveRef);
    await publishHistory(journal, resolveRef);
    return result;
  } finally {
    await release();
  }
}
