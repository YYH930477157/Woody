/** Project-scoped identity; absolute repository paths are resolved by the main process. */
export type GitWorkbenchScope = { projectId: string; peId: string; relativePath: string };

export type GitHistoryQuery = {
  skip?: number;
  limit?: number;
  text?: string;
  author?: string;
  ref?: string;
  path?: string;
  since?: string;
  until?: string;
  firstParent?: boolean;
  noMerges?: boolean;
  snapshot?: string;
};

export type GitHistoryCommit = {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  committerName: string;
  committerEmail: string;
  commitDate: number;
  refs: string[];
  subject: string;
};
export type GitHistoryPage = { commits: GitHistoryCommit[]; hasMore: boolean; nextSkip: number; snapshot?: string };
export type GitWorkbenchRef = {
  fullName: string;
  name: string;
  type: 'local' | 'remote' | 'tag';
  hash: string;
  current: boolean;
  /** Raw ref object; annotated tags retain their tag identity for compare-and-delete. */
  objectHash?: string;
  upstream?: string;
  ahead: number;
  behind: number;
};
export type GitCommitFile = { path: string; oldPath?: string; status: string };
export type GitCommitDetails = { hash: string; body: string; files: GitCommitFile[] };
export type GitCommitDiff = { patch: string; binary: boolean; truncated?: boolean };
export type GitDiffAnchor = { kind: 'worktree' | 'index' | 'head' } | { kind: 'revision'; revision: string };
export type GitDiffRequest = { file: string; from: GitDiffAnchor; to: GitDiffAnchor };
export type GitFileHistoryQuery = { path: string; skip?: number; limit?: number };
export type GitRevisionContent = {
  revision: string;
  path: string;
  exists: boolean;
  binary: boolean;
  truncated: boolean;
  size: number;
  content?: string;
  contentBase64?: string;
};
export type GitBlameLine = {
  line: number;
  hash: string;
  committed: boolean;
  author?: string;
  authorTime?: number;
  content: string;
};

/** Safe renderer view of the cached host Git executable. */
export type GitRuntimeStatus = {
  configuredPath?: string;
  available: boolean;
  executable?: string;
  source?: 'configured' | 'system' | 'bundled';
  version?: string;
  capabilities?: {
    updateRefs: boolean;
    memoryHistoryEdit: boolean;
  };
  error?: string;
  attempts?: Array<{
    source: 'configured' | 'system' | 'bundled';
    path: string;
    reason: string;
  }>;
};
