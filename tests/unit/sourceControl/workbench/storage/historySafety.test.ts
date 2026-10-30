import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGitStorageService } from '@process/services/sourceControl/workbench/storage';
import { fixture, scope } from './fixtures';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await fixture(false);
  cleanups.push(f.cleanup);
  return f;
}

describe('local history failure and lifecycle boundaries', { timeout: 30_000 }, () => {
  it('labels retain readable unchanged file content as an after-state snapshot', async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, 'draft'), 'baseline');
    await f.service.historyCapture(scope);
    const label = await f.service.historyLabel(scope, 'Before refactor');
    const saved = await f.service.historyRead(scope, { id: label.id, path: 'draft' });
    expect(Buffer.from(saved.contentBase64!, 'base64').toString()).toBe('baseline');
  });

  it('never converts an unreadable file into a deletion or empty snapshot', async () => {
    const f = await setup();
    const file = path.join(f.root, 'secret');
    await fs.writeFile(file, 'keep');
    const [first] = await f.service.historyCapture(scope);
    await fs.rm(file);
    await fs.mkdir(file);
    expect(await f.service.historyCapture(scope, { paths: ['secret'] })).toEqual([]);
    expect((await f.service.historyList(scope)).map((event) => event.id)).toEqual([first.id]);
    expect((await f.service.historyStatus(scope)).errors.join(' ')).toContain('Unable to record secret');
  });

  it('retains durable recovery and original bytes when a restore write fails', async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, 'draft'), 'first');
    const [event] = await f.service.historyCapture(scope);
    await fs.writeFile(path.join(f.root, 'draft'), 'second');
    const compare = await f.service.historyCompare(scope, { id: event.id, path: 'draft' });
    const failing = createGitStorageService({
      ...f.options,
      writeFile: async () => {
        throw Object.assign(new Error('write denied'), { code: 'EACCES' });
      },
    });
    await expect(
      failing.historyRestore(scope, { id: event.id, expected: { draft: compare.current.fingerprint } })
    ).rejects.toThrow(/recovery retained/);
    const recovery = (await failing.historyList(scope)).find((entry) => entry.kind === 'recovery')!;
    expect(
      Buffer.from(
        (await failing.historyRead(scope, { id: recovery.id, path: 'draft' })).contentBase64!,
        'base64'
      ).toString()
    ).toBe('second');
    expect(await fs.readFile(path.join(f.root, 'draft'), 'utf8')).toBe('second');
  });

  it('reports oversized files and traversal without capturing unavailable bytes', async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(await f.service.historyCapture(scope)).toEqual([]);
    expect((await f.service.historyStatus(scope)).errors).toHaveLength(1);
    await expect(f.service.historyCapture(scope, { paths: ['../outside'] })).rejects.toThrow();
  });

  it('records external edits while running, stops idempotently, and disposes pending work', async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.root, 'draft'), 'initial');
    const service = createGitStorageService({ ...f.options, recorderIntervalMs: 250 });
    cleanups.push(() => service.dispose());
    await Promise.all([service.historyStart(scope), service.historyStart(scope)]);
    await fs.writeFile(path.join(f.root, 'draft'), 'external');
    await vi.waitFor(
      async () => {
        expect((await service.historyList(scope)).length).toBe(2);
      },
      { timeout: 4000 }
    );
    await service.historyStop(scope);
    await service.historyStop(scope);
    expect((await service.historyStatus(scope)).recording).toBe(false);
    await fs.writeFile(path.join(f.root, 'draft'), 'after-stop');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await service.historyList(scope)).toHaveLength(2);
  });

  it('limits enumeration and exposes that later files were not scanned', async () => {
    const f = await setup();
    await Promise.all(Array.from({ length: 2002 }, (_, index) => fs.writeFile(path.join(f.root, `file-${index}`), '')));
    await f.service.historyCapture(scope);
    const status = await f.service.historyStatus(scope);
    expect(status.limited).toBe(true);
    expect(status.fileCount).toBeLessThanOrEqual(2000);
  });
});
