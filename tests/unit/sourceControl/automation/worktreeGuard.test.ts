import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { captureWorktree, changedWorktreePaths } from '@/process/services/sourceControl/worktreeGuard';

const exec = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aion-guard-'));
  await exec('git', ['init', '--initial-branch=main'], { cwd: root });
  await writeFile(join(root, 'selected.cpp'), 'original');
  await writeFile(join(root, 'other.cpp'), 'existing user changes');
  await exec('git', ['add', 'selected.cpp', 'other.cpp'], { cwd: root });
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe('actual repair file boundaries', () => {
  it('detects edits to unselected files even when they were already dirty', async () => {
    const before = await captureWorktree(root);
    await writeFile(join(root, 'other.cpp'), 'new agent changes');
    expect(changedWorktreePaths(before, await captureWorktree(root))).toEqual(['other.cpp']);
  });
  it('detects creations, deletions and selected file changes', async () => {
    const before = await captureWorktree(root);
    await unlink(join(root, 'other.cpp'));
    await writeFile(join(root, 'new.cpp'), 'new');
    await writeFile(join(root, 'selected.cpp'), 'fixed');
    expect(changedWorktreePaths(before, await captureWorktree(root)).toSorted()).toEqual([
      'new.cpp',
      'other.cpp',
      'selected.cpp',
    ]);
  });
  it('does not treat preexisting modifications as repair changes', async () => {
    const before = await captureWorktree(root);
    expect(changedWorktreePaths(before, await captureWorktree(root))).toEqual([]);
  });
  it('detects agent staging and branch changes', async () => {
    const before = await captureWorktree(root);
    await exec('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: root });
    expect(changedWorktreePaths(before, await captureWorktree(root))).toContain('\0git-state');
  });
  it.each([false, true])('detects submodule edits with a separate Git directory: %s', async (separate) => {
    const modulePath = join(root, 'lib');
    await mkdir(modulePath);
    const gitDirectory = join(root, '.git', 'modules', 'lib');
    if (separate) await mkdir(join(root, '.git', 'modules'));
    await exec('git', ['init', '--initial-branch=main', ...(separate ? [`--separate-git-dir=${gitDirectory}`] : [])], {
      cwd: modulePath,
    });
    await writeFile(join(modulePath, 'unselected.c'), 'original dependency');
    await exec('git', ['add', '.'], { cwd: modulePath });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'dependency'], {
      cwd: modulePath,
    });
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: modulePath });
    await exec('git', ['update-index', '--add', '--cacheinfo', `160000,${stdout.trim()},lib`], { cwd: root });
    const before = await captureWorktree(root);

    await writeFile(join(modulePath, 'unselected.c'), 'agent edit');
    await writeFile(join(modulePath, 'new.c'), 'unselected creation');

    expect(changedWorktreePaths(before, await captureWorktree(root)).toSorted()).toEqual([
      'lib/new.c',
      'lib/unselected.c',
    ]);
  });

  it('does not recurse into the parent repository for a deinitialized submodule', async () => {
    await mkdir(join(root, 'lib'));
    await exec('git', ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},lib`], { cwd: root });
    const before = await captureWorktree(root);
    expect(changedWorktreePaths(before, await captureWorktree(root))).toEqual([]);
    expect([...before.keys()].some((path) => path.startsWith('lib/'))).toBe(false);
  });
});
