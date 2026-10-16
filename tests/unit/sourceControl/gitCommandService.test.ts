import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { createGitCommandService } from '@/process/services/sourceControl/gitCommandService';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
};

const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'woody-git-workflow-'));
  tempDirs.push(dir);
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.name', 'Woody Test']);
  await runGit(dir, ['config', 'user.email', 'woody@example.test']);
  await writeFile(join(dir, 'a.c'), 'int main(void) { return 0; }\n', 'utf8');
  await runGit(dir, ['add', 'a.c']);
  await runGit(dir, ['commit', '-m', 'initial']);
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
});
