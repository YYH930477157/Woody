import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepositoryCoordinator } from '@/process/services/sourceControl/workbench/coordinator';
import { createGitExecutor } from '@/process/services/sourceControl/workbench/executor';
import {
  createTeamWorktreeService,
  teamWorktreeSlug,
} from '@/process/services/sourceControl/workbench/operations/teamWorktree';

const execFileAsync = promisify(execFile);
const run = async (cwd: string, args: string[]): Promise<string> =>
  (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();

let parent: string;
let repo: string;
const executor = createGitExecutor('git', false);
const service = createTeamWorktreeService({
  git: executor,
  run: createRepositoryCoordinator(undefined, executor).run,
  now: () => new Date(2026, 10, 15, 22, 45, 12),
});

beforeEach(async () => {
  parent = await realpath(await mkdtemp(path.join(tmpdir(), 'woody-team-worktree-')));
  repo = path.join(parent, 'project');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await run(repo, ['init', '-q', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Woody Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await run(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, '.gitignore'), 'build/\n');
  await writeFile(path.join(repo, 'src', 'sensor.c'), 'int sensor = 1;\n');
  await writeFile(path.join(repo, 'src', 'uart.c'), 'int uart = 1;\n');
  await run(repo, ['add', '.']);
  await run(repo, ['commit', '-q', '-m', 'base']);
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const createTeam = async (name = 'Sensor') => {
  const result = await service.create(path.join(repo, 'src'), name);
  if (result.state !== 'complete') throw new Error(result.output);
  return result.worktree;
};
const commit = async (cwd: string, file: string, text: string, message: string) => {
  await writeFile(path.join(cwd, file), text);
  await run(cwd, ['commit', '-q', '-am', message]);
};

describe('team worktrees', { timeout: 30_000 }, () => {
  it('name branches and folders in ASCII, falling back to the time for other names', () => {
    const now = new Date(2026, 10, 15, 22, 45, 12);
    expect(teamWorktreeSlug('Sensor Threshold!', now)).toBe('sensor-threshold');
    expect(teamWorktreeSlug('报警阈值', now)).toBe('team-20261115-224512');
  });

  it('inspect the repository around a chosen folder', async () => {
    expect(await service.inspect(path.join(repo, 'src'))).toMatchObject({ root: repo, branch: 'main', dirty: false });
    await writeFile(path.join(repo, 'notes.txt'), 'x');
    expect((await service.inspect(repo))?.dirty).toBe(true);
    expect(await service.inspect(parent)).toBeNull();
    expect(await service.inspect('relative/path')).toBeNull();
    expect(await service.inspect(path.join(parent, 'missing'))).toBeNull();
  });

  it('create a sibling folder on a new branch, keeping the chosen subfolder', async () => {
    const created = await createTeam();
    expect(created).toEqual({
      worktree: path.join(parent, 'project-sensor'),
      workspace: path.join(parent, 'project-sensor', 'src'),
      branch: 'team/sensor',
      base: 'main',
    });
    expect(await readFile(path.join(created.workspace, 'sensor.c'), 'utf8')).toBe('int sensor = 1;\n');
    // The same name again gets new names instead of touching the first.
    expect((await createTeam()).branch).toBe('team/sensor-2');
    expect(await service.describe(repo)).toBeNull();
    expect(await service.describe(created.worktree)).toMatchObject({ branch: 'team/sensor', base: 'main', ahead: 0 });
  });

  it('refuse to start from a detached HEAD', async () => {
    await run(repo, ['checkout', '-q', '--detach']);
    expect(await service.create(repo, 'Sensor')).toMatchObject({ state: 'blocked', reason: 'detached' });
  });

  it('fast-forward the base branch and its folder when only the team changed', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'raise sensor');
    expect(await service.describe(worktree)).toMatchObject({ ahead: 1, behind: 0 });
    expect(await service.merge(worktree)).toMatchObject({ state: 'complete', reason: 'merged' });
    expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(await run(worktree, ['rev-parse', 'HEAD']));
    expect(await readFile(path.join(repo, 'src', 'sensor.c'), 'utf8')).toBe('int sensor = 2;\n');
    expect(await service.merge(worktree)).toMatchObject({ state: 'complete', reason: 'upToDate' });
  });

  it('build a merge commit on the base branch when both changed other files', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'team change');
    const before = await run(repo, ['rev-parse', 'HEAD']);
    await commit(repo, 'src/uart.c', 'int uart = 2;\n', 'main change');
    const mainHead = await run(repo, ['rev-parse', 'HEAD']);
    expect(mainHead).not.toBe(before);
    expect(await service.merge(worktree)).toMatchObject({ state: 'complete', reason: 'merged' });
    // First parent stays on the base branch.
    expect(await run(repo, ['rev-parse', 'HEAD^1'])).toBe(mainHead);
    expect(await run(repo, ['rev-parse', 'HEAD^2'])).toBe(await run(worktree, ['rev-parse', 'HEAD']));
    expect(await readFile(path.join(repo, 'src', 'sensor.c'), 'utf8')).toBe('int sensor = 2;\n');
    expect(await run(repo, ['status', '--porcelain'])).toBe('');
  });

  it('send conflicts to the team folder, then fast-forward once they are resolved', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'team change');
    await commit(repo, 'src/sensor.c', 'int sensor = 3;\n', 'main change');
    const mainHead = await run(repo, ['rev-parse', 'HEAD']);
    expect(await service.merge(worktree)).toMatchObject({
      state: 'conflict',
      reason: 'resolveInWorktree',
      files: ['src/sensor.c'],
    });
    expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(mainHead);
    expect(await service.merge(worktree)).toMatchObject({ state: 'blocked', reason: 'operationInProgress' });
    await writeFile(path.join(worktree, 'src', 'sensor.c'), 'int sensor = 4;\n');
    await run(worktree, ['add', 'src/sensor.c']);
    await run(worktree, ['commit', '-q', '--no-edit']);
    expect(await service.merge(worktree)).toMatchObject({ state: 'complete', reason: 'merged' });
    expect(await readFile(path.join(repo, 'src', 'sensor.c'), 'utf8')).toBe('int sensor = 4;\n');
  });

  it('block on uncommitted team changes and on base folder changes the merge would overwrite', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'team change');
    await writeFile(path.join(worktree, 'src', 'uart.c'), 'dirty\n');
    expect(await service.merge(worktree)).toMatchObject({ state: 'blocked', reason: 'dirtyWorktree' });
    await run(worktree, ['checkout', '--', 'src/uart.c']);
    const mainHead = await run(repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(repo, 'src', 'sensor.c'), 'local edit\n');
    expect(await service.merge(worktree)).toMatchObject({ state: 'blocked', reason: 'baseLocalChanges' });
    expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(mainHead);
    expect(await readFile(path.join(repo, 'src', 'sensor.c'), 'utf8')).toBe('local edit\n');
  });

  it('move only the reference when no folder has the base branch checked out', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'team change');
    await run(repo, ['switch', '-q', '-c', 'other']);
    expect(await service.merge(worktree)).toMatchObject({ state: 'complete', reason: 'merged' });
    expect(await run(repo, ['rev-parse', 'main'])).toBe(await run(worktree, ['rev-parse', 'HEAD']));
    expect(await run(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('other');
  });

  it('remove a merged worktree, and an unmerged one only when discarding', async () => {
    const { worktree } = await createTeam();
    await commit(worktree, 'src/sensor.c', 'int sensor = 2;\n', 'team change');
    await mkdir(path.join(worktree, 'build'));
    await writeFile(path.join(worktree, 'build', 'out.o'), 'object');
    expect(await service.remove(worktree, false)).toMatchObject({ state: 'blocked', reason: 'unmerged' });
    expect(await service.remove(worktree, true)).toMatchObject({ state: 'complete', reason: 'removed' });
    expect(existsSync(worktree)).toBe(false);
    expect(await run(repo, ['branch', '--list', 'team/sensor'])).toBe('');
    expect(await run(repo, ['config', '--get-regexp', 'woodybase']).catch(() => '')).toBe('');

    const second = await createTeam('Uart');
    await commit(second.worktree, 'src/uart.c', 'int uart = 2;\n', 'team change');
    expect(await service.merge(second.worktree)).toMatchObject({ state: 'complete' });
    expect(await service.remove(second.worktree, false)).toMatchObject({ state: 'complete' });
    expect(existsSync(second.worktree)).toBe(false);
    expect(await readFile(path.join(repo, 'src', 'uart.c'), 'utf8')).toBe('int uart = 2;\n');
  });

  it('discard a prepared worktree only while it is unused', async () => {
    const fresh = await createTeam();
    expect(await service.discard(fresh.worktree)).toBe(true);
    expect(existsSync(fresh.worktree)).toBe(false);
    const used = await createTeam('Used');
    await commit(used.worktree, 'src/sensor.c', 'int sensor = 2;\n', 'work');
    expect(await service.discard(used.worktree)).toBe(false);
    expect(await service.discard(repo)).toBe(false);
    expect(await service.discard(used.workspace)).toBe(false);
    expect(existsSync(used.worktree)).toBe(true);
  });
});
