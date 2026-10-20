import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitCommandService } from '@/process/services/sourceControl/gitCommandService';
import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';
import { createStaticScanService } from '@/process/services/sourceControl/staticScanService';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
};

const makeRepo = async (initialCommit = true): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'woody-git-workflow-'));
  tempDirs.push(dir);
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.name', 'Woody Test']);
  await runGit(dir, ['config', 'user.email', 'woody@example.test']);
  await writeFile(join(dir, 'a.c'), 'int main(void) { return 0; }\n', 'utf8');
  if (initialCommit) {
    await runGit(dir, ['add', 'a.c']);
    await runGit(dir, ['commit', '-m', 'initial']);
  }
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('git command service', () => {
  it('reports current branch and selected working-tree changes', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 1; }\n', 'utf8');
    const service = createGitCommandService();

    const status = await service.getStatus(repoPath);

    expect(status.branch).toBe('main');
    expect(status.changedPaths).toEqual(['a.c']);
  });

  it('reports a staged rename by its destination without inventing a path from its source', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'module.c'), 'int value;\n', 'utf8');
    await runGit(repoPath, ['add', 'module.c']);
    await runGit(repoPath, ['commit', '-m', 'add module']);
    await runGit(repoPath, ['mv', 'module.c', 'renamed.c']);
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 3; }\n', 'utf8');

    const status = await createGitCommandService().getStatus(repoPath);

    expect(status.changedPaths).toEqual(['a.c', 'renamed.c']);
  });

  it('commits selected paths through a temporary index and preserves the real index', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 1; }\n', 'utf8');
    const service = createGitCommandService();

    const result = await service.createCommit(repoPath, ['a.c'], 'selected commit');

    expect(result.ok).toBe(true);
    expect(await runGit(repoPath, ['log', '-1', '--pretty=%s'])).toBe('selected commit');
    expect(await runGit(repoPath, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('blocks branch checkout while the worktree is dirty', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 2; }\n', 'utf8');
    const service = createGitCommandService();

    const result = await service.checkoutBranch(repoPath, 'main');

    expect(result).toEqual({ ok: false, kind: 'dirty-worktree' });
  });

  it('returns a retryable push failure without hiding command output', async () => {
    const repoPath = await makeRepo();
    const service = createGitCommandService();

    const result = await service.push(repoPath, 'main');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0);
    }
  });

  it('publishes a branch without upstream to origin and tracks it for later pushes', async () => {
    const repoPath = await makeRepo();
    const remotePath = await mkdtemp(join(tmpdir(), 'woody-git-remote-'));
    tempDirs.push(remotePath);
    await runGit(remotePath, ['init', '--bare']);
    await runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
    const service = createGitCommandService();

    const first = await service.push(repoPath, 'main');
    await runGit(repoPath, ['commit', '--allow-empty', '-m', 'second']);
    const second = await service.push(repoPath, 'main');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'main@{upstream}'])).toBe('origin/main');
    expect(await runGit(remotePath, ['rev-parse', 'refs/heads/main'])).toBe(
      await runGit(repoPath, ['rev-parse', 'HEAD'])
    );
  });

  it('does not push another branch when the worktree switched away from the workflow branch', async () => {
    const repoPath = await makeRepo();
    const remotePath = await mkdtemp(join(tmpdir(), 'woody-git-remote-'));
    tempDirs.push(remotePath);
    await runGit(remotePath, ['init', '--bare']);
    await runGit(repoPath, ['remote', 'add', 'origin', remotePath]);
    await runGit(repoPath, ['checkout', '-b', 'other']);

    const result = await createGitCommandService().push(repoPath, 'main');

    expect(result).toMatchObject({ ok: false, retryable: true });
    if (!result.ok) expect(result.stderr).toContain('"main"');
    await expect(runGit(remotePath, ['rev-parse', '--verify', '--quiet', 'refs/heads/other'])).rejects.toThrow();
  });

  it('treats a selected filename literally and preserves a similarly named staged file', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a[1].c'), 'initial selected\n');
    await writeFile(join(repoPath, 'a1.c'), 'initial neighbor\n');
    await runGit(repoPath, ['add', '.']);
    await runGit(repoPath, ['commit', '-m', 'fixtures']);
    await writeFile(join(repoPath, 'a[1].c'), 'selected change\n');
    await writeFile(join(repoPath, 'a1.c'), 'unselected staged change\n');
    await runGit(repoPath, ['add', 'a1.c']);

    const result = await createGitCommandService().createCommit(repoPath, ['a[1].c'], 'literal selection');

    expect(result.ok).toBe(true);
    expect(await runGit(repoPath, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a[1].c');
    expect(await runGit(repoPath, ['diff', '--cached', '--name-only'])).toBe('a1.c');
  });

  it('creates the first commit from selected files without including other untracked files', async () => {
    const repoPath = await makeRepo(false);
    await writeFile(join(repoPath, 'unselected.c'), 'leave untracked\n');
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(repoPath, ['a.c']);
    expect(snapshot.head).toBeNull();

    const result = await service.createCommit(repoPath, ['a.c'], 'first selected commit', snapshot);

    expect(result.ok).toBe(true);
    expect(await runGit(repoPath, ['ls-tree', '--name-only', 'HEAD'])).toBe('a.c');
  });

  it('blocks the workflow when the configured scanner executable does not exist', async () => {
    const repoPath = await makeRepo();
    const git = createGitCommandService();
    const push = vi.fn();
    const workflow = createCommitWorkflowService({ ...git, push });
    const messageFields = { reason: 'fix', scope: 'a.c', solution: 'update', impact: 'local', tests: 'unit' };
    const session = await workflow.prepare({
      repoPath,
      branch: 'main',
      selectedPaths: ['a.c'],
      scannerConfigs: [
        { tool: 'clang-tidy', executablePath: '__woody_missing_scanner__', scope: 'selected', arguments: [] },
      ],
      generateMessage: async () => messageFields,
      scan: createStaticScanService().scan,
    });
    expect(session).toMatchObject({ state: 'failed', reasonCode: 'scanFailed' });
    await workflow.commitAndPush(session.id, messageFields);
    expect(push).not.toHaveBeenCalled();
    expect(await runGit(repoPath, ['log', '-1', '--pretty=%s'])).toBe('initial');
  });

  it('commits in the selected worktree without changing its primary branch', async () => {
    const repoPath = await makeRepo();
    const primaryHead = await runGit(repoPath, ['rev-parse', 'HEAD']);
    const worktreePath = join(repoPath, 'feature');
    await runGit(repoPath, ['worktree', 'add', '-b', 'feature', worktreePath]);
    await writeFile(join(worktreePath, 'a.c'), 'worktree contents\n');
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(worktreePath, ['a.c']);

    const result = await service.createCommit(worktreePath, ['a.c'], 'worktree change', snapshot);

    expect(result.ok).toBe(true);
    expect(await runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(primaryHead);
    expect(await runGit(worktreePath, ['show', 'HEAD:a.c'])).toBe('worktree contents');
  });

  it('rejects a file changed after a successful scan without committing or pushing', async () => {
    const repoPath = await makeRepo();
    const originalHead = await runGit(repoPath, ['rev-parse', 'HEAD']);
    await writeFile(join(repoPath, 'a.c'), 'scanned contents\n');
    const push = vi.fn();
    const git = createGitCommandService();
    const workflow = createCommitWorkflowService({ ...git, push });
    const messageFields = { reason: 'fix', scope: 'a.c', solution: 'update', impact: 'local', tests: 'unit' };
    const session = await workflow.prepare({
      repoPath,
      branch: 'main',
      selectedPaths: ['a.c'],
      scannerConfigs: [{ tool: 'clang-tidy', executablePath: 'clang-tidy', scope: 'selected', arguments: [] }],
      generateMessage: async () => messageFields,
      scan: async () => ({ tool: 'clang-tidy', diagnostics: [], exitCode: 0, stdout: '', stderr: '' }),
    });
    await writeFile(join(repoPath, 'a.c'), 'unscanned contents\n');
    const result = await workflow.commitAndPush(session.id, messageFields);

    expect(result).toMatchObject({ state: 'blocked', reasonCode: 'snapshotChanged' });
    expect(await runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(originalHead);
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['head', 'branch'])('rejects a changed %s before committing a prepared selection', async (change) => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a.c'), 'scanned contents\n');
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(repoPath, ['a.c']);
    if (change === 'head') await runGit(repoPath, ['commit', '--allow-empty', '-m', 'external commit']);
    else await runGit(repoPath, ['checkout', '-b', 'other']);
    const headBeforeCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);

    const result = await service.createCommit(repoPath, ['a.c'], 'must not commit', snapshot);

    expect(result).toMatchObject({ ok: false, kind: 'snapshot-changed' });
    expect(await runGit(repoPath, ['rev-parse', 'HEAD'])).toBe(headBeforeCommit);
    expect(await runGit(repoPath, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('commits the verified index contents even when the working file changes after staging', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'a.c'), 'scanned contents\n');
    const snapshot = await createGitCommandService().getCommitSnapshot(repoPath, ['a.c']);
    const service = createGitCommandService(async (args, options) => {
      const result = await execFileAsync('git', ['--literal-pathspecs', ...args], {
        ...options,
        encoding: 'utf8',
      }).then(
        ({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => ({ ...error, exitCode: error.code })
      );
      if (args[0] === 'write-tree') await writeFile(join(repoPath, 'a.c'), 'edited after staging\n');
      return result;
    });

    const result = await service.createCommit(repoPath, ['a.c'], 'verified contents', snapshot);

    expect(result.ok).toBe(true);
    expect(await runGit(repoPath, ['show', 'HEAD:a.c'])).toBe('scanned contents');
    expect(await readFile(join(repoPath, 'a.c'), 'utf8')).toBe('edited after staging\n');
  });
});
