import { describe, expect, it, vi } from 'vitest';

import type { StaticScanService } from '@/process/services/sourceControl/staticScanService';

const providers = vi.hoisted(() => ({
  scan: vi.fn(),
  test: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    staticScan: {
      scan: { provider: providers.scan },
      test: { provider: providers.test },
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

    initStaticScanBridge(service);

    expect(providers.scan).toHaveBeenCalledOnce();
    expect(providers.test).toHaveBeenCalledOnce();
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
