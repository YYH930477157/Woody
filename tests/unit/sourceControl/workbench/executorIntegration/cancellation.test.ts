import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-cancel-'));
  git('init', '-q', '-b', 'main');
  git('init', '-q', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('Git operation cancellation', () => {
  it('aborts a real Git subprocess that is waiting for standard input', async () => {
    const controller = new AbortController();
    const pending = createGitExecutor()(root, ['hash-object', '--stdin'], false, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      clearTimeout(timer);
    }
  });
  it('cancels an active remote command and releases its repository lease', async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const realGit = createGitExecutor('git', false);
    const service = createGitOperationService({
      resolveRoot: async () => root,
      git: async (cwd, args, allowFailure, options) => {
        if (args[0] === 'fetch') {
          announce();
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          });
        }
        return realGit(cwd, args, allowFailure, options);
      },
    });
    const running = service.operate(scope, { kind: 'fetch', remote: 'origin' }, 'remote-1');
    await started;
    expect(await service.cancel(scope, 'remote-1')).toEqual({ cancelled: true });
    expect((await running).state).toBe('cancelled');
    expect((await service.operate(scope, { kind: 'inspect' })).state).toBe('complete');
  });
  it('does not begin a remote command canceled while queued, or cancel another root', async () => {
    git('init', '-q', path.join(root, 'other'));
    let announce!: () => void;
    const queued = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = vi.fn();
    const realGit = createGitExecutor('git', false);
    const service = createGitOperationService({
      resolveRoot: async (selected) => (selected.peId === 'other' ? path.join(root, 'other') : root),
      run: async (_root, operation) => {
        announce();
        await gate;
        return operation();
      },
      git: async (cwd, args, allowFailure, options) => {
        if (args[0] === 'fetch') remote();
        return realGit(cwd, args, allowFailure, options);
      },
    });
    const pending = service.operate(scope, { kind: 'fetch', remote: 'origin' }, 'remote-2');
    await queued;
    expect(await service.cancel({ ...scope, peId: 'other' }, 'remote-2')).toEqual({ cancelled: false });
    expect((await service.operate(scope, { kind: 'fetch', remote: 'origin' }, 'remote-2')).state).toBe('blocked');
    expect(await service.cancel(scope, 'missing')).toEqual({ cancelled: false });
    expect(await service.cancel(scope, 'remote-2')).toEqual({ cancelled: true });
    release();
    expect((await pending).state).toBe('cancelled');
    expect(remote).not.toHaveBeenCalled();
  });
});
