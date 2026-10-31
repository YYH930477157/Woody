import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const repository = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'woody-literal-'));
  roots.push(root);
  await run('git', ['init'], { cwd: root });
  for (const directory of ['[id]', 'i']) {
    await mkdir(path.join(root, 'app', directory), { recursive: true });
    await writeFile(path.join(root, 'app', directory, 'page.tsx'), 'x');
  }
  await run('git', ['add', '.'], { cwd: root });
  return root;
};

describe('literal pathspecs', () => {
  it('matches a bracketed route folder exactly by default', async () => {
    const root = await repository();
    const { stdout } = await createGitExecutor()(root, ['ls-files', '--', 'app/[id]/page.tsx']);
    expect(stdout.trim().split('\n')).toEqual(['app/[id]/page.tsx']);
  });

  it('reads the same path as a glob without the literal flag, which only operations use', async () => {
    const root = await repository();
    const { stdout } = await createGitExecutor('git', false)(root, ['ls-files', '--', 'app/[id]/page.tsx']);
    expect(stdout).toContain('app/i/page.tsx');
  });
});
