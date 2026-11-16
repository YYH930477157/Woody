import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  GitOperationOutcome,
  TeamWorktreeCreateResult,
  TeamWorktreeInfo,
  TeamWorktreeSource,
} from '@/common/types/sourceControl/operationTypes';
import { forUserOperation, type GitExecutor } from '../executor';
import {
  OperationBlocked,
  conflictedFiles,
  inspectOperation,
  parseWorktrees,
  runConflictAware,
  safeOutput,
} from './engine';

/**
 * Separate worktrees for teams. Each team gets its own folder next to the repository and
 * its own branch, so several teams can change one repository at the same time. The branch
 * config `woodyBase` marks a worktree Woody made and names the branch it merges back into;
 * deleting the branch removes the mark with it.
 */
const BASE_KEY = 'woodyBase';
const MAX_SUFFIX = 50;

type Run = <T>(root: string, operation: () => Promise<T>) => Promise<T>;
type Capabilities = { memoryHistoryEdit?: boolean; worktreeListNul?: boolean; mergeNoAutostash?: boolean };

const pad = (value: number) => String(value).padStart(2, '0');

/** An ASCII name for the branch and the folder: MinGW builds fail on paths with other characters. */
export function teamWorktreeSlug(name: string, now: Date): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (slug.length >= 2) return slug;
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `team-${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const exists = (target: string): Promise<boolean> =>
  access(target).then(
    () => true,
    () => false
  );

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Folders arrive from the renderer: only absolute paths are accepted. */
const isFolder = (folder: unknown): folder is string =>
  typeof folder === 'string' && folder.length < 4096 && !folder.includes('\0') && path.isAbsolute(folder);

const failure = (error: unknown): { state: 'blocked' | 'error'; reason?: string; output: string } =>
  error instanceof OperationBlocked
    ? { state: 'blocked', ...(error.reason ? { reason: error.reason } : {}), output: safeOutput(error.message) }
    : { state: 'error', output: safeOutput(error instanceof Error ? error.message : 'Git operation failed') };

export function createTeamWorktreeService(options: {
  git: GitExecutor;
  run: Run;
  capabilities?: Capabilities;
  now?: () => Date;
}) {
  const { git, run } = options;
  const userGit = forUserOperation(git);
  const capabilities = options.capabilities ?? {};
  const now = options.now ?? (() => new Date());
  const noAutostash = capabilities.mergeNoAutostash === false ? [] : ['--no-autostash'];

  const value = async (root: string, args: string[]): Promise<string | null> => {
    const result = await git(root, args, true);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const isAncestor = async (root: string, ancestor: string, descendant: string): Promise<boolean> =>
    (await git(root, ['merge-base', '--is-ancestor', ancestor, descendant], true)).code === 0;
  const isDirty = async (root: string): Promise<boolean> =>
    (await git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout.trim() !== '';
  const worktrees = async (root: string) => {
    const nul = capabilities.worktreeListNul !== false;
    const { stdout } = await git(root, ['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])]);
    return parseWorktrees(nul ? stdout : stdout.replace(/\r?\n/g, '\0'));
  };

  /** The repository around `folder`, or null when the folder is not inside one. */
  async function inspect(folder: string): Promise<TeamWorktreeSource | null> {
    if (!isFolder(folder)) return null;
    let top: string | null;
    try {
      top = await value(folder, ['rev-parse', '--show-toplevel']);
    } catch {
      // A missing folder fails to start Git at all.
      return null;
    }
    if (!top) return null;
    const root = await realpath(top);
    const [branch, head, dirty] = await Promise.all([
      value(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      value(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
      isDirty(root),
    ]);
    return { root, branch, head, dirty };
  }

  /** The team worktree at `root`, or null for any other repository or worktree. */
  async function describe(root: string): Promise<TeamWorktreeInfo | null> {
    const [gitDir, commonDir] = await Promise.all([
      value(root, ['rev-parse', '--git-dir']),
      value(root, ['rev-parse', '--git-common-dir']),
    ]);
    if (!gitDir || !commonDir) return null;
    const [own, common] = await Promise.all([
      realpath(path.resolve(root, gitDir)),
      realpath(path.resolve(root, commonDir)),
    ]);
    if (samePath(own, common)) return null;
    const branch = await value(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) return null;
    const base = await value(root, ['config', '--get', `branch.${branch}.${BASE_KEY}`]);
    if (!base) return null;
    const baseExists =
      (await value(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`])) !== null;
    let ahead = 0;
    let behind = 0;
    if (baseExists) {
      const counts = (await git(root, ['rev-list', '--left-right', '--count', `refs/heads/${base}...HEAD`])).stdout
        .trim()
        .split(/\s+/);
      behind = Number(counts[0]) || 0;
      ahead = Number(counts[1]) || 0;
    }
    return {
      worktree: root,
      branch,
      base,
      baseExists,
      ahead,
      behind,
      dirty: await isDirty(root),
      operation: await inspectOperation(root, git),
    };
  }

  /** A new folder beside the repository on a new `team/<name>` branch, started from the current commit. */
  async function create(folder: string, name: string): Promise<TeamWorktreeCreateResult> {
    try {
      if (typeof name !== 'string' || name.length > 500)
        throw new OperationBlocked('Invalid team name', 'invalidInput');
      const source = await inspect(folder);
      if (!source) throw new OperationBlocked('The folder is not inside a Git repository', 'notRepository');
      return await run(source.root, async () => {
        const base = await value(source.root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (!base) throw new OperationBlocked('HEAD is detached; switch to a branch first', 'detached');
        const head = await value(source.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        if (!head) throw new OperationBlocked('The repository has no commits yet', 'noCommits');
        const slug = teamWorktreeSlug(name, now());
        const repoName = path.basename(source.root);
        let branch = '';
        let worktree = '';
        // Each name is checked only after the previous one turned out to be taken.
        /* eslint-disable no-await-in-loop */
        for (let index = 1; index <= MAX_SUFFIX && !branch; index++) {
          const suffix = index === 1 ? '' : `-${index}`;
          const candidateBranch = `team/${slug}${suffix}`;
          const candidateFolder = path.join(path.dirname(source.root), `${repoName}-${slug}${suffix}`);
          const taken =
            (await value(source.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidateBranch}`])) !==
              null || (await exists(candidateFolder));
          if (!taken) {
            branch = candidateBranch;
            worktree = candidateFolder;
          }
        }
        /* eslint-enable no-await-in-loop */
        if (!branch) throw new OperationBlocked('No free branch or folder name is left', 'nameTaken');
        await userGit(source.root, ['worktree', 'add', '-b', branch, worktree, head]);
        try {
          await git(source.root, ['config', `branch.${branch}.${BASE_KEY}`, base]);
        } catch (error) {
          await git(source.root, ['worktree', 'remove', '--force', worktree], true);
          await git(source.root, ['branch', '-D', branch], true);
          throw error;
        }
        const created = await realpath(worktree);
        // A team that works in a subfolder keeps working in the same subfolder of the worktree.
        const relative = path.relative(source.root, await realpath(folder));
        const nested =
          relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? path.join(created, relative) : created;
        return {
          state: 'complete' as const,
          worktree: { workspace: (await exists(nested)) ? nested : created, worktree: created, branch, base },
        };
      });
    } catch (error) {
      return failure(error);
    }
  }

  /** Move the base branch to `target`, which must already contain it. */
  async function fastForward(root: string, base: string, expected: string, target: string) {
    const holder = (await worktrees(root)).find((tree) => tree.branch === base && !tree.bare && !tree.prunable);
    if (!holder) {
      // No folder has the base branch checked out, so only the reference moves.
      await git(root, ['update-ref', '-m', 'woody: merge team branch', `refs/heads/${base}`, target, expected]);
      return { state: 'complete' as const, reason: 'merged', output: '' };
    }
    if (await inspectOperation(holder.path, git))
      throw new OperationBlocked(`${holder.path} has an operation in progress`, 'baseBusy');
    const outcome = await runConflictAware(holder.path, userGit, [
      'merge',
      '--ff-only',
      '--no-edit',
      ...noAutostash,
      target,
    ]);
    if (outcome.state === 'blocked') return { ...outcome, reason: 'baseLocalChanges' };
    return outcome.state === 'complete' ? { ...outcome, reason: 'merged' } : outcome;
  }

  /**
   * Merge the team branch into its base branch. Without conflicts the merge commit is built
   * in memory and the base branch fast-forwards to it. With conflicts the base branch is
   * merged into the team worktree instead, so they are resolved where the team works; the
   * next merge then only fast-forwards.
   */
  async function merge(root: string): Promise<GitOperationOutcome> {
    try {
      return await run(root, async () => {
        const info = await describe(root);
        if (!info) throw new OperationBlocked('This is not a team worktree made by Woody', 'notTeamWorktree');
        if (info.operation || (await conflictedFiles(root, git)).length)
          throw new OperationBlocked(
            'An operation or unresolved conflict is already in progress',
            'operationInProgress'
          );
        if (!info.baseExists) throw new OperationBlocked(`Branch ${info.base} no longer exists`, 'baseMissing');
        if (info.dirty)
          throw new OperationBlocked('Commit or discard the changes in the team worktree first', 'dirtyWorktree');
        const baseHead = (await git(root, ['rev-parse', '--verify', `refs/heads/${info.base}^{commit}`])).stdout.trim();
        let target = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
        if (await isAncestor(root, target, baseHead)) return { state: 'complete', reason: 'upToDate', output: '' };
        if (!(await isAncestor(root, baseHead, target))) {
          const built =
            capabilities.memoryHistoryEdit === false
              ? undefined
              : await git(root, ['merge-tree', '--write-tree', baseHead, target], true);
          if (built?.code === 0) {
            const tree = built.stdout.split(/\r?\n/)[0].trim();
            const message = `Merge branch '${info.branch}' into ${info.base}`;
            target = (
              await git(root, ['commit-tree', tree, '-p', baseHead, '-p', target, '-m', message])
            ).stdout.trim();
          } else if (built && built.code !== 1) {
            return { state: 'error', output: safeOutput(built.stderr.trim() || 'git merge-tree failed') };
          } else {
            const outcome = await runConflictAware(root, userGit, ['merge', '--no-edit', ...noAutostash, baseHead]);
            if (outcome.state === 'conflict') return { ...outcome, reason: 'resolveInWorktree' };
            if (outcome.state !== 'complete') return outcome;
            target = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
          }
        }
        return await fastForward(root, info.base, baseHead, target);
      });
    } catch (error) {
      return failure(error);
    }
  }

  /**
   * Remove the worktree folder and its branch. A branch with commits the base lacks is
   * removed only with `dropUnmerged`; uncommitted changes always block, and Git refuses a
   * folder with untracked files.
   */
  async function remove(root: string, dropUnmerged: boolean): Promise<GitOperationOutcome> {
    try {
      return await run(root, async () => {
        const info = await describe(root);
        if (!info) throw new OperationBlocked('This is not a team worktree made by Woody', 'notTeamWorktree');
        if (info.operation) throw new OperationBlocked('An operation is in progress', 'operationInProgress');
        if (info.dirty)
          throw new OperationBlocked('Commit or discard the changes in the team worktree first', 'dirtyWorktree');
        const merged = info.baseExists && (await isAncestor(root, 'HEAD', `refs/heads/${info.base}`));
        if (!merged && !dropUnmerged)
          throw new OperationBlocked('The team branch has commits that are not merged', 'unmerged');
        const main = (await worktrees(root)).find((tree) => tree.main);
        const home =
          main && !main.bare
            ? main.path
            : await realpath(path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).stdout.trim()));
        const removed = await userGit(home, ['worktree', 'remove', root], true);
        if (removed.code !== 0)
          return { state: 'error', reason: 'removeFailed', output: safeOutput(removed.stderr.trim()) };
        // Merged was checked against the base above; `-d` would check the main folder's HEAD instead.
        const deleted = await git(home, ['branch', '-D', info.branch], true);
        if (deleted.code !== 0)
          return { state: 'error', reason: 'branchKept', output: safeOutput(deleted.stderr.trim()) };
        return { state: 'complete', reason: 'removed', output: '' };
      });
    } catch (error) {
      return failure(error);
    }
  }

  /** Remove a worktree prepared for a team that was never created: only while it is unused. */
  async function discard(worktree: string): Promise<boolean> {
    if (!isFolder(worktree)) return false;
    try {
      const root = await realpath(worktree);
      const top = await value(root, ['rev-parse', '--show-toplevel']);
      if (!top || !samePath(await realpath(top), root)) return false;
      const info = await describe(root);
      if (!info || info.ahead > 0 || info.dirty || info.operation) return false;
      return (await remove(root, false)).state === 'complete';
    } catch {
      return false;
    }
  }

  return { inspect, describe, create, merge, remove, discard };
}

export type TeamWorktreeService = ReturnType<typeof createTeamWorktreeService>;
