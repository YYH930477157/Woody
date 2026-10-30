import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import type { GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import { createCommitWorkflowService } from '@process/services/sourceControl/commitWorkflowService';
import { createGitCommandService } from '@process/services/sourceControl/gitCommandService';
import { repositoryCoordinator } from '@process/services/sourceControl/workbench/coordinator';
import { createGitWorkbenchService } from '@process/services/sourceControl/workbench/service';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
let head: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const operate = (request: GitOperationRequest) =>
  createGitOperationService({ resolveRoot: async () => root }).operate(scope, request);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-ops-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'file.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  head = git('rev-parse', 'HEAD');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('allowlisted Git operations', { timeout: 30_000 }, () => {
  it('blocks history editing when the resolved Git version lacks the required capability', async () => {
    const service = createGitOperationService({
      resolveRoot: async () => root,
      capabilities: { updateRefs: true, memoryHistoryEdit: false },
    });
    const result = await service.operate(scope, {
      kind: 'history.reword',
      commit: head,
      message: 'rewritten',
      expectedHead: head,
      expectedBranch: 'main',
      confirmed: true,
    });

    expect(result).toMatchObject({ state: 'blocked' });
    expect(result.output).toContain('Git 2.40');
  });
  it('omits --no-update-refs for Git versions before 2.38', async () => {
    const calls: string[][] = [];
    const actual = createGitExecutor('git', false);
    const service = createGitOperationService({
      resolveRoot: async () => root,
      git: async (...args) => {
        calls.push(args[1]);
        return actual(...args);
      },
      capabilities: { updateRefs: false },
    });

    const result = await service.operate(scope, {
      kind: 'rebase',
      target: head,
      expectedHead: head,
      expectedBranch: 'main',
      confirmed: true,
    });
    expect(result.state, result.output).toBe('complete');
    const rebase = calls.find((args) => args[0] === 'rebase');
    expect(rebase).toEqual(['rebase', '--no-autostash', head]);
  });
  it('explicitly marks a bounded stash preview even when the full patch exceeds the general command limit', async () => {
    await writeFile(path.join(root, 'file.txt'), 'large stash line\n'.repeat(600000));
    git('stash', 'push', '-qm', 'large');
    const hash = git('rev-parse', 'stash@{0}');
    const result = await operate({ kind: 'stash.show', ref: 'stash@{0}', expectedRef: hash });
    expect(result).toMatchObject({ state: 'complete', data: { truncated: true } });
    expect(result.data?.patch?.length).toBeLessThanOrEqual(256 * 1024);
    expect(result.data?.patch).toContain('+large stash line');
  });
  it('deletes an annotated tag using the raw object identity exposed with its peeled commit', async () => {
    git('tag', '-a', 'annotated', '-m', 'annotation');
    const ref = (await createGitWorkbenchService({ resolveRoot: async () => root }).refs(scope)).find(
      (row) => row.name === 'annotated'
    )!;
    expect(ref).toMatchObject({ hash: head, objectHash: git('rev-parse', 'refs/tags/annotated') });
    expect(
      (await operate({ kind: 'tag.delete', name: ref.name, expectedRef: ref.objectHash!, confirmed: true })).state
    ).toBe('complete');
  });
  it('applies the reviewed stash hash and keeps both entries if an external process shifts the selector', async () => {
    await writeFile(path.join(root, 'file.txt'), 'original\n');
    git('stash', 'push', '-qm', 'original');
    const original = git('rev-parse', 'stash@{0}');
    const realGit = createGitExecutor('git', false);
    let shifted = false;
    const service = createGitOperationService({
      resolveRoot: async () => root,
      git: async (cwd, args, allowFailure, options) => {
        if (!shifted && args[0] === 'stash' && ['apply', 'pop'].includes(args[1])) {
          shifted = true;
          await writeFile(path.join(root, 'file.txt'), 'external\n');
          git('stash', 'push', '-qm', 'external');
        }
        return realGit(cwd, args, allowFailure, options);
      },
    });
    const result = await service.operate(scope, {
      kind: 'stash.pop',
      ref: 'stash@{0}',
      expectedRef: original,
      expectedHead: head,
      confirmed: true,
    });
    expect(result.state).toBe('blocked');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('original\n');
    expect(git('rev-parse', 'stash@{1}')).toBe(original);
  });
  it('inspects detached HEAD and ongoing operations without performing writes', async () => {
    git('checkout', '-q', '--detach');
    expect((await operate({ kind: 'inspect' })).data).toMatchObject({ head, branch: null, operation: null });
    await writeFile(path.join(root, '.git', 'MERGE_HEAD'), head + '\n');
    expect((await operate({ kind: 'inspect' })).data).toMatchObject({ operation: 'merge' });
    expect((await operate({ kind: 'tag.create', name: 'blocked', target: head })).state).toBe('blocked');
  });
  it('blocks raw arguments and stale HEAD without changing references', async () => {
    expect(
      (await operate({ kind: 'branch.create', name: 'new', startPoint: 'HEAD', expectedHead: '0'.repeat(40) })).state
    ).toBe('blocked');
    expect(
      (
        await operate({
          kind: 'branch.create',
          name: 'new',
          startPoint: 'HEAD',
          expectedHead: head,
          args: ['--force'],
        } as GitOperationRequest)
      ).state
    ).toBe('blocked');
    expect(git('branch', '--list', 'new')).toBe('');
  });
  it('creates, switches and renames branches using verified references', async () => {
    expect((await operate({ kind: 'branch.create', name: 'topic', startPoint: head, expectedHead: head })).state).toBe(
      'complete'
    );
    expect((await operate({ kind: 'branch.switch', name: 'topic', expectedHead: head })).state).toBe('complete');
    expect(
      (
        await operate({
          kind: 'branch.rename',
          name: 'topic',
          newName: 'renamed',
          expectedRef: head,
          expectedHead: head,
          confirmed: true,
        })
      ).state
    ).toBe('complete');
    expect(git('branch', '--show-current')).toBe('renamed');
  });
  it('refuses deleting an unmerged branch and requires confirmation', async () => {
    git('checkout', '-qb', 'topic');
    await writeFile(path.join(root, 'file.txt'), 'topic\n');
    git('commit', '-qam', 'topic');
    const target = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    expect(
      (
        await operate({
          kind: 'branch.delete',
          name: 'topic',
          expectedRef: target,
          expectedHead: head,
          confirmed: true,
        })
      ).state
    ).toBe('error');
    expect(
      (
        await operate({
          kind: 'branch.delete',
          name: 'topic',
          expectedRef: target,
          expectedHead: head,
          confirmed: false,
        } as unknown as GitOperationRequest)
      ).state
    ).toBe('blocked');
    expect(git('rev-parse', 'topic')).toBe(target);
  });
  it('creates and removes tags with a verified expected object', async () => {
    expect((await operate({ kind: 'tag.create', name: 'v1', target: head })).state).toBe('complete');
    expect(
      (await operate({ kind: 'tag.delete', name: 'v1', expectedRef: '0'.repeat(40), confirmed: true })).state
    ).toBe('blocked');
    expect((await operate({ kind: 'tag.delete', name: 'v1', expectedRef: head, confirmed: true })).state).toBe(
      'complete'
    );
  });
  it('saves untracked files and rejects a shifted stash selector', async () => {
    await writeFile(path.join(root, 'new.txt'), 'untracked');
    expect(
      (await operate({ kind: 'stash.save', message: 'saved', includeUntracked: true, expectedHead: head })).state
    ).toBe('complete');
    const hash = git('rev-parse', 'stash@{0}');
    expect((await operate({ kind: 'stash.list' })).data?.stashes?.[0]).toMatchObject({ ref: 'stash@{0}', hash });
    expect(
      (await operate({ kind: 'stash.drop', ref: 'stash@{0}', expectedRef: '0'.repeat(40), confirmed: true })).state
    ).toBe('blocked');
    const popped = await operate({
      kind: 'stash.pop',
      ref: 'stash@{0}',
      expectedRef: hash,
      expectedHead: head,
      confirmed: true,
    });
    expect(popped.state, popped.output).toBe('complete');
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('untracked');
  });
  it('preserves stash on pop conflict and blocks subsequent mutations', async () => {
    await writeFile(path.join(root, 'file.txt'), 'stashed\n');
    git('stash', 'push', '-qm', 'stashed');
    const hash = git('rev-parse', 'stash@{0}');
    await writeFile(path.join(root, 'file.txt'), 'committed\n');
    git('commit', '-qam', 'other');
    head = git('rev-parse', 'HEAD');
    const outcome = await operate({
      kind: 'stash.pop',
      ref: 'stash@{0}',
      expectedRef: hash,
      expectedHead: head,
      confirmed: true,
    });
    expect(outcome).toMatchObject({ state: 'conflict', files: ['file.txt'] });
    expect(git('rev-parse', 'stash@{0}')).toBe(hash);
    expect(
      (await operate({ kind: 'branch.create', name: 'blocked', startPoint: head, expectedHead: head })).state
    ).toBe('blocked');
  });
  it('lists linked worktrees without accepting arbitrary mutation paths', async () => {
    expect((await operate({ kind: 'worktree.list' })).data?.worktrees?.[0]).toMatchObject({
      head,
      branch: 'main',
      main: true,
    });
    expect((await operate({ kind: 'worktree.remove', path: '..' } as unknown as GitOperationRequest)).state).toBe(
      'blocked'
    );
  });
  it('uses an explicit bare remote for fetch and push and safely manages its configuration', async () => {
    const bare = path.join(root, 'remote.git');
    git('init', '-q', '--bare', bare);
    expect((await operate({ kind: 'remote.add', name: 'origin', url: bare })).state).toBe('complete');
    expect(
      (await operate({ kind: 'push', remote: 'origin', branch: 'main', expectedHead: head, confirmed: true })).state
    ).toBe('complete');
    expect((await operate({ kind: 'fetch', remote: 'origin' })).state).toBe('complete');
    expect((await operate({ kind: 'remote.list' })).data?.remotes?.[0]).toMatchObject({
      name: 'origin',
      fetchUrl: bare,
    });
    expect((await operate({ kind: 'remote.remove', name: 'origin', expectedUrl: bare, confirmed: true })).state).toBe(
      'complete'
    );
  });
  it('rejects option and transport injection', async () => {
    expect(
      (await operate({ kind: 'branch.create', name: '--force', startPoint: head, expectedHead: head })).state
    ).toBe('blocked');
    expect((await operate({ kind: 'remote.add', name: 'bad', url: 'ext::sh -c false' })).state).toBe('blocked');
    expect(
      (await operate({ kind: 'remote.add', name: 'bad', url: 'https://user:secret@example.test/repo' })).state
    ).toBe('blocked');
  });
  it('keeps local content when a branch switch would overwrite it', async () => {
    git('checkout', '-qb', 'topic');
    await writeFile(path.join(root, 'file.txt'), 'topic\n');
    git('commit', '-qam', 'topic');
    git('checkout', '-q', 'main');
    await writeFile(path.join(root, 'file.txt'), 'local\n');
    expect(await operate({ kind: 'branch.switch', name: 'topic', expectedHead: head })).toMatchObject({
      state: 'blocked',
      files: ['file.txt'],
    });
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('local\n');
    expect(git('branch', '--show-current')).toBe('main');
  });
  it('does not rename onto an existing branch and deletes a merged branch safely', async () => {
    git('branch', 'topic');
    expect(
      (
        await operate({
          kind: 'branch.rename',
          name: 'topic',
          newName: 'main',
          expectedHead: head,
          expectedRef: head,
          confirmed: true,
        })
      ).state
    ).toBe('error');
    expect(
      (await operate({ kind: 'branch.delete', name: 'topic', expectedHead: head, expectedRef: head, confirmed: true }))
        .state
    ).toBe('complete');
    expect(git('branch', '--list', 'topic')).toBe('');
  });
  it('shows and applies a stash without dropping it, then drops only its expected identity', async () => {
    await writeFile(path.join(root, 'file.txt'), 'stashed\n');
    git('stash', 'push', '-qm', 'saved');
    const hash = git('rev-parse', 'stash@{0}');
    expect((await operate({ kind: 'stash.show', ref: 'stash@{0}', expectedRef: hash })).data?.patch).toContain(
      '+stashed'
    );
    expect(
      (await operate({ kind: 'stash.apply', ref: 'stash@{0}', expectedRef: hash, expectedHead: head })).state
    ).toBe('complete');
    expect(git('rev-parse', 'stash@{0}')).toBe(hash);
    expect((await operate({ kind: 'stash.drop', ref: 'stash@{0}', expectedRef: hash, confirmed: true })).state).toBe(
      'complete'
    );
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('stashed\n');
  });
  it('requires the reviewed remote URL before replacing it and redacts existing credentials', async () => {
    git('remote', 'add', 'origin', 'https://example.test/old');
    expect(
      (
        await operate({
          kind: 'remote.setUrl',
          name: 'origin',
          url: 'https://example.test/new',
          expectedUrl: 'https://example.test/wrong',
          confirmed: true,
        })
      ).state
    ).toBe('blocked');
    expect(
      (
        await operate({
          kind: 'remote.setUrl',
          name: 'origin',
          url: 'https://example.test/new',
          expectedUrl: 'https://example.test/old',
          confirmed: true,
        })
      ).state
    ).toBe('complete');
    git('remote', 'set-url', 'origin', 'https://user:secret@example.test/repo?token=secret');
    expect(JSON.stringify(await operate({ kind: 'remote.list' }))).not.toContain('secret');
    expect((await operate({ kind: 'fetch', remote: 'origin' })).state).toBe('blocked');
  });
  it('pulls only a fast-forward and rejects a divergent remote without losing local commits', async () => {
    const bare = path.join(root, 'remote.git');
    git('init', '-q', '--bare', bare);
    git('remote', 'add', 'origin', bare);
    git('push', '-q', 'origin', 'main');
    const peer = path.join(root, 'peer');
    git('clone', '-q', '-b', 'main', bare, peer);
    const peerGit = (...args: string[]) => git('-C', peer, ...args);
    peerGit('config', 'user.name', 'Peer');
    peerGit('config', 'user.email', 'peer@example.test');
    peerGit('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(peer, 'peer.txt'), 'remote');
    peerGit('add', 'peer.txt');
    peerGit('commit', '-qm', 'remote');
    peerGit('push', '-q', 'origin', 'main');
    expect((await operate({ kind: 'pull', remote: 'origin', branch: 'main', expectedHead: head })).state).toBe(
      'complete'
    );
    await writeFile(path.join(root, 'local.txt'), 'local');
    git('add', 'local.txt');
    git('commit', '-qm', 'local');
    head = git('rev-parse', 'HEAD');
    await writeFile(path.join(peer, 'peer.txt'), 'new remote');
    peerGit('commit', '-qam', 'new remote');
    peerGit('push', '-q', 'origin', 'main');
    expect((await operate({ kind: 'pull', remote: 'origin', branch: 'main', expectedHead: head })).state).toBe('error');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(
      (await operate({ kind: 'push', remote: 'origin', branch: 'main', expectedHead: head, confirmed: true })).state
    ).toBe('error');
  });
  it('serializes checked preparation against operations in a linked worktree sharing refs', async () => {
    const linked = path.join(root, 'linked');
    git('worktree', 'add', '-q', '-b', 'linked', linked);
    await writeFile(path.join(root, 'file.txt'), 'changed\n');
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workflow = createCommitWorkflowService(createGitCommandService(), { run: repositoryCoordinator.run });
    const preparing = workflow.prepare({
      repoPath: root,
      branch: 'main',
      selectedPaths: ['file.txt'],
      scannerConfigs: [{ tool: 'clang-tidy', executablePath: 'unused', scope: 'selected', arguments: [] }],
      checks: { scanners: ['clang-tidy'], autoRepair: false, compile: false },
      scan: async () => {
        announce();
        await gate;
        return { tool: 'clang-tidy', diagnostics: [], exitCode: 0, stdout: '', stderr: '' };
      },
    });
    await started;
    const service = createGitOperationService({ resolveRoot: async () => linked });
    const creating = service.operate(scope, {
      kind: 'branch.create',
      name: 'after-check',
      startPoint: head,
      expectedHead: head,
    });
    expect(git('branch', '--list', 'after-check')).toBe('');
    release();
    expect((await preparing).state).toBe('confirmation');
    expect((await creating).state).toBe('complete');
  });
});
