import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { detectGit, prepareSourceOnlyOverlay } =
  require('../../../resources/bundled-mcp/codebase-memory/sourceFilter.cjs') as {
    detectGit(root: string): { topLevel: string; infoExclude: string } | null;
    prepareSourceOnlyOverlay(
      root: string,
      owner?: { indexLock: string; indexToken: string }
    ): {
      gitTrackedOnly: boolean;
      files: string[];
      cleanup(): { restored: boolean; conflict?: string };
    };
  };

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-source-filter-'));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('source-only index overlay', () => {
  it('hides untracked files, keeps tracked files visible, and restores original bytes', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'tracked.c'), 'int tracked(void) { return 1; }\n');
    fs.writeFileSync(path.join(root, 'src', 'untracked.c'), 'int untracked(void) { return 2; }\n');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'probe@example.invalid');
    git(root, 'config', 'user.name', 'probe');
    git(root, 'add', 'src/tracked.c');
    git(root, 'commit', '-qm', 'fixture');

    const excludePath = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
    const cbmignorePath = path.join(root, '.cbmignore');
    const excludeBefore = Buffer.from('# original exclude\r\n', 'utf8');
    const cbmignoreBefore = Buffer.from('# original cbmignore\r\n', 'utf8');
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.writeFileSync(excludePath, excludeBefore);
    fs.writeFileSync(cbmignorePath, cbmignoreBefore);

    const overlay = prepareSourceOnlyOverlay(root);
    expect(overlay.gitTrackedOnly).toBe(true);
    expect(overlay.files).toEqual(expect.arrayContaining([excludePath, cbmignorePath]));
    expect(git(root, 'check-ignore', '-v', 'src/untracked.c')).toContain('info/exclude');
    expect(() => git(root, 'check-ignore', '-v', 'src/tracked.c')).toThrow();
    expect(fs.readFileSync(cbmignorePath, 'utf8')).toMatch(/tests/);

    expect(overlay.cleanup()).toEqual({ restored: true });
    expect(fs.readFileSync(excludePath)).toEqual(excludeBefore);
    expect(fs.readFileSync(cbmignorePath)).toEqual(cbmignoreBefore);
  });

  it('falls back to source-only rules without Git in a non-Git folder', () => {
    const root = makeRoot();
    const overlay = prepareSourceOnlyOverlay(root);
    const cbmignorePath = path.join(root, '.cbmignore');

    expect(overlay.gitTrackedOnly).toBe(false);
    expect(overlay.files).toEqual([cbmignorePath]);
    expect(fs.existsSync(path.join(root, '.git', 'info', 'exclude'))).toBe(false);
    expect(fs.readFileSync(cbmignorePath, 'utf8')).toMatch(/__tests__/);

    expect(overlay.cleanup()).toEqual({ restored: true });
    expect(fs.existsSync(cbmignorePath)).toBe(false);
  });

  it('preserves external edits instead of overwriting them during cleanup', () => {
    const root = makeRoot();
    const cbmignorePath = path.join(root, '.cbmignore');
    fs.writeFileSync(cbmignorePath, '# user rules\n', 'utf8');
    const overlay = prepareSourceOnlyOverlay(root);

    fs.appendFileSync(cbmignorePath, '# external edit\n', 'utf8');

    const result = overlay.cleanup();
    expect(result.restored).toBe(false);
    expect(result.conflict).toContain('.cbmignore');
    expect(fs.readFileSync(cbmignorePath, 'utf8')).toContain('# external edit');
  });

  it('recognizes a linked Git worktree and uses its shared exclude path', () => {
    const main = makeRoot();
    const worktree = path.join(main, 'linked-worktree');
    fs.writeFileSync(path.join(main, 'tracked.c'), 'int tracked(void) { return 1; }\n');
    git(main, 'init', '-q');
    git(main, 'config', 'user.email', 'probe@example.invalid');
    git(main, 'config', 'user.name', 'probe');
    git(main, 'add', 'tracked.c');
    git(main, 'commit', '-qm', 'fixture');
    git(main, 'worktree', 'add', '-q', '-b', 'probe-worktree', worktree);

    const detected = detectGit(worktree);
    expect(detected).not.toBeNull();
    expect(detected?.topLevel).toBe(path.resolve(worktree));
    expect(detected?.infoExclude).toBe(path.resolve(main, '.git', 'info', 'exclude'));

    const overlay = prepareSourceOnlyOverlay(worktree);
    expect(overlay.gitTrackedOnly).toBe(true);
    expect(overlay.cleanup()).toEqual({ restored: true });
  });

  it('lets explicit user includes override the default directory filters', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, '.cbmignore'), '!/app/obj/\n');
    const overlay = prepareSourceOnlyOverlay(root);
    try {
      // Ask Git's ignore matcher to evaluate the generated rules independently
      // of the tracked-only overlay (the folder was not a repo at preparation).
      git(root, 'init', '-q');
      const args = ['-c', `core.excludesFile=${path.join(root, '.cbmignore')}`, 'check-ignore', '--no-index'];
      expect(() => git(root, ...args, 'app/obj/product.c')).toThrow();
      expect(git(root, ...args, 'tests/product.test.c')).toBe('tests/product.test.c');
    } finally {
      overlay.cleanup();
    }
  });

  it.each([
    ['GBK comments', Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])],
    ['mixed line endings', Buffer.from('# first\r\n# second\nlogs/')],
    ['UTF-8 BOM', Buffer.from('\uFEFF# user rules\r\n!/app/obj/')],
  ])('preserves %s byte for byte', (_name, original) => {
    const root = makeRoot();
    const filename = path.join(root, '.cbmignore');
    fs.writeFileSync(filename, original);
    const overlay = prepareSourceOnlyOverlay(root);
    expect(overlay.cleanup()).toEqual({ restored: true });
    expect(fs.readFileSync(filename)).toEqual(original);
  });

  it('rejects overlapping projects before touching an active shared Git filter', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    const nested = path.join(root, 'subproject');
    fs.mkdirSync(nested);
    const first = prepareSourceOnlyOverlay(root);
    const exclude = detectGit(root)!.infoExclude;
    const active = fs.readFileSync(exclude);
    try {
      expect(() => prepareSourceOnlyOverlay(nested)).toThrow(/already running.*Git repository/i);
      expect(fs.readFileSync(exclude)).toEqual(active);
      expect(fs.existsSync(path.join(nested, '.cbmignore'))).toBe(false);
    } finally {
      expect(first.cleanup()).toEqual({ restored: true });
    }
    expect(prepareSourceOnlyOverlay(nested).cleanup()).toEqual({ restored: true });
  });

  it('protects the Git filter from an index in another process', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    const nested = path.join(root, 'subproject');
    fs.mkdirSync(nested);
    const overlay = prepareSourceOnlyOverlay(root);
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    try {
      const output = execFileSync(
        process.execPath,
        [
          '-e',
          `try { require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1]); console.log('acquired'); } catch(e) { console.log(e.message); }`,
          nested,
        ],
        { encoding: 'utf8', windowsHide: true }
      );
      expect(output).toMatch(/already running.*Git repository/i);
    } finally {
      expect(overlay.cleanup()).toEqual({ restored: true });
    }
  });

  it('recovers an overlay left by an exited process', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    const exclude = detectGit(root)!.infoExclude;
    const original = fs.readFileSync(exclude);
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    execFileSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1]);`, root],
      { windowsHide: true }
    );
    expect(prepareSourceOnlyOverlay(root).cleanup()).toEqual({ restored: true });
    expect(fs.readFileSync(exclude)).toEqual(original);
    expect(fs.existsSync(path.join(root, '.cbmignore'))).toBe(false);
  });

  it('does not recover a dead adapter while its native child is still alive', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    const indexLock = path.join(root, 'index.lock');
    fs.mkdirSync(indexLock);
    fs.writeFileSync(path.join(indexLock, 'owner.json'), JSON.stringify({ token: 'test', childPid: process.pid }));
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    execFileSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1], { indexLock: process.argv[2], indexToken: 'test' });`,
        root,
        indexLock,
      ],
      { windowsHide: true }
    );
    expect(() => prepareSourceOnlyOverlay(root)).toThrow(/already running/i);
    fs.writeFileSync(
      path.join(indexLock, 'owner.json'),
      JSON.stringify({ token: 'replacement', childPid: process.pid })
    );
    expect(prepareSourceOnlyOverlay(root).cleanup()).toEqual({ restored: true });
  });

  it('refuses recovery when a recorded index owner cannot be read', () => {
    const root = makeRoot();
    const indexLock = path.join(root, 'index.lock');
    fs.mkdirSync(indexLock);
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    execFileSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1], { indexLock: process.argv[2], indexToken: 'test' });`,
        root,
        indexLock,
      ],
      { windowsHide: true }
    );
    fs.writeFileSync(path.join(indexLock, 'owner.json'), '{interrupted');
    const active = fs.readFileSync(path.join(root, '.cbmignore'));
    expect(() => prepareSourceOnlyOverlay(root)).toThrow(/already running/i);
    expect(fs.readFileSync(path.join(root, '.cbmignore'))).toEqual(active);
  });

  it('recovers when a dead writer left a journal temporary file', () => {
    const root = makeRoot();
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    execFileSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1]);`, root],
      { windowsHide: true }
    );
    const lock = path.join(root, '.cbmignore.woody-source-lock');
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    fs.writeFileSync(path.join(lock, `${owner.token}.tmp`), '{interrupted');
    expect(prepareSourceOnlyOverlay(root).cleanup()).toEqual({ restored: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('rejects a forged recovery target before modifying any file', () => {
    const root = makeRoot();
    const outside = path.join(makeRoot(), 'outside.txt');
    fs.writeFileSync(outside, 'original');
    const modulePath = path.resolve('resources/bundled-mcp/codebase-memory/sourceFilter.cjs');
    execFileSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(modulePath)}).prepareSourceOnlyOverlay(process.argv[1]);`, root],
      { windowsHide: true }
    );
    const ownerFile = path.join(root, '.cbmignore.woody-source-lock', 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    owner.layers.push({
      filename: outside,
      expected: Buffer.from('original').toString('base64'),
      restore: Buffer.from('overwritten').toString('base64'),
      originallyExists: true,
    });
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    expect(() => prepareSourceOnlyOverlay(root)).toThrow(/recovery.*target/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('original');
  });

  it('releases the shared lock and restores Git rules when the project filter cannot be prepared', () => {
    const root = makeRoot();
    git(root, 'init', '-q');
    const exclude = detectGit(root)!.infoExclude;
    const original = Buffer.from([0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
    fs.writeFileSync(exclude, original);
    fs.writeFileSync(path.join(root, '.cbmignore'), Buffer.from([0xff, 0xfe, 35, 0]));
    expect(() => prepareSourceOnlyOverlay(root)).toThrow(/UTF-16/);
    expect(fs.readFileSync(exclude)).toEqual(original);
    fs.unlinkSync(path.join(root, '.cbmignore'));
    expect(prepareSourceOnlyOverlay(root).cleanup()).toEqual({ restored: true });
  });

  it('allows independent repositories to index at the same time', () => {
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    git(firstRoot, 'init', '-q');
    git(secondRoot, 'init', '-q');
    const first = prepareSourceOnlyOverlay(firstRoot);
    const second = prepareSourceOnlyOverlay(secondRoot);
    expect(second.cleanup()).toEqual({ restored: true });
    expect(first.cleanup()).toEqual({ restored: true });
  });
});
