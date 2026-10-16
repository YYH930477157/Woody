import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  GitBranch,
  GitBranchSnapshot,
  GitCommitResult,
  GitCommitSnapshot,
  GitOperationResult,
  GitPushResult,
  GitStatusSnapshot,
} from '@/common/types/sourceControl/gitWorkflowTypes';

import { createTemporaryGitIndex } from './gitIndexWorkspace';
import { isSameCommitSnapshot } from './gitWorkflowModel';

const execFileAsync = promisify(execFile);

type GitRunnerOptions = { cwd: string; env?: NodeJS.ProcessEnv };
type GitCommandOutput = { stdout: string; stderr: string; exitCode: number };
type GitCommandRunner = (args: string[], options: GitRunnerOptions) => Promise<GitCommandOutput>;

const defaultRunner: GitCommandRunner = async (args, options) => {
  try {
    const result = await execFileAsync('git', ['--literal-pathspecs', ...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? String(error),
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
};

const parsePorcelainPaths = (output: string): string[] => {
  const paths = new Set<string>();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const payload = record.slice(3);
    if (!payload) continue;
    const renameSeparator = payload.indexOf(' -> ');
    paths.add(renameSeparator >= 0 ? payload.slice(renameSeparator + 4) : payload);
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
    expectedSnapshot?: GitCommitSnapshot
  ) => Promise<GitCommitResult>;
  push: (repoPath: string, branch: string) => Promise<GitPushResult>;
};

export const createGitCommandService = (runner: GitCommandRunner = defaultRunner): GitCommandService => {
  const requireSuccess = async (args: string[], options: GitRunnerOptions): Promise<string> => {
    const result = await runner(args, options);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'Git command failed');
    return result.stdout.trim();
  };

  const readHead = async (repoPath: string): Promise<Pick<GitCommitSnapshot, 'head' | 'branch'>> => {
    const branch = await requireSuccess(['branch', '--show-current'], { cwd: repoPath });
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

  return {
    async getStatus(repoPath) {
      const [branchResult, statusResult] = await Promise.all([
        runner(['branch', '--show-current'], { cwd: repoPath }),
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

    async createCommit(repoPath, paths, message, expectedSnapshot) {
      if (paths.length === 0) return { ok: false, kind: 'command-failed', stdout: '', stderr: 'No files selected' };
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
          (expectedSnapshot && !isSameCommitSnapshot(expectedSnapshot, actualSnapshot))
        ) {
          return {
            ok: false,
            kind: 'snapshot-changed',
            stdout: '',
            stderr: 'Files or Git HEAD changed after the static scan',
          };
        }
        const commit = await runner(['commit', '-m', message], { cwd: repoPath, env: index.env });
        if (commit.exitCode !== 0) {
          return { ok: false, kind: 'command-failed', stdout: commit.stdout, stderr: commit.stderr };
        }
        const revision = await runner(['rev-parse', 'HEAD'], { cwd: repoPath, env: index.env });
        if (revision.exitCode !== 0) {
          return { ok: false, kind: 'command-failed', stdout: revision.stdout, stderr: revision.stderr };
        }
        const refresh = await runner(['reset', 'HEAD', '--', ...paths], { cwd: repoPath });
        if (refresh.exitCode !== 0) {
          return { ok: false, kind: 'command-failed', stdout: refresh.stdout, stderr: refresh.stderr };
        }
        return { ok: true, commit: revision.stdout.trim() };
      } catch (error) {
        return {
          ok: false,
          kind: 'command-failed',
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await index.cleanup();
      }
    },

    async push(repoPath, _branch) {
      const result = await runner(['push'], { cwd: repoPath });
      return result.exitCode === 0
        ? { ok: true, stdout: result.stdout, stderr: result.stderr }
        : { ok: false, retryable: true, stdout: result.stdout, stderr: result.stderr };
    },
  };
};
