import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageContext } from '@process/services/sourceControl/workbench/storage/core';
import { createGitStorageService } from '@process/services/sourceControl/workbench/storage';
import { fixture, git, scope } from './fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const setup = async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  return f;
};
const files = (...keys: string[]) => keys.map((key) => ({ key, path: key }));

describe('changelists', () => {
  it('starts with one active list', async () => {
    const f = await setup();

    const state = await f.service.changelistRead(scope);

    expect(state.lists.map((list) => list.id)).toEqual(['default']);
    expect(state.activeId).toBe('default');
  });

  it('files new changes under the active list', async () => {
    const f = await setup();
    const { activeId } = await f.service.changelistMutate(scope, { kind: 'create', name: 'Later', makeActive: true });

    const state = await f.service.changelistSync(scope, files('a'));

    expect(state.assignments).toEqual({ a: activeId });
  });

  it('keeps a file in its list when other files change', async () => {
    const f = await setup();
    await f.service.changelistSync(scope, files('a'));
    const created = await f.service.changelistMutate(scope, { kind: 'create', name: 'Later' });
    const later = created.lists.at(-1)!.id;
    await f.service.changelistMutate(scope, { kind: 'move', id: later, keys: ['a'] });

    const state = await f.service.changelistSync(scope, files('a', 'b'));

    expect(state.assignments).toEqual({ a: later, b: 'default' });
  });

  it('forgets a file once it is no longer changed', async () => {
    const f = await setup();
    await f.service.changelistSync(scope, files('a', 'b'));

    const state = await f.service.changelistSync(scope, files('b'));

    expect(state.assignments).toEqual({ b: 'default' });
  });

  it('trims a list name', async () => {
    const f = await setup();

    const state = await f.service.changelistMutate(scope, { kind: 'create', name: '  Later  ' });

    expect(state.lists.at(-1)?.name).toBe('Later');
  });

  it('refuses a blank list name', async () => {
    const f = await setup();

    await expect(f.service.changelistMutate(scope, { kind: 'create', name: '   ' })).rejects.toThrow();
    expect((await f.service.changelistRead(scope)).lists).toHaveLength(1);
  });

  it('renames a list without moving its files', async () => {
    const f = await setup();
    await f.service.changelistSync(scope, files('a'));

    const state = await f.service.changelistMutate(scope, { kind: 'edit', id: 'default', name: 'Renamed' });

    expect(state.lists[0].name).toBe('Renamed');
    expect(state.assignments).toEqual({ a: 'default' });
  });

  it('moves the files of a removed list to the active list', async () => {
    const f = await setup();
    await f.service.changelistSync(scope, files('a'));
    const created = await f.service.changelistMutate(scope, { kind: 'create', name: 'Later' });
    const later = created.lists.at(-1)!.id;
    await f.service.changelistMutate(scope, { kind: 'move', id: later, keys: ['a'] });

    const state = await f.service.changelistMutate(scope, { kind: 'remove', id: later });

    expect(state.assignments).toEqual({ a: 'default' });
    expect(state.lists.map((list) => list.id)).toEqual(['default']);
  });

  it('activates another list when the active one is removed', async () => {
    const f = await setup();
    const { activeId } = await f.service.changelistMutate(scope, { kind: 'create', name: 'Later', makeActive: true });

    const state = await f.service.changelistMutate(scope, { kind: 'remove', id: activeId });

    expect(state.activeId).toBe('default');
  });

  it('refuses to remove the last list', async () => {
    const f = await setup();

    await expect(f.service.changelistMutate(scope, { kind: 'remove', id: 'default' })).rejects.toThrow(/final/);
  });

  it('refuses to move a file it has not seen', async () => {
    const f = await setup();

    await expect(f.service.changelistMutate(scope, { kind: 'move', id: 'default', keys: ['ghost'] })).rejects.toThrow(
      /refresh/
    );
  });

  it('refuses a list that does not exist', async () => {
    const f = await setup();

    await expect(f.service.changelistMutate(scope, { kind: 'activate', id: 'missing' })).rejects.toThrow(/Unknown/);
  });

  it('refuses the same file twice in one sync', async () => {
    const f = await setup();

    await expect(f.service.changelistSync(scope, files('a', 'a'))).rejects.toThrow(/Duplicate/);
  });

  it('keeps lists and assignments across a restart', async () => {
    const f = await setup();
    await f.service.changelistSync(scope, files('a'));
    await f.service.changelistMutate(scope, { kind: 'create', name: 'Later' });
    const restarted = createGitStorageService(f.options);
    cleanup.push(() => restarted.dispose());

    const state = await restarted.changelistRead(scope);

    expect(state.lists.map((list) => list.name)).toEqual(['Changes', 'Later']);
    expect(state.assignments).toEqual({ a: 'default' });
  });

  it.each([
    ['broken JSON', '{broken'],
    ['the wrong shape', '{"lists":[]}'],
    ['an active list that does not exist', '{"lists":[{"id":"a","name":"A"}],"activeId":"b","assignments":{}}'],
  ])('starts over from a store holding %s, and keeps the damaged copy', async (_name, content) => {
    const f = await setup();
    const { dir } = await createStorageContext({ ...f.options, git }).resolve(scope);
    await writeFile(path.join(dir, 'changelists.json'), content);

    const state = await f.service.changelistSync(scope, files('a'));

    expect(state.assignments).toEqual({ a: 'default' });
    expect((await readdir(dir)).some((name) => name.startsWith('changelists.damaged-'))).toBe(true);
  });
});
