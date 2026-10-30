import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import type { GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
let head: string;
let target: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const operate = (request: GitOperationRequest) =>
  createGitOperationService({ resolveRoot: async () => root }).operate(scope, request);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-history-op-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'file'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  head = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  await writeFile(path.join(root, 'feature'), 'feature\n');
  git('add', '.');
  git('commit', '-qm', 'Original incoming subject\n\nOriginal body');
  target = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
describe('reviewed history operations', () => {
  it('revalidates HEAD and branch immediately after start preflight', async () => {
    const realGit = createGitExecutor('git', false);
    let changed = false;
    const service = createGitOperationService({
      resolveRoot: async () => root,
      git: async (cwd, args, allowed, options) => {
        const result = await realGit(cwd, args, allowed, options);
        if (!changed && args[0] === 'status') {
          changed = true;
          git('checkout', '-qb', 'unexpected');
        }
        return result;
      },
    });
    expect(
      (
        await service.operate(scope, {
          kind: 'merge',
          target,
          expectedHead: head,
          expectedBranch: 'main',
          confirmed: true,
        })
      ).state
    ).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it('cherry-picks the selected immutable commit preserving its original message', async () => {
    const outcome = await operate({
      kind: 'cherry-pick',
      target,
      expectedHead: head,
      expectedBranch: 'main',
      confirmed: true,
    });
    expect(outcome.state).toBe('complete');
    expect(git('show', '-s', '--format=%B', 'HEAD')).toBe('Original incoming subject\n\nOriginal body');
  });
  it('requires confirmation, exact branch identity and a clean worktree', async () => {
    const request = { kind: 'merge', target, expectedHead: head, expectedBranch: 'main', confirmed: true } as const;
    expect((await operate({ ...request, expectedBranch: 'feature' })).state).toBe('blocked');
    await writeFile(path.join(root, 'untracked'), 'preserve');
    expect((await operate(request)).state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it('fast-forwards a clean merge and reverts using Git original message semantics', async () => {
    expect(
      (await operate({ kind: 'merge', target, expectedHead: head, expectedBranch: 'main', confirmed: true })).state
    ).toBe('complete');
    expect(
      (await operate({ kind: 'revert', target, expectedHead: target, expectedBranch: 'main', confirmed: true })).state
    ).toBe('complete');
    expect(git('show', '-s', '--format=%B', 'HEAD')).toContain('Revert "Original incoming subject"');
  });
  it('rebases a branch onto an immutable target', async () => {
    await writeFile(path.join(root, 'local'), 'local\n');
    git('add', '.');
    git('commit', '-qm', 'local original');
    head = git('rev-parse', 'HEAD');
    expect(
      (await operate({ kind: 'rebase', target, expectedHead: head, expectedBranch: 'main', confirmed: true })).state
    ).toBe('complete');
    expect(git('rev-parse', 'HEAD^')).toBe(target);
    expect(await readFile(path.join(root, 'local'), 'utf8')).toBe('local\n');
  });
  it('blocks mismatched continue/abort and allows abort only for the current operation', async () => {
    git('checkout', '-q', 'feature');
    await writeFile(path.join(root, 'file'), 'incoming\n');
    git('commit', '-qam', 'incoming conflict');
    target = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    await writeFile(path.join(root, 'file'), 'current\n');
    git('commit', '-qam', 'current');
    head = git('rev-parse', 'HEAD');
    expect(
      (await operate({ kind: 'merge', target, expectedHead: head, expectedBranch: 'main', confirmed: true })).state
    ).toBe('conflict');
    const request = {
      kind: 'history.continue',
      operation: 'merge',
      expectedHead: head,
      expectedBranch: 'main',
      confirmed: true,
    } as const;
    expect((await operate(request)).state).toBe('blocked');
    expect((await operate({ ...request, kind: 'history.abort', operation: 'rebase' })).state).toBe('blocked');
    expect((await operate({ ...request, kind: 'history.abort' })).state).toBe('complete');
  });
  it('continues a resolved cherry-pick with its original message and no editor', async () => {
    git('checkout', '-q', 'feature');
    await writeFile(path.join(root, 'file'), 'incoming\n');
    git('commit', '-qam', 'Original conflict subject\n\nOriginal conflict body');
    target = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    await writeFile(path.join(root, 'file'), 'current\n');
    git('commit', '-qam', 'current');
    head = git('rev-parse', 'HEAD');
    expect(
      (await operate({ kind: 'cherry-pick', target, expectedHead: head, expectedBranch: 'main', confirmed: true }))
        .state
    ).toBe('conflict');
    await writeFile(path.join(root, 'file'), 'resolved\n');
    git('add', 'file');
    expect(
      (
        await operate({
          kind: 'history.continue',
          operation: 'cherry-pick',
          expectedHead: head,
          expectedBranch: 'main',
          confirmed: true,
        })
      ).state
    ).toBe('complete');
    expect(git('show', '-s', '--format=%B', 'HEAD')).toBe('Original conflict subject\n\nOriginal conflict body');
  });
  it('classifies a multi-revert sequencer by its actual instruction', async () => {
    await mkdir(path.join(root, '.git', 'sequencer'));
    await writeFile(path.join(root, '.git', 'sequencer', 'todo'), `revert ${head} base\n`);
    expect((await operate({ kind: 'inspect' })).data?.operation).toBe('revert');
    expect(
      (
        await operate({
          kind: 'history.abort',
          operation: 'cherry-pick',
          expectedHead: head,
          expectedBranch: 'main',
          confirmed: true,
        })
      ).state
    ).toBe('blocked');
  });
});
