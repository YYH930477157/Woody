import { bridge } from '@/common/platform/bridge';
import type {
  CodebaseMemoryConfig,
  CodebaseMemorySession,
  CodebaseMemoryStatus,
} from '@/common/types/codebaseMemory/types';

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
type ProjectRequest = { repoPath: string };

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

export const codebaseMemory = {
  get: provider<CodebaseMemoryStatus, ProjectRequest>('codebase-memory.get'),
  save: provider<CodebaseMemoryStatus, ProjectRequest & { config: CodebaseMemoryConfig }>('codebase-memory.save'),
  start: provider<CodebaseMemoryStatus, ProjectRequest>('codebase-memory.start'),
  cancel: provider<CodebaseMemoryStatus, ProjectRequest>('codebase-memory.cancel'),
  session: provider<CodebaseMemorySession, ProjectRequest>('codebase-memory.session'),
};
