import path from 'node:path';

/** Keep databases under the user profile: upstream rejects shared writable cache ancestors on Windows. */
export function resolveCodebaseMemoryResources(options: {
  resourceRoot: string;
  localAppData?: string;
  userData: string;
}) {
  const directory = path.join(options.resourceRoot, 'bundled-mcp', 'codebase-memory');
  return {
    binaryPath: path.join(directory, 'bin', 'win32-x64', 'codebase-memory-mcp.exe'),
    adapterPath: path.join(directory, 'index.cjs'),
    skillPath: path.join(directory, 'skills', 'woody-codebase-memory', 'SKILL.md'),
    cacheRoot: options.localAppData
      ? path.join(options.localAppData, 'AionUi', 'codebase-memory')
      : path.join(options.userData, 'codebase-memory'),
  };
}
