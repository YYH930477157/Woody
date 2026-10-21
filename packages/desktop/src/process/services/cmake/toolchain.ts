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

/** Resolve manual paths, companion tools, then PATH; no shell lookup is involved. */
export async function resolveTools(config: CmakeTools, env: NodeJS.ProcessEnv): Promise<CmakeTools> {
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
  const cmake = await resolve(config.cmake, ['cmake']);
  const cCompiler = await resolve(config.cCompiler, ['gcc']);
  const ctest = await resolve(config.ctest, ['ctest'], cmake ? [path.dirname(cmake)] : []);
  const cxxCompiler = await resolve(config.cxxCompiler, ['g++'], cCompiler ? [path.dirname(cCompiler)] : []);
  const make = await resolve(config.make, ['mingw32-make', 'make'], cCompiler ? [path.dirname(cCompiler)] : []);
  return { cmake, ctest, cCompiler, cxxCompiler, make };
}

export async function requireTools(tools: CmakeTools, names: (keyof CmakeTools)[]): Promise<void> {
  for (const name of names)
    if (!tools[name] || !(await executable([tools[name]]))) throw new Error(`cmake.toolNotFound: ${name}`);
}

export async function toolIdentity(tools: CmakeTools): Promise<Record<string, string>> {
  const identities: Record<string, string> = {};
  for (const [name, file] of Object.entries(tools)) {
    if (!file) continue;
    try {
      const stat = await fs.stat(file);
      identities[name] = `${stat.size}:${stat.mtimeMs}`;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return identities;
}
