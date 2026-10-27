import { createRequire } from 'node:module';
import path from 'node:path';
import type { CodebaseMemoryConfig, CodebaseMemoryStatus } from '@/common/types/codebaseMemory/types';
import { createLensManager, type LensProject } from './lens';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type CodebaseMemoryServiceOptions = {
  binaryPath: string;
  adapterPath: string;
  cacheRoot: string;
  skillPath: string;
  openExternal?: (url: string) => Promise<void>;
};

export type CodebaseMemorySession = {
  enabled: boolean;
  transport?: { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };
  skillPath?: string;
};

export type CodebaseMemoryService = {
  get(repoPath: string): Promise<CodebaseMemoryStatus>;
  save(repoPath: string, config: CodebaseMemoryConfig): Promise<CodebaseMemoryStatus>;
  start(repoPath: string): Promise<CodebaseMemoryStatus>;
  cancel(repoPath: string): Promise<CodebaseMemoryStatus>;
  session(repoPath: string): Promise<CodebaseMemorySession>;
  openLens(repoPath: string): Promise<CodebaseMemoryStatus>;
  dispose(): Promise<void>;
};

/** Load the same packaged runtime used by MCP so locking and config never diverge. */
export function createCodebaseMemoryService(options: CodebaseMemoryServiceOptions): CodebaseMemoryService {
  const load = createRequire(path.resolve(options.adapterPath));
  const shared = load('./runtime.cjs') as {
    createRuntime(
      options: CodebaseMemoryServiceOptions
    ): Omit<CodebaseMemoryService, 'openLens' | 'dispose'> & { dispose(): void };
    canonical(repoPath: string): string;
    identity(root: string, cacheRoot: string): LensProject;
    terminateOwnedProcess(child: ChildProcessWithoutNullStreams): Promise<void>;
  };
  const runtime = shared.createRuntime(options);
  const lenses = createLensManager({
    binaryPath: options.binaryPath,
    terminateProcess: shared.terminateOwnedProcess,
    validateProject: async (project) => {
      const status = await runtime.get(project.root);
      if (!status.config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (status.phase !== 'succeeded')
        throw new Error('Initialize the project index successfully before opening Lens');
    },
    openExternal:
      options.openExternal ??
      (async () => {
        throw new Error('Browser launcher is unavailable');
      }),
  });
  const projectFor = (repoPath: string) => shared.identity(shared.canonical(repoPath), path.resolve(options.cacheRoot));
  return {
    ...runtime,
    async get(repoPath) {
      const status = await runtime.get(repoPath);
      if (!status.config.enabled) await lenses.stop(projectFor(repoPath).name);
      return status;
    },
    async save(repoPath, config) {
      const status = await runtime.save(repoPath, config);
      if (!status.config.enabled) await lenses.stop(projectFor(repoPath).name);
      return status;
    },
    async openLens(repoPath) {
      const status = await runtime.get(repoPath);
      if (!status.config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (!status.available) throw new Error('Bundled codebase-memory executable is unavailable');
      if (status.phase !== 'succeeded')
        throw new Error('Initialize the project index successfully before opening Lens');
      await lenses.open(projectFor(repoPath));
      return runtime.get(repoPath);
    },
    async dispose() {
      runtime.dispose();
      await lenses.dispose();
    },
  };
}
