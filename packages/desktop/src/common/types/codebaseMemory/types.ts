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
  /** Modules found from the dispatch tables, as listed in the file's modules section. */
  modules?: CodebaseMemoryModule[];
};

/** A module Woody found: a source file that registers functions in a dispatch table, with its header and same-prefix files. */
export type CodebaseMemoryModule = {
  /** Lowercase words joined by `-`, from the file name; usable as an expert id. */
  id: string;
  /** Project-relative files. */
  files: string[];
  /**
   * Set when the module is a split-file family such as `display_*.c` in one folder: `dir` is
   * the folder (`''` at the root) and `base` the lowercase name before the first `_`.
   */
  split?: { dir: string; base: string };
  /** Dispatch tables the module registers functions in. */
  tables: string[];
  /** The functions it registers there. */
  functions: string[];
  /** Ids of the experts that own any of its files. */
  experts: string[];
};

/**
 * State of a module expert's feature card `.woody/features/<id>.md`:
 * `nobrief` before Woody wrote the expert's brief (or after its paths changed), `missing`
 * before the expert wrote its own part, `stale` when the module's files changed after the
 * expert's last update, `ready`, or `error` when the card could not be read or written.
 */
export type ModuleCardState = 'nobrief' | 'missing' | 'stale' | 'ready' | 'error';

/** The short form of a brief that the expert's role rules carry. */
export type ModuleCardDigest = {
  files: number;
  /** Tasks, dispatch table entries and struct table fields, e.g. `secondList #1 SENSOR_Second`. */
  entries: string[];
  /** Functions called from outside the module, with who calls them (expert names, `shared`, `unowned`). */
  provides: Array<{ name: string; callers: string[] }>;
  /** Globals of the module that other files write or take the address of. */
  writtenOutside: string[];
  issues: {
    partial: number;
    unusable: number;
    changed: number;
    missingFunctions: number;
    missingGlobals: number;
    unmatched: number;
    drift?: number;
  };
};

export type ModuleCard = {
  id: string;
  /** Project-relative path of the card. */
  card: string;
  state: ModuleCardState;
  error?: string;
  generatedAt?: number;
  digest?: ModuleCardDigest;
};

export type CodebaseMemoryIndexDrift = {
  added: number;
  deleted: number;
  modified: number;
};

export type ModuleCards = {
  modules: CodebaseMemoryModule[];
  /** One entry per expert in `.woody/experts.json`, in its order. */
  experts: ModuleCard[];
  /** The experts file could not be read when the cards were last written. */
  error?: string;
  /** Current phase of the project's codebase-memory index. */
  indexPhase?: CodebaseMemoryStatus['phase'];
  /** Last index error when `indexPhase === 'failed'`. */
  indexError?: string;
  /** The last index was refused by the ciphertext pre-check; only `bypassPrecheck` gets past it. */
  indexPrecheckRefused?: boolean;
  /** Disk changes detected since the last completed index. */
  indexDrift?: CodebaseMemoryIndexDrift;
};

export type ModuleCardsRequest = {
  /** Write the briefs of `ids` (all experts when omitted) and of every expert whose brief is missing or outdated. */
  refresh?: boolean;
  ids?: string[];
  /** Language for a new architecture file and new cards. */
  language?: string;
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
