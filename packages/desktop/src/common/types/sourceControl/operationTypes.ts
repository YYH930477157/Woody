export type GitOperationRequest =
  | { kind: 'inspect' }
  | {
      kind: 'history.reword';
      commit: string;
      message: string;
      expectedHead: string;
      expectedBranch: string;
      confirmed: true;
    }
  | {
      kind: 'history.squash';
      commits: string[];
      message?: string;
      expectedHead: string;
      expectedBranch: string;
      confirmed: true;
    }
  | {
      kind: 'history.fixup' | 'history.drop';
      commits: string[];
      expectedHead: string;
      expectedBranch: string;
      confirmed: true;
    }
  | {
      kind: 'merge' | 'cherry-pick' | 'revert' | 'rebase';
      target: string;
      expectedHead: string;
      expectedBranch: string;
      confirmed: true;
    }
  | {
      kind: 'history.continue' | 'history.abort';
      operation: 'merge' | 'cherry-pick' | 'revert' | 'rebase';
      expectedHead: string;
      expectedBranch: string | null;
      confirmed: true;
    }
  | { kind: 'branch.create'; name: string; startPoint: string; expectedHead: string }
  | { kind: 'branch.switch'; name: string; expectedHead: string }
  | { kind: 'branch.rename'; name: string; newName: string; expectedRef: string; expectedHead: string; confirmed: true }
  | { kind: 'branch.delete'; name: string; expectedRef: string; expectedHead: string; confirmed: true }
  | { kind: 'tag.create'; name: string; target: string }
  | { kind: 'tag.delete'; name: string; expectedRef: string; confirmed: true }
  | { kind: 'fetch'; remote: string }
  | { kind: 'pull'; remote: string; branch: string; expectedHead: string }
  | { kind: 'push'; remote: string; branch: string; expectedHead: string; confirmed: true }
  | { kind: 'remote.list' }
  | { kind: 'remote.add'; name: string; url: string }
  | { kind: 'remote.setUrl'; name: string; url: string; expectedUrl: string; confirmed: true }
  | { kind: 'remote.remove'; name: string; expectedUrl: string; confirmed: true }
  | { kind: 'worktree.list' }
  | { kind: 'stash.list' }
  | { kind: 'stash.save'; message: string; includeUntracked: boolean; expectedHead: string }
  | { kind: 'stash.apply'; ref: string; expectedRef: string; expectedHead: string }
  | { kind: 'stash.pop'; ref: string; expectedRef: string; expectedHead: string; confirmed: true }
  | { kind: 'stash.drop'; ref: string; expectedRef: string; confirmed: true }
  | { kind: 'stash.show'; ref: string; expectedRef: string };

export type GitRemote = { name: string; fetchUrl: string; pushUrl: string };
export type GitStash = { ref: string; hash: string; subject: string; date: number };
export type GitWorktree = {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  main: boolean;
};
export type GitOperationOutcome = {
  state: 'complete' | 'blocked' | 'conflict' | 'error' | 'cancelled';
  output: string;
  reason?: string;
  files?: string[];
  data?: {
    remotes?: GitRemote[];
    stashes?: GitStash[];
    worktrees?: GitWorktree[];
    patch?: string;
    truncated?: boolean;
    head?: string | null;
    branch?: string | null;
    operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  };
};
