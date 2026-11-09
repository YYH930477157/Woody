import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const { detectGit, prepareSourceOnlyOverlay } =
  require('../../../resources/bundled-mcp/codebase-memory/sourceFilter.cjs') as {
    detectGit(root: string): { topLevel: string; infoExclude: string } | null;
    prepareSourceOnlyOverlay(root: string): {
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
});
