import { createRequire } from 'node:module';
import path from 'node:path';
import type { CodebaseMemoryConfig, CodebaseMemoryStatus } from '@/common/types/codebaseMemory/types';

export type CodebaseMemoryServiceOptions = {
  binaryPath: string;
  adapterPath: string;
  cacheRoot: string;
  skillPath: string;
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
  dispose(): void;
};

/** Load the same packaged runtime used by MCP so locking and config never diverge. */
export function createCodebaseMemoryService(options: CodebaseMemoryServiceOptions): CodebaseMemoryService {
  const load = createRequire(path.resolve(options.adapterPath));
  const shared = load('./runtime.cjs') as {
    createRuntime(options: CodebaseMemoryServiceOptions): CodebaseMemoryService;
  };
  return shared.createRuntime(options);
}
