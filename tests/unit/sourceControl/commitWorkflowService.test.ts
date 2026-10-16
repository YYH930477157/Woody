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

describe('commit workflow service', () => {
  it('runs scan, repair, rescan and compile before confirmation', async () => {
    const scan = vi.fn().mockResolvedValueOnce(finding()).mockResolvedValueOnce(clean());
    const repair = vi.fn().mockResolvedValue({ changedPaths: ['src/a.cpp'] });
    const compile = vi.fn().mockResolvedValue({ ok: true });
    const states: string[] = [];
    const service = createCommitWorkflowService({
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
    expect(states).toEqual(['collecting', 'message_draft', 'scan', 'repair', 'rescan', 'compile', 'confirmation']);
  });

  it('blocks after two repair attempts when diagnostics remain', async () => {
    const repair = vi.fn().mockResolvedValue({ changedPaths: ['src/a.cpp'] });
    const service = createCommitWorkflowService({ createCommit: vi.fn(), push: vi.fn() });
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
    const service = createCommitWorkflowService({ createCommit: vi.fn(), push: vi.fn() });
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
    const service = createCommitWorkflowService({ createCommit, push });
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
});
