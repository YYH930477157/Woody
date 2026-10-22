import { bridge } from '@/common/platform/bridge';
import type {
  CmakeAction,
  CmakeConfiguration,
  CmakeJob,
  CmakeJobRead,
  CmakeProject,
  CmakeWorkspace,
} from '@/common/types/cmake';
import type { GdbReply, GdbRequest } from '@/common/types/cmake/gdb';

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
function provider<T, P>(name: string) {
  const wire = bridge.buildProvider<Reply<T>, P>(name);
  return {
    provider(handler: (params: P) => T | Promise<T>) {
      const wrapped = async (params: P): Promise<Reply<T>> => {
        try {
          return { ok: true, value: await handler(params) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'cmake.failed' };
        }
      };
      return wire.provider(wrapped as Parameters<typeof wire.provider>[0]);
    },
    async invoke(params: P): Promise<T> {
      const result = await (wire.invoke as (params: P) => Promise<Reply<T>>)(params);
      if (result.ok === false) throw new Error(result.error);
      return result.value;
    },
  };
}
type ProjectInput = { projectPath: string };
export const cmake = {
  discover: provider<CmakeWorkspace, ProjectInput & { selection?: string }>('cmake.discover'),
  debug: provider<GdbReply, GdbRequest>('cmake.debug'),
  debugAiEnabled: provider<boolean, ProjectInput>('cmake.debug-ai-enabled'),
  setDebugAiEnabled: provider<void, ProjectInput & { enabled: boolean }>('cmake.set-debug-ai-enabled'),
  inspect: provider<CmakeProject, ProjectInput & { discover?: boolean }>('cmake.inspect'),
  reload: provider<CmakeProject, ProjectInput>('cmake.reload'),
  revealConfiguration: provider<void, ProjectInput>('cmake.reveal-configuration'),
  save: provider<CmakeProject, ProjectInput & { config: CmakeConfiguration }>('cmake.save'),
  start: provider<CmakeJob, ProjectInput & { action: CmakeAction; selection?: Record<string, string> }>('cmake.start'),
  read: provider<CmakeJobRead, { jobId: string; cursor?: number }>('cmake.read'),
  cancel: provider<void, { jobId: string }>('cmake.cancel'),
  aiEnabled: provider<boolean, ProjectInput>('cmake.ai-enabled'),
  setAiEnabled: provider<void, ProjectInput & { enabled: boolean }>('cmake.set-ai-enabled'),
};
