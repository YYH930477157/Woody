import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
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
});
