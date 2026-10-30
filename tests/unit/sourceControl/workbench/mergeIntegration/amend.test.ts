import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitCommandService } from '@process/services/sourceControl/gitCommandService';
import { createCommitWorkflowService } from '@process/services/sourceControl/commitWorkflowService';

let root: string;
let head: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const fields = { reason: '修复', scope: 'driver', solution: 'change', impact: 'none', tests: 'verified' };
const prepare = (workflow: ReturnType<typeof createCommitWorkflowService>, expectedHead = head) =>
  workflow.prepare({
    repoPath: root,
    branch: 'main',
    selectedPaths: ['selected'],
    scannerConfigs: [],
    checks: { scanners: [], autoRepair: false, compile: false },
    messageFields: fields,
    mode: { kind: 'amend', expectedHead },
    scan: vi.fn(),
  });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-amend-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Committer');
  git('config', 'user.email', 'committer@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'selected'), 'old\n');
  await writeFile(path.join(root, 'other'), 'old other\n');
  git('add', '.');
  git('commit', '-qm', 'original', '--author=Original Author <original@example.test>');
  head = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'selected'), 'new\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('checked Amend', () => {
  it('amends only selected files once, retaining original author and unrelated staged/working bytes', async () => {
    await writeFile(path.join(root, 'other'), 'staged other\n');
    git('add', 'other');
    await writeFile(path.join(root, 'other'), 'working other\n');
    const workflow = createCommitWorkflowService(createGitCommandService());
    const session = await prepare(workflow);
    expect(session.state).toBe('confirmation');
    const [result, duplicate] = await Promise.all([
      workflow.commit(session.id, fields),
      workflow.commit(session.id, fields),
    ]);
    expect(result).toMatchObject({ state: 'completed', commit: duplicate.commit });
    expect({
      count: git('rev-list', '--count', 'HEAD'),
      author: git('show', '-s', '--format=%an <%ae>', 'HEAD'),
      selected: git('show', 'HEAD:selected'),
      committedOther: git('show', 'HEAD:other'),
      staged: git('show', ':other'),
      working: await readFile(path.join(root, 'other'), 'utf8'),
    }).toEqual({
      count: '1',
      author: 'Original Author <original@example.test>',
      selected: 'new',
      committedOther: 'old other',
      staged: 'staged other',
      working: 'working other\n',
    });
  });
  it('blocks an immutable target mismatch before scanning', async () => {
    const workflow = createCommitWorkflowService(createGitCommandService());
    expect(await prepare(workflow, 'a'.repeat(40))).toMatchObject({ state: 'blocked', reasonCode: 'snapshotChanged' });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
  it('records the successful commit when selected-index refresh fails, so confirmation cannot commit twice', async () => {
    const service = createGitCommandService(async (args, options) => {
      if (args[0] === 'reset') return { stdout: '', stderr: 'simulated index lock', exitCode: 1 };
      try {
        return {
          stdout: execFileSync('git', ['--literal-pathspecs', ...args], {
            ...options,
            encoding: 'utf8',
            windowsHide: true,
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
    });
    const workflow = createCommitWorkflowService(service);
    const session = await prepare(workflow);
    const result = await workflow.commit(session.id, fields);
    const created = git('rev-parse', 'HEAD');
    expect(result).toMatchObject({
      state: 'completed',
      commit: created,
      reason: expect.stringContaining('index lock'),
    });
    await workflow.commit(session.id, fields);
    expect(git('rev-parse', 'HEAD')).toBe(created);
  });
  it('rejects changed HEAD after preparation, including duplicate confirmation', async () => {
    const workflow = createCommitWorkflowService(createGitCommandService());
    const session = await prepare(workflow);
    git('commit', '--allow-empty', '-qm', 'external');
    const moved = git('rev-parse', 'HEAD');
    expect(await workflow.commit(session.id, fields)).toMatchObject({
      state: 'blocked',
      reasonCode: 'snapshotChanged',
    });
    await workflow.commit(session.id, fields);
    expect(git('rev-parse', 'HEAD')).toBe(moved);
  });
  it('rejects an unborn HEAD', async () => {
    git('checkout', '--orphan', 'unborn');
    const workflow = createCommitWorkflowService(createGitCommandService());
    const result = await workflow.prepare({
      repoPath: root,
      branch: 'unborn',
      selectedPaths: ['selected'],
      scannerConfigs: [],
      checks: { scanners: [], autoRepair: false, compile: false },
      messageFields: fields,
      mode: { kind: 'amend', expectedHead: head },
      scan: vi.fn(),
    });
    expect(result).toMatchObject({ state: 'blocked', reasonCode: 'snapshotChanged' });
  });
  it('keeps selected-file scan/build and all five required fields in Amend', async () => {
    const scan = vi.fn(async () => ({
      tool: 'clang-tidy' as const,
      diagnostics: [],
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    const compile = vi.fn(async () => ({ ok: true }));
    const workflow = createCommitWorkflowService(createGitCommandService());
    const session = await workflow.prepare({
      repoPath: root,
      branch: 'main',
      selectedPaths: ['selected'],
      mode: { kind: 'amend', expectedHead: head },
      scannerConfigs: [{ tool: 'clang-tidy', executablePath: 'test-scanner', scope: 'repository', arguments: [] }],
      checks: { scanners: ['clang-tidy'], autoRepair: false, compile: true },
      messageFields: fields,
      scan,
      compile,
    });
    expect({ scan: scan.mock.calls.length, compile: compile.mock.calls.length, state: session.state }).toEqual({
      scan: 1,
      compile: 1,
      state: 'confirmation',
    });
    expect(await workflow.commit(session.id, { ...fields, tests: '' })).toMatchObject({
      state: 'blocked',
      reason: 'Missing commit message field: tests',
    });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });
});
