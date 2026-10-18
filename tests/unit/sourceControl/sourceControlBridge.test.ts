import { describe, expect, it, vi } from 'vitest';

import type { GitCommandService } from '@/process/services/sourceControl/gitCommandService';
import type { GitWorkflowPrepareRequest, GitWorkflowSession } from '@/common/types/sourceControl/gitWorkflowTypes';
import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';
import type { CommitWorkflowScan } from '@/process/services/sourceControl/commitWorkflowService';

const providers = vi.hoisted(() => ({
  status: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  prepare: vi.fn(),
  progress: vi.fn(),
  scan: vi.fn<CommitWorkflowScan>(async () => ({
    tool: 'clang-tidy',
    diagnostics: [],
    exitCode: 0,
    stdout: '',
    stderr: '',
  })),
}));

vi.mock('@/process/services/sourceControl/staticScanService', () => ({
  createStaticScanService: () => ({ scan: providers.scan }),
  runStaticScanCommand: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    sourceControl: {
      status: { provider: providers.status },
      branches: { provider: providers.branches },
      checkout: { provider: providers.checkout },
      commit: { provider: providers.commit },
      push: { provider: providers.push },
      workflowPrepare: { provider: providers.prepare },
      workflowProgress: { emit: providers.progress },
    },
  },
}));

import { initSourceControlBridge } from '@/process/bridge/sourceControlBridge';

describe('source control bridge', () => {
  it('registers every Git operation with the main-process service', async () => {
    const service: GitCommandService = {
      getStatus: vi.fn(async () => ({ branch: 'main', changedPaths: [] })),
      getBranches: vi.fn(async () => ({ branches: [] })),
      checkoutBranch: vi.fn(async () => ({ ok: true })),
      getCommitSnapshot: vi.fn(async () => ({ head: 'abc', branch: 'main', tree: 'tree' })),
      createCommit: vi.fn(async () => ({ ok: true, commit: 'abc' })),
      push: vi.fn(async () => ({ ok: true, stdout: '', stderr: '' })),
    };

    initSourceControlBridge(service);

    expect(providers.status).toHaveBeenCalledOnce();
    expect(providers.branches).toHaveBeenCalledOnce();
    expect(providers.checkout).toHaveBeenCalledOnce();
    expect(providers.commit).toHaveBeenCalledOnce();
    expect(providers.push).toHaveBeenCalledOnce();

    const statusHandler = providers.status.mock.calls[0][0] as (params: { repoPath: string }) => Promise<unknown>;
    await statusHandler({ repoPath: 'D:/repo' });
    expect(service.getStatus).toHaveBeenCalledWith('D:/repo');
  });

  it('connects real preparation to repair, compile, AI draft generation and progress', async () => {
    const git: GitCommandService = {
      getStatus: vi.fn(),
      getBranches: vi.fn(),
      checkoutBranch: vi.fn(),
      getCommitSnapshot: vi.fn(async () => ({ head: 'abc', branch: 'main', tree: 'tree' })),
      createCommit: vi.fn(),
      push: vi.fn(),
    };
    const fields = { reason: '', scope: '', solution: '', impact: '', tests: '' };
    const draft = { reason: 'fixed', scope: 'a.cpp', solution: 'nullptr', impact: 'none', tests: 'build passed' };
    const repair = vi.fn(async () => ({ changedPaths: ['a.cpp'] }));
    const agent = { repair: vi.fn(() => repair), generateMessage: vi.fn(async () => ({ ...draft })) };
    const builder = { compile: vi.fn(async () => ({ ok: true, stdout: 'build passed' })) };
    providers.prepare.mockClear();
    providers.scan.mockResolvedValueOnce({
      tool: 'clang-tidy',
      exitCode: 1,
      stdout: 'warning',
      stderr: '',
      diagnostics: [{ tool: 'clang-tidy', file: 'a.cpp', line: 1, severity: 'warning', message: 'fix' }],
    });
    initSourceControlBridge(git, createCommitWorkflowService(git), agent, builder);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const result = await handler({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      messageFields: fields,
      conversationId: 'existing-chat',
      requestId: 'request-id',
      scannerConfigs: [{ tool: 'clang-tidy', executablePath: 'clang-tidy', arguments: [], scope: 'repository' }],
    });
    expect(result).toMatchObject({ state: 'confirmation', messageFields: draft, compileResult: { ok: true } });
    expect(repair).toHaveBeenCalledOnce();
    expect(builder.compile).toHaveBeenCalledWith({ repoPath: 'D:/repo', selectedPaths: ['a.cpp'] });
    expect(agent.generateMessage).toHaveBeenCalledWith(
      'existing-chat',
      'D:/repo',
      ['a.cpp'],
      fields,
      expect.stringContaining('build passed'),
      expect.any(Function)
    );
    expect(providers.scan).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ scope: 'selected' }) })
    );
    expect(providers.progress).toHaveBeenLastCalledWith({ requestId: 'request-id', session: result });
    expect(git.createCommit).not.toHaveBeenCalled();
  });

  it('blocks missing conversation context before starting the scan', async () => {
    providers.prepare.mockClear();
    const git = {} as GitCommandService;
    initSourceControlBridge(git);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const result = await handler({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      scannerConfigs: [],
      messageFields: { reason: '', scope: '', solution: '', impact: '', tests: '' },
    });
    expect(result.reasonCode).toBe('conversationRequired');
  });

  it('blocks duplicate workflows in one repository until the active preparation finishes', async () => {
    providers.prepare.mockClear();
    let finish!: (session: GitWorkflowSession) => void;
    const pending = new Promise<GitWorkflowSession>((resolve) => {
      finish = resolve;
    });
    const workflow = { prepare: vi.fn(() => pending), commitAndPush: vi.fn(), retryPush: vi.fn() };
    initSourceControlBridge({} as GitCommandService, workflow);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const request: GitWorkflowPrepareRequest = {
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      scannerConfigs: [],
      conversationId: 'chat',
      messageFields: { reason: '', scope: '', solution: '', impact: '', tests: '' },
    };
    const first = handler(request);
    expect((await handler({ ...request, conversationId: 'other-chat' })).reasonCode).toBe('conversationBusy');
    expect(workflow.prepare).toHaveBeenCalledOnce();
    finish({
      id: 'session',
      state: 'confirmation',
      repoPath: request.repoPath,
      branch: 'main',
      selectedPaths: ['a.cpp'],
      diagnostics: [],
    });
    await first;
    expect((await handler(request)).state).toBe('confirmation');
  });
});
