import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type {
  MemoryDistillResult,
  MemoryEntry,
  MemoryInput,
  MemoryProject,
  MemorySettings,
} from '@/common/types/memory';

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** One workspace's memories, the search over them, and the memory settings. */
export function useMemoryPanel(workspace: string | undefined, visible: boolean, refreshToken: number) {
  const [project, setProject] = useState<MemoryProject>();
  const [settings, setSettings] = useState<MemorySettings>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryEntry[]>();
  const [busy, setBusy] = useState<'save' | 'remove' | 'distill' | 'settings' | 'open'>();
  const [error, setError] = useState<string>();
  const [distilled, setDistilled] = useState<MemoryDistillResult>();
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!workspace) return;
    const id = ++request.current;
    try {
      const [next, nextSettings] = await Promise.all([
        ipcBridge.memory.list.invoke({ workspace }),
        ipcBridge.memory.getSettings.invoke(),
      ]);
      if (id !== request.current) return;
      setProject(next);
      setSettings(nextSettings);
      setError(undefined);
    } catch (cause) {
      if (id === request.current) setError(errorMessage(cause));
    }
  }, [workspace]);

  useEffect(() => {
    if (visible) void load();
  }, [load, visible, refreshToken]);

  useEffect(() => {
    if (!workspace || !query.trim()) {
      setResults(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      ipcBridge.memory.search
        .invoke({ workspace, query })
        .then((found) => current && setResults(found))
        .catch((cause: unknown) => current && setError(errorMessage(cause)));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [workspace, query, project]);

  const run = async <T>(action: NonNullable<typeof busy>, work: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    setBusy(action);
    setError(undefined);
    try {
      return await work();
    } catch (cause) {
      setError(errorMessage(cause));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  return {
    project,
    settings,
    query,
    setQuery,
    entries: results ?? project?.entries ?? [],
    searching: Boolean(query.trim()),
    busy,
    error,
    distilled,
    reload: load,
    save: (input: MemoryInput) =>
      run('save', async () => {
        if (!workspace) return undefined;
        const saved = await ipcBridge.memory.save.invoke({ workspace, input });
        await load();
        return saved;
      }),
    remove: (file: string) =>
      run('remove', async () => {
        if (!workspace) return;
        await ipcBridge.memory.remove.invoke({ workspace, file });
        await load();
      }),
    distill: (conversationId: string) =>
      run('distill', async () => {
        setDistilled(undefined);
        const result = await ipcBridge.memory.distill.invoke({ conversationId });
        setDistilled(result);
        await load();
      }),
    updateSettings: (next: MemorySettings) =>
      run('settings', async () => setSettings(await ipcBridge.memory.setSettings.invoke(next))),
    openFolder: () =>
      run('open', async () => {
        if (workspace) await ipcBridge.memory.openFolder.invoke({ workspace });
      }),
  };
}
