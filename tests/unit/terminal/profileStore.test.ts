import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalProfileStore } from '@/process/services/terminal/profileStore';

const directories: string[] = [];
const setup = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'woody-terminal-profiles-'));
  directories.push(dir);
  const file = path.join(dir, 'profiles.json');
  return { file, store: new TerminalProfileStore(file) };
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('TerminalProfileStore', () => {
  it('loads no connections at startup and saves additive versioned profiles', async () => {
    const { file, store } = await setup();
    expect(await store.list()).toEqual([]);
    await store.upsert({ id: 'one', name: 'One', kind: 'shell', args: ['-NoLogo'] });
    await store.upsert({ id: 'two', name: 'Two', kind: 'shell' });
    const disk = JSON.parse(await readFile(file, 'utf8'));
    expect([disk.version, disk.profiles.length, disk.grants]).toEqual([1, 2, undefined]);
    expect((await new TerminalProfileStore(file).list()).map((profile) => profile.id)).toEqual(['one', 'two']);
  });

  it('serializes concurrent modifications and preserves unrelated JSON fields', async () => {
    const { file, store } = await setup();
    await writeFile(file, JSON.stringify({ version: 1, profiles: [], custom: { keep: true } }));
    await Promise.all([
      store.upsert({ id: 'one', name: 'One', kind: 'shell' }),
      store.upsert({ id: 'two', name: 'Two', kind: 'shell' }),
    ]);
    await store.remove('one');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      custom: { keep: true },
      profiles: [{ id: 'two' }],
    });
  });

  it('rejects malformed configurations without overwriting the last good file', async () => {
    const { file, store } = await setup();
    await store.upsert({ id: 'one', name: 'One', kind: 'shell' });
    const before = await readFile(file, 'utf8');
    await expect(store.upsert({ id: 'bad', name: 'Bad', kind: 'serial' } as never)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
    await writeFile(file, '{"version":99,"profiles":[]}');
    await expect(store.list()).rejects.toThrow();
  });
});
