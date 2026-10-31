/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Usage scenarios for the source-control features, driven through the same services the desktop wires to IPC
 * against real Git repositories. Each case is a user-visible situation rather than a unit of code.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';
import { createGitCommandService } from '@/process/services/sourceControl/gitCommandService';
import { createProjectBuildService } from '@/process/services/sourceControl/projectBuildService';
import { createGitExecutor } from '@/process/services/sourceControl/workbench/executor';
import { createGitOperationService } from '@/process/services/sourceControl/workbench/operations';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
};

const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'woody-scenario-'));
  tempDirs.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Woody Scenario']);
  await git(dir, ['config', 'user.email', 'scenario@example.test']);
  await writeFile(join(dir, 'a.c'), 'int main(void) { return 0; }\n', 'utf8');
  await git(dir, ['add', 'a.c']);
  await git(dir, ['commit', '-m', 'initial commit']);
  return dir;
};

const makeRemote = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'woody-scenario-remote-'));
  tempDirs.push(dir);
  await git(dir, ['init', '--bare']);
  return dir;
};

const messageFields = {
  reason: 'update the counter',
  scope: 'a.c',
  solution: 'return 1',
  impact: 'none',
  tests: 'not run',
};

const shellExecutable = (): string =>
  process.platform === 'win32' ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('source control user scenarios', () => {
  it('commits the selected file and pushes it to the remote', async () => {
    const repoPath = await makeRepo();
    const remotePath = await makeRemote();
    await git(repoPath, ['remote', 'add', 'origin', remotePath]);
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 1; }\n', 'utf8');
    const workflow = createCommitWorkflowService(createGitCommandService());

    const session = await workflow.prepare({
      repoPath,
      branch: 'main',
      selectedPaths: ['a.c'],
      scannerConfigs: [],
      checks: { scanners: [], compile: false, autoRepair: false },
      messageFields,
      scan: vi.fn(),
    });
    expect(session.state).toBe('confirmation');

    const committed = await workflow.commitAndPush(session.id, messageFields);
    expect(committed.state).toBe('completed');
    expect(await git(remotePath, ['rev-parse', 'refs/heads/main'])).toBe(await git(repoPath, ['rev-parse', 'HEAD']));
  });

  it('switches branches while the repository holds untracked files', async () => {
    const repoPath = await makeRepo();
    await writeFile(join(repoPath, 'scratch.log'), 'generated\n', 'utf8');
    await git(repoPath, ['checkout', '-b', 'feature']);
    const service = createGitCommandService();

    expect(await service.checkoutBranch(repoPath, 'main')).toEqual({ ok: true });
    expect((await service.getStatus(repoPath)).branch).toBe('main');
  });

  it('refuses to build when the committed config names a shell as the build tool', async () => {
    const repoPath = await makeRepo();
    const marker = join(repoPath, 'pwned.txt');
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 2; }\n', 'utf8');
    await mkdir(join(repoPath, '.woody'), { recursive: true });
    await writeFile(
      join(repoPath, '.woody', 'static-scan.json'),
      JSON.stringify({ build: { executable: shellExecutable(), arguments: ['/c', `echo pwned > "${marker}"`] } })
    );
    const workflow = createCommitWorkflowService(createGitCommandService());

    const session = await workflow.prepare({
      repoPath,
      branch: 'main',
      selectedPaths: ['a.c'],
      scannerConfigs: [],
      checks: { scanners: [], compile: true, autoRepair: false },
      messageFields,
      scan: vi.fn(),
      compile: createProjectBuildService().compile,
    });

    expect(session.state).toBe('blocked');
    expect(session.reasonCode).toBe('buildFailed');
    expect(session.reason).toMatch(/shell or script host|absolute path/);
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to build with an executable that ships inside the repository', async () => {
    const repoPath = await makeRepo();
    // A cloned repository can carry its own binary; the config must not be able to point at it.
    const bundled = join(repoPath, 'tools', 'builder.exe');
    await mkdir(join(repoPath, 'tools'), { recursive: true });
    await writeFile(bundled, 'not a real executable\n', 'utf8');
    await writeFile(join(repoPath, 'a.c'), 'int main(void) { return 3; }\n', 'utf8');
    await mkdir(join(repoPath, '.woody'), { recursive: true });
    await writeFile(
      join(repoPath, '.woody', 'static-scan.json'),
      JSON.stringify({ build: { executable: bundled, arguments: [] } })
    );
    const workflow = createCommitWorkflowService(createGitCommandService());

    const session = await workflow.prepare({
      repoPath,
      branch: 'main',
      selectedPaths: ['a.c'],
      scannerConfigs: [],
      checks: { scanners: [], compile: true, autoRepair: false },
      messageFields,
      scan: vi.fn(),
      compile: createProjectBuildService().compile,
    });

    expect(session.state).toBe('blocked');
    expect(session.reasonCode).toBe('buildFailed');
    expect(session.reason).toContain('outside the repository');
  });

  it('rewrites a commit after the previous run died holding the Git locks', async () => {
    const repoPath = await makeRepo();
    // Rewriting the root commit is refused by design, so reword the second commit.
    await writeFile(join(repoPath, 'b.c'), 'int b(void) { return 1; }\n', 'utf8');
    await git(repoPath, ['add', 'b.c']);
    await git(repoPath, ['commit', '-m', 'second commit']);
    const head = await git(repoPath, ['rev-parse', 'HEAD']);
    const storeDir = await mkdtemp(join(tmpdir(), 'woody-scenario-recovery-'));
    tempDirs.push(storeDir);
    // What a hard kill leaves behind: our own locks, marked with a pid that no longer exists.
    await writeFile(join(repoPath, '.git', 'HEAD.lock'), 'woody-history-lock:2147483647:2026-01-01T00:00:00.000Z\n');
    await writeFile(join(repoPath, '.git', 'index.lock'), 'woody-history-lock:2147483647:2026-01-01T00:00:00.000Z\n');

    const operations = createGitOperationService({
      resolveRoot: async () => realpath(repoPath),
      git: createGitExecutor('git', false),
      storeDir,
      run: (_root, operation) => operation(),
    });

    const outcome = await operations.operate(
      { projectId: 'project-1', peId: 'pe-1', relativePath: '' },
      {
        kind: 'history.reword',
        commit: head,
        message: 'rewritten subject',
        expectedHead: head,
        expectedBranch: 'main',
        confirmed: true,
      }
    );

    expect(outcome.state).toBe('complete');
    expect(await git(repoPath, ['log', '-1', '--format=%s'])).toBe('rewritten subject');
    expect(existsSync(join(repoPath, '.git', 'HEAD.lock'))).toBe(false);
    expect(existsSync(join(repoPath, '.git', 'index.lock'))).toBe(false);
  });
});
