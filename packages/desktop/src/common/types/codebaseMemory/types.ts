import type { IMcpServerTransportStdio } from '@/common/config/storage';

export type CodebaseMemorySession = {
  enabled: boolean;
  transport?: IMcpServerTransportStdio;
  skillPath?: string;
};

export type CodebaseMemoryConfig = {
  version: 1;
  enabled: boolean;
  mode: 'fast' | 'moderate' | 'full';
};

/** Why an index run failed, as classified by the shared runtime. */
export type CodebaseMemoryDiagnosis =
  | 'encrypted-for-app'
  | 'encrypted-on-disk'
  | 'permission-denied'
  | 'missing-binary'
  | 'launcher-missing'
  | 'timeout'
  | 'worker-crash'
  | 'unknown';

export type CodebaseMemorySkippedFolder = {
  /** Project-relative, with `/` separators. */
  path: string;
  /** Source files counted inside it, up to a cap. */
  files: number;
  /** The count stopped at the cap. */
  more?: boolean;
  /** .cbmignore already asks for it, yet it is still skipped: a .gitignore rule excludes it. */
  requested?: boolean;
  /** Woody cannot read the project's .cbmignore as text (encrypted for Woody); the user adds the rule. */
  manual?: boolean;
};

/** The project's .woody/architecture.md, as the last generation left it. */
export type CodebaseMemoryArchitecture = {
  generatedAt?: number;
  /** Tasks and dispatch tables found. */
  tasks?: number;
  tables?: number;
  /** Language of the generated headings. */
  language?: string;
  /** The last update failed; the file keeps its earlier content. */
  error?: string;
};

export type CodebaseMemoryStatus = {
  repoPath: string;
  config: CodebaseMemoryConfig;
  available: boolean;
  phase: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  log: string;
  error?: string;
  reason?: 'unreadable';
  launcher?: 'powershell' | 'direct';
  summary?: string;
  /** Full failure report (environment, folder, encryption and read probes). */
  diagnostics?: string;
  /** File the same report was written to, ready to attach to a bug report. */
  diagnosticsPath?: string;
  conclusion?: CodebaseMemoryDiagnosis;
  /** The run was refused before the indexer started: Woody reads ciphertext where PowerShell 7 reads text. */
  precheckRefused?: boolean;
  /** An earlier index proved the indexer reads plaintext here, so the pre-check is skipped. */
  indexerReadsPlain?: boolean;
  /** Folders holding source files that the last index skipped by name (obj, build, thirdparty...). */
  skippedSources?: CodebaseMemorySkippedFolder[];
  /** Present once .woody/architecture.md exists; updated after every index. */
  architecture?: CodebaseMemoryArchitecture;
  updatedAt?: number;
};
