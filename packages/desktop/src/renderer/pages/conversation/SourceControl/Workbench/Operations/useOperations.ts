import { useCallback, useEffect, useRef, useState } from 'react';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type {
  GitOperationOutcome,
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
  const [error, setError] = useState<string>();
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
  const refresh = useCallback(() => {
    if (!running.current) void read(++generation.current);
  }, [read]);
  const run = useCallback(
    async (request: GitOperationRequest) => {
      if (running.current || loading) return;
      running.current = true;
      setBusy(true);
      setOutcome(undefined);
      const epoch = generation.current;
      const operationId = ['fetch', 'pull', 'push'].includes(request.kind) ? crypto.randomUUID() : undefined;
      if (operationId) activeRemote.current = { scope, operationId };
      try {
        const result = await gitWorkbench.operate.invoke({ scope, request, operationId });
        if (generation.current === epoch) setOutcome(result);
      } catch (failure) {
        if (generation.current === epoch)
          setOutcome({ state: 'error', output: failure instanceof Error ? failure.message : String(failure) });
      } finally {
        if (activeRemote.current?.operationId === operationId) activeRemote.current = undefined;
        try {
          await refreshRepo(repoId);
        } finally {
          if (generation.current === epoch) {
            await read(epoch);
            running.current = false;
            setBusy(false);
          }
        }
      }
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
  return { data, loading, busy, error, outcome, refresh, run, cancel, canCancel: busy && !!activeRemote.current };
}
