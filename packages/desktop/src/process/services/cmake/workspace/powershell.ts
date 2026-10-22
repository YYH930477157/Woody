import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isPrivateEnvironment } from '../variants';

type ReadOptions = { path: string; limit: number; env: NodeJS.ProcessEnv; timeoutMs?: number; spawn?: typeof spawn };
export type PowerShellRead = (
  file: string,
  options: ReadOptions,
  signal: AbortSignal
) => Promise<{ bytes: Buffer; executable: string }>;

// The file name is environment data. This script is constant for every project and never evaluates project text.
const script = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { [Console]::Out.Write('E:version'); exit 1 }
$stream = $null
try {
  $limit = [int]$env:WOODY_READER_LIMIT
  $stream = [IO.File]::Open($env:WOODY_READER_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  if ($stream.Length -gt $limit) { [Console]::Out.Write('E:large'); exit 1 }
  $buffer = [byte[]]::new($limit + 1)
  $used = 0
  do {
    $count = $stream.Read($buffer, $used, $buffer.Length - $used)
    $used += $count
  } while ($count -gt 0 -and $used -lt $buffer.Length)
  if ($used -gt $limit) { [Console]::Out.Write('E:large'); exit 1 }
  [Console]::Out.Write('B:' + [Convert]::ToBase64String($buffer, 0, $used))
} catch {
  $errorType = $_.Exception.GetBaseException()
  if ($errorType -is [UnauthorizedAccessException]) { [Console]::Out.Write('E:denied') }
  elseif ($errorType -is [IO.FileNotFoundException] -or $errorType -is [IO.DirectoryNotFoundException]) { [Console]::Out.Write('E:missing') }
  else { [Console]::Out.Write('E:failed') }
  exit 1
} finally { if ($null -ne $stream) { $stream.Dispose() } }
`;

/** The only executable the reader may start; saved paths must match this name exactly. */
export const powerShellExecutableName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';

/** Resolve only a native PowerShell executable; never use cmd, scripts, or shell lookup. */
export async function resolvePowerShell(saved: string, env: NodeJS.ProcessEnv): Promise<string> {
  const name = powerShellExecutableName;
  if (saved && (!path.isAbsolute(saved) || saved.includes('\0') || path.basename(saved).toLowerCase() !== name))
    throw new Error('cmake.readPowerShellMissing');
  const variable = (variableName: string) =>
    Object.entries(env).find(([key]) => key.toLowerCase() === variableName.toLowerCase())?.[1];
  const directories = (variable('PATH') ?? '').split(path.delimiter).filter((value) => value && path.isAbsolute(value));
  const candidates = saved ? [saved] : directories.map((directory) => path.join(directory, name));
  if (!saved && process.platform === 'win32')
    candidates.push(path.join(variable('ProgramFiles') ?? 'C:\\Program Files', 'PowerShell', '7', name));
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch {
      /* Try the next installed location. */
    }
  }
  throw new Error('cmake.readPowerShellMissing');
}

/** Read raw bytes through a bounded, hidden PowerShell 7 child process. */
export const readPowerShell: PowerShellRead = async (file, options, signal) => {
  if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('cmake.readPath');
  const executable = await resolvePowerShell(options.path, options.env);
  const failure = (code: string): Error => Object.assign(new Error(code), { executable });
  if (signal.aborted) throw failure('cmake.readCancelled');
  const output = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stopping: string | undefined;
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    let size = 0;
    const chunks: Buffer[] = [];
    const child = (options.spawn ?? spawn)(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(Object.entries(options.env).filter(([key]) => !isPrivateEnvironment(key))),
          WOODY_READER_FILE: file,
          WOODY_READER_LIMIT: String(options.limit),
        },
      }
    );
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(shutdown);
      signal.removeEventListener('abort', abort);
      if (error) reject(failure(error));
      else resolve(Buffer.concat(chunks).toString('latin1'));
    };
    const stop = (code: string): void => {
      if (settled || stopping) return;
      stopping = code;
      clearTimeout(timer);
      child.kill();
      // A malfunctioning child must not keep reload or shutdown pending forever.
      shutdown = setTimeout(() => {
        child.kill('SIGKILL');
        finish(code);
      }, 1000);
    };
    const abort = (): void => stop('cmake.readCancelled');
    const timer = setTimeout(() => stop('cmake.readTimeout'), options.timeoutMs ?? 8000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: Buffer, stdout: boolean): void => {
      if (settled || stopping) return;
      size += chunk.length;
      if (size > Math.ceil(options.limit / 3) * 4 + 128) stop('cmake.readTransport');
      else if (stdout) chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, false));
    child.once('error', () => stop('cmake.readFailed'));
    child.once('close', (code) => {
      const data = Buffer.concat(chunks).toString('latin1');
      const errors: Record<string, string> = {
        'E:version': 'cmake.readPowerShellVersion',
        'E:large': 'cmake.fileTooLarge',
        'E:denied': 'cmake.readDenied',
        'E:missing': 'cmake.readMissing',
        'E:failed': 'cmake.readFailed',
      };
      finish(stopping ?? (code === 0 ? undefined : (errors[data] ?? 'cmake.readFailed')));
    });
  });
  if (!/^B:(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output))
    throw failure('cmake.readTransport');
  const bytes = Buffer.from(output.slice(2), 'base64');
  if (bytes.length > options.limit || bytes.toString('base64') !== output.slice(2))
    throw failure('cmake.readTransport');
  return { bytes, executable };
};
