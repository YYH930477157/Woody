import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitCommandService } from '@process/services/sourceControl/gitCommandService';

let root: string;
let head: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
type Runner = NonNullable<Parameters<typeof createGitCommandService>[0]>;
const delegate: Runner = async (args, options) => {
  try {
    return {
      stdout: execFileSync('git', ['--literal-pathspecs', ...args], {
        ...options,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      exitCode: failure.status ?? 1,
    };
  }
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-commit-safety-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Committer');
  git('config', 'user.email', 'committer@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'selected'), 'old\n');
  await writeFile(path.join(root, 'other'), 'old\n');
  git('add', '.');
  git('commit', '-qm', 'reviewed', '--author=Original <original@example.test>');
  head = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'selected'), 'reviewed change\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
describe('atomic checked commit publication', () => {
  it.each([
    { depth: 1, amend: false },
    { depth: 2, amend: true },
    { depth: 1, amend: true },
  ])('preserves shallow history topology (depth=$depth, amend=$amend)', async ({ depth, amend }) => {
    git('commit', '--allow-empty', '-qm', 'second');
    git('commit', '--allow-empty', '-qm', 'third');
    const clone = path.join(root, 'shallow-clone');
    git('clone', '--depth', String(depth), pathToFileURL(root).href, clone);
    const clonedGit = (...args: string[]) =>
      execFileSync('git', args, { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    clonedGit('config', 'user.name', 'Clone Committer');
    clonedGit('config', 'user.email', 'clone@example.test');
    clonedGit('config', 'commit.gpgsign', 'false');
    clonedGit('config', 'core.autocrlf', 'false');
    await writeFile(path.join(clone, 'selected'), 'shallow reviewed contents\n');
    const original = clonedGit('rev-parse', 'HEAD');
    const originalParents = clonedGit('cat-file', 'commit', 'HEAD')
      .split('\n\n', 1)[0]
      .split('\n')
      .filter((line) => line.startsWith('parent '));
    const originalIndex = await readFile(path.join(clone, '.git', 'index'));
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(clone, ['selected']);
    const result = await service.createCommit(
      clone,
      ['selected'],
      'shallow checked commit',
      snapshot,
      amend ? { kind: 'amend', expectedHead: original } : undefined
    );
    if (depth === 1 && amend) {
      expect(result).toMatchObject({
        ok: false,
        kind: 'command-failed',
        stderr: expect.stringContaining('Deepen the clone'),
      });
      expect(clonedGit('rev-parse', 'HEAD')).toBe(original);
      expect(await readFile(path.join(clone, '.git', 'index'))).toEqual(originalIndex);
      expect(await readFile(path.join(clone, 'selected'), 'utf8')).toBe('shallow reviewed contents\n');
    } else {
      expect(result).toEqual({ ok: true, commit: clonedGit('rev-parse', 'HEAD') });
      expect(
        clonedGit('cat-file', 'commit', 'HEAD')
          .split('\n\n', 1)[0]
          .split('\n')
          .filter((line) => line.startsWith('parent '))
      ).toEqual(amend ? originalParents : [`parent ${original}`]);
      expect(clonedGit('show', 'HEAD:selected')).toBe('shallow reviewed contents');
      expect(clonedGit('diff', '--cached', '--name-only')).toBe('');
    }
  });
  it.each([false, true])(
    'preserves an external commit created immediately before construction (amend=%s)',
    async (amend) => {
      let external = '';
      let externalIndex: Buffer | undefined;
      const service = createGitCommandService(async (args, options) => {
        if (args[0] === 'commit' && !external) {
          await writeFile(path.join(root, 'other'), 'VALUABLE EXTERNAL COMMIT\n');
          git('add', 'other');
          git('commit', '-qm', 'external', '--author=External <external@example.test>');
          external = git('rev-parse', 'HEAD');
          externalIndex = await readFile(path.join(root, '.git', 'index'));
        }
        return delegate(args, options);
      });
      const snapshot = await service.getCommitSnapshot(root, ['selected']);
      const result = await service.createCommit(
        root,
        ['selected'],
        'reviewed message',
        snapshot,
        amend ? { kind: 'amend', expectedHead: head } : undefined
      );
      expect(result).toMatchObject({ ok: false, kind: 'snapshot-changed' });
      expect({
        head: git('rev-parse', 'HEAD'),
        other: git('show', 'HEAD:other'),
        author: git('show', '-s', '--format=%an', 'HEAD'),
        selected: await readFile(path.join(root, 'selected'), 'utf8'),
        index: await readFile(path.join(root, '.git', 'index')),
      }).toEqual({
        head: external,
        other: 'VALUABLE EXTERNAL COMMIT',
        author: 'External',
        selected: 'reviewed change\n',
        index: externalIndex,
      });
    }
  );
  it('does not publish to a branch switched immediately before construction', async () => {
    let switched = false;
    const service = createGitCommandService(async (args, options) => {
      if (args[0] === 'commit' && !switched) {
        switched = true;
        git('checkout', '-qb', 'other-branch');
      }
      return delegate(args, options);
    });
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(
      await service.createCommit(root, ['selected'], 'reviewed message', snapshot, {
        kind: 'amend',
        expectedHead: head,
      })
    ).toMatchObject({ ok: false, kind: 'snapshot-changed' });
    expect({
      branch: git('symbolic-ref', '--short', 'HEAD'),
      main: git('rev-parse', 'main'),
      other: git('rev-parse', 'other-branch'),
    }).toEqual({ branch: 'other-branch', main: head, other: head });
  });
  it('runs branch-sensitive hooks against the reviewed branch and original working directory', async () => {
    await writeFile(
      path.join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ntest "$(git symbolic-ref --short HEAD)" = main || exit 1\ntest "$(cat selected)" = "reviewed change" || exit 2\n',
      { mode: 0o755 }
    );
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(
      await service.createCommit(root, ['selected'], 'reviewed message', snapshot, {
        kind: 'amend',
        expectedHead: head,
      })
    ).toMatchObject({ ok: true });
    expect(git('show', '-s', '--format=%an', 'HEAD')).toBe('Original');
  });
  it('rejects hook-added unreviewed content before publishing the candidate', async () => {
    await writeFile(path.join(root, 'other'), 'unreviewed\n');
    await writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ngit add other\n', { mode: 0o755 });
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(
      await service.createCommit(root, ['selected'], 'reviewed message', snapshot, {
        kind: 'amend',
        expectedHead: head,
      })
    ).toMatchObject({ ok: false, kind: 'snapshot-changed' });
    expect({ head: git('rev-parse', 'HEAD'), staged: git('diff', '--cached', '--name-only') }).toEqual({
      head,
      staged: '',
    });
  });
  it('preserves selected staging changed during construction and returns the published identity with a warning', async () => {
    let staged = false;
    const service = createGitCommandService(async (args, options) => {
      if (args[0] === 'commit' && !staged) {
        staged = true;
        await writeFile(path.join(root, 'selected'), 'external staged\n');
        git('add', 'selected');
        await writeFile(path.join(root, 'selected'), 'external working\n');
      }
      return delegate(args, options);
    });
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    const result = await service.createCommit(root, ['selected'], 'reviewed message', snapshot, {
      kind: 'amend',
      expectedHead: head,
    });
    expect(result).toMatchObject({ ok: true, commit: git('rev-parse', 'HEAD'), warning: expect.any(String) });
    expect({
      committed: git('show', 'HEAD:selected'),
      staged: git('show', ':selected'),
      working: await readFile(path.join(root, 'selected'), 'utf8'),
    }).toEqual({ committed: 'reviewed change', staged: 'external staged', working: 'external working\n' });
  });
  it('honors configured signing failures without publishing an unsigned amendment', async () => {
    git('config', 'commit.gpgsign', 'true');
    git('config', 'gpg.program', path.join(root, '.git', 'missing-signer.exe'));
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(
      await service.createCommit(root, ['selected'], 'reviewed message', snapshot, {
        kind: 'amend',
        expectedHead: head,
      })
    ).toMatchObject({ ok: false, kind: 'command-failed' });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it('keeps an unfinished merge and its staged resolution intact instead of creating a single-parent commit', async () => {
    git('checkout', '-qb', 'side');
    await writeFile(path.join(root, 'other'), 'merge-side change\n');
    git('add', 'other');
    git('commit', '-qm', 'side');
    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '--no-commit', 'side');
    const index = await readFile(path.join(root, '.git', 'index'));
    const mergeHead = await readFile(path.join(root, '.git', 'MERGE_HEAD'));
    const service = createGitCommandService();
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(await service.createCommit(root, ['selected'], 'checked during merge', snapshot)).toMatchObject({
      ok: false,
      kind: 'command-failed',
      stderr: expect.stringContaining('in progress'),
    });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(path.join(root, '.git', 'MERGE_HEAD'))).toEqual(mergeHead);
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(index);
  });
  it.each([false, true])(
    'publishes a detached commit with immutable parents and an accurate HEAD reflog (amend=%s)',
    async (amend) => {
      git('checkout', '--detach', '-q');
      const service = createGitCommandService();
      const snapshot = await service.getCommitSnapshot(root, ['selected']);
      const result = await service.createCommit(
        root,
        ['selected'],
        'detached reviewed message',
        snapshot,
        amend ? { kind: 'amend', expectedHead: head } : undefined
      );
      expect(result).toEqual({ ok: true, commit: git('rev-parse', 'HEAD') });
      expect({
        main: git('rev-parse', 'main'),
        parents: git('show', '-s', '--format=%P', 'HEAD'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        reflog: git('reflog', '-1', '--format=%H'),
      }).toEqual({ main: head, parents: amend ? '' : head, tree: snapshot.tree, reflog: git('rev-parse', 'HEAD') });
      expect(git('diff', '--cached', '--name-only')).toBe('');
    }
  );
  it("preserves another writer's index lock and reports the published commit with a warning", async () => {
    const index = await readFile(path.join(root, '.git', 'index'));
    const lock = path.join(root, '.git', 'index.lock');
    let injected = false;
    const service = createGitCommandService(async (args, options) => {
      if (args[0] === 'commit' && !injected) {
        injected = true;
        await writeFile(lock, 'owned by another writer');
      }
      return delegate(args, options);
    });
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    expect(await service.createCommit(root, ['selected'], 'reviewed message', snapshot)).toMatchObject({
      ok: true,
      commit: git('rev-parse', 'HEAD'),
      warning: expect.any(String),
    });
    expect(await readFile(lock, 'utf8')).toBe('owned by another writer');
    expect(await readFile(path.join(root, '.git', 'index'))).toEqual(index);
  });
  it('returns the captured candidate and refreshes from it when another context moves the branch after publication', async () => {
    let candidate = '';
    let external = '';
    const service = createGitCommandService(async (args, options) => {
      const result = await delegate(args, options);
      if (args[0] === 'update-ref' && result.exitCode === 0 && !candidate) {
        candidate = git('rev-parse', 'HEAD');
        const originalTree = git('rev-parse', `${head}^{tree}`);
        external = execFileSync(
          'git',
          ['commit-tree', originalTree, '-p', candidate, '-m', 'external after publication'],
          { ...options, encoding: 'utf8' }
        ).trim();
        await delegate(['update-ref', 'refs/heads/main', external, candidate], options);
      }
      return result;
    });
    const snapshot = await service.getCommitSnapshot(root, ['selected']);
    const result = await service.createCommit(root, ['selected'], 'reviewed message', snapshot);
    expect(result).toEqual({ ok: true, commit: candidate });
    expect(git('rev-parse', 'HEAD')).toBe(external);
    expect(git('show', ':selected')).toBe('reviewed change');
  });
});
