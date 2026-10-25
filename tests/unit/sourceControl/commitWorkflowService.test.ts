import { describe, expect, it, vi } from 'vitest';

import type { StaticScanConfig, StaticScanResult } from '@/common/types/sourceControl/staticScanTypes';
import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';

const config: StaticScanConfig = {
  tool: 'clang-tidy',
  executablePath: 'clang-tidy',
  scope: 'selected',
  arguments: [],
};

const clean = (): StaticScanResult => ({
  tool: 'clang-tidy',
  diagnostics: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
});

const finding = (): StaticScanResult => ({
  tool: 'clang-tidy',
  diagnostics: [
    {
      tool: 'clang-tidy',
      file: 'src/a.cpp',
      line: 4,
      severity: 'warning',
      message: 'use nullptr',
      rule: 'modernize-use-nullptr',
    },
  ],
  stdout: '',
  stderr: '',
  exitCode: 1,
});

const fields = {
  reason: '【BUG[x]】修复空指针',
  scope: '【驱动】',
  solution: '补充空指针判断',
  impact: '【无影响】',
  tests: '运行单元测试',
};

const snapshot = { head: 'head-1', branch: 'main', tree: 'tree-1' };
const getCommitSnapshot = () => vi.fn().mockResolvedValue(snapshot);

describe('commit workflow service', () => {
  it.each([false, true])('allows no scanners with compile=%s without running repair', async (compileEnabled) => {
    const scan = vi.fn();
    const repair = vi.fn();
    const compile = vi.fn().mockResolvedValue({ ok: true });
    const createCommit = vi.fn().mockResolvedValue({ ok: true, commit: 'abc123' });
    const states: string[] = [];
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit,
      push: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      checks: { scanners: [], compile: compileEnabled, autoRepair: true },
      messageFields: fields,
      scan,
      repair,
      compile,
      onStateChange: (state) => states.push(state),
    });
    expect(session.state).toBe('confirmation');
    expect(scan).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(compileEnabled ? 1 : 0);
    expect(states).toEqual(compileEnabled ? ['collecting', 'compile', 'confirmation'] : ['collecting', 'confirmation']);
    await service.commitAndPush(session.id, fields);
    expect(createCommit).toHaveBeenCalledWith('D:/repo', ['src/a.cpp'], expect.any(String), snapshot);
  });

  it.each(['tree', 'head', 'branch'] as const)('still detects %s changes with every check disabled', async (key) => {
    const service = createCommitWorkflowService({
      getCommitSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue({ ...snapshot, [key]: 'changed' }),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [],
      checks: { scanners: [], compile: false, autoRepair: false },
      messageFields: fields,
      scan: vi.fn(),
    });
    expect(session).toMatchObject({ state: 'blocked', reasonCode: 'snapshotChanged' });
  });

  it('reports remaining diagnostics without invoking disabled repair or compilation', async () => {
    const repair = vi.fn();
    const compile = vi.fn();
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      checks: { scanners: ['clang-tidy'], compile: false, autoRepair: false },
      messageFields: fields,
      scan: vi.fn().mockResolvedValue(finding()),
      repair,
      compile,
    });
    expect(session).toMatchObject({ state: 'blocked', reasonCode: 'diagnosticsRemain' });
    expect(repair).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  it.each([['pc-lint'], ['clang-tidy', 'pc-lint']] as const)(
    'runs exactly the chosen scanners: %j',
    async (...tools) => {
      const scanners = tools.flat();
      const scan = vi.fn().mockResolvedValue(clean());
      const service = createCommitWorkflowService({
        getCommitSnapshot: getCommitSnapshot(),
        createCommit: vi.fn(),
        push: vi.fn(),
      });
      const session = await service.prepare({
        repoPath: 'D:/repo',
        branch: 'main',
        selectedPaths: ['src/a.cpp'],
        scannerConfigs: [config, { ...config, tool: 'pc-lint' }],
        checks: { scanners, compile: false, autoRepair: false },
        messageFields: fields,
        scan,
      });
      expect(session.state).toBe('confirmation');
      expect(scan.mock.calls.map(([request]) => request.config.tool)).toEqual(scanners);
    }
  );

  it('blocks a selected scanner without configuration', async () => {
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [],
      checks: { scanners: ['pc-lint'], compile: false, autoRepair: false },
      messageFields: fields,
      scan: vi.fn(),
    });
    expect(session).toMatchObject({ state: 'blocked', reasonCode: 'scanConfigRequired' });
  });

  it('runs scan, repair, rescan and compile before confirmation', async () => {
    const scan = vi.fn().mockResolvedValueOnce(finding()).mockResolvedValueOnce(clean());
    const repair = vi.fn().mockResolvedValue({ changedPaths: ['src/a.cpp'] });
    const compile = vi.fn().mockResolvedValue({ ok: true });
    const states: string[] = [];
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });

    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: vi.fn().mockResolvedValue(fields),
      scan,
      repair,
      compile,
      onStateChange: (state) => states.push(state),
    });

    expect(session.state).toBe('confirmation');
    expect(scan).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledOnce();
    expect(session.diagnostics).toEqual([]);
    expect(states).toEqual(['collecting', 'scan', 'repair', 'rescan', 'compile', 'message_draft', 'confirmation']);
  });

  it('keeps the reviewed draft while scanning and does not regenerate it afterward', async () => {
    const scan = vi.fn().mockResolvedValue(clean());
    const compile = vi.fn().mockResolvedValue({ ok: true });
    const generateMessage = vi.fn();
    const states: string[] = [];
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });

    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      messageFields: fields,
      generateMessage,
      scan,
      compile,
      onStateChange: (state) => states.push(state),
    });

    expect(session.state).toBe('confirmation');
    expect(session.messageFields).toEqual(fields);
    expect(generateMessage).not.toHaveBeenCalled();
    expect(states).toEqual(['collecting', 'scan', 'compile', 'confirmation']);
  });

  it('blocks after two repair attempts when diagnostics remain', async () => {
    const repair = vi.fn().mockResolvedValue({ changedPaths: ['src/a.cpp'] });
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: vi.fn().mockResolvedValue(fields),
      scan: vi.fn().mockResolvedValue(finding()),
      repair,
    });

    expect(session.state).toBe('blocked');
    expect(repair).toHaveBeenCalledTimes(2);
    expect(session.reason).toContain('diagnostics');
  });

  it('blocks when an AI repair changes an unselected path', async () => {
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: vi.fn().mockResolvedValue(fields),
      scan: vi.fn().mockResolvedValue(finding()),
      repair: vi.fn().mockResolvedValue({ changedPaths: ['src/other.cpp'] }),
    });

    expect(session.state).toBe('blocked');
    expect(session.reason).toContain('unselected');
  });

  it('keeps the local commit when push fails and supports retry', async () => {
    const createCommit = vi.fn().mockResolvedValue({ ok: true, commit: 'abc123' });
    const push = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, stdout: '', stderr: 'remote unavailable' })
      .mockResolvedValueOnce({ ok: true, stdout: 'done', stderr: '' });
    const service = createCommitWorkflowService({ getCommitSnapshot: getCommitSnapshot(), createCommit, push });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: vi.fn().mockResolvedValue(fields),
      scan: vi.fn().mockResolvedValue(clean()),
    });

    const afterCommit = await service.commitAndPush(session.id, fields);
    expect(afterCommit.state).toBe('push');
    expect(afterCommit.commit).toBe('abc123');
    const afterRetry = await service.retryPush(session.id);
    expect(afterRetry.state).toBe('completed');
    expect(push).toHaveBeenCalledTimes(2);
  });

  it.each([
    { exitCode: 1 },
    { exitCode: 2 },
    { executableMissing: true },
    { timedOut: true },
    { timedOut: true, diagnostics: finding().diagnostics },
  ])('blocks confirmation when a scanner cannot complete: %j', async (failure) => {
    const createCommit = vi.fn();
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit,
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: async () => fields,
      scan: async () => ({ ...clean(), ...failure }),
    });

    expect(session.state).toBe('failed');
    expect(session.reasonCode).toBe('scanFailed');
    await service.commitAndPush(session.id, fields);
    expect(createCommit).not.toHaveBeenCalled();
  });

  it('does not hide a scanner failure behind diagnostics from another scanner', async () => {
    const service = createCommitWorkflowService({
      getCommitSnapshot: getCommitSnapshot(),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config, config],
      generateMessage: async () => fields,
      scan: vi
        .fn()
        .mockResolvedValueOnce(finding())
        .mockResolvedValueOnce({ ...clean(), exitCode: 1 }),
      repair: vi.fn(),
    });
    expect(session.state).toBe('failed');
    expect(session.reasonCode).toBe('scanFailed');
    expect(session.diagnostics).toEqual(finding().diagnostics);
  });

  it.each(['tree', 'head', 'branch'] as const)('blocks if %s changes during scanning', async (changedField) => {
    const service = createCommitWorkflowService({
      getCommitSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue({ ...snapshot, [changedField]: 'changed' }),
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: async () => fields,
      scan: async () => clean(),
    });
    expect(session.state).toBe('blocked');
    expect(session.reasonCode).toBe('snapshotChanged');
  });

  it('binds confirmation to the repaired files that passed the rescan', async () => {
    const repairedSnapshot = { ...snapshot, tree: 'repaired-tree' };
    const readSnapshot = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValue(repairedSnapshot);
    const createCommit = vi.fn().mockResolvedValue({ ok: true, commit: 'abc123' });
    const service = createCommitWorkflowService({
      getCommitSnapshot: readSnapshot,
      createCommit,
      push: vi.fn().mockResolvedValue({ ok: true, stdout: '', stderr: '' }),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: async () => fields,
      scan: vi.fn().mockResolvedValueOnce(finding()).mockResolvedValue(clean()),
      repair: async () => ({ changedPaths: ['src/a.cpp'] }),
    });
    await service.commitAndPush(session.id, fields);
    expect(session.state).toBe('completed');
    expect(createCommit).toHaveBeenCalledWith('D:/repo', ['src/a.cpp'], expect.any(String), repairedSnapshot);
  });

  it('blocks confirmation if compilation modifies a scanned file', async () => {
    let currentSnapshot = snapshot;
    const service = createCommitWorkflowService({
      getCommitSnapshot: async () => currentSnapshot,
      createCommit: vi.fn(),
      push: vi.fn(),
    });
    const session = await service.prepare({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['src/a.cpp'],
      scannerConfigs: [config],
      generateMessage: async () => fields,
      scan: async () => clean(),
      compile: async () => {
        currentSnapshot = { ...snapshot, tree: 'generated-file-tree' };
        return { ok: true };
      },
    });
    expect(session.state).toBe('blocked');
    expect(session.reasonCode).toBe('snapshotChanged');
  });
});
