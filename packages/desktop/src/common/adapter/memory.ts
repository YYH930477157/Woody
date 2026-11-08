import { bridge } from '@/common/platform/bridge';
import type {
  MemoryDistillResult,
  MemoryEntry,
  MemoryInput,
  MemoryProject,
  MemoryRecall,
  MemorySettings,
} from '@/common/types/memory';

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
type WorkspaceRequest = { workspace: string };

/** Native events must return an error envelope, otherwise a thrown provider leaves the caller pending. */
function provider<T, P>(name: string) {
  const wire = bridge.buildProvider<Reply<T>, P>(name);
  return {
    provider(handler: (params: P) => T | Promise<T>) {
      return wire.provider((async (params: P): Promise<Reply<T>> => {
        try {
          return { ok: true, value: await handler(params) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }) as Parameters<typeof wire.provider>[0]);
    },
    async invoke(params: P): Promise<T> {
      const result = await (wire.invoke as (params: P) => Promise<Reply<T>>)(params);
      if (result.ok === false) throw new Error(result.error);
      return result.value;
    },
  };
}

export const memory = {
  list: provider<MemoryProject, WorkspaceRequest>('memory.list'),
  search: provider<MemoryEntry[], WorkspaceRequest & { query: string }>('memory.search'),
  save: provider<MemoryEntry, WorkspaceRequest & { input: MemoryInput }>('memory.save'),
  remove: provider<void, WorkspaceRequest & { file: string }>('memory.remove'),
  openFolder: provider<void, WorkspaceRequest>('memory.open-folder'),
  /** Distill memories from this conversation now. */
  distill: provider<MemoryDistillResult, { conversationId: string }>('memory.distill'),
  /** Called just before a message is sent: stops a running distill and returns relevant memories. */
  recall: provider<MemoryRecall, { conversationId: string; text: string }>('memory.recall'),
  /** The workspace aionrs keys this conversation's memories by, or null for other agents. */
  workspaceOf: provider<string | null, { conversationId: string }>('memory.workspace-of'),
  getSettings: provider<MemorySettings, void>('memory.get-settings'),
  setSettings: provider<MemorySettings, MemorySettings>('memory.set-settings'),
};
