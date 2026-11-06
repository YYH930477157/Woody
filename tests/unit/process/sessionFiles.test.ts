/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSessionFilesService,
  firstSentence,
  isSessionFolder,
  safeSegment,
  sessionFolderName,
} from '@process/sessionFiles/sessionFiles';

const names = { root: '会话文件', work: '过程', output: '成品', untitled: '新会话' };
const now = new Date(2026, 10, 6, 14, 30);

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('chat folder names', () => {
  it('keeps letters and digits in any script and turns shell-special characters into one underscore', () => {
    expect(safeSegment('修复 串口$接收`超时 (v2) & "重试"', 40)).toBe('修复_串口_接收_超时_v2_重试');
    expect(safeSegment('..\\..\\Windows', 40)).toBe('Windows');
    expect(safeSegment('###', 40)).toBe('');
  });

  it('cuts by characters, not UTF-16 units, and never ends on a separator', () => {
    expect(safeSegment('一二三四五六七八九十一二三四五六七八九十多出来的', 20)).toBe(
      '一二三四五六七八九十一二三四五六七八九十'
    );
    expect(safeSegment('abc_def', 4)).toBe('abc');
    // U+20000 is one letter stored as two UTF-16 units.
    expect(Array.from(safeSegment('\u{20000}'.repeat(30), 20))).toHaveLength(20);
    expect(safeSegment('修复😀串口', 20)).toBe('修复_串口');
  });

  it('takes the first sentence of the first non-empty line', () => {
    expect(firstSentence('\n  修复串口接收超时。然后再看日志')).toBe('修复串口接收超时');
    expect(firstSentence('Fix the UART timeout. Then check logs')).toBe('Fix the UART timeout');
    expect(firstSentence('升级到 1.5 版本？')).toBe('升级到 1.5 版本');
    expect(firstSentence('第一行\n第二行')).toBe('第一行');
  });

  it('prefixes the local date and falls back to the untitled name', () => {
    expect(sessionFolderName('修复串口接收超时。', '新会话', now)).toBe('2026-11-06_修复串口接收超时');
    expect(sessionFolderName('', '新会话', now)).toBe('2026-11-06_新会话');
    expect(sessionFolderName('？？？', '', now)).toBe('2026-11-06_untitled');
  });

  it('recognizes only <...>/.woody/<root>/<date>_<label> as a chat folder', () => {
    const root = path.join(os.tmpdir(), 'repo', '.woody', '会话文件');
    expect(isSessionFolder(path.join(root, '2026-11-06_修复'))).toBe(true);
    expect(isSessionFolder(path.join(os.tmpdir(), 'repo'))).toBe(false);
    expect(isSessionFolder(path.join(root, 'notes'))).toBe(false);
    expect(isSessionFolder(path.join(os.tmpdir(), 'repo', 'src', 'x', '2026-11-06_a'))).toBe(false);
    expect(isSessionFolder(`${root}${path.sep}..${path.sep}..${path.sep}2026-11-06_a`)).toBe(false);
    expect(isSessionFolder('repo/.woody/会话文件/2026-11-06_a')).toBe(false);
  });
});

describe('session files service', () => {
  let workspace: string;
  const trash = vi.fn(async (dir: string) => rmSync(dir, { recursive: true, force: true }));
  const service = () => createSessionFilesService({ now: () => now, trash, warn: () => undefined });

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'woody-session-files-'));
    trash.mockClear();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('hands out the folders and creates only the Git-ignored root, not the chat folder', async () => {
    const prepared = await service().prepare({ workspace, title: '修复串口接收超时。然后看日志', names });

    const dir = path.join(workspace, '.woody', '会话文件', '2026-11-06_修复串口接收超时');
    expect(prepared).toEqual({ dir, work_dir: path.join(dir, '过程'), output_dir: path.join(dir, '成品') });
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(path.join(workspace, '.woody', '会话文件', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  });

  it('gives a second chat with the same first sentence on the same day its own folder', async () => {
    const files = service();
    const first = await files.prepare({ workspace, title: '修复串口', names });
    const second = await files.prepare({ workspace, title: '修复串口', names });
    mkdirSync(path.join(workspace, '.woody', '会话文件', '2026-11-06_修复串口-3'), { recursive: true });
    const fourth = await service().prepare({ workspace, title: '修复串口', names });
    const third = await files.prepare({ workspace, title: '修复串口', names });

    expect(path.basename(first!.dir)).toBe('2026-11-06_修复串口');
    expect(path.basename(second!.dir)).toBe('2026-11-06_修复串口-2');
    expect(path.basename(fourth!.dir)).toBe('2026-11-06_修复串口');
    expect(path.basename(third!.dir)).toBe('2026-11-06_修复串口-4');
  });

  it('keeps a .gitignore the user already edited', async () => {
    const root = path.join(workspace, '.woody', '会话文件');
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), '# mine\n');

    await service().prepare({ workspace, title: 'a', names });

    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('# mine\n');
  });

  it('keeps the two subfolders apart when a translation names them alike', async () => {
    const prepared = await service().prepare({
      workspace,
      title: 'a',
      names: { ...names, work: 'out', output: 'OUT' },
    });

    expect(path.basename(prepared!.work_dir)).toBe('out');
    expect(path.basename(prepared!.output_dir)).toBe('OUT-2');
  });

  it('accepts a workspace that is itself a link to the real project folder', async () => {
    const real = path.join(workspace, 'real');
    mkdirSync(real);
    const linked = path.join(workspace, 'linked');
    symlinkSync(real, linked, 'junction');

    const prepared = await service().prepare({ workspace: linked, title: 'a', names });

    expect(prepared?.dir.startsWith(path.join(linked, '.woody'))).toBe(true);
    expect(existsSync(path.join(real, '.woody', '会话文件', '.gitignore'))).toBe(true);
  });

  it('returns null instead of throwing for a workspace it cannot use', async () => {
    const file = path.join(workspace, 'file.txt');
    writeFileSync(file, 'x');
    const files = service();

    expect(await files.prepare({ workspace: 'relative/path', title: 'a', names })).toBeNull();
    expect(await files.prepare({ workspace: path.join(workspace, 'missing'), title: 'a', names })).toBeNull();
    expect(await files.prepare({ workspace: file, title: 'a', names })).toBeNull();
    expect(await files.prepare(undefined as never)).toBeNull();
  });

  it.skipIf(!hasGit)('leaves Git status clean however many files a chat writes', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    const prepared = await service().prepare({ workspace, title: '修复串口', names });
    mkdirSync(prepared!.work_dir, { recursive: true });
    mkdirSync(prepared!.output_dir, { recursive: true });
    writeFileSync(path.join(prepared!.work_dir, 'probe.py'), 'print(1)\n');
    writeFileSync(path.join(prepared!.output_dir, 'report.md'), '# report\n');

    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: workspace,
    }).toString();

    expect(status).toBe('');
  });

  it('reports existing chat folders with their file count and skips everything else', async () => {
    const prepared = await service().prepare({ workspace, title: '修复串口', names });
    mkdirSync(prepared!.work_dir, { recursive: true });
    writeFileSync(path.join(prepared!.work_dir, 'a.py'), '');
    writeFileSync(path.join(prepared!.work_dir, 'b.py'), '');
    const missing = path.join(workspace, '.woody', '会话文件', '2026-11-06_gone');

    const states = await service().inspect([prepared!.dir, prepared!.dir, missing, workspace, 42 as never]);

    expect(states).toEqual([{ dir: prepared!.dir, files: 2 }]);
  });

  it('refuses a link dressed up as a chat folder', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'woody-outside-'));
    try {
      writeFileSync(path.join(outside, 'keep.txt'), 'x');
      const root = path.join(workspace, '.woody', '会话文件');
      mkdirSync(root, { recursive: true });
      const link = path.join(root, '2026-11-06_link');
      symlinkSync(outside, link, 'junction');

      expect(await service().inspect([link])).toEqual([]);
      expect(await service().trash([link])).toEqual({ trashed: [], failed: [link] });
      expect(trash).not.toHaveBeenCalled();
      expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('trashes chat folders only, and treats a folder that is already gone as done', async () => {
    const prepared = await service().prepare({ workspace, title: '修复串口', names });
    mkdirSync(prepared!.output_dir, { recursive: true });
    const gone = path.join(workspace, '.woody', '会话文件', '2026-11-06_gone');

    const result = await service().trash([prepared!.dir, gone, workspace]);

    expect(result).toEqual({ trashed: [prepared!.dir], failed: [workspace] });
    expect(trash).toHaveBeenCalledTimes(1);
    expect(trash).toHaveBeenCalledWith(prepared!.dir);
    expect(existsSync(workspace)).toBe(true);
  });

  it('reports a folder the system trash rejected as failed', async () => {
    const prepared = await service().prepare({ workspace, title: '修复串口', names });
    mkdirSync(prepared!.dir, { recursive: true });
    trash.mockRejectedValueOnce(new Error('in use'));

    expect(await service().trash([prepared!.dir])).toEqual({ trashed: [], failed: [prepared!.dir] });
  });
});
