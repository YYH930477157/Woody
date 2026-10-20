import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildStaticScanCommand,
  createStaticScanConfigStore,
  createStaticScanService,
  decodeCommandOutput,
  readWindowsCodePage,
  runStaticScanCommand,
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

  it('decodes non-UTF-8 tool output with the Windows code page', () => {
    const gbk = Buffer.from([0xb4, 0xed, 0xce, 0xf3]); // "错误" in GBK
    const utf8 = Buffer.from('src/显示.c(3): Error (10)', 'utf8');

    expect(decodeCommandOutput(gbk, 936)).toBe('错误');
    expect(decodeCommandOutput(utf8, 936)).toBe('src/显示.c(3): Error (10)');
    expect(decodeCommandOutput(utf8)).toBe('src/显示.c(3): Error (10)');
  });

  it('keeps UTF-8 command output intact on both streams', async () => {
    const result = await runStaticScanCommand(
      process.execPath,
      ['-e', "process.stdout.write('输出 ok'); process.stderr.write('错误 bad'); process.exit(2)"],
      { cwd: process.cwd(), timeoutMs: 30_000 }
    );

    expect(result).toMatchObject({ stdout: '输出 ok', stderr: '错误 bad', exitCode: 2 });
  });

  it.runIf(process.platform === 'win32')('reads the Windows ANSI code page', async () => {
    expect(await readWindowsCodePage()).toBeGreaterThan(0);
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
