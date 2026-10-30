import type {
  GitBranch,
  GitCommitMode,
  GitBranchSnapshot,
  GitCommitResult,
  GitCommitSnapshot,
  GitOperationResult,
  GitPushResult,
  GitStatusSnapshot,
} from '@/common/types/sourceControl/gitWorkflowTypes';

import { createTemporaryGitIndex } from './gitIndexWorkspace';
import { isSameCommitSnapshot } from './gitWorkflowModel';
import { publishCheckedCommit } from './workbench/commit';
import { createGitExecutor } from './workbench/executor';
import {
  inspectCommitRepository,
  type GitRunnerOptions,
  type GitCommandOutput,
  type GitCommandRunner,
} from './workbench/commit/workspace';

const DEFAULT_GIT_RUNNER_TIMEOUT_MS = 5 * 60 * 1000;

export const createGitCommandRunner = (executable = 'git'): GitCommandRunner => {
  const execute = createGitExecutor(executable);
  return async (args, options) => {
    try {
      const result = await execute(options.cwd, args, true, {
        env: options.env,
        maxBuffer: 8 * 1024 * 1024,
        timeoutMs: options.timeoutMs ?? DEFAULT_GIT_RUNNER_TIMEOUT_MS,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    }
  };
};
const defaultRunner = createGitCommandRunner();

const parsePorcelainPaths = (output: string): string[] => {
  const paths = new Set<string>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const payload = record.slice(3);
    if (!payload) continue;
    paths.add(payload);
    // With -z, a rename or copy is followed by its source path as a separate, status-less record.
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return [...paths].toSorted();
};

const parseBranches = (output: string): GitBranch[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, upstream = '', head = ''] = line.split('|');
      return Object.assign({ name }, upstream ? { upstream } : {}, { current: head === `*` });
    });

/** Push failures stay retryable: the user can fix the branch or remote setup, then retry the same commit. */
const pushFailed = (stderr: string, stdout = ''): GitPushResult => ({ ok: false, retryable: true, stdout, stderr });

export type GitCommandService = {
  getStatus: (repoPath: string) => Promise<GitStatusSnapshot>;
  getBranches: (repoPath: string) => Promise<GitBranchSnapshot>;
  checkoutBranch: (repoPath: string, branch: string) => Promise<GitOperationResult>;
  /** Capture selected files without changing the user's index. */
  getCommitSnapshot: (repoPath: string, paths: string[]) => Promise<GitCommitSnapshot>;
  createCommit: (
    repoPath: string,
    paths: string[],
    message: string,
    expectedSnapshot?: GitCommitSnapshot,
    mode?: GitCommitMode
  ) => Promise<GitCommitResult>;
  push: (repoPath: string, branch: string) => Promise<GitPushResult>;
};

export const createGitCommandService = (runner: GitCommandRunner = defaultRunner): GitCommandService => {
  const requireSuccess = async (args: string[], options: GitRunnerOptions): Promise<string> => {
    const result = await runner(args, options);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Git command failed');
    return result.stdout.trim();
  };

  /** Current branch, or an empty name on a detached HEAD. `git branch --show-current` needs Git 2.22+. */
  const readBranch = async (repoPath: string): Promise<GitCommandOutput> => {
    const result = await runner(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoPath });
    // --short adds a heads/ prefix when a tag has the same name as the branch.
    if (result.exitCode === 0) return { ...result, stdout: result.stdout.replace(/^refs\/heads\//, '') };
    // Exit code 1 without a message is a detached HEAD, not a failure.
    return result.exitCode === 1 && !result.stderr ? { ...result, stdout: '', exitCode: 0 } : result;
  };

  const readHead = async (repoPath: string): Promise<Pick<GitCommitSnapshot, 'head' | 'branch'>> => {
    const branchResult = await readBranch(repoPath);
    if (branchResult.exitCode !== 0) throw new Error(branchResult.stderr || 'Unable to read Git branch');
    const branch = branchResult.stdout.trim();
    const revision = await runner(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoPath });
    if (revision.exitCode !== 0 && (revision.exitCode !== 1 || !branch || revision.stderr)) {
      throw new Error(revision.stderr || 'Unable to read Git HEAD');
    }
    return { branch, head: revision.exitCode === 0 ? revision.stdout.trim() : null };
  };

  const stageSelection = async (
    repoPath: string,
    paths: string[],
    env: NodeJS.ProcessEnv
  ): Promise<GitCommitSnapshot> => {
    const head = await readHead(repoPath);
    await requireSuccess(['read-tree', ...(head.head ? [head.head] : ['--empty'])], { cwd: repoPath, env });
    await requireSuccess(['add', '--', ...paths], { cwd: repoPath, env });
    const tree = await requireSuccess(['write-tree'], { cwd: repoPath, env });
    return { ...head, tree };
  };

  /** Prefer remote.pushDefault, then origin, then the only configured remote. */
  const resolvePushRemote = async (
    repoPath: string
  ): Promise<{ ok: true; name: string } | { ok: false; error: string }> => {
    const listed = await runner(['remote'], { cwd: repoPath });
    if (listed.exitCode !== 0) return { ok: false, error: listed.stderr || 'Unable to read Git remotes' };
    const remotes = listed.stdout
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    const pushDefault = (await runner(['config', '--get', 'remote.pushDefault'], { cwd: repoPath })).stdout.trim();
    const name = remotes.includes(pushDefault)
      ? pushDefault
      : remotes.includes('origin')
        ? 'origin'
        : remotes.length === 1
          ? remotes[0]
          : undefined;
    if (name) return { ok: true, name };
    return {
      ok: false,
      error: remotes.length
        ? 'Multiple Git remotes are configured; set an upstream for this branch before pushing'
        : 'No Git remote is configured for this repository',
    };
  };

  return {
    async getStatus(repoPath) {
      const [branchResult, statusResult] = await Promise.all([
        readBranch(repoPath),
        runner(['status', '--porcelain=v1', '-z'], { cwd: repoPath }),
      ]);
      if (branchResult.exitCode !== 0 || statusResult.exitCode !== 0) {
        throw new Error(branchResult.stderr || statusResult.stderr || 'Unable to read Git status');
      }
      return { branch: branchResult.stdout.trim(), changedPaths: parsePorcelainPaths(statusResult.stdout) };
    },

    async getBranches(repoPath) {
      const result = await runner(
        ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(HEAD)', 'refs/heads'],
        {
          cwd: repoPath,
        }
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to read Git branches');
      return { branches: parseBranches(result.stdout) };
    },

    async checkoutBranch(repoPath, branch) {
      const status = await this.getStatus(repoPath);
      if (status.changedPaths.length > 0) return { ok: false, kind: 'dirty-worktree' };
      const result = await runner(['checkout', branch], { cwd: repoPath });
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, kind: 'command-failed', stdout: result.stdout, stderr: result.stderr };
    },

    async getCommitSnapshot(repoPath, paths) {
      if (paths.length === 0) throw new Error('No files selected');
      const index = await createTemporaryGitIndex(repoPath);
      try {
        return await stageSelection(repoPath, paths, index.env);
      } finally {
        await index.cleanup();
      }
    },

    async createCommit(repoPath, paths, message, expectedSnapshot, mode) {
      if (paths.length === 0) return { ok: false, kind: 'command-failed', stdout: '', stderr: 'No files selected' };
      const repository = await inspectCommitRepository(runner, repoPath);
      const staged = await runner(['diff', '--cached', '--name-only', '--', ...paths], { cwd: repoPath });
      if (staged.exitCode !== 0) {
        return { ok: false, kind: 'command-failed', stdout: staged.stdout, stderr: staged.stderr };
      }
      if (staged.stdout.trim()) {
        return {
          ok: false,
          kind: 'staged-selection',
          stdout: staged.stdout,
          stderr: 'Selected files already contain staged changes',
        };
      }
      const index = await createTemporaryGitIndex(repoPath);
      try {
        // Commit the same staged tree that was scanned, even if working files change afterwards.
        const actualSnapshot = await stageSelection(repoPath, paths, index.env);
        const currentHead = await readHead(repoPath);
        if (
          !isSameCommitSnapshot(actualSnapshot, { ...actualSnapshot, ...currentHead }) ||
          (expectedSnapshot && !isSameCommitSnapshot(expectedSnapshot, actualSnapshot)) ||
          (mode &&
            (mode.kind !== 'amend' ||
              !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mode.expectedHead) ||
              actualSnapshot.head !== mode.expectedHead))
        ) {
          return {
            ok: false,
            kind: 'snapshot-changed',
            stdout: '',
            stderr: 'Files or Git HEAD changed after preparing the commit',
          };
        }
        return await publishCheckedCommit(
          runner,
          repoPath,
          paths,
          message,
          actualSnapshot,
          index.path,
          repository,
          mode
        );
      } catch (error) {
        return {
          ok: false,
          kind: 'command-failed',
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      } finally {
        // A successfully published commit must remain successful even if temporary-file cleanup fails.
        await index.cleanup().catch((): undefined => undefined);
      }
    },

    async push(repoPath, branch) {
      if (!branch) return pushFailed('Cannot push from a detached HEAD');
      const current = await readBranch(repoPath);
      if (current.exitCode !== 0) return pushFailed(current.stderr || 'Unable to read Git branch', current.stdout);
      if (current.stdout.trim() !== branch) {
        return pushFailed(
          `Current branch is "${current.stdout.trim()}"; switch back to "${branch}" to push this commit`
        );
      }
      const upstream = await runner(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
        cwd: repoPath,
      });
      let args = ['push'];
      if (upstream.exitCode !== 0) {
        // A new local branch has no upstream yet: publish it to the default remote and track it.
        const remote = await resolvePushRemote(repoPath);
        if (remote.ok === false) return pushFailed(remote.error);
        args = ['push', '--set-upstream', remote.name, `refs/heads/${branch}:refs/heads/${branch}`];
      }
      const result = await runner(args, { cwd: repoPath });
      return result.exitCode === 0
        ? { ok: true, stdout: result.stdout, stderr: result.stderr }
        : pushFailed(result.stderr || 'Git push failed', result.stdout);
    },
  };
};
