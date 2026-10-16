import { describe, expect, it, vi } from 'vitest';

import type { StaticScanService } from '@/process/services/sourceControl/staticScanService';
import type { StaticScanConfigStore } from '@/process/services/sourceControl/staticScanConfigStore';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'D:/user-data') } }));

const providers = vi.hoisted(() => ({
  scan: vi.fn(),
  test: vi.fn(),
  getMachineConfig: vi.fn(),
  saveMachineConfig: vi.fn(),
  getProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    staticScan: {
      scan: { provider: providers.scan },
      test: { provider: providers.test },
      getMachineConfig: { provider: providers.getMachineConfig },
      saveMachineConfig: { provider: providers.saveMachineConfig },
      getProjectConfig: { provider: providers.getProjectConfig },
      saveProjectConfig: { provider: providers.saveProjectConfig },
    },
  },
}));

import { initStaticScanBridge } from '@/process/bridge/staticScanBridge';

describe('static scan bridge', () => {
  it('registers scan and test configuration operations', async () => {
    const service: StaticScanService = {
      scan: vi.fn(async () => ({
        tool: 'clang-tidy',
        diagnostics: [],
        stdout: '',
        stderr: '',
        exitCode: 0,
      })),
    };
    const configStore: StaticScanConfigStore = {
      getMachineConfig: () => ({ tools: {} }),
      saveMachineConfig: vi.fn(async () => undefined),
      getProjectConfig: vi.fn(async () => ({})),
      saveProjectConfig: vi.fn(async () => undefined),
    };

    initStaticScanBridge(service, configStore);

    expect(providers.scan).toHaveBeenCalledOnce();
    expect(providers.test).toHaveBeenCalledOnce();
    expect(providers.getMachineConfig).toHaveBeenCalledOnce();
    expect(providers.saveMachineConfig).toHaveBeenCalledOnce();
    expect(providers.getProjectConfig).toHaveBeenCalledOnce();
    expect(providers.saveProjectConfig).toHaveBeenCalledOnce();
    const handler = providers.test.mock.calls[0][0] as (params: {
      repoPath: string;
      selectedPaths: string[];
      config: {
        tool: 'clang-tidy';
        executablePath: string;
        scope: 'selected';
        arguments: string[];
      };
    }) => Promise<unknown>;
    await handler({
      repoPath: 'D:/repo',
      selectedPaths: ['src/a.cpp'],
      config: { tool: 'clang-tidy', executablePath: 'clang-tidy', scope: 'selected', arguments: [] },
    });
    expect(service.scan).toHaveBeenCalledWith({
      repoPath: 'D:/repo',
      selectedPaths: ['src/a.cpp'],
      config: { tool: 'clang-tidy', executablePath: 'clang-tidy', scope: 'selected', arguments: [] },
    });
  });
});
