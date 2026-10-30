import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { createRepositoryCoordinator, repositoryCoordinator } from '../coordinator';
import { createGitExecutor, type GitExecutor } from '../executor';
import { scopeSchema } from '../validation';

export const MAX_FILE = 2 * 1024 * 1024;
export const MAX_PATCH = 8 * 1024 * 1024;
export const MAX_FILES = 2000;
export const MAX_JSON = 32 * 1024 * 1024;
export const MAX_CAPTURE = 32 * 1024 * 1024;
export const idSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
export const nameSchema = z.string().trim().min(1).max(500);
export const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

/** Reject dangerous names before interpreting any imported patch or renderer request. */
export function validatePath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 32768 ||
    hasControlCharacter(value) ||
    value.includes('\\') ||
    value.includes(':') ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error('Invalid project-relative file path');
  }
  const parts = value.split('/');
  if (
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:\.git|git~\d+|\.git~\d+)$/i.test(part)
    )
  ) {
    throw new Error('Unsafe project-relative file path');
  }
  return value;
}

export const pathsSchema = z
  .array(z.string())
  .min(1)
  .max(MAX_FILES)
  .transform((items) => [...new Set(items.map(validatePath))]);

/** Resolve each existing ancestor without following links, including the final file. */
export async function safeFile(root: string, relative: string): Promise<string> {
  validatePath(relative);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not supported by project storage');
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return current;
}

/** Write and flush a complete replacement before atomically publishing it. */
export async function atomicWrite(file: string, bytes: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function boundedRead(file: string, limit: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('File is unavailable or exceeds storage size limit');
    // Read at most limit + 1 even when a concurrently-written file grows after stat.
    const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > limit || offset !== info.size)
      throw new Error('File changed while reading or exceeds storage size limit');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse((await boundedRead(file, MAX_JSON)).toString('utf8')) as T;
  } catch (error) {
    if (missing(error)) return fallback;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_JSON) throw new Error('Storage metadata size limit exceeded');
  await atomicWrite(file, bytes);
}

export type StorageOptions = {
  resolveRoot: (scope: GitWorkbenchScope) => Promise<string>;
  storeDir: string;
  /** Host-resolved executable shared with every other workbench service. */
  git?: GitExecutor;
  /** Shared repository coordinator; renderer requests cannot supply or bypass it. */
  run?: <T>(root: string, operation: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
  /** Host-only scheduling option; never renderer input. */
  recorderIntervalMs?: number;
  now?: () => number;
  /** Host/test override for filesystem mutation; renderer input never reaches this port. */
  writeFile?: typeof writeProjectFile;
};
export type StorageContext = {
  root: string;
  dir: string;
  git: GitExecutor;
  now: () => number;
  log: (message: string) => void;
  writeFile: typeof writeProjectFile;
};
export function createStorageContext(options: StorageOptions) {
  if (!path.isAbsolute(options.storeDir)) throw new Error('Storage directory must be an absolute host-owned path');
  const git = options.git ?? createGitExecutor();
  const localCoordinator = createRepositoryCoordinator(async (root) => {
    const canonical = await realpath(root);
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  }, git);
  const sharedCoordinator = options.run ?? repositoryCoordinator.run;
  const resolve = async (scope: GitWorkbenchScope): Promise<StorageContext> => {
    scopeSchema.parse(scope);
    const root = await realpath(await options.resolveRoot(scope));
    if (!(await stat(root)).isDirectory()) throw new Error('Project root is not a directory');
    const identity = process.platform === 'win32' ? root.toLowerCase() : root;
    const dir = path.join(
      options.storeDir,
      'git-workbench',
      digest(JSON.stringify([scope.projectId, scope.peId, identity]))
    );
    await mkdir(dir, { recursive: true });
    return {
      root,
      dir,
      git,
      now: options.now ?? Date.now,
      log: options.log ?? (() => undefined),
      writeFile: options.writeFile ?? writeProjectFile,
    };
  };
  const run = async <T>(
    scope: GitWorkbenchScope,
    action: (context: StorageContext) => Promise<T>,
    mutation = false
  ): Promise<T> => {
    const context = await resolve(scope);
    if (mutation) {
      const probe = await git(context.root, ['rev-parse', '--show-toplevel'], true);
      if (probe.code === 0) return sharedCoordinator(context.root, () => action(context));
    }
    return localCoordinator.run(context.root, () => action(context));
  };
  return { resolve, run };
}

/** Read a regular file. Only a genuine missing file represents deletion. */
export async function currentFile(context: StorageContext, relative: string): Promise<Buffer | null> {
  try {
    return await boundedRead(await safeFile(context.root, relative), MAX_FILE);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function writeProjectFile(context: StorageContext, relative: string, bytes: Buffer | null): Promise<void> {
  const file = await safeFile(context.root, relative);
  if (bytes === null) await rm(file, { force: true });
  else {
    const existing = await stat(file).catch((error: unknown): Awaited<ReturnType<typeof stat>> | undefined => {
      if (missing(error)) return undefined;
      throw error;
    });
    await atomicWrite(file, bytes);
    if (existing) {
      const { chmod } = await import('node:fs/promises');
      await chmod(file, Number(existing.mode));
    }
  }
}
