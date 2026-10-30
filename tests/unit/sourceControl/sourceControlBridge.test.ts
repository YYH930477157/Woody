import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'D:/test-user-data') } }));

import type { GitCommandService } from '@/process/services/sourceControl/gitCommandService';
import type {
  GitWorkflowDraftRequest,
  GitWorkflowPrepareRequest,
  GitWorkflowSession,
} from '@/common/types/sourceControl/gitWorkflowTypes';
import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';
import type { CommitWorkflowScan } from '@/process/services/sourceControl/commitWorkflowService';

const providers = vi.hoisted(() => ({
  coordinate: vi.fn(async <T>(_root: string, operation: () => Promise<T>): Promise<T> => operation()),
  status: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
  draft: vi.fn(),
  prepare: vi.fn(),
  workflowCommit: vi.fn(),
  progress: vi.fn(),
  scan: vi.fn<CommitWorkflowScan>(async () => ({
    tool: 'clang-tidy',
    diagnostics: [],
    exitCode: 0,
    stdout: '',
    stderr: '',
  })),
}));

vi.mock('@/process/services/sourceControl/workbench/coordinator', () => ({
  repositoryCoordinator: { run: providers.coordinate },
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
      workflowDraft: { provider: providers.draft },
      workflowPrepare: { provider: providers.prepare },
      workflowCommit: { provider: providers.workflowCommit },
      workflowProgress: { emit: providers.progress },
    },
  },
}));

import { initSourceControlBridge } from '@/process/bridge/sourceControlBridge';

describe('source control bridge', () => {
  it.each(['checkout', 'commit', 'push'] as const)(
    'returns the existing failure union when %s cannot acquire a repository',
    async (channel) => {
      providers[channel].mockClear();
      const git = { checkoutBranch: vi.fn(), createCommit: vi.fn(), push: vi.fn() } as unknown as GitCommandService;
      initSourceControlBridge(git, undefined, undefined, undefined, async () => {
        throw new Error('Repository missing');
      });
      const result = await providers[channel].mock.calls[0][0]({
        repoPath: 'D:/missing',
        branch: 'main',
        paths: ['a.cpp'],
        message: 'change',
      });
      expect(result).toMatchObject(
        channel === 'push'
          ? { ok: false, retryable: true, stdout: '', stderr: 'Repository missing' }
          : { ok: false, kind: 'command-failed', stderr: 'Repository missing' }
      );
      expect(git.createCommit).not.toHaveBeenCalled();
      expect(git.push).not.toHaveBeenCalled();
      expect(git.checkoutBranch).not.toHaveBeenCalled();
    }
  );
  it('coordinates each legacy mutation once while read-only queries remain independent', async () => {
    providers.checkout.mockClear();
    providers.commit.mockClear();
    providers.push.mockClear();
    providers.coordinate.mockClear();
    const git = {
      checkoutBranch: vi.fn(async () => ({ ok: true })),
      createCommit: vi.fn(async () => ({ ok: true })),
      push: vi.fn(async () => ({ ok: true })),
    } as unknown as GitCommandService;
    initSourceControlBridge(git);
    await providers.checkout.mock.calls[0][0]({ repoPath: 'D:/repo', branch: 'main' });
    await providers.commit.mock.calls[0][0]({ repoPath: 'D:/repo', paths: ['a.cpp'], message: 'change' });
    await providers.push.mock.calls[0][0]({ repoPath: 'D:/repo', branch: 'main' });
    expect(providers.coordinate.mock.calls.map((call) => call[0])).toEqual(['D:/repo', 'D:/repo', 'D:/repo']);
    expect(git.createCommit).toHaveBeenCalledOnce();
  });
  const manualFields = { reason: 'fix', scope: 'a', solution: 'update', impact: 'none', tests: 'reviewed' };
  const manualRequest: GitWorkflowPrepareRequest = {
    repoPath: 'D:/repo',
    branch: 'main',
    selectedPaths: ['a.cpp'],
    scannerConfigs: [{ tool: 'clang-tidy', executablePath: 'clang-tidy', arguments: [], scope: 'selected' }],
    checks: { scanners: ['clang-tidy'], compile: false, autoRepair: false },
    messageFields: manualFields,
  };

  it('runs manual static scanning without a conversation', async () => {
    const git = {
      getCommitSnapshot: vi.fn(async () => ({ head: 'abc', branch: 'main', tree: 'tree' })),
    } as unknown as GitCommandService;
    const agent = { repair: vi.fn(() => vi.fn()), generateMessage: vi.fn() };
    providers.prepare.mockClear();
    providers.scan.mockClear();
    initSourceControlBridge(git, createCommitWorkflowService(git), agent);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    expect(await handler(manualRequest)).toMatchObject({ state: 'confirmation' });
    expect(providers.scan).toHaveBeenCalledOnce();
    expect(agent.repair).not.toHaveBeenCalled();
  });

  it('requires conversation context when automatic repair is requested', async () => {
    providers.prepare.mockClear();
    initSourceControlBridge({} as GitCommandService);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    expect(
      await handler({ ...manualRequest, checks: { scanners: ['clang-tidy'], compile: false, autoRepair: true } })
    ).toMatchObject({ state: 'blocked', reasonCode: 'conversationRequired' });
  });

  it('requires conversation context for AI drafting', async () => {
    providers.draft.mockClear();
    initSourceControlBridge({} as GitCommandService);
    const handler = providers.draft.mock.calls[0][0] as (
      request: GitWorkflowDraftRequest
    ) => Promise<GitWorkflowSession>;
    expect(await handler(manualRequest)).toMatchObject({ state: 'blocked', reasonCode: 'conversationRequired' });
  });

  it.each([false, true, undefined])(
    'routes checked commit with push=%s and preserves the legacy default',
    async (push) => {
      providers.workflowCommit.mockClear();
      const result = {
        id: 'session',
        state: 'completed' as const,
        repoPath: 'D:/repo',
        branch: 'main',
        selectedPaths: ['a.cpp'],
        diagnostics: [],
      };
      const workflow = {
        prepare: vi.fn(),
        commit: vi.fn(async () => result),
        commitAndPush: vi.fn(async () => result),
        retryPush: vi.fn(),
      };
      initSourceControlBridge({} as GitCommandService, workflow);
      const handler = providers.workflowCommit.mock.calls[0][0] as (request: {
        sessionId: string;
        messageFields: typeof manualFields;
        push?: boolean;
      }) => Promise<GitWorkflowSession>;
      expect(await handler({ sessionId: 'session', messageFields: manualFields, push })).toBe(result);
      expect(workflow.commit).toHaveBeenCalledTimes(push === false ? 1 : 0);
      expect(workflow.commitAndPush).toHaveBeenCalledTimes(push === false ? 0 : 1);
    }
  );

  it('allows independent manual repositories but rejects another operation on the same repository', async () => {
    providers.prepare.mockClear();
    let finish!: (session: GitWorkflowSession) => void;
    const pending = new Promise<GitWorkflowSession>((resolve) => {
      finish = resolve;
    });
    const workflow = { prepare: vi.fn(() => pending), commit: vi.fn(), commitAndPush: vi.fn(), retryPush: vi.fn() };
    initSourceControlBridge({} as GitCommandService, workflow);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const first = handler(manualRequest);
    const independent = handler({ ...manualRequest, repoPath: 'D:/other' });
    expect(await handler({ ...manualRequest, repoPath: 'D:\\repo\\' })).toMatchObject({
      reasonCode: 'conversationBusy',
    });
    expect(workflow.prepare).toHaveBeenCalledTimes(2);
    finish({
      id: 'session',
      state: 'confirmation',
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      diagnostics: [],
    });
    await Promise.all([first, independent]);
    expect(await handler(manualRequest)).toMatchObject({ state: 'confirmation' });
  });

  it('tracks a supplied conversation independently of its repository', async () => {
    providers.prepare.mockClear();
    let finish!: (session: GitWorkflowSession) => void;
    const pending = new Promise<GitWorkflowSession>((resolve) => {
      finish = resolve;
    });
    const workflow = { prepare: vi.fn(() => pending), commit: vi.fn(), commitAndPush: vi.fn(), retryPush: vi.fn() };
    initSourceControlBridge({} as GitCommandService, workflow);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const first = handler({ ...manualRequest, conversationId: 'chat' });
    expect(await handler({ ...manualRequest, repoPath: 'D:/other', conversationId: 'chat' })).toMatchObject({
      reasonCode: 'conversationBusy',
    });
    expect(workflow.prepare).toHaveBeenCalledOnce();
    finish({
      id: 'session',
      state: 'confirmation',
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      diagnostics: [],
    });
    await first;
    expect(await handler({ ...manualRequest, repoPath: 'D:/other', conversationId: 'chat' })).toMatchObject({
      state: 'confirmation',
    });
  });

  it('does not initialize AI repair or compile when all checks are disabled', async () => {
    const git: GitCommandService = {
      getStatus: vi.fn(),
      getBranches: vi.fn(),
      checkoutBranch: vi.fn(),
      getCommitSnapshot: vi.fn(async () => ({ head: 'abc', branch: 'main', tree: 'tree' })),
      createCommit: vi.fn(),
      push: vi.fn(),
    };
    const agent = { repair: vi.fn(() => vi.fn()), generateMessage: vi.fn() };
    const builder = { compile: vi.fn() };
    providers.prepare.mockClear();
    providers.scan.mockClear();
    initSourceControlBridge(git, createCommitWorkflowService(git), agent, builder);
    const handler = providers.prepare.mock.calls[0][0] as (
      request: GitWorkflowPrepareRequest
    ) => Promise<GitWorkflowSession>;
    const result = await handler({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      conversationId: 'chat',
      scannerConfigs: [],
      checks: { scanners: [], compile: false, autoRepair: true },
      messageFields: { reason: 'fix', scope: 'a', solution: 'update', impact: 'none', tests: 'skipped' },
    });
    expect(result.state).toBe('confirmation');
    expect(agent.repair).not.toHaveBeenCalled();
    expect(builder.compile).not.toHaveBeenCalled();
    expect(providers.scan).not.toHaveBeenCalled();
  });

  it('registers every Git operation with the main-process service', async () => {
    for (const name of ['status', 'branches', 'checkout', 'commit', 'push'] as const) providers[name].mockClear();
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

  it('connects confirmed draft fields to repair, compile and progress', async () => {
    const git: GitCommandService = {
      getStatus: vi.fn(),
      getBranches: vi.fn(),
      checkoutBranch: vi.fn(),
      getCommitSnapshot: vi.fn(async () => ({ head: 'abc', branch: 'main', tree: 'tree' })),
      createCommit: vi.fn(),
      push: vi.fn(),
    };
    const fields = { reason: 'fixed', scope: 'a.cpp', solution: 'nullptr', impact: 'none', tests: 'build passed' };
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
    expect(agent.generateMessage).not.toHaveBeenCalled();
    expect(providers.scan).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ scope: 'selected' }) })
    );
    expect(providers.progress).toHaveBeenLastCalledWith({ requestId: 'request-id', session: result });
    expect(git.createCommit).not.toHaveBeenCalled();
  });

  it('generates a draft before the static scan workflow starts', async () => {
    providers.draft.mockClear();
    providers.scan.mockClear();
    const fields = { reason: '', scope: '', solution: '', impact: '', tests: '' };
    const draft = { reason: 'fixed', scope: 'a.cpp', solution: 'nullptr', impact: 'none', tests: 'reviewed' };
    const agent = { repair: vi.fn(() => vi.fn()), generateMessage: vi.fn(async () => ({ ...draft })) };
    initSourceControlBridge({} as GitCommandService, undefined, agent);
    const handler = providers.draft.mock.calls[0][0] as (
      request: GitWorkflowDraftRequest
    ) => Promise<GitWorkflowSession>;
    const result = await handler({
      repoPath: 'D:/repo',
      branch: 'main',
      selectedPaths: ['a.cpp'],
      messageFields: fields,
      conversationId: 'existing-chat',
      requestId: 'draft-request',
    });
    expect(result).toMatchObject({ state: 'draft_ready', messageFields: draft });
    expect(agent.generateMessage).toHaveBeenCalledWith(
      'existing-chat',
      'D:/repo',
      ['a.cpp'],
      fields,
      '',
      expect.any(Function)
    );
    expect(providers.scan).not.toHaveBeenCalled();
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
    const workflow = { prepare: vi.fn(() => pending), commit: vi.fn(), commitAndPush: vi.fn(), retryPush: vi.fn() };
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
