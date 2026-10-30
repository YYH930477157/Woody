import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitWorkbenchService } from '@process/services/sourceControl/workbench/service';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const commit = async (content: string, message: string): Promise<string> => {
  await writeFile(path.join(root, 'unicode 文件.txt'), content);
  git('add', '--', 'unicode 文件.txt');
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-revisions-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
});
afterEach(async () => rm(root, { recursive: true, force: true, maxRetries: 3 }));

describe('file revisions and preview comparisons', () => {
  const service = () => createGitWorkbenchService({ resolveRoot: async () => root });

  it('returns history for one path with exact commits and paging', async () => {
    const first = await commit('one\n', 'first');
    const second = await commit('two\n', 'second');
    const page = await service().fileHistory(scope, { path: 'unicode 文件.txt', limit: 1 });
    expect(page.commits.map((row) => row.hash)).toEqual([second]);
    expect(page.hasMore).toBe(true);
    expect(
      (await service().fileHistory(scope, { path: 'unicode 文件.txt', skip: 1, limit: 1 })).commits.map(
        (row) => row.hash
      )
    ).toEqual([first]);
  });

  it('reads a historical UTF-8 file and reports missing files without fabricating content', async () => {
    const hash = await commit('历史内容\n', 'history');
    expect(await service().readRevision(scope, { kind: 'revision', revision: hash }, 'unicode 文件.txt')).toMatchObject(
      { exists: true, binary: false, content: '历史内容\n' }
    );
    expect(await service().readRevision(scope, { kind: 'revision', revision: hash }, 'missing.txt')).toMatchObject({
      exists: false,
    });
  });

  it('parses blame lines and marks worktree changes uncommitted', async () => {
    const hash = await commit('committed\nsecond\n', 'base');
    await writeFile(path.join(root, 'unicode 文件.txt'), 'committed\nworking\n');
    const lines = await service().blame(scope, 'unicode 文件.txt');
    expect(lines).toEqual([
      expect.objectContaining({ line: 1, hash, committed: true, content: 'committed' }),
      expect.objectContaining({ committed: false, content: 'working' }),
    ]);
  });

  it('compares committed, index and working tree anchors without changing them', async () => {
    const first = await commit('old\n', 'old');
    await writeFile(path.join(root, 'unicode 文件.txt'), 'staged\n');
    git('add', '--', 'unicode 文件.txt');
    await writeFile(path.join(root, 'unicode 文件.txt'), 'working\n');
    expect(
      (
        await service().compare(scope, {
          file: 'unicode 文件.txt',
          from: { kind: 'revision', revision: first },
          to: { kind: 'index' },
        })
      ).patch
    ).toContain('+staged');
    expect(
      (await service().compare(scope, { file: 'unicode 文件.txt', from: { kind: 'index' }, to: { kind: 'worktree' } }))
        .patch
    ).toContain('+working');
    expect(git('show', 'HEAD:unicode 文件.txt')).toBe('old');
  });

  it('rejects option-like revisions and escaped paths', async () => {
    const reader = service();
    await expect(reader.readRevision(scope, { kind: 'revision', revision: '--output=bad' }, 'a')).rejects.toThrow();
    await expect(reader.fileHistory(scope, { path: '../outside' })).rejects.toThrow();
  });
});
