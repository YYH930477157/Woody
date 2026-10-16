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
