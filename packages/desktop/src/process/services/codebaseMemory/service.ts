import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  CodebaseMemoryConfig,
  CodebaseMemoryStatus,
  ModuleCards,
  ModuleCardsRequest,
} from '@/common/types/codebaseMemory/types';
import type { ModuleExpertsFile, ModuleExpertsState } from '@/common/types/team/moduleExperts';
import { createExpertsStore } from './experts';
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
  /** `language` is the panel's: files the first index creates use it. */
  start(repoPath: string, options?: { bypassPrecheck?: boolean; language?: string }): Promise<CodebaseMemoryStatus>;
  /** Add a folder the last index skipped by name to the project's .cbmignore, then index again. */
  include(repoPath: string, folder: string): Promise<CodebaseMemoryStatus>;
  /** Write .woody/architecture.md and the expert cards from the index, with headings in `language`. */
  architecture(repoPath: string, options?: { language?: string }): Promise<CodebaseMemoryStatus>;
  cancel(repoPath: string): Promise<CodebaseMemoryStatus>;
  session(repoPath: string): Promise<CodebaseMemorySession>;
  openLens(repoPath: string): Promise<CodebaseMemoryStatus>;
  /** The module experts saved in the project's `.woody/experts.json`, and its feature card ids. */
  experts(repoPath: string): Promise<ModuleExpertsState>;
  saveExperts(repoPath: string, file: ModuleExpertsFile): Promise<ModuleExpertsState>;
  /** State of each expert's feature card, and the detected modules; can write missing briefs first. */
  moduleCards(repoPath: string, options?: ModuleCardsRequest): Promise<ModuleCards>;
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
    findPowerShell(): string | undefined;
    looksLikeText(bytes: Buffer): boolean;
    readFileThroughPowerShellSync(executable: string, file: string): Buffer;
  };
  const runtime = shared.createRuntime(options);
  const powerShell = shared.findPowerShell();
  const experts = createExpertsStore({
    canonical: shared.canonical,
    looksLikeText: shared.looksLikeText,
    plainReader: powerShell ? (file) => shared.readFileThroughPowerShellSync(powerShell, file) : undefined,
  });
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
    async experts(repoPath) {
      return experts.read(repoPath);
    },
    async saveExperts(repoPath, file) {
      return experts.save(repoPath, file);
    },
    async dispose() {
      runtime.dispose();
      await lenses.dispose();
    },
  };
}
