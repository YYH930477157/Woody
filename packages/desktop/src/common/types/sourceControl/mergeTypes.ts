import type { ChangeState } from '@/common/git/merge/mergeModel';
import type { GitOperationOutcome } from './operationTypes';

export type GitMergeOperation = NonNullable<GitOperationOutcome['data']>['operation'];
export type GitMergeStage = {
  oid: string | null;
  mode: string | null;
  text: string | null;
  binary: boolean;
  deleted: boolean;
};
export type GitMergeProgress = { lines: string[]; states: ChangeState[]; contentModified: boolean };
export type GitMergeDocument = {
  file: string;
  /** Opaque identity of HEAD, branch, operation, complete index, and working file. */
  version: string;
  head: string;
  branch: string | null;
  operation: GitMergeOperation;
  /** Git stage 2 is always ours/current and stage 3 theirs/incoming, including during rebase. */
  stages: { base: GitMergeStage; ours: GitMergeStage; theirs: GitMergeStage };
  result: string | null;
  binary: boolean;
  crlf: boolean;
  progress?: GitMergeProgress;
  recoveryStale?: boolean;
  /** Saved draft differing from the working file; restore only after explicit user action. */
  recoveryResult?: string;
};
export type GitMergeList = { files: string[]; operation: GitMergeOperation };
export type GitMergeSaveRequest = { file: string; version: string; result: string; progress?: GitMergeProgress };
export type GitMergeFinishRequest = {
  file: string;
  version: string;
  resolution: 'result' | 'ours' | 'theirs' | 'delete';
  result?: string;
  /** Explicit acknowledgement that marker-like text is intentional in a manually reviewed result. */
  reviewedManual?: boolean;
  confirmed: true;
};
export type GitMergeOutcome = { state: 'complete' | 'blocked' | 'error'; output: string };
