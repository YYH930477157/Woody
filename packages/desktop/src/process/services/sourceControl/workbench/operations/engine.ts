/**
 * Classifier and worktree parser adapted from vs-idea-gittool src/features/ops/engine.ts,
 * pinned at 8bd81d26dbb2997d021465f16fec6fc3656c3f38. See resources/third-party/ideagittool/PROVENANCE.md
 * for upstream provenance and the pinned license discrepancy. No VS Code runtime dependency.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitOperationOutcome, GitWorktree } from '@/common/types/sourceControl/operationTypes';
import type { GitExecutor } from '../executor';
import { recoverPendingHistory, resolveHistoryRef } from './historyWorkspace';

export const safeOutput = (text: string): string =>
  text
    .replace(/\b(https?|ssh):\/\/([^\s/@]+)@/gi, (match, protocol: string, userInfo: string) =>
      protocol.toLowerCase() === 'ssh' && !userInfo.includes(':') ? match : `${protocol}://[redacted]@`
    )
    .replace(/([?&](?:token|access_token|password|secret|key)=)[^\s&#]+/gi, '$1[redacted]');

export class OperationBlocked extends Error {}

/** Read operation markers in the current worktree, not the common directory. */
export async function inspectOperation(root: string, git: GitExecutor) {
  const directory = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).stdout.trim());
  try {
    await recoverPendingHistory(
      directory,
      async () => path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).stdout.trim()),
      resolveHistoryRef(root, git)
    );
  } catch (error) {
    throw new OperationBlocked(error instanceof Error ? error.message : 'History state recovery failed');
  }
  const markers = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ] as const;
  for (const [marker, operation] of markers) {
    try {
      await access(path.join(directory, marker));
      return operation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // A multi-commit sequencer may remain after a resolved cherry-pick/revert.
  try {
    const todo = await readFile(path.join(directory, 'sequencer', 'todo'), 'utf8');
    if (/^revert /m.test(todo)) return 'revert' as const;
    if (/^pick /m.test(todo)) return 'cherry-pick' as const;
    throw new OperationBlocked('Unknown sequencer operation; inspect it with Git before continuing');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return null;
}

export const conflictedFiles = async (root: string, git: GitExecutor): Promise<string[]> =>
  (await git(root, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout.split('\0').filter(Boolean);

/** Classify conflict and local-overwrite failures while retaining safe Git diagnostics. */
export async function runConflictAware(root: string, git: GitExecutor, args: string[]): Promise<GitOperationOutcome> {
  const result = await git(root, args, true);
  const output = safeOutput(`${result.stdout}\n${result.stderr}`.trim());
  if (result.code === 0) return { state: 'complete', output };
  const overwritten =
    /(Your local changes to the following files would be overwritten|The following untracked working tree files would be (?:overwritten|removed)) by [^:\n]+:\n((?:\t.*\n?)+)/.exec(
      result.stderr
    );
  if (overwritten)
    return {
      state: 'blocked',
      reason: 'localChanges',
      output,
      files: overwritten[2]
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  const files = await conflictedFiles(root, git);
  if (files.length || /CONFLICT|Merge conflict|could not apply|after resolving the conflicts/i.test(output))
    return { state: 'conflict', output, files };
  return { state: 'error', output: output || 'Git command failed' };
}

/** Parse NUL-delimited porcelain so paths containing newlines remain intact. */
export function parseWorktrees(output: string): GitWorktree[] {
  const rows: GitWorktree[] = [];
  for (const block of output.split('\0\0')) {
    const fields = block.split('\0');
    if (!fields[0]?.startsWith('worktree ')) continue;
    const row: GitWorktree = {
      path: fields[0].slice(9),
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      main: rows.length === 0,
    };
    for (const field of fields.slice(1)) {
      if (field.startsWith('HEAD ')) row.head = field.slice(5);
      else if (field.startsWith('branch ')) row.branch = field.slice(7).replace(/^refs\/heads\//, '');
      else if (field === 'bare') row.bare = true;
      else if (field === 'detached') row.detached = true;
      else if (field === 'locked' || field.startsWith('locked ')) row.locked = true;
      else if (field === 'prunable' || field.startsWith('prunable ')) row.prunable = true;
    }
    rows.push(row);
  }
  return rows;
}
