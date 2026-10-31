/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireHistoryLocks } from '@/process/services/sourceControl/workbench/operations/historyWorkspace';

let root: string;
let gitDir: string;
let indexPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'woody-history-lock-'));
  gitDir = join(root, '.git');
  await mkdir(gitDir, { recursive: true });
  indexPath = join(gitDir, 'index');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const headLock = (): string => join(gitDir, 'HEAD.lock');

describe('history operation locks', () => {
  it('marks its own locks and releases both of them', async () => {
    const release = await acquireHistoryLocks(gitDir, indexPath);
    expect(await readFile(headLock(), 'utf8')).toContain('woody-history-lock');
    await release();
    await expect(readFile(headLock(), 'utf8')).rejects.toThrow();
    await expect(readFile(`${indexPath}.lock`, 'utf8')).rejects.toThrow();
  });

  it('reclaims a lock left behind by a dead process', async () => {
    // The largest pid is never a live process, so the marker is definitely abandoned.
    await writeFile(headLock(), 'woody-history-lock:2147483647:2026-01-01T00:00:00.000Z\n');
    const release = await acquireHistoryLocks(gitDir, indexPath);
    expect(await readFile(headLock(), 'utf8')).toContain('woody-history-lock:');
    await release();
  });

  it('never removes a Git-owned lock that carries no marker', async () => {
    await writeFile(headLock(), '');
    await expect(acquireHistoryLocks(gitDir, indexPath)).rejects.toMatchObject({
      code: 'EEXIST',
      message: expect.stringContaining(headLock()),
    });
    expect(await readFile(headLock(), 'utf8')).toBe('');
  });

  it('keeps a lock that a live process still owns', async () => {
    await writeFile(headLock(), `woody-history-lock:${process.pid}:2026-01-01T00:00:00.000Z\n`);
    await expect(acquireHistoryLocks(gitDir, indexPath)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(headLock(), 'utf8')).toContain(`woody-history-lock:${process.pid}:`);
  });
});
