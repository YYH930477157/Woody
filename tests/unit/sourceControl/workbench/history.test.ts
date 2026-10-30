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
const commit = async (name: string, content: string, message: string): Promise<string> => {
  await writeFile(path.join(root, name), content);
  git('add', '--', name);
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-history-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Woody Test');
  git('config', 'user.email', 'woody@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('Git workbench history', () => {
  const service = () => createGitWorkbenchService({ resolveRoot: async () => root });

  it('returns an empty page for a repository without commits', async () => {
    expect(await service().history(scope, {})).toMatchObject({ commits: [], hasMore: false });
  });

  it('paginates history without duplicate rows', async () => {
    const first = await commit('a.txt', 'one', 'first');
    const second = await commit('a.txt', 'two', 'second');
    const reader = service();
    const page = await reader.history(scope, { limit: 1 });
    expect(page).toMatchObject({ commits: [{ hash: second }], hasMore: true });
    expect((await reader.history(scope, { limit: 1, skip: 1 })).commits.map((row) => row.hash)).toEqual([first]);
  });

  it('finds a commit by abbreviated hash and includes detached HEAD history', async () => {
    await commit('a.txt', 'one', 'first');
    git('checkout', '--detach');
    const detached = await commit('a.txt', 'two', 'detached');
    expect((await service().history(scope, {})).commits[0].hash).toBe(detached);
    expect((await service().history(scope, { text: detached.slice(0, 10) })).commits.map((row) => row.hash)).toEqual([
      detached,
    ]);
  });

  it('rejects continuing an old page when refs changed so commits cannot be silently skipped', async () => {
    await commit('a.txt', 'one', 'first');
    await commit('a.txt', 'two', 'second');
    const reader = service();
    const page = await reader.history(scope, { limit: 1 });
    await commit('a.txt', 'three', 'third');
    await expect(reader.history(scope, { limit: 1, skip: 1, snapshot: page.snapshot })).rejects.toThrow(
      /history changed/i
    );
  });

  it('returns both parents of a real merge commit', async () => {
    await commit('base.txt', 'base', 'base');
    git('checkout', '-qb', 'feature');
    const feature = await commit('feature.txt', 'feature', 'feature');
    git('checkout', '-q', 'main');
    const main = await commit('main.txt', 'main', 'main');
    git('merge', '--no-ff', '-qm', 'merged', 'feature');
    expect((await service().history(scope, {})).commits[0].parents).toEqual([main, feature]);
  });

  it('includes morning commits on the selected starting date', async () => {
    await writeFile(path.join(root, 'morning.txt'), 'morning');
    git('add', '--', 'morning.txt');
    execFileSync('git', ['commit', '-qm', 'morning'], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-29T01:00:00', GIT_COMMITTER_DATE: '2026-10-29T01:00:00' },
    });
    expect((await service().history(scope, { since: '2026-10-29' })).commits.map((row) => row.subject)).toEqual([
      'morning',
    ]);
  });

  it('filters messages and repository-relative Unicode paths literally', async () => {
    await commit('普通 文件.txt', 'one', 'REQ[1] display');
    await commit('other.txt', 'two', 'other');
    expect(
      (await service().history(scope, { text: 'REQ[1]', path: '普通 文件.txt' })).commits.map((row) => row.subject)
    ).toEqual(['REQ[1] display']);
  });

  it('reads tags, branches and exact commit details without changing HEAD', async () => {
    const hash = await commit('普通 文件.txt', 'one\n', 'subject\n\nbody');
    git('tag', '-a', 'v1', '-m', 'tag');
    git('branch', 'feature');
    const reader = service();
    expect(await reader.refs(scope)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'main', type: 'local', current: true }),
        expect.objectContaining({ name: 'v1', type: 'tag', hash }),
      ])
    );
    expect(await reader.details(scope, hash)).toMatchObject({
      body: 'subject\n\nbody\n',
      files: [{ path: '普通 文件.txt', status: 'A' }],
    });
    expect(git('rev-parse', 'HEAD')).toBe(hash);
  });

  it('returns a selected commit diff instead of the current working file', async () => {
    const hash = await commit('a.txt', 'committed\n', 'base');
    await writeFile(path.join(root, 'a.txt'), 'working\n');
    const result = await service().diff(scope, hash, 'a.txt');
    expect(result.patch).toContain('+committed');
    expect(result.patch).not.toContain('+working');
  });

  it('decodes commit subjects and bodies as UTF-8 even when repository output encoding is GBK', async () => {
    const hash = await commit('a.txt', 'one', '修复缺陷');
    git('config', 'i18n.logOutputEncoding', 'GBK');
    expect((await service().history(scope, {})).commits[0].subject).toBe('修复缺陷');
    expect((await service().details(scope, hash)).body.trim()).toBe('修复缺陷');
  });

  it('returns a bounded preview with an explicit truncated flag for a large text diff', async () => {
    const hash = await commit('large.txt', 'long line of source code\n'.repeat(20000), 'large');
    const result = await service().diff(scope, hash, 'large.txt');
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain('+long line of source code');
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(256 * 1024);
  });

  it('rejects command options as revisions and paths outside the repository', async () => {
    const reader = service();
    await expect(reader.history(scope, { ref: '--output=bad' })).rejects.toThrow();
    await expect(reader.history(scope, { path: '../outside' })).rejects.toThrow();
    await expect(reader.history(scope, { limit: 100000 })).rejects.toThrow();
  });

  it('surfaces a missing or invalid repository instead of showing an empty history', async () => {
    await rm(path.join(root, '.git'), { recursive: true, force: true });
    await expect(service().history(scope, {})).rejects.toThrow();
  });
});
