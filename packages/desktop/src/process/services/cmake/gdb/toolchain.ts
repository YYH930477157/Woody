import fs from 'node:fs/promises';
import path from 'node:path';

/** Prefer the user's debugger, then GCC's companion, then PATH. No package download. */
export async function resolveGdb(manual: string, compiler: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (
    manual &&
    (!path.isAbsolute(manual) ||
      (process.platform === 'win32' ? !/\.exe$/i.test(manual) : /\.(bat|cmd|ps1)$/i.test(manual)))
  )
    throw new Error('gdb.toolPath');
  const directories = [
    compiler ? path.dirname(compiler) : '',
    ...(Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '').split(path.delimiter),
  ].filter(Boolean);
  const candidates = manual
    ? [manual]
    : directories.map((directory) =>
        path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'gdb.exe' : 'gdb')
      );
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('gdb.toolNotFound');
}
