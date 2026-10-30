import { describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => {
  const provider = vi.fn();
  const service = {
    history: vi.fn(),
    refs: vi.fn(),
    details: vi.fn(),
    diff: vi.fn(),
    compare: vi.fn(),
    fileHistory: vi.fn(),
    readRevision: vi.fn(),
    blame: vi.fn(),
    getStatus: vi.fn(),
    getBranches: vi.fn(),
    checkoutBranch: vi.fn(),
    getCommitSnapshot: vi.fn(),
    createCommit: vi.fn(),
    push: vi.fn(),
  };
  const operations = { operate: vi.fn(), cancel: vi.fn() };
  const merge = { list: vi.fn(), read: vi.fn(), save: vi.fn(), finish: vi.fn() };
  return {
    provider,
    service,
    operations,
    merge,
    getGitBridgeRuntime: vi.fn(),
    getGitRuntimeStatus: vi.fn(async () => ({ available: true })),
    initGitStorageBridge: vi.fn(),
    createGitCommandRunner: vi.fn(() => vi.fn()),
    createGitCommandService: vi.fn(() => service),
    createCommitWorkflowService: vi.fn(() => ({
      prepare: vi.fn(),
      commit: vi.fn(),
      commitAndPush: vi.fn(),
      retryPush: vi.fn(),
    })),
    createGitWorkbenchService: vi.fn(() => service),
    createGitOperationService: vi.fn(() => operations),
    createGitMergeService: vi.fn(() => merge),
    createProjectRootResolver: vi.fn(() => vi.fn()),
  };
});

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'D:/test-user-data') } }));
vi.mock('@/common', () => ({
  ipcBridge: {
    gitWorkbench: Object.fromEntries(
      [
        'runtime',
        'mergeList',
        'mergeRead',
        'mergeSave',
        'mergeFinish',
        'operate',
        'cancel',
        'history',
        'refs',
        'details',
        'diff',
        'compare',
        'fileHistory',
        'readRevision',
        'blame',
      ].map((name) => [name, { provider: dependencies.provider }])
    ),
    sourceControl: Object.fromEntries(
      [
        'status',
        'branches',
        'checkout',
        'commit',
        'push',
        'workflowDraft',
        'workflowPrepare',
        'workflowCommit',
        'workflowRetryPush',
      ].map((name) => [name, { provider: dependencies.provider }])
    ),
  },
}));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@process/services/sourceControl/gitCommandService', () => ({
  createGitCommandRunner: dependencies.createGitCommandRunner,
  createGitCommandService: dependencies.createGitCommandService,
}));
vi.mock('@process/services/sourceControl/commitWorkflowService', () => ({
  createCommitWorkflowService: dependencies.createCommitWorkflowService,
}));
vi.mock('@process/services/sourceControl/workbench/service', () => ({
  createGitWorkbenchService: dependencies.createGitWorkbenchService,
}));
vi.mock('@process/services/sourceControl/workbench/operations', () => ({
  createGitOperationService: dependencies.createGitOperationService,
}));
vi.mock('@process/services/sourceControl/workbench/merge', () => ({
  createGitMergeService: dependencies.createGitMergeService,
}));
vi.mock('@process/services/sourceControl/workbench/workspace', () => ({
  createProjectRootResolver: dependencies.createProjectRootResolver,
}));
vi.mock('@process/services/sourceControl/workbench/coordinator', () => ({
  repositoryCoordinator: { run: vi.fn() },
}));
vi.mock('@process/bridge/sourceControlBridge/runtime', () => ({
  getGitBridgeRuntime: dependencies.getGitBridgeRuntime,
  getGitRuntimeStatus: dependencies.getGitRuntimeStatus,
}));
vi.mock('@process/bridge/sourceControlBridge/storage', () => ({
  initGitStorageBridge: dependencies.initGitStorageBridge,
}));

import { initGitWorkbenchBridge, initSourceControlBridge } from '@/process/bridge/sourceControlBridge';

describe('source control bridge runtime sharing', () => {
  it('uses one configured executable and coordinator for checked commits, workbench, operations, merge and storage', async () => {
    const git = vi.fn();
    const run = vi.fn();
    const runtimePromise = Promise.resolve({
      runtime: {
        executable: 'D:/offline/git/cmd/git.exe',
        requestedPath: 'D:/offline/git/cmd/git.exe',
        source: 'bundled' as const,
        version: { major: 2, minor: 56, patch: 0, raw: '2.56.0.windows.4' },
        capabilities: { updateRefs: true, memoryHistoryEdit: true },
      },
      configuredPath: '',
      git,
      coordinator: { run },
    });
    dependencies.getGitBridgeRuntime.mockReturnValue(runtimePromise);

    initSourceControlBridge();
    initGitWorkbenchBridge();
    await runtimePromise;
    await vi.waitFor(() => expect(dependencies.createCommitWorkflowService).toHaveBeenCalledOnce());

    expect(dependencies.getGitBridgeRuntime).toHaveBeenCalledTimes(2);
    expect(dependencies.initGitStorageBridge).toHaveBeenCalledWith(runtimePromise);
    expect(dependencies.createGitCommandRunner).toHaveBeenCalledWith('D:/offline/git/cmd/git.exe');
    expect(dependencies.createGitCommandService).toHaveBeenCalledWith(expect.any(Function));
    expect(dependencies.createCommitWorkflowService).toHaveBeenCalledWith(
      dependencies.service,
      expect.objectContaining({ run })
    );
    expect(dependencies.createGitWorkbenchService).toHaveBeenCalledWith(expect.objectContaining({ git }));
    expect(dependencies.createGitOperationService).toHaveBeenCalledWith(
      expect.objectContaining({
        git,
        run,
        capabilities: { updateRefs: true, memoryHistoryEdit: true },
      })
    );
    expect(dependencies.createGitMergeService).toHaveBeenCalledWith(expect.objectContaining({ git, run }));
  });
});
