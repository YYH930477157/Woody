import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { StaticScanConfig, StaticScanResult } from '@/common/types/sourceControl/staticScanTypes';
import { parseClangTidyDiagnostics, parsePcLintDiagnostics } from './staticScanParser';
import { createStaticScanConfigStore } from './staticScanConfigStore';

const execFileAsync = promisify(execFile);

export type StaticScanCommand = {
  executable: string;
  args: string[];
};

export type StaticScanCommandOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  executableMissing?: boolean;
};

export type StaticScanCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<StaticScanCommandOutput>;

const defaultRunner: StaticScanCommandRunner = async (executable, args, options) => {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    const missing = failure.code === 'ENOENT';
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message ?? String(error),
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      timedOut: failure.killed === true || failure.code === 'ETIMEDOUT',
      executableMissing: missing,
    };
  }
};

const normalizePath = (path: string): string => path.replaceAll('\\', '/');

export const buildStaticScanCommand = (
  config: StaticScanConfig,
  repoPath: string,
  selectedPaths: string[]
): StaticScanCommand => {
  const args = [...config.arguments];
  if (config.tool === 'clang-tidy' && config.compileCommandsPath) {
    args.push('-p', normalizePath(`${repoPath}/${config.compileCommandsPath}`));
  }
  if (config.scope === 'selected') args.push(...selectedPaths);
  return { executable: config.executablePath, args };
};

export type StaticScanRequest = {
  repoPath: string;
  selectedPaths: string[];
  config: StaticScanConfig;
};

export type StaticScanService = {
  scan: (request: StaticScanRequest) => Promise<StaticScanResult>;
};

export const createStaticScanService = (runner: StaticScanCommandRunner = defaultRunner): StaticScanService => ({
  async scan(request) {
    const command = buildStaticScanCommand(request.config, request.repoPath, request.selectedPaths);
    const output = await runner(command.executable, command.args, {
      cwd: request.repoPath,
      timeoutMs: request.config.timeoutMs ?? 120_000,
    });
    const combined = [output.stdout, output.stderr].filter(Boolean).join('\n');
    const diagnostics =
      request.config.tool === 'clang-tidy' ? parseClangTidyDiagnostics(combined) : parsePcLintDiagnostics(combined);
    return { tool: request.config.tool, diagnostics, ...output };
  },
});

export { createStaticScanConfigStore };
