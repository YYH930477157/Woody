import type { GitHistoryCommit, GitHistoryPage } from '@/common/types/sourceControl/workbenchTypes';
import type { ScmRepository } from '@/renderer/pages/conversation/SourceControl/scmModel';

export const commit = (hash: string, subject = hash, parents: string[] = []): GitHistoryCommit => ({
  hash,
  subject,
  parents,
  authorName: 'Ada',
  authorEmail: 'ada@example.test',
  authorDate: 1720000000,
  committerName: 'Ada',
  committerEmail: 'ada@example.test',
  commitDate: 1720000000,
  refs: [],
});
export const page = (commits: GitHistoryCommit[], hasMore = false, nextSkip = commits.length): GitHistoryPage => ({
  commits,
  hasMore,
  nextSkip,
});
export const repository = (id: string): ScmRepository => ({
  repo_id: id,
  provider_id: 'git',
  root: { pe_id: id, relative_path: 'nested' },
  label: id,
  capabilities: { staging: true, local_branches: true, history_graph: false, remote_ops: false },
  state: 'idle',
});
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
