import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import { safeOutput } from '@process/services/sourceControl/workbench/operations/engine';
const scope = { projectId: 'p', peId: 'root', relativePath: '' };
let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-operation-review-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, 'file.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
describe('reviewed repository identity', () => {
  it('allows removing an SSH remote as displayed while keeping passwords redacted', async () => {
    git('remote', 'add', 'origin', 'ssh://git@example.test/repo');
    const service = createGitOperationService({ resolveRoot: async () => root });
    const list = await service.operate(scope, { kind: 'remote.list' });
    const remote = list.data!.remotes![0];
    expect(
      await service.operate(scope, {
        kind: 'remote.remove',
        name: remote.name,
        expectedUrl: remote.fetchUrl,
        confirmed: true,
      })
    ).toMatchObject({ state: 'complete' });
    expect(git('remote')).toBe('');
    expect(safeOutput('ssh://git:secret@example.test/repo')).not.toContain('secret');
  });
  it('blocks pull after an external switch to a different branch at the same commit', async () => {
    const head = git('rev-parse', 'HEAD');
    git('branch', 'feature');
    const remote = path.join(root, 'remote.git');
    git('init', '--bare', '-q', remote);
    git('remote', 'add', 'origin', remote);
    await writeFile(path.join(root, 'file.txt'), 'new');
    git('add', 'file.txt');
    git('commit', '-qm', 'new');
    git('push', '-q', 'origin', 'main');
    git('checkout', '-q', 'feature');
    const service = createGitOperationService({ resolveRoot: async () => root });
    const outcome = await service.operate(scope, {
      kind: 'pull',
      remote: 'origin',
      branch: 'main',
      expectedHead: head,
    });
    expect(outcome.state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('branch', '--show-current')).toBe('feature');
  });
  it('rechecks the branch after fetch before applying the downloaded commits', async () => {
    const head = git('rev-parse', 'HEAD');
    git('branch', 'feature');
    const remote = path.join(root, 'remote.git');
    git('init', '--bare', '-q', remote);
    git('remote', 'add', 'origin', remote);
    await writeFile(path.join(root, 'file.txt'), 'new');
    git('add', 'file.txt');
    git('commit', '-qm', 'new');
    git('push', '-q', 'origin', 'main');
    git('reset', '--hard', head);
    const script = path.join(root, 'switch-during-fetch.sh');
    const quoted = (value: string) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
    await writeFile(script, `#!/bin/sh\ngit -C ${quoted(root)} switch -q feature\nexec git-upload-pack "$@"\n`);
    await chmod(script, 0o755);
    git('config', 'remote.origin.uploadpack', quoted(script));
    const service = createGitOperationService({ resolveRoot: async () => root });
    const outcome = await service.operate(scope, {
      kind: 'pull',
      remote: 'origin',
      branch: 'main',
      expectedHead: head,
    });
    expect(outcome.state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('branch', '--show-current')).toBe('feature');
  });
  it('does not autostash dirty work even when merge.autoStash is enabled', async () => {
    const head = git('rev-parse', 'HEAD');
    const remote = path.join(root, 'remote.git');
    git('init', '--bare', '-q', remote);
    git('remote', 'add', 'origin', remote);
    await writeFile(path.join(root, 'file.txt'), 'remote');
    git('add', 'file.txt');
    git('commit', '-qm', 'remote');
    git('push', '-q', 'origin', 'main');
    git('reset', '--hard', head);
    git('config', 'merge.autoStash', 'true');
    await writeFile(path.join(root, 'file.txt'), 'local');
    const result = await createGitOperationService({ resolveRoot: async () => root }).operate(scope, {
      kind: 'pull',
      remote: 'origin',
      branch: 'main',
      expectedHead: head,
    });
    expect(result.state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('local');
    expect(git('stash', 'list')).toBe('');
  });
});
