import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildStaticScanCommand,
  createStaticScanConfigStore,
  createStaticScanService,
  type StaticScanCommandRunner,
} from '@/process/services/sourceControl/staticScanService';
import type { StaticScanConfig } from '@/common/types/sourceControl/staticScanTypes';

describe('static scan service', () => {
  it('builds a clang-tidy command for selected files only', () => {
    const config: StaticScanConfig = {
      tool: 'clang-tidy',
      executablePath: 'C:/LLVM/bin/clang-tidy.exe',
      scope: 'selected',
      arguments: ['-checks=*', '--warnings-as-errors=*'],
      compileCommandsPath: 'build/compile_commands.json',
    };
    expect(buildStaticScanCommand(config, 'D:/repo', ['src/a.cpp', 'src/b.cpp'])).toEqual({
      executable: 'C:/LLVM/bin/clang-tidy.exe',
      args: [
        '-checks=*',
        '--warnings-as-errors=*',
        '-p',
        'D:/repo/build/compile_commands.json',
        'src/a.cpp',
        'src/b.cpp',
      ],
    });
  });

  it('uses the configured repository scope without appending selected files', () => {
    const config: StaticScanConfig = {
      tool: 'pc-lint',
      executablePath: 'C:/PCLint/pclp.exe',
      scope: 'repository',
      arguments: ['project.lnt'],
    };
    expect(buildStaticScanCommand(config, 'D:/repo', ['src/a.c'])).toEqual({
      executable: 'C:/PCLint/pclp.exe',
      args: ['project.lnt'],
    });
  });

  it('reports executable failures in a structured result', async () => {
    const runner: StaticScanCommandRunner = vi.fn().mockResolvedValue({
      stdout: 'src/a.c(3): Error (10) bad',
      stderr: '',
      exitCode: 1,
    });
    const service = createStaticScanService(runner);
    const result = await service.scan({
      repoPath: 'D:/repo',
      selectedPaths: ['src/a.c'],
      config: {
        tool: 'pc-lint',
        executablePath: 'pclp',
        scope: 'selected',
        arguments: [],
      },
    });
    expect(result.diagnostics[0]?.rule).toBe('10');
    expect(result.exitCode).toBe(1);
  });

  it('stores machine tool paths separately from project configuration', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'woody-static-scan-test-'));
    try {
      const store = createStaticScanConfigStore(userDataPath);
      await store.saveMachineConfig({ tools: { 'clang-tidy': 'C:/LLVM/bin/clang-tidy.exe' } });
      expect(store.getMachineConfig()).toEqual({ tools: { 'clang-tidy': 'C:/LLVM/bin/clang-tidy.exe' } });
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
