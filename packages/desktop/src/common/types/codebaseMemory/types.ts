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
  updatedAt?: number;
};
