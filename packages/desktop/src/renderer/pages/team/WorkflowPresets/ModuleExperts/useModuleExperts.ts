import { useCallback, useEffect, useMemo, useState } from 'react';
import { ipcBridge } from '@/common';
import {
  expertIssue,
  MODULE_EXPERTS_LIMIT,
  type ExpertIssue,
  type ModuleExpert,
  type ModuleExpertsFile,
} from '@/common/types/team/moduleExperts';
import { isElectronDesktop } from '@renderer/utils/platform';

export type ExpertDraft = ModuleExpert & { key: string; selected: boolean };

type Loaded = {
  /** The folder the list was read from. */
  workspace: string;
  file: string;
  drafts: ExpertDraft[];
  shared: string[];
  /** The project already had a valid experts file. */
  saved: boolean;
};

let nextKey = 0;
const draftOf = (expert: ModuleExpert): ExpertDraft => ({ ...expert, key: `expert-${++nextKey}`, selected: true });

/**
 * The module experts of a project for a new expert team: read from the chosen folder's
 * `.woody/experts.json` (or started from its feature cards), edited in the dialog, and
 * written back when the team is created.
 */
export function useModuleExperts(workspace: string, active: boolean) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const available = isElectronDesktop();

  useEffect(() => {
    setLoaded(undefined);
    setError(undefined);
    setDirty(false);
    if (!active || !workspace || !available) return;
    let cancelled = false;
    setLoading(true);
    ipcBridge.codebaseMemory.experts
      .invoke({ repoPath: workspace })
      .then((state) => {
        if (cancelled) return;
        const experts =
          state.saved?.experts ?? state.cards.map((id) => ({ id, name: id, summary: '', paths: [] as string[] }));
        setLoaded({
          workspace,
          file: state.file,
          drafts: experts.slice(0, MODULE_EXPERTS_LIMIT).map(draftOf),
          shared: state.saved?.shared ?? [],
          saved: Boolean(state.saved),
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, available, workspace]);

  const change = useCallback((next: (current: Loaded) => Loaded) => {
    setLoaded((current) => (current ? next(current) : current));
    setDirty(true);
  }, []);

  const drafts = loaded?.drafts ?? [];
  const issues = useMemo(
    () =>
      new Map<string, ExpertIssue | null>(
        drafts.map((draft) => [
          draft.key,
          expertIssue(
            draft,
            drafts.filter((other) => other.key !== draft.key)
          ),
        ])
      ),
    [drafts]
  );
  const selected = drafts.filter((draft) => draft.selected);
  const canAdd = drafts.length < MODULE_EXPERTS_LIMIT;
  const ready = Boolean(loaded) && selected.length > 0 && drafts.every((draft) => !issues.get(draft.key));

  /** Write the list to the project when it changed or was never saved; returns the experts that join the team. */
  const save = useCallback(async (): Promise<{ experts: ModuleExpert[]; shared: string[] }> => {
    if (!loaded) throw new Error('No expert list is loaded');
    const strip = ({ key: _key, selected: _selected, ...expert }: ExpertDraft): ModuleExpert => expert;
    const file: ModuleExpertsFile = { version: 1, experts: loaded.drafts.map(strip), shared: loaded.shared };
    if (dirty || !loaded.saved) {
      await ipcBridge.codebaseMemory.saveExperts.invoke({ repoPath: loaded.workspace, file });
      setLoaded((current) => (current ? { ...current, saved: true } : current));
      setDirty(false);
    }
    return { experts: loaded.drafts.filter((draft) => draft.selected).map(strip), shared: loaded.shared };
  }, [dirty, loaded]);

  return {
    available,
    loading,
    error,
    file: loaded?.file,
    drafts,
    shared: loaded?.shared ?? [],
    issues,
    selected,
    canAdd,
    ready,
    save,
    add: () =>
      change((current) => ({
        ...current,
        drafts: [...current.drafts, draftOf({ id: '', name: '', summary: '', paths: [] })],
      })),
    /** Who joins this team is not saved, so choosing does not rewrite the file. */
    toggle: (key: string, selected: boolean) =>
      setLoaded((current) =>
        current
          ? {
              ...current,
              drafts: current.drafts.map((draft) => (draft.key === key ? { ...draft, selected } : draft)),
            }
          : current
      ),
    update: (key: string, patch: Partial<Omit<ExpertDraft, 'key' | 'selected'>>) =>
      change((current) => ({
        ...current,
        drafts: current.drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
      })),
    remove: (key: string) =>
      change((current) => ({ ...current, drafts: current.drafts.filter((draft) => draft.key !== key) })),
    setShared: (shared: string[]) => change((current) => ({ ...current, shared })),
  };
}

export type ModuleExpertsState = ReturnType<typeof useModuleExperts>;
