import fs from 'node:fs/promises';
import path from 'node:path';
import type { CmakeDiagnostic, CmakeReadInfo, CmakeReadOptions } from '@/common/types/cmake';
import { readPowerShell, type PowerShellRead } from './powershell';

type ReadResult = { text: string; info: CmakeReadInfo };
type ReaderDependencies = {
  env?: NodeJS.ProcessEnv;
  directRead?: (file: string, limit: number) => Promise<Buffer>;
  powershellRead?: PowerShellRead;
};
type CacheEntry = { promise: Promise<ReadResult>; controller: AbortController; pending: boolean };
const defaults: CmakeReadOptions = { mode: 'auto', encoding: 'auto', powershellPath: '' };
const safeCodes = new Set([
  'cmake.readDecode',
  'cmake.fileTooLarge',
  'cmake.readMissing',
  'cmake.readDenied',
  'cmake.readFailed',
  'cmake.readTimeout',
  'cmake.readTransport',
  'cmake.readCancelled',
  'cmake.readPowerShellMissing',
  'cmake.readPowerShellVersion',
  'cmake.readPath',
  'cmake.readBusy',
]);

/** Convert IO errors into stable codes without copying OS messages or file content. */
export function readErrorCode(error: unknown): string {
  const value = error as NodeJS.ErrnoException;
  if (safeCodes.has(value?.message)) return value.message;
  if (value?.code === 'ENOENT') return 'cmake.readMissing';
  if (value?.code === 'EACCES' || value?.code === 'EPERM') return 'cmake.readDenied';
  return 'cmake.readFailed';
}

/** Strict decoder shared by the direct and PowerShell byte transports. */
function decode(
  bytes: Buffer,
  options: CmakeReadOptions,
  limit: number,
  asciiTokens: boolean
): { text: string; encoding: string } {
  if (bytes.length > limit) throw new Error('cmake.fileTooLarge');
  let encoding: string = options.encoding;
  if (encoding === 'auto') {
    encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8';
  }
  if (asciiTokens && !encoding.startsWith('utf-16')) {
    // A caller that only reads ASCII tokens accepts any ASCII-compatible encoding (UTF-8, GBK, ...), so
    // non-ASCII bytes stay undecoded. Control bytes still mark binary content such as ciphertext, which
    // must fail here so the PowerShell reader is tried next.
    // Tab, line breaks, form feed and ESC occur in text; any other C0 byte does not.
    if (bytes.some((byte) => byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)))
      throw new Error('cmake.readDecode');
    return { text: bytes.toString('latin1'), encoding: 'ascii-compatible' };
  }
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('cmake.readDecode');
  }
  if (text.includes('\0')) throw new Error('cmake.readDecode');
  if (Buffer.byteLength(text) > limit) throw new Error('cmake.fileTooLarge');
  return { text, encoding };
}

/** Service-owned bounded cache. Failed reads also stay cached until file/settings change or reload. */
export class ConfigurationReader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Set<CacheEntry>();
  private disposed = false;
  private generation = 0;
  constructor(private readonly dependencies: ReaderDependencies = {}) {}

  /** `asciiTokens` is for callers that only scan ASCII syntax, such as project() in CMakeLists.txt. */
  async read(file: string, options = defaults, limit = 262144, asciiTokens = false): Promise<ReadResult> {
    if (this.disposed) throw new Error('cmake.readCancelled');
    if (!path.isAbsolute(file) || file.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576)
      throw new Error('cmake.readPath');
    const generation = this.generation;
    const settings = { ...defaults, ...options };
    const canonical = await fs.realpath(file);
    const identity = await fs.stat(canonical, { bigint: true }).then(
      (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        return `unavailable:${readErrorCode(error)}`;
      }
    );
    if (this.disposed) throw new Error('cmake.readCancelled');
    const key = JSON.stringify([
      canonical,
      identity,
      settings.mode,
      settings.encoding,
      settings.powershellPath,
      limit,
      asciiTokens,
    ]);
    const cached = generation === this.generation ? this.cache.get(key) : undefined;
    if (cached) return cached.promise;
    if (this.inFlight.size >= 8) throw new Error('cmake.readBusy');
    if (this.cache.size >= 32) {
      const old = [...this.cache].find(([, entry]) => !entry.pending);
      if (old) this.cache.delete(old[0]);
    }
    const controller = new AbortController();
    const entry: CacheEntry = { controller, pending: true, promise: Promise.resolve(undefined as never) };
    entry.promise = this.perform(canonical, settings, limit, asciiTokens, controller.signal).finally(() => {
      entry.pending = false;
      this.inFlight.delete(entry);
    });
    this.inFlight.add(entry);
    if (generation === this.generation) this.cache.set(key, entry);
    return entry.promise;
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.inFlight].map((entry) => entry.promise);
    for (const entry of this.inFlight) entry.controller.abort();
    this.clear();
    await Promise.allSettled(pending);
  }

  private async perform(
    file: string,
    options: CmakeReadOptions,
    limit: number,
    asciiTokens: boolean,
    signal: AbortSignal
  ): Promise<ReadResult> {
    const attempts: NonNullable<CmakeDiagnostic['attempts']> = [];
    for (const reader of options.mode === 'auto' ? (['direct', 'powershell'] as const) : [options.mode]) {
      let executable: string | undefined;
      try {
        if (signal.aborted) throw new Error('cmake.readCancelled');
        let bytes: Buffer;
        if (reader === 'direct') bytes = await (this.dependencies.directRead ?? readBoundedBytes)(file, limit);
        else {
          const result = await (this.dependencies.powershellRead ?? readPowerShell)(
            file,
            { path: options.powershellPath, limit, env: this.dependencies.env ?? process.env },
            signal
          );
          bytes = result.bytes;
          executable = result.executable;
        }
        if (signal.aborted) throw new Error('cmake.readCancelled');
        const decoded = decode(bytes, options, limit, asciiTokens);
        return {
          text: decoded.text,
          info: { reader, encoding: decoded.encoding, ...(executable ? { executable } : {}) },
        };
      } catch (error) {
        const code = readErrorCode(error);
        const attempted = (error as { executable?: unknown })?.executable;
        if (!executable && typeof attempted === 'string' && path.isAbsolute(attempted) && !attempted.includes('\0'))
          executable = attempted;
        attempts.push({ reader, code, ...(executable ? { executable } : {}) });
        if (code === 'cmake.readCancelled' || code === 'cmake.fileTooLarge' || code === 'cmake.readMissing') break;
      }
    }
    const message = attempts.at(-1)?.code ?? 'cmake.readFailed';
    const diagnostic: CmakeDiagnostic = { kind: 'read', message, file, attempts };
    throw Object.assign(new Error(message), {
      diagnostic,
      ...(message === 'cmake.readMissing' ? { code: 'ENOENT' } : {}),
    });
  }
}

/** Bounded bytes for configuration and application-owned storage, with no child process. */
export async function readBoundedBytes(file: string, limit = 262144): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > limit) throw new Error('cmake.fileTooLarge');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > limit) throw new Error('cmake.fileTooLarge');
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}
