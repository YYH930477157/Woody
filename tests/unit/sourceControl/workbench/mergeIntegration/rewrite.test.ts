import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import type { GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';
import { createGitMergeService } from '@process/services/sourceControl/workbench/merge';
import { createGitCommandService } from '@process/services/sourceControl/gitCommandService';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
let storeDir: string;
let base: string;
let first: string;
let second: string;
let head: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const operate = (request: GitOperationRequest) =>
  createGitOperationService({ resolveRoot: async () => root, storeDir }).operate(scope, request);
const identity = () => ({ expectedHead: head, expectedBranch: 'main', confirmed: true as const });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "woody rewrite 'repo-"));
  storeDir = await mkdtemp(path.join(os.tmpdir(), "woody rewrite 'store-"));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'base'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'first'), 'first\n');
  git('add', '.');
  git('commit', '-qm', 'First subject\n\nFirst body', '--author=Original <original@example.test>');
  first = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'second'), 'second\n');
  git('add', '.');
  git('commit', '-qm', 'Second subject\n\nSecond body');
  second = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'third'), 'third\n');
  git('add', '.');
  git('commit', '-qm', 'Third');
  head = git('rev-parse', 'HEAD');
});
afterEach(async () => {
  await Promise.all([root, storeDir].map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
});
describe('pure historical rewrites', { timeout: 30_000 }, () => {
  it('blocks publication recovery after a symbolic branch moves while reflogs are disabled', async () => {
    git('config', 'core.logAllRefUpdates', 'false');
    await rm(path.join(root, '.git', 'logs'), { recursive: true, force: true });
    await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
    git('add', 'first');
    git('commit', '-qm', 'dependent');
    head = git('rev-parse', 'HEAD');
    const index = path.join(root, '.git', 'index');
    await chmod(index, 0o444);
    try {
      expect((await operate({ kind: 'history.drop', commits: [first], ...identity() })).state).toBe('blocked');
    } finally {
      await chmod(index, 0o600);
    }
    git('reset', '--soft', base);
    const staged = await readFile(index);
    const result = await operate({ kind: 'inspect' });
    expect(result.state).toBe('blocked');
    expect(result.output).toContain('External reference changed');
    expect(git('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git('rev-parse', 'HEAD')).toBe(base);
    expect(await readFile(index)).toEqual(staged);
    expect(await readdir(path.join(root, '.git'))).toContain('woody-history-pending.json');
  });
  it('blocks checked commits until a completed rewrite has published its index', async () => {
    const index = path.join(root, '.git', 'index');
    await chmod(index, 0o444);
    try {
      expect(
        (await operate({ kind: 'history.reword', commit: first, message: 'rewritten', ...identity() })).state
      ).toBe('blocked');
    } finally {
      await chmod(index, 0o600);
    }
    await writeFile(path.join(root, 'first'), 'new selected change\n');
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(root, ['first']);
    expect(await service.createCommit(root, ['first'], 'checked', snapshot)).toMatchObject({
      ok: false,
      kind: 'command-failed',
      stderr: expect.stringContaining('Inspect'),
    });
    expect(git('rev-parse', 'HEAD')).toBe(snapshot.head);
  });
  it.each(['list', 'read'] as const)(
    'recovers publication before the first merge %s after restart reads conflict stages',
    async (consumer) => {
      await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
      git('add', 'first');
      git('commit', '-qm', 'dependent');
      head = git('rev-parse', 'HEAD');
      const index = path.join(root, '.git', 'index');
      await chmod(index, 0o444);
      try {
        expect((await operate({ kind: 'history.drop', commits: [first], ...identity() })).state).toBe('blocked');
      } finally {
        await chmod(index, 0o600);
      }
      const merge = createGitMergeService({ resolveRoot: async () => root, storeDir });
      if (consumer === 'list') expect(await merge.list(scope)).toEqual({ files: ['first'], operation: 'rebase' });
      else
        expect(await merge.read(scope, 'first')).toMatchObject({
          file: 'first',
          operation: 'rebase',
          head: git('rev-parse', 'HEAD'),
        });
    }
  );
  it.each([false, true])(
    'retains and safely recovers failed index publication (external staging=%s)',
    async (externalStage) => {
      await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
      git('add', 'first');
      git('commit', '-qm', 'dependent');
      head = git('rev-parse', 'HEAD');
      const indexPath = path.join(root, '.git', 'index');
      await chmod(indexPath, 0o444);
      try {
        const result = await operate({ kind: 'history.drop', commits: [first], ...identity() });
        expect(result.state).toBe('blocked');
        expect(result.output).toContain('Recoverable Git state:');
        const journalPath = path.join(root, '.git', 'woody-history-pending.json');
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { workspace: string; phase: string };
        expect(journal.phase).toBe('ready');
        expect(await readFile(path.join(journal.workspace, 'git', 'index'))).not.toEqual(await readFile(indexPath));
        const stillBlocked = await operate({ kind: 'inspect' });
        expect(stillBlocked.state).toBe('blocked');
        expect(stillBlocked.output).toContain(journal.workspace);
        await chmod(indexPath, 0o600);
        if (externalStage) {
          await writeFile(path.join(root, 'first'), 'external staged value\n');
          git('add', 'first');
          const staged = await readFile(indexPath);
          const blocked = await operate({ kind: 'inspect' });
          expect(blocked.state).toBe('blocked');
          expect(blocked.output).toContain('External changes');
          expect(await readFile(indexPath)).toEqual(staged);
          expect(JSON.parse(await readFile(journalPath, 'utf8')).workspace).toBe(journal.workspace);
        } else {
          const recovered = await operate({ kind: 'inspect' });
          expect(recovered).toMatchObject({
            state: 'complete',
            data: { operation: 'rebase', branch: null },
            files: ['first'],
          });
          expect(recovered.data?.head).toBe(git('rev-parse', 'HEAD'));
          expect(await readdir(path.join(root, '.git'))).not.toContain('woody-history-pending.json');
          expect(
            (
              await operate({
                kind: 'history.abort',
                operation: 'rebase',
                expectedHead: git('rev-parse', 'HEAD'),
                expectedBranch: null,
                confirmed: true,
              })
            ).state
          ).toBe('complete');
          expect(git('rev-parse', 'HEAD')).toBe(head);
        }
      } finally {
        await chmod(indexPath, 0o600);
      }
    }
  );
  it.each(['start', 'continue', 'abort'] as const)(
    'excludes reset --soft at the final rewrite %s invocation without losing an empty authored commit',
    async (phase) => {
      git('reset', '--hard', base);
      git('commit', '--allow-empty', '-qm', 'Empty first', '--author=First Author <first@example.test>');
      first = git('rev-parse', 'HEAD');
      await writeFile(path.join(root, 'second'), 'second\n');
      git('add', 'second');
      git('commit', '-qm', 'Second');
      head = git('rev-parse', 'HEAD');
      await writeFile(
        path.join(root, '.git', 'hooks', 'commit-msg'),
        '#!/bin/sh\nmarker="$(git rev-parse --git-path woody-hook-failed)"\nif grep -q "rewritten blocked" "$1" && test ! -f "$marker"; then touch "$marker"; exit 1; fi\n',
        { mode: 0o755 }
      );
      if (phase !== 'start')
        expect(
          (await operate({ kind: 'history.reword', commit: first, message: 'rewritten blocked', ...identity() })).state
        ).toBe('error');
      const paused = git('rev-parse', 'HEAD');
      const executor = createGitExecutor('git', false);
      let attempted = false;
      let resetBlocked = false;
      const service = createGitOperationService({
        resolveRoot: async () => root,
        storeDir,
        git: async (cwd, args, allowed, options) => {
          if (args[0] === 'rebase' && (phase === 'start' ? args.includes('--interactive') : args[1] === `--${phase}`)) {
            attempted = true;
            try {
              git('reset', '--soft', base);
            } catch {
              resetBlocked = true;
            }
          }
          return executor(cwd, args, allowed, options);
        },
      });
      const result = await service.operate(
        scope,
        phase === 'start'
          ? { kind: 'history.reword', commit: first, message: 'rewritten safe', ...identity() }
          : {
              kind: phase === 'continue' ? 'history.continue' : 'history.abort',
              operation: 'rebase',
              expectedHead: paused,
              expectedBranch: null,
              confirmed: true,
            }
      );
      expect({
        state: result.state,
        attempted,
        resetBlocked,
        count: git('rev-list', '--count', 'HEAD'),
        author: git('show', '-s', '--format=%an', 'HEAD^'),
        tree: git('rev-parse', 'HEAD^{tree}'),
      }).toEqual({
        state: 'complete',
        attempted: true,
        resetBlocked: true,
        count: '3',
        author: 'First Author',
        tree: git('rev-parse', `${head}^{tree}`),
      });
      expect(await readdir(storeDir)).toEqual([]);
      expect(await readdir(path.join(root, '.git'))).not.toContain('HEAD.lock');
    }
  );
  it.each(['start', 'continue'] as const)(
    'keeps checkout excluded until the %s pause has been saved',
    async (phase) => {
      git('branch', 'unrelated', base);
      await writeFile(
        path.join(root, '.git', 'hooks', 'commit-msg'),
        '#!/bin/sh\ngrep -q "rewritten blocked" "$1" && exit 1\nexit 0\n',
        { mode: 0o755 }
      );
      if (phase === 'continue')
        expect(
          (await operate({ kind: 'history.reword', commit: first, message: 'rewritten blocked', ...identity() })).state
        ).toBe('error');
      let paused = git('rev-parse', 'HEAD');
      const executor = createGitExecutor('git', false);
      let returned = false;
      let attempted = false;
      let checkoutBlocked = false;
      const service = createGitOperationService({
        resolveRoot: async () => root,
        storeDir,
        git: async (cwd, args, allowed, options) => {
          if (returned && !attempted && args[0] === 'rev-parse' && args[1] === '--git-dir') {
            attempted = true;
            try {
              git('checkout', '-q', '--detach', base);
            } catch {
              checkoutBlocked = true;
            }
          }
          const result = await executor(cwd, args, allowed, options);
          if (args[0] === 'rebase' && (args[1] === '--continue' || args.includes('--interactive'))) {
            returned = true;
            paused = (await executor(cwd, ['rev-parse', 'HEAD'], false, options)).stdout.trim();
          }
          return result;
        },
      });
      const result = await service.operate(
        scope,
        phase === 'continue'
          ? {
              kind: 'history.continue',
              operation: 'rebase',
              expectedHead: paused,
              expectedBranch: null,
              confirmed: true,
            }
          : { kind: 'history.reword', commit: first, message: 'rewritten blocked', ...identity() }
      );
      expect(result.state).toBe('error');
      expect(attempted && checkoutBlocked).toBe(true);
      const [recoveryDir] = await readdir(storeDir);
      expect(JSON.parse(await readFile(path.join(storeDir, recoveryDir, 'recovery.json'), 'utf8')).pausedHead).toBe(
        paused
      );
      expect(git('rev-parse', 'HEAD')).toBe(paused);
    }
  );
  it.each(['continue', 'abort'] as const)('excludes a checkout at the final rebase %s invocation', async (action) => {
    git('branch', 'unrelated', base);
    await writeFile(
      path.join(root, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\nmarker="$(git rev-parse --git-path woody-hook-failed)"\nif grep -q "rewritten blocked" "$1" && test ! -f "$marker"; then touch "$marker"; exit 1; fi\n',
      { mode: 0o755 }
    );
    expect(
      (await operate({ kind: 'history.reword', commit: first, message: 'rewritten blocked', ...identity() })).state
    ).toBe('error');
    const paused = git('rev-parse', 'HEAD');
    const executor = createGitExecutor('git', false);
    let checkoutBlocked = false;
    const service = createGitOperationService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        if (args[0] === 'rebase' && args[1] === `--${action}`) {
          try {
            git('checkout', '-q', 'unrelated');
          } catch {
            checkoutBlocked = true;
          }
        }
        return executor(cwd, args, allowed, options);
      },
    });
    const result = await service.operate(scope, {
      kind: action === 'continue' ? 'history.continue' : 'history.abort',
      operation: 'rebase',
      expectedHead: paused,
      expectedBranch: null,
      confirmed: true,
    });
    expect({
      state: result.state,
      checkoutBlocked,
      unrelated: git('rev-parse', 'unrelated'),
      tree: git('rev-parse', 'main^{tree}'),
      work: await readFile(path.join(root, 'first'), 'utf8'),
      status: git('status', '--porcelain'),
    }).toEqual({
      state: 'complete',
      checkoutBlocked: true,
      unrelated: base,
      tree: git('rev-parse', `${head}^{tree}`),
      work: 'first\n',
      status: '',
    });
    expect(await readdir(path.join(root, '.git'))).not.toContain('index.lock');
    expect(await readdir(storeDir)).toEqual([]);
  });
  it('reports a second conflict during an ordinary rebase without requiring rewrite recovery files', async () => {
    git('checkout', '-qb', 'other', base);
    await writeFile(path.join(root, 'first'), 'other first\n');
    await writeFile(path.join(root, 'second'), 'other second\n');
    git('add', '.');
    git('commit', '-qm', 'Other branch');
    const target = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    expect((await operate({ kind: 'rebase', target, ...identity() })).state).toBe('conflict');
    await writeFile(path.join(root, 'first'), 'resolved first\n');
    git('add', 'first');
    const result = await operate({
      kind: 'history.continue',
      operation: 'rebase',
      expectedHead: git('rev-parse', 'HEAD'),
      expectedBranch: null,
      confirmed: true,
    });
    expect(result.state, result.output).toBe('conflict');
    expect(result.files).toContain('second');
    expect(git('show', 'main:first')).toBe('first');
    expect(git('diff', '--name-only', '--diff-filter=U')).toBe('second');
    expect(await readdir(storeDir)).toEqual([]);
  });

  it('rejects a HEAD changed at the actual rebase command before replacing Git todo', async () => {
    const executor = createGitExecutor('git', false);
    let external = '';
    let externalIndex: Buffer | undefined;
    const service = createGitOperationService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        if (args.includes('rebase') && args.includes('--interactive') && !external) {
          await writeFile(path.join(root, 'external'), 'valuable external\n');
          // Another linked context can update a shared branch while this worktree's HEAD is locked.
          externalIndex = await readFile(path.join(root, '.git', 'index'));
          const externalIndexFile = path.join(root, '.git', 'external-index');
          await writeFile(externalIndexFile, externalIndex);
          const externalContext = path.join(root, '.git', 'external-context');
          await mkdir(externalContext);
          await writeFile(path.join(externalContext, 'HEAD'), 'ref: refs/heads/main\n');
          await writeFile(path.join(externalContext, 'commondir'), `${path.join(root, '.git')}\n`);
          const externalGit = (externalArgs: string[]) =>
            execFileSync('git', externalArgs, {
              cwd: root,
              windowsHide: true,
              env: {
                ...process.env,
                GIT_INDEX_FILE: externalIndexFile,
                GIT_DIR: externalContext,
                GIT_COMMON_DIR: path.join(root, '.git'),
                GIT_WORK_TREE: root,
              },
              stdio: 'pipe',
            });
          externalGit(['add', 'external']);
          externalGit(['commit', '-qm', 'external']);
          external = git('rev-parse', 'HEAD');
        }
        return executor(cwd, args, allowed, options);
      },
    });
    const result = await service.operate(scope, {
      kind: 'history.reword',
      commit: first,
      message: 'reviewed',
      ...identity(),
    });
    expect(result.state).not.toBe('complete');
    expect({
      head: git('rev-parse', 'HEAD'),
      file: await readFile(path.join(root, 'external'), 'utf8'),
      index: await readFile(path.join(root, '.git', 'index')),
    }).toEqual({ head: external, file: 'valuable external\n', index: externalIndex });
  });
  it.each([
    ['attached', 'continue'],
    ['attached', 'abort'],
    ['detached', 'continue'],
    ['detached', 'abort'],
  ] as const)('rejects %s HEAD drift before owned rewrite %s', async (mode, action) => {
    git('branch', 'unrelated', base);
    await writeFile(
      path.join(root, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\nmarker="$(git rev-parse --git-path woody-hook-failed)"\nif grep -q "rewritten blocked" "$1" && test ! -f "$marker"; then touch "$marker"; exit 1; fi\n',
      { mode: 0o755 }
    );
    expect(
      (await operate({ kind: 'history.reword', commit: first, message: 'rewritten blocked', ...identity() })).state
    ).toBe('error');
    const paused = git('rev-parse', 'HEAD');
    if (mode === 'attached') git('checkout', '-q', 'unrelated');
    else git('checkout', '-q', '--detach', base);
    const index = await readFile(path.join(root, '.git', 'index'));
    const result = await operate({
      kind: action === 'continue' ? 'history.continue' : 'history.abort',
      operation: 'rebase',
      expectedHead: base,
      expectedBranch: mode === 'attached' ? 'unrelated' : null,
      confirmed: true,
    });
    expect(result.state, result.output).toBe('blocked');
    expect({
      main: git('rev-parse', 'main'),
      unrelated: git('rev-parse', 'unrelated'),
      current: git('rev-parse', 'HEAD'),
      index: await readFile(path.join(root, '.git', 'index')),
      helpers: (await readdir(storeDir)).length,
    }).toEqual({ main: head, unrelated: base, current: base, index, helpers: 1 });
    expect(result.output).toContain(paused);
    git('checkout', '-q', '--detach', paused);
    const restored = await operate({
      kind: action === 'continue' ? 'history.continue' : 'history.abort',
      operation: 'rebase',
      expectedHead: paused,
      expectedBranch: null,
      confirmed: true,
    });
    expect(restored.state, restored.output).toBe('complete');
    expect(git('rev-parse', 'unrelated')).toBe(base);
    expect(git('rev-parse', 'main^{tree}')).toBe(git('rev-parse', `${head}^{tree}`));
    expect(await readdir(storeDir)).toEqual([]);
  });
  it('rewords exact user message bytes safely and preserves original author/tree', async () => {
    const message = "中文 'quoted' $() `echo bad` & | ; %PATH%\n\n  exact whitespace  \n";
    const tree = git('rev-parse', 'HEAD^{tree}');
    const outcome = await operate({ kind: 'history.reword', commit: first, message, ...identity() });
    expect(outcome.state, outcome.output).toBe('complete');
    const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD~2'], { cwd: root, encoding: 'utf8' });
    expect(raw.slice(raw.indexOf('\n\n') + 2)).toBe(message);
    expect({
      author: git('show', '-s', '--format=%an <%ae>', 'HEAD~2'),
      tree: git('rev-parse', 'HEAD^{tree}'),
    }).toEqual({ author: 'Original <original@example.test>', tree });
  });
  it.each(['history.squash', 'history.fixup'] as const)(
    'combines contiguous existing commits with %s semantics',
    async (kind) => {
      const tree = git('rev-parse', 'HEAD^{tree}');
      const outcome = await operate({ kind, commits: [second, first], ...identity() });
      expect(outcome.state, outcome.output).toBe('complete');
      expect({
        count: git('rev-list', '--count', 'HEAD'),
        author: git('show', '-s', '--format=%an', 'HEAD^'),
        tree: git('rev-parse', 'HEAD^{tree}'),
      }).toEqual({ count: '3', author: 'Original', tree });
      expect(git('show', '-s', '--format=%B', 'HEAD^')).toBe(
        kind === 'history.fixup'
          ? 'First subject\n\nFirst body'
          : 'First subject\n\nFirst body\n\nSecond subject\n\nSecond body'
      );
    }
  );
  it('drops only selected commit', async () => {
    const outcome = await operate({ kind: 'history.drop', commits: [second], ...identity() });
    expect(outcome.state, outcome.output).toBe('complete');
    expect(git('ls-tree', '--name-only', 'HEAD')).toBe('base\nfirst\nthird');
  });
  it('blocks root commits and noncontiguous squash without changing HEAD', async () => {
    expect((await operate({ kind: 'history.drop', commits: [base], ...identity() })).state).toBe('blocked');
    expect((await operate({ kind: 'history.squash', commits: [first, head], ...identity() })).state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it('uses optional squash message bytes and preserves the oldest author', async () => {
    const message = 'Combined 中文\n\n keep trailing spaces  \n';
    const result = await operate({ kind: 'history.squash', commits: [first, second], message, ...identity() });
    expect(result.state, result.output).toBe('complete');
    const raw = execFileSync('git', ['cat-file', 'commit', 'HEAD^'], { cwd: root, encoding: 'utf8' });
    expect(raw.slice(raw.indexOf('\n\n') + 2)).toBe(message);
  });
  it.each(['untracked', 'staged', 'branch', 'head', 'foreign'] as const)(
    'blocks %s changes before mutation',
    async (change) => {
      const request: Extract<GitOperationRequest, { kind: 'history.reword' }> = {
        kind: 'history.reword',
        commit: first,
        message: 'changed',
        ...identity(),
      };
      if (change === 'untracked' || change === 'staged') {
        await writeFile(path.join(root, 'dirty'), 'preserve');
        if (change === 'staged') git('add', 'dirty');
      } else if (change === 'branch') git('checkout', '-qb', 'other');
      else if (change === 'head') git('commit', '--allow-empty', '-qm', 'external');
      else {
        git('checkout', '-qb', 'foreign', base);
        git('commit', '--allow-empty', '-qm', 'foreign');
        request.commit = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
      }
      const before = git('rev-parse', 'HEAD');
      expect((await operate(request)).state).toBe('blocked');
      expect(git('rev-parse', 'HEAD')).toBe(before);
    }
  );
  it('revalidates the reviewed branch after preparing helper files', async () => {
    const executor = createGitExecutor('git', false);
    let moved = false;
    const service = createGitOperationService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        const result = await executor(cwd, args, allowed, options);
        if (!moved && args[0] === 'rev-list') {
          moved = true;
          git('checkout', '-qb', 'external');
        }
        return result;
      },
    });
    const outcome = await service.operate(scope, {
      kind: 'history.reword',
      commit: first,
      message: 'changed',
      ...identity(),
    });
    expect(outcome.state).toBe('blocked');
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(await readdir(storeDir)).toEqual([]);
  });
  it('rejects a merge anywhere in the rewritten suffix', async () => {
    git('checkout', '-qb', 'side', first);
    await writeFile(path.join(root, 'side'), 'side');
    git('add', '.');
    git('commit', '-qm', 'side');
    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '-qm', 'merge', 'side');
    head = git('rev-parse', 'HEAD');
    const outcome = await operate({ kind: 'history.reword', commit: first, message: 'changed', ...identity() });
    expect(outcome).toMatchObject({ state: 'blocked', output: expect.stringContaining('non-linear') });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it.each(['continue', 'abort'] as const)(
    'retains helpers across conflict and restart until %s finishes',
    async (action) => {
      await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
      git('add', '.');
      git('commit', '-qm', 'Dependent change');
      head = git('rev-parse', 'HEAD');
      const outcome = await operate({ kind: 'history.drop', commits: [first], ...identity() });
      expect(outcome.state, outcome.output).toBe('conflict');
      expect((await readdir(storeDir)).length).toBe(1);
      if (action === 'continue') {
        await writeFile(path.join(root, 'first'), 'resolved intentionally\n');
        git('add', 'first');
      }
      const result = await operate({
        kind: action === 'continue' ? 'history.continue' : 'history.abort',
        operation: 'rebase',
        expectedHead: git('rev-parse', 'HEAD'),
        expectedBranch: null,
        confirmed: true,
      });
      expect({
        state: result.state,
        output: result.state === 'complete' ? '' : result.output,
        helpers: await readdir(storeDir),
        branch: git('symbolic-ref', '--short', 'HEAD'),
        recovered:
          action === 'abort'
            ? git('rev-parse', 'HEAD') === head
            : git('show', 'HEAD:first') === 'resolved intentionally',
      }).toEqual({ state: 'complete', output: '', helpers: [], branch: 'main', recovered: true });
    }
  );
  it('preserves originally empty commits when replaying history', async () => {
    git('commit', '--allow-empty', '-qm', 'Intentional empty');
    head = git('rev-parse', 'HEAD');
    const result = await operate({ kind: 'history.reword', commit: first, message: 'changed', ...identity() });
    expect(result.state, result.output).toBe('complete');
    expect({ count: git('rev-list', '--count', 'HEAD'), subject: git('show', '-s', '--format=%s', 'HEAD') }).toEqual({
      count: '5',
      subject: 'Intentional empty',
    });
  });
  it('retries a failed reword after restart instead of silently skipping the selected action', async () => {
    await writeFile(
      path.join(root, '.git', 'hooks', 'commit-msg'),
      '#!/bin/sh\nmarker="$(git rev-parse --git-path woody-hook-failed)"\nif grep -q "rewritten blocked" "$1" && test ! -f "$marker"; then\n  touch "$marker"\n  exit 1\nfi\n',
      { mode: 0o755 }
    );
    const result = await operate({
      kind: 'history.reword',
      commit: first,
      message: 'rewritten blocked\n',
      ...identity(),
    });
    expect(result.state).toBe('error');
    expect((await readdir(storeDir)).length).toBe(1);
    const continued = await operate({
      kind: 'history.continue',
      operation: 'rebase',
      expectedHead: git('rev-parse', 'HEAD'),
      expectedBranch: null,
      confirmed: true,
    });
    expect({
      state: continued.state,
      message: git('show', '-s', '--format=%B', 'HEAD~2'),
      helpers: await readdir(storeDir),
    }).toEqual({ state: 'complete', message: 'rewritten blocked', helpers: [] });
  });
  it.each([
    ['app', 'continue'],
    ['app', 'abort'],
    ['external', 'continue'],
    ['external', 'abort'],
  ] as const)(
    'does not apply stale recovery to an unrelated %s rebase on %s',
    async (source, action) => {
      await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
      git('add', '.');
      git('commit', '-qm', 'Dependent change');
      head = git('rev-parse', 'HEAD');
      expect((await operate({ kind: 'history.drop', commits: [first], ...identity() })).state).toBe('conflict');
      git('rebase', '--abort');
      git('checkout', '-qb', 'unrelated', base);
      await writeFile(path.join(root, 'first'), 'unrelated first\n');
      git('add', '.');
      git('commit', '-qm', 'Unrelated');
      const target = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('commit', '--allow-empty', '-qm', 'New main commit');
      head = git('rev-parse', 'HEAD');
      if (source === 'app') {
        const started = await operate({ kind: 'rebase', target, ...identity() });
        expect({ state: started.state, staleHelpers: await readdir(storeDir) }).toEqual({
          state: 'conflict',
          staleHelpers: [],
        });
      } else expect(() => git('rebase', target)).toThrow();
      if (action === 'continue') {
        await writeFile(path.join(root, 'first'), 'first\n');
        git('add', 'first');
      }
      const result = await operate({
        kind: action === 'continue' ? 'history.continue' : 'history.abort',
        operation: 'rebase',
        expectedHead: git('rev-parse', 'HEAD'),
        expectedBranch: null,
        confirmed: true,
      });
      expect(result.state, result.output).toBe('complete');
      expect({
        branch: git('symbolic-ref', '--short', 'HEAD'),
        correctHead:
          action === 'abort'
            ? git('rev-parse', 'HEAD') === head
            : git('merge-base', '--is-ancestor', target, 'HEAD') === '',
        helpers: await readdir(storeDir),
      }).toEqual({ branch: 'main', correctHead: true, helpers: [] });
    },
    30000
  );
  it.each(['continue', 'abort'] as const)(
    'retains the true rewrite branch guard on %s after restart',
    async (action) => {
      await writeFile(path.join(root, 'first'), 'depends on dropped first\n');
      git('add', '.');
      git('commit', '-qm', 'Dependent change');
      head = git('rev-parse', 'HEAD');
      expect((await operate({ kind: 'history.drop', commits: [first], ...identity() })).state).toBe('conflict');
      if (action === 'continue') {
        await writeFile(path.join(root, 'first'), 'resolved\n');
        git('add', 'first');
      }
      git('update-ref', 'refs/heads/main', base, head);
      const result = await operate({
        kind: action === 'continue' ? 'history.continue' : 'history.abort',
        operation: 'rebase',
        expectedHead: git('rev-parse', 'HEAD'),
        expectedBranch: null,
        confirmed: true,
      });
      expect(result).toMatchObject({
        state: 'blocked',
        output: expect.stringContaining('Original rewrite branch changed'),
      });
      expect((await readdir(storeDir)).length).toBe(1);
    }
  );
  it('respects configured signing and retains recovery after signing failure', async () => {
    git('config', 'commit.gpgsign', 'true');
    git('config', 'gpg.program', path.join(storeDir, 'missing-gpg-program.exe'));
    const result = await operate({
      kind: 'history.reword',
      commit: first,
      message: 'Signed replacement\n',
      ...identity(),
    });
    expect(result.state).not.toBe('complete');
    expect((await readdir(storeDir)).length).toBe(1);
    const aborted = await operate({
      kind: 'history.abort',
      operation: 'rebase',
      expectedHead: git('rev-parse', 'HEAD'),
      expectedBranch: null,
      confirmed: true,
    });
    expect(aborted.state, aborted.output).toBe('complete');
    // Stand in for the GPG signing protocol without accessing the user's keyring.
    const signer = path.join(root, '.git', 'test-signer.sh');
    await writeFile(
      signer,
      '#!/bin/sh\ncat >/dev/null\nprintf "%s\\n" "-----BEGIN PGP SIGNATURE-----" "test-signature" "-----END PGP SIGNATURE-----"\nprintf "%s\\n" "[GNUPG:] SIG_CREATED D 1 10 00 0 0000000000000000000000000000000000000000" >&2\n',
      { mode: 0o755 }
    );
    git('config', 'gpg.program', signer);
    const retried = await operate({
      kind: 'history.reword',
      commit: first,
      message: 'Signed replacement\n',
      ...identity(),
    });
    expect(retried.state, retried.output).toBe('complete');
    expect({
      message: git('show', '-s', '--format=%B', 'HEAD~2'),
      helpers: await readdir(storeDir),
      signed: git('cat-file', 'commit', 'HEAD~2').includes('gpgsig -----BEGIN PGP SIGNATURE-----'),
    }).toEqual({ message: 'Signed replacement', helpers: [], signed: true });
  });
});
