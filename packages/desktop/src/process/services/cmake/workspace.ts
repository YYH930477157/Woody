import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CmakeConfiguration } from '@/common/types/cmake';
import { defaultConfiguration, normalizeConfiguration } from './configuration';
import { parseVariants } from './variants';

export const projectKey = (root: string): string => (process.platform === 'win32' ? root.toLowerCase() : root);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function canonicalProject(input: string): Promise<string> {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || !path.isAbsolute(input))
    throw new Error('cmake.invalidProject');
  const root = await fs.realpath(input);
  const stat = await fs.stat(path.join(root, 'CMakeLists.txt'));
  if (!stat.isFile()) throw new Error('cmake.invalidProject: CMakeLists.txt missing');
  return root;
}

export async function readBounded(file: string, limit = 262144): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > limit) throw new Error('cmake.fileTooLarge');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('cmake.fileTooLarge');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function loadDimensions(root: string): Promise<ReturnType<typeof parseVariants>> {
  const found: string[] = [];
  for (const file of [
    'cmake-variants.yaml',
    'cmake-variants.yml',
    '.vscode/cmake-variants.yaml',
    '.vscode/cmake-variants.yml',
  ]) {
    try {
      found.push(await readBounded(path.join(root, file)));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  if (found.length > 1) throw new Error('cmake.ambiguousVariants: multiple variants files');
  return parseVariants(found[0]);
}

function configurationFile(storage: string, root: string): string {
  return path.join(storage, `${createHash('sha256').update(projectKey(root)).digest('hex')}.json`);
}

export async function loadConfiguration(storage: string, root: string): Promise<CmakeConfiguration> {
  try {
    return normalizeConfiguration(
      JSON.parse(await readBounded(configurationFile(storage, root))) as CmakeConfiguration
    );
  } catch (error) {
    if (missing(error)) return defaultConfiguration();
    throw error;
  }
}

export async function storeConfiguration(storage: string, root: string, config: CmakeConfiguration): Promise<void> {
  await fs.mkdir(storage, { recursive: true });
  const file = configurationFile(storage, root);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(config, null, 2), { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reject junctions before any generated build directory is created. */
export async function buildDirectory(root: string, hash: string, create = false): Promise<string> {
  let current = root;
  for (const segment of ['build', 'woody', hash]) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(root, await fs.realpath(current)))
        throw new Error('cmake.buildPath: build path is not a contained directory');
    } catch (error) {
      if (!missing(error)) throw error;
      if (create) await fs.mkdir(current);
    }
  }
  return current;
}

export async function validateExecutable(build: string, input: string, require32Bit: boolean): Promise<string> {
  if (!input || path.isAbsolute(input) || path.extname(input).toLowerCase() !== '.exe')
    throw new Error('cmake.executablePath: choose a relative .exe inside the build directory');
  const candidate = path.resolve(build, input);
  if (!isInside(build, candidate)) throw new Error('cmake.executablePath: executable escapes build directory');
  const real = await fs.realpath(candidate);
  if (!isInside(await fs.realpath(build), real) || !(await fs.stat(real)).isFile())
    throw new Error('cmake.executablePath: executable escapes build directory');
  await verifyArchitecture(real, require32Bit);
  return real;
}

/** Read the executable header without running compiler probes or project binaries. */
export async function verifyArchitecture(file: string, require32Bit: boolean): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ')
      throw new Error('cmake.architecture: not a Windows executable');
    const offset = header.readUInt32LE(60);
    if (offset > 1048576) throw new Error('cmake.architecture: invalid PE header');
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.toString('ascii', 0, 4) !== 'PE\0\0')
      throw new Error('cmake.architecture: invalid PE signature');
    const machine = pe.readUInt16LE(4);
    if (require32Bit ? machine !== 0x14c : ![0x14c, 0x8664].includes(machine))
      throw new Error(
        `cmake.architecture: expected ${require32Bit ? 'Win32 x86' : 'Windows x86/x64'}, machine 0x${machine.toString(16)}`
      );
  } finally {
    await handle.close();
  }
}
