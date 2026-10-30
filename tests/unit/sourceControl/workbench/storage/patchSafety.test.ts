import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePatch } from '@process/services/sourceControl/workbench/storage/patch';
import { fixture, git, scope } from './fixtures';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const patch = (name: string) =>
  `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..7898192\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+a\n`;

describe('shelf patch path safety', () => {
  it('decodes quoted octal UTF-8 and rejects control characters and traversal in every header', () => {
    const quoted = patch('x').replaceAll('a/x', '"a/\\346\\226\\260.txt"').replaceAll('b/x', '"b/\\346\\226\\260.txt"');
    expect(parsePatch(quoted)[0].file.path).toBe('新.txt');
    for (const name of ['../outside', '.git/config', 'folder/../../outside', '.GIT/config', 'git~1/config'])
      expect(() => parsePatch(patch(name))).toThrow();
    expect(() => parsePatch(patch('x').replaceAll('b/x', '"b/evil\\nfile"'))).toThrow();
  });

  it('keeps rename origins and rejects symlink, submodule, and inconsistent headers', () => {
    const rename =
      'diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\n';
    expect(parsePatch(rename)[0].file).toMatchObject({ path: 'new name', oldPath: 'old name', status: 'R' });
    expect(() => parsePatch(patch('normal').replace('100644', '120000'))).toThrow(/symlink/i);
    expect(() => parsePatch(patch('normal').replace('+++ b/normal', '+++ b/.git/config'))).toThrow();
  });

  it('rejects a junction that points outside the project before import and capture', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    const outside = path.join(f.storeDir, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(f.root, 'link'), 'junction');
    await expect(f.service.shelfImport(scope, { name: 'escape', patch: patch('link/target') })).rejects.toThrow(
      /symbolic/i
    );
    await expect(f.service.shelfCreate(scope, { name: 'escape', paths: ['link/target'] })).rejects.toThrow(/symbolic/i);
  });

  it('applies only explicitly selected shelf files and retains a recoverable original and active remainder', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    await writeFile(path.join(f.root, 'one.txt'), 'first edit\n');
    await writeFile(path.join(f.root, 'other.txt'), 'other edit\n');
    const item = await f.service.shelfCreate(scope, { name: 'two', paths: ['one.txt', 'other.txt'], rollback: true });
    await f.service.shelfApply(scope, { id: item.id, paths: ['one.txt'], removeApplied: true });
    expect(await readFile(path.join(f.root, 'other.txt'), 'utf8')).toBe('other\n');
    const remaining = (await f.service.shelfList(scope)).find((candidate) => !candidate.deleted)!;
    expect(remaining.files.map((file) => file.path)).toEqual(['other.txt']);
    expect((await f.service.shelfRead(scope, item.id)).item.files).toHaveLength(2);
  });

  it('imports and exports a binary patch and preserves the index during apply', async () => {
    const f = await fixture();
    cleanup.push(f.cleanup);
    await writeFile(path.join(f.root, 'one.txt'), 'new\n');
    const item = await f.service.shelfCreate(scope, { name: 'original', paths: ['one.txt'], rollback: true });
    const exported = await f.service.shelfExport(scope, { id: item.id });
    const imported = await f.service.shelfImport(scope, { name: 'imported', patch: exported });
    const index = await readFile(path.join(f.root, '.git/index'));
    await f.service.shelfApply(scope, { id: imported.id });
    expect(await readFile(path.join(f.root, '.git/index'))).toEqual(index);
    expect((await git(f.root, ['diff', '--', 'one.txt'])).stdout).toContain('+new');
  });
});
