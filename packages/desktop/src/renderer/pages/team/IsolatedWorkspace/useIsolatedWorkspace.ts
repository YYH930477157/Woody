import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { TeamWorktreeCreated, TeamWorktreeSource } from '@/common/types/sourceControl/operationTypes';
import { isElectronDesktop } from '@renderer/utils/platform';

export class IsolatedWorkspaceError extends Error {
  constructor(
    readonly reason: string | undefined,
    message: string
  ) {
    super(message);
  }
}

type Prepared = TeamWorktreeCreated & { from: string };

/**
 * The "separate workspace" choice of a new team: the repository around the chosen folder,
 * and the worktree made for the team. A worktree made for a team that then failed to be
 * created is reused on retry from the same folder, and removed when the dialog closes.
 */
export function useIsolatedWorkspace(workspace: string) {
  const [source, setSource] = useState<TeamWorktreeSource | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [prepared, setPrepared] = useState<Prepared>();
  const preparedRef = useRef<Prepared | undefined>(undefined);
  preparedRef.current = prepared;

  useEffect(() => {
    setSource(null);
    if (!workspace || !isElectronDesktop()) return;
    let cancelled = false;
    ipcBridge.gitWorkbench.teamWorktreeInspect
      .invoke({ path: workspace })
      .then((result) => {
        if (!cancelled) setSource(result);
      })
      .catch(() => {
        if (!cancelled) setSource(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const discardPrepared = useCallback((target: Prepared | undefined) => {
    if (!target) return;
    ipcBridge.gitWorkbench.teamWorktreeDiscard
      .invoke({ path: target.worktree })
      .catch((error: unknown) => console.warn('Failed to remove the prepared team worktree', error));
  }, []);

  const available = Boolean(source?.branch && source.head);

  /** The worktree for the team: the prepared one when it came from this folder, otherwise a new one. */
  const prepare = useCallback(
    async (name: string): Promise<TeamWorktreeCreated> => {
      const current = preparedRef.current;
      if (current?.from === workspace) return current;
      discardPrepared(current);
      setPrepared(undefined);
      const result = await ipcBridge.gitWorkbench.teamWorktreeCreate.invoke({ path: workspace, name });
      if (result.state !== 'complete') throw new IsolatedWorkspaceError(result.reason, result.output);
      const next = { ...result.worktree, from: workspace };
      preparedRef.current = next;
      setPrepared(next);
      return next;
    },
    [workspace, discardPrepared]
  );

  /** Closing without a team: remove the unused worktree. */
  const discard = useCallback(() => {
    discardPrepared(preparedRef.current);
  }, [discardPrepared]);

  const reset = useCallback(() => {
    preparedRef.current = undefined;
    setPrepared(undefined);
    setEnabled(false);
  }, []);

  return {
    source,
    available,
    enabled: enabled && available,
    setEnabled,
    prepared,
    prepare,
    discard,
    reset,
  };
}

export type IsolatedWorkspaceState = ReturnType<typeof useIsolatedWorkspace>;
