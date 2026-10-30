import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitStorageService } from '@process/services/sourceControl/workbench/storage';
import { fixture, git, scope } from './fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
async function setup(repository = true) {
  const f = await fixture(repository);
  cleanup.push(f.cleanup);
  return f;
}

describe('durable project storage', () => {
  it('shelves only selected binary and untracked files, rolls back without changing the index, and reapplies after restart', async () => {
    const f = await setup();
    await writeFile(path.join(f.root, 'one.txt'), 'staged\n');
    await git(f.root, ['add', 'one.txt']);
    await writeFile(path.join(f.root, 'one.txt'), 'working\n');
    await writeFile(path.join(f.root, 'other.txt'), 'untouched edit\n');
    const binary = Buffer.from([0, 1, 255, 42]);
    await writeFile(path.join(f.root, '新增 文件.bin'), binary);
    const index = await readFile(path.join(f.root, '.git/index'));
    const shelf = await f.service.shelfCreate(scope, {
      name: 'work',
      paths: ['one.txt', '新增 文件.bin'],
      rollback: true,
    });
    expect(await readFile(path.join(f.root, '.git/index'))).toEqual(index);
    expect(await readFile(path.join(f.root, 'other.txt'), 'utf8')).toBe('untouched edit\n');
    const restarted = createGitStorageService(f.options);
    cleanup.push(() => restarted.dispose());
    await restarted.shelfApply(scope, { id: shelf.id });
    expect(await readFile(path.join(f.root, '新增 文件.bin'))).toEqual(binary);
  });

  it('keeps a conflicted shelf and all working files intact even when removeApplied was requested', async () => {
    const f = await setup();
    await writeFile(path.join(f.root, 'one.txt'), 'shelf\n');
    const item = await f.service.shelfCreate(scope, { name: 'conflict', paths: ['one.txt'], rollback: true });
    await writeFile(path.join(f.root, 'one.txt'), 'new user edit\n');
    const result = await f.service.shelfApply(scope, { id: item.id, removeApplied: true });
    expect(result).toMatchObject({ applied: false, conflicts: true });
    expect((await f.service.shelfList(scope))[0].deleted).toBe(false);
    expect(await readFile(path.join(f.root, 'one.txt'), 'utf8')).toBe('new user edit\n');
  });

  it('rejects metadata paths, traversal and forged scopes before creating a shelf', async () => {
    const f = await setup();
    for (const p of ['../outside', '.git/config', 'folder/../../outside']) {
      await expect(f.service.shelfCreate(scope, { name: 'bad', paths: [p] })).rejects.toThrow();
    }
    await expect(f.service.shelfList({ ...scope, projectId: 'forged' })).rejects.toThrow('Unknown project');
  });

  it('persists untracked assignments across active-list changes and restart without storing checked files', async () => {
    const f = await setup(false);
    await f.service.changelistSync(scope, [{ key: 'untracked-a', path: 'a' }]);
    const next = await f.service.changelistMutate(scope, { kind: 'create', name: 'Next', makeActive: true });
    const restarted = createGitStorageService(f.options);
    cleanup.push(() => restarted.dispose());
    const state = await restarted.changelistSync(scope, [
      { key: 'untracked-a', path: 'a' },
      { key: 'untracked-b', path: 'b' },
    ]);
    expect(state.assignments).toEqual({ 'untracked-a': 'default', 'untracked-b': next.activeId });
    expect(state).not.toHaveProperty('included');
    await expect(
      restarted.changelistMutate(scope, { kind: 'move', id: 'missing', keys: ['untracked-a'] })
    ).rejects.toThrow();
  });

  it('records non-Git files and saves recoverable before-state before restoring an event after-state', async () => {
    const f = await setup(false);
    await writeFile(path.join(f.root, 'draft.txt'), 'first');
    const [event] = await f.service.historyCapture(scope, { paths: ['draft.txt'] });
    await writeFile(path.join(f.root, 'draft.txt'), 'second');
    const preview = await f.service.historyCompare(scope, { id: event.id, path: 'draft.txt' });
    const result = await f.service.historyRestore(scope, {
      id: event.id,
      expected: { 'draft.txt': preview.current.fingerprint },
    });
    const recovery = await f.service.historyRead(scope, { id: result.recoveryId, path: 'draft.txt' });
    expect(Buffer.from(recovery.contentBase64!, 'base64').toString()).toBe('second');
    expect(await readFile(path.join(f.root, 'draft.txt'), 'utf8')).toBe('first');
  });

  it('rejects stale history previews and treats only ENOENT as deletion', async () => {
    const f = await setup(false);
    await writeFile(path.join(f.root, 'draft.txt'), 'first');
    const [event] = await f.service.historyCapture(scope, { paths: ['draft.txt'] });
    const preview = await f.service.historyCompare(scope, { id: event.id, path: 'draft.txt' });
    await writeFile(path.join(f.root, 'draft.txt'), 'newer');
    await expect(
      f.service.historyRestore(scope, { id: event.id, expected: { 'draft.txt': preview.current.fingerprint } })
    ).rejects.toThrow(/changed|stale/i);
    await unlink(path.join(f.root, 'draft.txt'));
    const [deleted] = await f.service.historyCapture(scope, { paths: ['draft.txt'] });
    expect(deleted.files[0].after).toBeNull();
  });
});
