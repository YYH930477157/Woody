/** Shared contracts for the local Git submission workflow. */

export type GitWorkflowState =
  | 'idle'
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

export type GitOperationResult =
  | { ok: true }
  | { ok: false; kind: 'dirty-worktree' | 'command-failed'; stdout?: string; stderr?: string };

export type GitCommitResult =
  | { ok: true; commit: string }
  | { ok: false; kind: 'command-failed' | 'staged-selection'; stdout: string; stderr: string };

export type GitPushResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; retryable: true; stdout: string; stderr: string };
