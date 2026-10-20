import { isUtf8 } from 'node:buffer';
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

// Windows ANSI code pages that the WHATWG TextDecoder can read.
const CODE_PAGE_ENCODINGS: Record<number, string> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  54936: 'gb18030',
};

let windowsCodePage: Promise<number | undefined> | undefined;

/** The system ANSI code page, which console tools such as IarBuild and PC-lint write instead of UTF-8. */
export const readWindowsCodePage = (): Promise<number | undefined> => {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  windowsCodePage ??= execFileAsync(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
    { encoding: 'utf8', windowsHide: true }
  )
    .then(({ stdout }) => Number(/\bACP\s+REG_SZ\s+(\d+)/.exec(stdout)?.[1]) || undefined)
    .catch((): undefined => undefined);
  return windowsCodePage;
};

/** Keep valid UTF-8; otherwise decode with the Windows code page when the runtime supports it. */
export const decodeCommandOutput = (bytes: Buffer, codePage?: number): string => {
  const encoding = codePage === undefined ? undefined : CODE_PAGE_ENCODINGS[codePage];
  if (isUtf8(bytes) || !encoding) return bytes.toString('utf8');
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
};

const decodeOutput = async (bytes: Buffer): Promise<string> =>
  isUtf8(bytes) ? bytes.toString('utf8') : decodeCommandOutput(bytes, await readWindowsCodePage());

export const runStaticScanCommand: StaticScanCommandRunner = async (executable, args, options) => {
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd,
      encoding: 'buffer',
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: await decodeOutput(result.stdout), stderr: await decodeOutput(result.stderr), exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: Buffer;
      stderr?: Buffer;
      code?: number | string;
      killed?: boolean;
    };
    const missing = failure.code === 'ENOENT';
    return {
      stdout: failure.stdout ? await decodeOutput(failure.stdout) : '',
      stderr: failure.stderr ? await decodeOutput(failure.stderr) : (failure.message ?? String(error)),
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

export const createStaticScanService = (runner: StaticScanCommandRunner = runStaticScanCommand): StaticScanService => ({
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
