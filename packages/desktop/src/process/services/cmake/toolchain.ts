import fs from 'node:fs/promises';
import path from 'node:path';
import type { CmakeTools } from '@/common/types/cmake';

async function executable(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return '';
}

/** Resolve tools strictly, or collect independent failures for an inspection-only caller. */
export async function resolveTools(
  config: CmakeTools,
  env: NodeJS.ProcessEnv,
  errors?: Partial<Record<keyof CmakeTools, string>>
): Promise<CmakeTools> {
  const directories = (Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => directory.replace(/^"|"$/g, ''));
  const resolve = async (manual: string, names: string[], companions: string[] = []): Promise<string> => {
    if (manual) {
      if (!path.isAbsolute(manual) || /\.(?:cmd|bat|ps1)$/i.test(manual))
        throw new Error('cmake.toolPath: tools require absolute native executable paths');
      return (await executable([manual])) || manual;
    }
    const candidates = [...companions, ...directories].flatMap((directory) =>
      names.flatMap((name) => [
        path.join(directory, `${name}.exe`),
        ...(process.platform === 'win32' ? [] : [path.join(directory, name)]),
      ])
    );
    return executable(candidates);
  };
  const checked = async (name: keyof CmakeTools, names: string[], companions: string[] = []): Promise<string> => {
    try {
      return await resolve(config[name], names, companions);
    } catch (error) {
      if (!errors) throw error;
      const cause = error as NodeJS.ErrnoException;
      errors[name] = cause.message?.startsWith('cmake.toolPath:')
        ? 'cmake.toolPath'
        : ['EACCES', 'EPERM'].includes(cause.code ?? '')
          ? 'cmake.readDenied'
          : 'cmake.readFailed';
      return config[name];
    }
  };
  const cmake = await checked('cmake', ['cmake']);
  const cCompiler = await checked('cCompiler', ['gcc']);
  const ctest = await checked('ctest', ['ctest'], cmake ? [path.dirname(cmake)] : []);
  const cxxCompiler = await checked('cxxCompiler', ['g++'], cCompiler ? [path.dirname(cCompiler)] : []);
  const make = await checked('make', ['mingw32-make', 'make'], cCompiler ? [path.dirname(cCompiler)] : []);
  return { cmake, ctest, cCompiler, cxxCompiler, make };
}

export async function requireTools(tools: CmakeTools, names: (keyof CmakeTools)[]): Promise<void> {
  for (const name of names)
    if (!tools[name] || !(await executable([tools[name]]))) throw new Error(`cmake.toolNotFound: ${name}`);
}

export async function toolIdentity(
  tools: CmakeTools,
  errors?: Partial<Record<keyof CmakeTools, string>>
): Promise<Record<string, string>> {
  const identities: Record<string, string> = {};
  for (const [name, file] of Object.entries(tools)) {
    if (!file) continue;
    try {
      const stat = await fs.stat(file);
      identities[name] = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (['ENOENT', 'ENOTDIR'].includes(code)) continue;
      if (!errors) throw error;
      errors[name as keyof CmakeTools] = ['EACCES', 'EPERM'].includes(code) ? 'cmake.readDenied' : 'cmake.readFailed';
    }
  }
  return identities;
}
