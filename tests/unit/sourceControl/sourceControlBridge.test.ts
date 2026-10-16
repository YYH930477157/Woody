import { describe, expect, it, vi } from 'vitest';

import type { GitCommandService } from '@/process/services/sourceControl/gitCommandService';

const providers = vi.hoisted(() => ({
  status: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
  commit: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    sourceControl: {
      status: { provider: providers.status },
      branches: { provider: providers.branches },
      checkout: { provider: providers.checkout },
      commit: { provider: providers.commit },
      push: { provider: providers.push },
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
});
