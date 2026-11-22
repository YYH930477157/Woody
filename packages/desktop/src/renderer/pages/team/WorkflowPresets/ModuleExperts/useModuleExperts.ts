import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { CodebaseMemoryIndexDrift, ModuleCard, ModuleCards } from '@/common/types/codebaseMemory/types';
import {
  expertIssue,
  MODULE_EXPERTS_LIMIT,
  modulePaths,
  type ExpertIssue,
  type ModuleExpert,
  type ModuleExpertsFile,
  type ModuleExpertsState as SavedExpertsState,
} from '@/common/types/team/moduleExperts';
import { isElectronDesktop } from '@renderer/utils/platform';

export type ExpertDraft = ModuleExpert & { key: string; selected: boolean };

export type ExpertIndexState = 'disabled' | 'unindexed' | 'running' | 'failed' | 'outdated' | 'ready';

type Loaded = {
  /** The folder the list was read from. */
  workspace: string;
  file: string;
  drafts: ExpertDraft[];
  shared: string[];
  /** The project already had a valid experts file. */
  saved: boolean;
  /** Card states from codebase memory; undefined when the project has none. */
  cards?: ModuleCards;
  /** The project already has the business overview `.woody/business.md`. */
  business: boolean;
};

let nextKey = 0;
const draftOf = (expert: ModuleExpert): ExpertDraft => ({ ...expert, key: `expert-${++nextKey}`, selected: true });

function initialExperts(state: SavedExpertsState, moduleCards: ModuleCards | undefined): ModuleExpert[] {
  if (state.saved?.experts) return state.saved.experts;
  if (state.cards.length > 0) {
    return state.cards.map((id) => ({ id, name: id, summary: '', paths: [] as string[] }));
  }
  if (moduleCards?.modules?.length) {
    return moduleCards.modules.map((mod) => ({
      id: mod.id,
      name: mod.id,
      summary: '',
      paths: modulePaths(moduleCards.modules, [mod.id]),
    }));
  }
  return [];
}

function resolveIndexState(
  cards: ModuleCards | undefined,
  indexing: boolean,
  actionError: string | undefined
): ExpertIndexState {
  if (actionError) return 'failed';
  if (indexing) return 'running';
  if (!cards) return 'disabled';
  const phase = cards.indexPhase ?? 'succeeded';
  if (phase === 'running') return 'running';
  if (phase === 'failed') return 'failed';
  if (phase === 'idle' || phase === 'cancelled') return 'unindexed';
  const drift = cards.indexDrift;
  if (drift && drift.added + drift.deleted + drift.modified > 0) return 'outdated';
  return 'ready';
}

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
  const [indexing, setIndexing] = useState(false);
  const [indexActionError, setIndexActionError] = useState<string>();
  // Experts whose cards are not up to date learn their modules when the team starts, and
  // the dispatcher writes the business overview when the project has none.
  const [onboard, setOnboard] = useState(true);
  const available = isElectronDesktop();
  const dirtyRef = useRef(false);
  const sessionRef = useRef(0);
  dirtyRef.current = dirty;

  const canIndex = Boolean(
    available &&
    workspace &&
    ipcBridge.codebaseMemory.get?.invoke &&
    ipcBridge.codebaseMemory.save?.invoke &&
    ipcBridge.codebaseMemory.start?.invoke
  );

  const reloadAfterIndex = useCallback(async (targetWorkspace: string, session: number) => {
    const cardsPromise = ipcBridge.codebaseMemory.moduleCards
      .invoke({ repoPath: targetWorkspace })
      .catch((): ModuleCards | undefined => undefined);
    const [state, moduleCards] = await Promise.all([
      ipcBridge.codebaseMemory.experts.invoke({ repoPath: targetWorkspace }),
      cardsPromise,
    ]);
    if (sessionRef.current !== session) return;
    setLoaded((current) => {
      const seeded = initialExperts(state, moduleCards).slice(0, MODULE_EXPERTS_LIMIT).map(draftOf);
      const keepDrafts = Boolean(current && (dirtyRef.current || current.drafts.length > 0));
      return {
        workspace: targetWorkspace,
        file: state.file,
        drafts: keepDrafts && current ? current.drafts : seeded,
        shared: keepDrafts && current ? current.shared : (state.saved?.shared ?? []),
        saved: Boolean(state.saved),
        cards: moduleCards,
        business: state.business,
      };
    });
  }, []);

  useEffect(() => {
    const session = ++sessionRef.current;
    setLoaded(undefined);
    setError(undefined);
    setDirty(false);
    setIndexing(false);
    setIndexActionError(undefined);
    if (!active || !workspace || !available) return;
    let cancelled = false;
    setLoading(true);
    // A project without codebase memory has no cards; the experts list still works.
    const cards = ipcBridge.codebaseMemory.moduleCards
      .invoke({ repoPath: workspace })
      .catch((): ModuleCards | undefined => undefined);
    Promise.all([ipcBridge.codebaseMemory.experts.invoke({ repoPath: workspace }), cards])
      .then(([state, moduleCards]) => {
        if (cancelled || sessionRef.current !== session) return;
        const experts = initialExperts(state, moduleCards);
        setLoaded({
          workspace,
          file: state.file,
          drafts: experts.slice(0, MODULE_EXPERTS_LIMIT).map(draftOf),
          shared: state.saved?.shared ?? [],
          saved: Boolean(state.saved),
          cards: moduleCards,
          business: state.business,
        });
      })
      .catch((reason: unknown) => {
        if (!cancelled && sessionRef.current === session) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled && sessionRef.current === session) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, available, workspace]);

  useEffect(() => {
    if (!active || !canIndex || !workspace || loaded?.cards?.indexPhase !== 'running') return;
    const session = sessionRef.current;
    let polling = false;
    const timer = setInterval(() => {
      if (polling || sessionRef.current !== session) return;
      polling = true;
      void ipcBridge.codebaseMemory.get
        .invoke({ repoPath: workspace })
        .then(async (status) => {
          if (sessionRef.current !== session || status.phase === 'running') return;
          await reloadAfterIndex(workspace, session);
        })
        .catch(() => {
          // Transient poll failures settle on the next tick.
        })
        .finally(() => {
          polling = false;
        });
    }, 500);
    return () => clearInterval(timer);
  }, [active, canIndex, loaded?.cards?.indexPhase, reloadAfterIndex, workspace]);

  /** Enable codebase memory when needed and start (or refresh) the project's index. */
  const runIndex = useCallback(
    async (language?: string): Promise<void> => {
      if (!canIndex || indexing || !workspace) return;
      const session = sessionRef.current;
      setIndexing(true);
      setIndexActionError(undefined);
      try {
        const status = await ipcBridge.codebaseMemory.get.invoke({ repoPath: workspace });
        if (sessionRef.current !== session) return;
        if (!status.config.enabled) {
          await ipcBridge.codebaseMemory.save.invoke({
            repoPath: workspace,
            config: { ...status.config, enabled: true },
          });
          if (sessionRef.current !== session) return;
        }
        const started = await ipcBridge.codebaseMemory.start.invoke({ repoPath: workspace, language });
        if (sessionRef.current !== session) return;
        if (started.phase === 'running') {
          setLoaded((current) =>
            current
              ? {
                  ...current,
                  cards: {
                    modules: current.cards?.modules ?? [],
                    experts: current.cards?.experts ?? [],
                    indexPhase: 'running',
                  },
                }
              : current
          );
        } else {
          await reloadAfterIndex(workspace, session);
        }
      } catch (reason: unknown) {
        if (sessionRef.current === session) {
          setIndexActionError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (sessionRef.current === session) setIndexing(false);
      }
    },
    [canIndex, indexing, reloadAfterIndex, workspace]
  );

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
  const hasCards = Boolean(loaded?.cards) && (loaded?.cards?.indexPhase ?? 'succeeded') === 'succeeded';
  const indexState = resolveIndexState(loaded?.cards, indexing, indexActionError);
  const indexDrift: CodebaseMemoryIndexDrift | undefined = loaded?.cards?.indexDrift;
  const indexError = indexActionError ?? loaded?.cards?.indexError;

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
    /** Whether the project has an active, completed codebase-memory index for feature cards. */
    hasCards,
    indexState,
    indexDrift,
    indexError,
    indexing: indexState === 'running',
    canIndex,
    runIndex,
    cardOf: (id: string): ModuleCard | undefined => loaded?.cards?.experts.find((card) => card.id === id),
    onboard,
    setOnboard,
    /** Whether the project lacks the business overview, so the dispatcher writes it when the team starts. */
    businessMissing: loaded ? !loaded.business : false,
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
