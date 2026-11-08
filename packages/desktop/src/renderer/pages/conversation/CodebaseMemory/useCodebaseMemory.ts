import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { CodebaseMemoryConfig, CodebaseMemoryStatus } from '@/common/types/codebaseMemory/types';

const initialConfig: CodebaseMemoryConfig = { version: 1, enabled: false, mode: 'fast' };
type CodebaseMemoryAction = 'save' | 'start' | 'startAnyway' | 'include' | 'architecture' | 'cancel' | 'openLens';
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Own one folder's requests; the panel remounts this hook when its path changes. */
export function useCodebaseMemory(repoPath: string, visible: boolean, refreshToken: number) {
  const { i18n } = useTranslation();
  const [status, setStatus] = useState<CodebaseMemoryStatus>();
  const [draft, setDraft] = useState(initialConfig);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CodebaseMemoryAction>();
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const readFailed = readError !== undefined;
  const mounted = useRef(false);
  const revision = useRef(0);
  const actionPending = useRef(false);
  const reading = useRef<number | undefined>(undefined);
  const edited = useRef(false);

  const read = useCallback(async () => {
    if (reading.current || actionPending.current) return;
    const request = ++revision.current;
    reading.current = request;
    try {
      const result = await ipcBridge.codebaseMemory.get.invoke({ repoPath });
      if (!mounted.current || revision.current !== request) return;
      setStatus(result);
      setReadError(undefined);
      if (!edited.current) setDraft(result.config);
    } catch (cause) {
      if (!mounted.current || revision.current !== request) return;
      setReadError(errorMessage(cause));
    } finally {
      if (reading.current === request) reading.current = undefined;
      if (mounted.current && revision.current === request) setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
      reading.current = undefined;
    };
  }, []);
  useEffect(() => {
    void read();
  }, [read, refreshToken, visible]);
  useEffect(() => {
    if (!visible && status?.phase !== 'running') return;
    const timer = setInterval(() => {
      void read();
    }, 2000);
    return () => clearInterval(timer);
  }, [read, visible, status?.phase]);

  const updateDraft = (config: CodebaseMemoryConfig) => {
    edited.current = true;
    setDirty(true);
    setDraft(config);
  };
  /**
   * startAnyway skips the encryption pre-check, for an indexer the user had whitelisted.
   * include adds `folder`, which the last index skipped by name, and indexes again.
   * architecture writes .woody/architecture.md with headings in the interface language.
   */
  const run = async (action: CodebaseMemoryAction, folder?: string) => {
    if (actionPending.current || !status) return;
    if (action !== 'cancel' && (readFailed || status.phase === 'running')) return;
    if (action !== 'save' && action !== 'cancel' && (dirty || !status.config.enabled || !status.available)) return;
    if ((action === 'openLens' || action === 'architecture') && status.phase !== 'succeeded') return;
    if (action === 'startAnyway' && !status.precheckRefused) return;
    if (action === 'include' && !folder) return;
    actionPending.current = true;
    const request = ++revision.current;
    setBusy(action);
    setError(undefined);
    try {
      const result =
        action === 'save'
          ? await ipcBridge.codebaseMemory.save.invoke({ repoPath, config: draft })
          : action === 'startAnyway'
            ? await ipcBridge.codebaseMemory.start.invoke({ repoPath, bypassPrecheck: true })
            : action === 'include'
              ? await ipcBridge.codebaseMemory.include.invoke({ repoPath, folder: folder ?? '' })
              : action === 'architecture'
                ? await ipcBridge.codebaseMemory.architecture.invoke({ repoPath, language: i18n?.language })
                : await ipcBridge.codebaseMemory[action].invoke({ repoPath });
      if (!mounted.current || revision.current !== request) return;
      setStatus(result);
      if (action === 'save') {
        edited.current = false;
        setDirty(false);
        setDraft(result.config);
      }
    } catch (cause) {
      if (mounted.current && revision.current === request) setError(errorMessage(cause));
    } finally {
      actionPending.current = false;
      if (mounted.current && revision.current === request) setBusy(undefined);
    }
  };
  return { status, draft, dirty, loading, busy, error: readError ?? error, readFailed, updateDraft, run, reload: read };
}
