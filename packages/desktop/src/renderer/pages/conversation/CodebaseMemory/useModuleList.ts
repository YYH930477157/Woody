import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { CodebaseMemoryModule, ModuleCards } from '@/common/types/codebaseMemory/types';
import {
  expertIssue,
  MODULE_EXPERTS_LIMIT,
  modulePaths,
  type ExpertIssue,
  type ModuleExpert,
  type ModuleExpertsFile,
} from '@/common/types/team/moduleExperts';

export { modulePaths };

export type ExpertFields = Pick<ModuleExpert, 'id' | 'name' | 'summary'>;
type Busy = 'create' | 'add' | 'refresh';
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The detected modules of a project and its module experts, for the Architecture panel:
 * turn chosen modules into a new expert or add them to one, and keep the experts' cards
 * written. `version` changes whenever the panel's status does, so the list follows each index.
 */
export function useModuleList(repoPath: string, enabled: boolean, version: number | undefined) {
  const { i18n } = useTranslation();
  const [file, setFile] = useState<ModuleExpertsFile | null>(null);
  const [cards, setCards] = useState<ModuleCards>();
  const [expertsError, setExpertsError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<Busy>();
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    const [expertsResult, cardsResult] = await Promise.allSettled([
      ipcBridge.codebaseMemory.experts.invoke({ repoPath }),
      ipcBridge.codebaseMemory.moduleCards.invoke({ repoPath }),
    ]);
    if (request.current !== current) return;
    if (expertsResult.status === 'fulfilled') {
      setFile(expertsResult.value.saved);
      setExpertsError(undefined);
    } else {
      setFile(null);
      setExpertsError(errorMessage(expertsResult.reason));
    }
    if (cardsResult.status === 'fulfilled') {
      setCards(cardsResult.value);
      setError(undefined);
    } else {
      setCards(undefined);
      // Avoid duplicating the experts-file error when experts.invoke already reported it.
      setError(expertsResult.status === 'rejected' ? undefined : errorMessage(cardsResult.reason));
    }
  }, [repoPath]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, version]);

  /** Save the experts, then write the changed expert's card from the index. */
  const saveAndWrite = async (next: ModuleExpertsFile, id: string) => {
    await ipcBridge.codebaseMemory.saveExperts.invoke({ repoPath, file: next });
    setFile(next);
    setExpertsError(undefined);
    try {
      setCards(
        await ipcBridge.codebaseMemory.moduleCards.invoke({
          repoPath,
          refresh: true,
          ids: [id],
          language: i18n?.language,
        })
      );
    } catch (cause) {
      // The expert is already saved; surface the card-write failure so the user can retry Refresh.
      setError(errorMessage(cause));
    }
  };
  /** Resolves true when the work succeeded; a failure is shown in the list. */
  const run = async (action: Busy, work: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(action);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const experts = file?.experts ?? [];

  return {
    file,
    experts,
    cards,
    expertsError,
    error,
    busy,
    canCreate: experts.length < MODULE_EXPERTS_LIMIT,
    /** The first problem with a new expert made of `moduleIds`, or null. */
    issueOf: (fields: ExpertFields, modules: CodebaseMemoryModule[], moduleIds: string[]): ExpertIssue | null =>
      expertIssue({ ...fields, paths: modulePaths(modules, moduleIds) }, experts),
    create: (fields: ExpertFields, modules: CodebaseMemoryModule[], moduleIds: string[]) =>
      run('create', async () => {
        const expert: ModuleExpert = { ...fields, paths: modulePaths(modules, moduleIds) };
        const issue = expertIssue(expert, experts);
        if (issue) throw new Error(issue);
        await saveAndWrite({ version: 1, experts: [...experts, expert], shared: file?.shared ?? [] }, expert.id);
      }),
    addTo: (expertId: string, modules: CodebaseMemoryModule[], moduleIds: string[]) =>
      run('add', async () => {
        const next = experts.map((expert) =>
          expert.id === expertId
            ? { ...expert, paths: [...new Set([...expert.paths, ...modulePaths(modules, moduleIds)])] }
            : expert
        );
        await saveAndWrite({ version: 1, experts: next, shared: file?.shared ?? [] }, expertId);
      }),
    refreshCards: () =>
      run('refresh', async () => {
        setCards(
          await ipcBridge.codebaseMemory.moduleCards.invoke({ repoPath, refresh: true, language: i18n?.language })
        );
      }),
    reload: load,
  };
}

export type ModuleListState = ReturnType<typeof useModuleList>;
