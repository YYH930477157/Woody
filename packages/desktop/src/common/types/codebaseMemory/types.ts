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

export type CodebaseMemoryStatus = {
  repoPath: string;
  config: CodebaseMemoryConfig;
  available: boolean;
  phase: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  log: string;
  error?: string;
  summary?: string;
  updatedAt?: number;
};
