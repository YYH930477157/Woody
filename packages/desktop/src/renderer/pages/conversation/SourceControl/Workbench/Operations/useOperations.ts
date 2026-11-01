import { useCallback, useEffect, useRef, useState } from 'react';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type {
  GitOperationOutcome,
  GitOperationProgress,
  GitOperationRequest,
  GitRemote,
  GitStash,
  GitWorktree,
} from '@/common/types/sourceControl/operationTypes';
import type { GitWorkbenchRef, GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { refreshRepo } from '../../scmStore';

type RepositoryData = {
  head: string | null;
  branch: string | null;
  operation?: string | null;
  refs: GitWorkbenchRef[];
  remotes: GitRemote[];
  stashes: GitStash[];
  worktrees: GitWorktree[];
};

/** Read local repository state and invalidate it after every explicit mutation outcome. */
export function useOperations(scope: GitWorkbenchScope, repoId: string) {
  const [data, setData] = useState<RepositoryData>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runningKind, setRunningKind] = useState<GitOperationRequest['kind']>();
  const [progress, setProgress] = useState<GitOperationProgress>();
  const [error, setError] = useState<string>();
  const [interrupted, setInterrupted] = useState(false);
  const [outcome, setOutcome] = useState<GitOperationOutcome>();
  const generation = useRef(0);
  const running = useRef(false);
  const activeRemote = useRef<{ scope: GitWorkbenchScope; operationId: string }>(undefined);
  const read = useCallback(
    async (request: number) => {
      setLoading(true);
      setError(undefined);
      try {
        const [refs, inspected, remote, stash, tree] = await Promise.all([
          gitWorkbench.refs.invoke({ scope }),
          ...(['inspect', 'remote.list', 'stash.list', 'worktree.list'] as const).map((kind) =>
            gitWorkbench.operate.invoke({ scope, request: { kind } })
          ),
        ]);
        if (generation.current !== request) return;
        setInterrupted(inspected.reason === 'historyInterrupted');
        for (const result of [inspected, remote, stash, tree])
          if (result.state !== 'complete') throw new Error(result.output || result.reason);
        setData({
          refs,
          head: inspected.data?.head ?? null,
          branch: inspected.data?.branch ?? null,
          operation: inspected.data?.operation,
          remotes: remote.data?.remotes ?? [],
          stashes: stash.data?.stashes ?? [],
          worktrees: tree.data?.worktrees ?? [],
        });
      } catch (failure) {
        if (generation.current === request) {
          setData(undefined);
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      } finally {
        if (generation.current === request) setLoading(false);
      }
    },
    [scope]
  );
  useEffect(() => {
    const request = ++generation.current;
    running.current = false;
    setBusy(false);
    setRunningKind(undefined);
    setData(undefined);
    setOutcome(undefined);
    void read(request);
    return () => {
      ++generation.current;
      if (activeRemote.current) {
        void gitWorkbench.cancel.invoke(activeRemote.current).catch(() => {});
        activeRemote.current = undefined;
      }
    };
  }, [read]);
  useEffect(
    () =>
      gitWorkbench.operationProgress?.on(({ operationId, phase, percent }) => {
        if (operationId === activeRemote.current?.operationId) setProgress({ phase, percent });
      }),
    []
  );
  const refresh = useCallback(() => {
    if (!running.current) void read(++generation.current);
  }, [read]);
  const run = useCallback(
    async (request: GitOperationRequest): Promise<GitOperationOutcome | undefined> => {
      if (running.current || loading) return undefined;
      running.current = true;
      setBusy(true);
      setRunningKind(request.kind);
      setProgress(undefined);
      setOutcome(undefined);
      const epoch = generation.current;
      const operationId = ['fetch', 'pull', 'push'].includes(request.kind) ? crypto.randomUUID() : undefined;
      if (operationId) activeRemote.current = { scope, operationId };
      let result: GitOperationOutcome | undefined;
      try {
        result = await gitWorkbench.operate.invoke({ scope, request, operationId });
      } catch (failure) {
        result = { state: 'error', output: failure instanceof Error ? failure.message : String(failure) };
      } finally {
        if (generation.current === epoch) setOutcome(result);
        if (activeRemote.current?.operationId === operationId) activeRemote.current = undefined;
        try {
          await refreshRepo(repoId);
        } finally {
          if (generation.current === epoch) {
            await read(epoch);
            running.current = false;
            setBusy(false);
            setRunningKind(undefined);
            setProgress(undefined);
          }
        }
      }
      return generation.current === epoch ? result : undefined;
    },
    [scope, repoId, loading, read]
  );
  const cancel = useCallback(async () => {
    const active = activeRemote.current;
    if (!active) return;
    try {
      await gitWorkbench.cancel.invoke(active);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  return {
    data,
    loading,
    busy,
    runningKind,
    progress,
    error,
    interrupted,
    outcome,
    refresh,
    run,
    cancel,
    canCancel: busy && !!activeRemote.current,
  };
}
