import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';
import { inspectOperation } from '@process/services/sourceControl/workbench/operations/engine';
import { withIsolatedHistory } from '@process/services/sourceControl/workbench/operations/lockedHistory';

const run = promisify(execFile);
const git = createGitExecutor();
const roots: string[] = [];
const PENDING_JOURNAL = 'woody-history-pending.json';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 4 })));
});

const command = (root: string, ...args: string[]) => run('git', args, { cwd: root });
const head = async (root: string) => (await command(root, 'rev-parse', 'HEAD')).stdout.trim();
const commit = async (root: string, content: string, message: string) => {
  await writeFile(path.join(root, 'file.txt'), content);
  await command(root, 'add', '.');
  await command(root, 'commit', '-m', message);
};

/** Three commits, so a rebase stopped after the first one leaves different file contents behind. */
const repository = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'woody-history-rollback-'));
  roots.push(root);
  await command(root, 'init');
  await command(root, 'config', 'user.name', 'Rollback Test');
  await command(root, 'config', 'user.email', 'test@example.invalid');
  await command(root, 'config', 'core.autocrlf', 'false');
  await commit(root, 'one', 'first');
  await commit(root, 'two', 'second');
  await writeFile(path.join(root, 'added.txt'), 'added');
  await commit(root, 'three', 'third');
  return root;
};

const STOP_AFTER_FIRST_COMMIT = ['rebase', '--force-rebase', '--exec', 'exit 1', 'HEAD~2'];
const INTERRUPTED = 'Git command timed out';

describe('interrupted history rewrite', () => {
  it('restores the repository and leaves it usable', async () => {
    const root = await repository();
    const before = await head(root);

    await expect(
      withIsolatedHistory(
        root,
        git,
        async () => {},
        async (locked) => {
          await locked(root, STOP_AFTER_FIRST_COMMIT, true);
          expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('two');
          throw new Error(INTERRUPTED);
        }
      )
    ).rejects.toThrow(new RegExp(`^${INTERRUPTED}$`));

    expect(await head(root)).toBe(before);
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('three');
    expect(await readFile(path.join(root, 'added.txt'), 'utf8')).toBe('added');
    expect((await command(root, 'status', '--porcelain')).stdout).toBe('');
    await expect(access(path.join(root, '.git', PENDING_JOURNAL))).rejects.toThrow();
    await expect(inspectOperation(root, git)).resolves.toBeNull();
  });

  it('keeps the retained state when the repository was already mid-rebase', async () => {
    const root = await repository();
    await git(root, STOP_AFTER_FIRST_COMMIT, true);
    const paused = await readFile(path.join(root, 'file.txt'), 'utf8');

    await expect(
      withIsolatedHistory(
        root,
        git,
        async () => {},
        async () => {
          throw new Error(INTERRUPTED);
        }
      )
    ).rejects.toThrow(/publication is pending/);

    await expect(access(path.join(root, '.git', PENDING_JOURNAL))).resolves.toBeUndefined();
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe(paused);
  });
});
