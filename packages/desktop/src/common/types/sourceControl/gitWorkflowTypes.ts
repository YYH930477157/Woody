/** Shared contracts for the local Git submission workflow. */

export type GitWorkflowState =
  | 'idle'
  | 'draft_ready'
  | 'collecting'
  | 'message_draft'
  | 'scan'
  | 'repair'
  | 'rescan'
  | 'compile'
  | 'confirmation'
  | 'commit'
  | 'push'
  | 'completed'
  | 'blocked'
  | 'failed';

export type CommitMessageFields = {
  reason: string;
  scope: string;
  solution: string;
  impact: string;
  tests: string;
  largeChangeNote?: string;
};

export type LargeChangeMetrics = {
  fileCount: number;
  changedLines: number;
};

export type CommitMessageValidation = { ok: true } | { ok: false; field: keyof CommitMessageFields };

export type GitStatusSnapshot = {
  branch: string;
  changedPaths: string[];
};

export type GitBranch = {
  name: string;
  upstream?: string;
  current: boolean;
};

export type GitBranchSnapshot = { branches: GitBranch[] };

export type GitCommitSnapshot = {
  head: string | null;
  branch: string;
  tree: string;
};

export type GitWorkflowReasonCode =
  | 'scanFailed'
  | 'scanConfigRequired'
  | 'diagnosticsRemain'
  | 'snapshotChanged'
  | 'conversationRequired'
  | 'conversationBusy'
  | 'agentFailed'
  | 'repairOutsideSelection'
  | 'repairLimit'
  | 'buildConfigRequired'
  | 'buildAmbiguous'
  | 'buildFailed';

export type GitWorkflowCompileResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  reasonCode?: GitWorkflowReasonCode;
  commands?: string[];
};

export type GitOperationResult =
  | { ok: true }
  | { ok: false; kind: 'dirty-worktree' | 'command-failed'; stdout?: string; stderr?: string };

export type GitCommitResult =
  | { ok: true; commit: string }
  | { ok: false; kind: 'command-failed' | 'staged-selection' | 'snapshot-changed'; stdout: string; stderr: string };

export type GitPushResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; retryable: true; stdout: string; stderr: string };

export type GitWorkflowSession = {
  id: string;
  state: GitWorkflowState;
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  diagnostics: Array<{
    tool: 'clang-tidy' | 'pc-lint';
    file: string;
    line: number;
    column?: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    rule?: string;
  }>;
  compileResult?: GitWorkflowCompileResult;
  scanResults?: import('./staticScanTypes').StaticScanResult[];
  agentTurnIds?: string[];
  messageFields?: CommitMessageFields;
  message?: string;
  commit?: string;
  push?: GitPushResult;
  reason?: string;
  reasonCode?: GitWorkflowReasonCode;
};

export type GitWorkflowPrepareRequest = {
  checks?: import('./staticScanTypes').CommitCheckOptions;
  conversationId?: string;
  requestId?: string;
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  scannerConfigs: Array<{
    tool: 'clang-tidy' | 'pc-lint';
    executablePath: string;
    scope: 'selected' | 'repository';
    arguments: string[];
    compileCommandsPath?: string;
    timeoutMs?: number;
  }>;
  messageFields: CommitMessageFields;
};

export type GitWorkflowDraftRequest = {
  conversationId?: string;
  requestId?: string;
  repoPath: string;
  branch: string;
  selectedPaths: string[];
  messageFields: CommitMessageFields;
};
