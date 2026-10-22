import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSON5 from 'json5';
import type {
  CmakeConfiguration,
  CmakeDiagnostic,
  CmakeReadInfo,
  CmakeReadOptions,
  CmakeWorkspace,
} from '@/common/types/cmake';
import { defaultConfiguration, normalizeConfiguration } from '../configuration';
import { parseVariants } from '../variants';
import { ConfigurationReader, readBoundedBytes } from './reader';
export { ConfigurationReader } from './reader';

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

/** Discover source roots only when opening a workspace, never when running a saved target. */
export async function discoverProject(input: string): Promise<string> {
  const found = await discoverProjects(input);
  if (!found.projects.length) throw new Error(`cmake.projectMissing: ${found.workspacePath}`);
  if (found.projects.length > 1)
    throw new Error(`cmake.ambiguousProject: ${found.projects.map((candidate) => candidate.relativePath).join(', ')}`);
  return canonicalProject(found.projects[0].projectPath);
}

export async function discoverProjects(
  input: string,
  reader = new ConfigurationReader(),
  options?: CmakeReadOptions
): Promise<CmakeWorkspace> {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || !path.isAbsolute(input))
    throw new Error('cmake.invalidProject');
  const root = await fs.realpath(input).catch((error: unknown) => {
    if (missing(error)) throw new Error(`cmake.projectMissing: ${input}`);
    throw error;
  });
  const ignored = new Set(['.git', '.svn', '.hg', 'node_modules', 'build', 'out', 'dist', 'cmakefiles']);
  const candidates: string[] = [];
  let entries = 0;
  let directories = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (++directories > 2000 || depth > 16) throw new Error(`cmake.projectSearchLimit: ${root}`);
    try {
      if ((await fs.stat(path.join(directory, 'CMakeLists.txt'))).isFile()) {
        candidates.push(directory);
        return;
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (++entries > 50000) throw new Error(`cmake.projectSearchLimit: ${root}`);
      const name = entry.name.toLowerCase();
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(name) || name.startsWith('cmake-build-'))
        continue;
      const child = path.join(directory, entry.name);
      // Recheck junctions before descending; Windows projects often contain linked SDKs.
      if ((await fs.lstat(child)).isSymbolicLink() || !isInside(root, await fs.realpath(child))) continue;
      await visit(child, depth + 1);
    }
  }
  const configured = await configuredSources(root, reader, options);
  if (configured) candidates.push(...configured);
  else await visit(root, 0);
  return {
    workspacePath: root,
    projects: candidates
      .toSorted()
      .map((candidate) => ({ projectPath: candidate, relativePath: path.relative(root, candidate) || '.' })),
  };
}

async function configuredSources(
  root: string,
  reader: ConfigurationReader,
  options?: CmakeReadOptions
): Promise<string[] | undefined> {
  const file = path.join(root, '.vscode', 'settings.json');
  let text: string;
  try {
    const canonical = await containedConfiguration(root, file);
    text = (await reader.read(canonical, options)).text;
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error(`cmake.invalidProject: ${file}`, { cause: error });
  }
  try {
    const settings: unknown = JSON5.parse(text);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('expected settings');
    const value = (settings as Record<string, unknown>)['cmake.sourceDirectory'];
    if (value === undefined) return undefined;
    const sources: unknown[] = Array.isArray(value) ? value : [value];
    if (!sources.length || sources.length > 100) throw new Error('source directory count');
    const directories = new Map<string, string>();
    for (const source of sources) {
      if (typeof source !== 'string' || !source.trim() || source.includes('\0')) throw new Error('source directory');
      const expanded = source.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
        if (name === 'workspaceFolder' || name === 'workspaceRoot') return root;
        if (name === 'workspaceFolderBasename') return path.basename(root);
        throw new Error(`unsupported variable: ${name}`);
      });
      if (/[*?]/.test(expanded)) throw new Error('source directory glob');
      const directory = await canonicalProject(path.resolve(root, expanded));
      if (projectKey(root) !== projectKey(directory) && !isInside(root, directory))
        throw new Error('source directory outside workspace');
      directories.set(projectKey(directory), directory);
    }
    return [...directories.values()];
  } catch (cause) {
    throw new Error(`cmake.invalidProject: ${file} [cmake.sourceDirectory]`, { cause });
  }
}

export async function readBounded(file: string, limit = 262144): Promise<string> {
  return (await readBoundedBytes(file, limit)).toString('utf8');
}

async function containedConfiguration(root: string, file: string): Promise<string> {
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (!isInside(realRoot, realFile)) throw new Error('cmake.readPath');
  return realFile;
}

export async function loadVariantConfiguration(
  root: string,
  workspace = root,
  options?: CmakeReadOptions,
  reader = new ConfigurationReader()
): Promise<{
  dimensions: ReturnType<typeof parseVariants>;
  file?: string;
  error?: string;
  diagnostic?: CmakeDiagnostic;
  readInfo?: CmakeReadInfo;
}> {
  for (const directory of new Set([workspace, root])) {
    for (const file of [
      'cmake-variants.yaml',
      'cmake-variants.yml',
      'cmake-variants.json',
      '.vscode/cmake-variants.yaml',
      '.vscode/cmake-variants.yml',
      '.vscode/cmake-variants.json',
    ]) {
      const absolute = path.join(directory, file);
      let result: Awaited<ReturnType<ConfigurationReader['read']>>;
      try {
        const canonical = await containedConfiguration(directory, absolute);
        result = await reader.read(canonical, options);
      } catch (cause) {
        if (missing(cause)) continue;
        const diagnostic = configurationDiagnostic(cause, absolute, 'read');
        return { dimensions: [], file: absolute, error: variantError(diagnostic, absolute), diagnostic };
      }
      try {
        const text = result.text;
        const source = file.endsWith('.json') ? JSON.stringify(JSON5.parse(text)) : text;
        return { dimensions: parseVariants(source), file: absolute, readInfo: result.info };
      } catch (cause) {
        const diagnostic = configurationDiagnostic(cause, absolute);
        return {
          dimensions: [],
          file: absolute,
          error: variantError(diagnostic, absolute),
          diagnostic,
          readInfo: result.info,
        };
      }
    }
  }
  return { dimensions: parseVariants(undefined) };
}

/** Preserve parser locations but never include YAML snippets or JSON source tokens. */
export function configurationDiagnostic(
  cause: unknown,
  file: string,
  kind: CmakeDiagnostic['kind'] = 'syntax'
): CmakeDiagnostic {
  const error = cause as {
    diagnostic?: CmakeDiagnostic;
    message?: string;
    mark?: { line: number; column: number };
    lineNumber?: number;
    columnNumber?: number;
  };
  if (error?.diagnostic) return { ...error.diagnostic, file };
  const message =
    typeof error?.message === 'string' && /^cmake\.[A-Za-z]+(?:$|:)/.test(error.message)
      ? error.message
      : 'cmake.invalidVariants';
  return {
    kind: message.startsWith('cmake.unsupportedVariants')
      ? 'unsupported'
      : message.startsWith('cmake.variantConflict')
        ? 'conflict'
        : kind,
    message,
    file,
    ...(error?.mark ? { line: error.mark.line + 1, column: error.mark.column + 1 } : {}),
    ...(Number.isInteger(error?.lineNumber) ? { line: error.lineNumber, column: error.columnNumber } : {}),
  };
}

function variantError(diagnostic: CmakeDiagnostic, file: string): string {
  return `${diagnostic.kind === 'read' ? 'cmake.invalidVariants: ' : ''}${diagnostic.message}\n${file}`;
}

export async function loadDimensions(root: string): Promise<ReturnType<typeof parseVariants>> {
  const result = await loadVariantConfiguration(root);
  if (result.error) throw new Error(result.error);
  return result.dimensions;
}

function configurationFile(storage: string, root: string): string {
  return path.join(storage, `${createHash('sha256').update(projectKey(root)).digest('hex')}.json`);
}

/** A canonical source root retains its selected workspace for desktop and MCP calls. */
export async function loadProjectWorkspace(storage: string, root: string): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(await readBounded(`${configurationFile(storage, root)}.context`));
  } catch (error) {
    if (missing(error)) return root;
    throw error;
  }
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new Error('cmake.invalidProject');
  const workspace = await fs.realpath(value);
  if (projectKey(workspace) !== projectKey(root) && !isInside(workspace, root)) throw new Error('cmake.invalidProject');
  return workspace;
}

export async function storeProjectWorkspace(storage: string, root: string, workspace: string): Promise<void> {
  await writeJson(`${configurationFile(storage, root)}.context`, workspace);
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
  await writeJson(configurationFile(storage, root), config);
}

export async function loadWorkspaceSelection(storage: string, root: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readBounded(`${configurationFile(storage, root)}.workspace`));
    return typeof value === 'string' ? value : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export async function storeWorkspaceSelection(storage: string, root: string, relativePath: string): Promise<void> {
  await writeJson(`${configurationFile(storage, root)}.workspace`, relativePath);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
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
