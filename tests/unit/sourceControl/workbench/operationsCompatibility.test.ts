import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import { remoteUrlSchema } from '@process/services/sourceControl/workbench/operations/validation';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-compat-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  await writeFile(path.join(root, 'file.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('Git older than the newest flags', () => {
  const older = createGitOperationServiceFor({
    worktreeListNul: false,
    mergeNoAutostash: false,
    stashShowUntracked: false,
  });

  it('lists worktrees without -z', async () => {
    const result = await older().operate(scope, { kind: 'worktree.list' });

    expect(result.state).toBe('complete');
    expect(result.data?.worktrees).toHaveLength(1);
    expect(result.data?.worktrees?.[0]).toMatchObject({ branch: 'main', main: true });
  });

  it('shows a stash without --include-untracked', async () => {
    await writeFile(path.join(root, 'file.txt'), 'changed');
    git('stash', 'push', '-q');
    const expectedRef = git('rev-parse', 'stash@{0}');

    const result = await older().operate(scope, { kind: 'stash.show', ref: 'stash@{0}', expectedRef });

    expect(result.data?.patch).toContain('changed');
  });
});

function createGitOperationServiceFor(capabilities: Record<string, boolean>) {
  return () => createGitOperationService({ resolveRoot: async () => root, capabilities });
}

describe('remote URLs', () => {
  it.each([
    'https://github.com/org/repo.git',
    'git@github.com:org/repo.git',
    'ssh://git@host/org/repo.git',
    'https://contoso@dev.azure.com/contoso/project/_git/repo',
    'github-work:org/repo.git',
    'C:/repos/origin.git',
  ])('accepts %s', (url) => {
    expect(remoteUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    'https://user:secret@github.com/org/repo.git',
    'https://ghp_token@github.com/org/repo.git',
    'ext::sh -c whoami',
    '--upload-pack=whoami',
    'c:relative',
    'file:relative',
  ])('rejects %s', (url) => {
    expect(remoteUrlSchema.safeParse(url).success).toBe(false);
  });

  it('removes a remote identified by its redacted address', async () => {
    git('remote', 'add', 'origin', 'https://user:secret@example.test/org/repo.git');
    const service = createGitOperationService({ resolveRoot: async () => root });
    const listed = await service.operate(scope, { kind: 'remote.list' });
    const expectedUrl = listed.data?.remotes?.[0].fetchUrl ?? '';
    expect(expectedUrl).not.toContain('secret');

    const result = await service.operate(scope, {
      kind: 'remote.remove',
      name: 'origin',
      expectedUrl,
      confirmed: true,
    });

    expect(result.state).toBe('complete');
    expect(git('remote')).toBe('');
  });

  it('refuses to remove a remote whose address has changed', async () => {
    git('remote', 'add', 'origin', 'https://example.test/org/repo.git');
    const service = createGitOperationService({ resolveRoot: async () => root });

    const result = await service.operate(scope, {
      kind: 'remote.remove',
      name: 'origin',
      expectedUrl: 'https://example.test/org/other.git',
      confirmed: true,
    });

    expect(result.state).toBe('blocked');
    expect(git('remote')).toBe('origin');
  });
});
