import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageContext } from '@process/services/sourceControl/workbench/storage/core';
import {
  captureHistory,
  emptyStatus,
  type KnownFiles,
} from '@process/services/sourceControl/workbench/storage/history';
import { fixture, git, scope } from './fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const LONG_AGO = new Date('2020-01-01T00:00:00Z');

/** A project with `one.txt` old enough to trust, polled once so the recorder knows it. */
const polled = async () => {
  const f = await fixture();
  cleanup.push(f.cleanup);
  const contexts = createStorageContext({ ...f.options, git });
  const known: KnownFiles = new Map();
  const file = path.join(f.root, 'one.txt');
  await utimes(file, LONG_AGO, LONG_AGO);
  const poll = () =>
    contexts.run(scope, (context) =>
      captureHistory(context, { kind: 'external', paths: ['one.txt'] }, emptyStatus(), false, undefined, known)
    );
  await poll();
  return { f, file, poll };
};

describe('local history polling', () => {
  it('does not read a file again when its size and time are unchanged', async () => {
    const { file, poll } = await polled();
    // Same length and time, different bytes: only a re-read could notice this.
    await writeFile(file, 'BASE' + String.fromCharCode(10));
    await utimes(file, LONG_AGO, LONG_AGO);

    expect(await poll()).toEqual([]);
  });

  it('records a file whose size changed', async () => {
    const { file, poll } = await polled();
    await writeFile(file, 'a longer body');
    await utimes(file, LONG_AGO, LONG_AGO);

    expect((await poll())[0].files.map((entry) => entry.path)).toEqual(['one.txt']);
  });

  it('re-reads a recent write even when its stamp looks unchanged', async () => {
    const { file, poll } = await polled();
    await writeFile(file, 'edited');
    expect((await poll())[0].files.map((entry) => entry.path)).toEqual(['one.txt']);
  });

  it('leaves the history file alone when nothing changed', async () => {
    const { f, poll } = await polled();
    const { dir } = await createStorageContext({ ...f.options, git }).resolve(scope);
    const before = await stat(path.join(dir, 'history.json'));
    const content = await readFile(path.join(dir, 'history.json'), 'utf8');

    await poll();

    expect((await stat(path.join(dir, 'history.json'))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(dir, 'history.json'), 'utf8')).toBe(content);
  });
});
