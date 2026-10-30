import { watch, type FSWatcher } from 'node:fs';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type {
  HistoryCaptureInput,
  HistoryEvent,
  HistoryRecorderStatus,
} from '@/common/types/sourceControl/storageTypes';
import type { createStorageContext, StorageOptions } from './core';
import { captureHistory, emptyStatus, type CaptureStatus } from './history';

type Recording = {
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setInterval>;
  debounce?: ReturnType<typeof setTimeout>;
  pending?: Promise<void>;
  stopped: boolean;
};

/** One bounded watcher per scope plus bounded polling for descendants and missed filesystem events. */
export function createHistoryRecorder(contexts: ReturnType<typeof createStorageContext>, options: StorageOptions) {
  const entries = new Map<string, Recording>();
  const statuses = new Map<string, CaptureStatus>();
  const starts = new Map<string, Promise<void>>();
  let disposed = false;
  const keyOf = (scope: GitWorkbenchScope) => JSON.stringify([scope.projectId, scope.peId, scope.relativePath]);
  const capture = async (scope: GitWorkbenchScope, input: HistoryCaptureInput = {}): Promise<HistoryEvent[]> => {
    if (disposed) throw new Error('Local history recorder is disposed');
    const status = emptyStatus();
    const result = await contexts.run(scope, (context) => captureHistory(context, input, status));
    statuses.set(keyOf(scope), status);
    return result;
  };
  const start = async (scope: GitWorkbenchScope): Promise<void> => {
    if (disposed) throw new Error('Local history recorder is disposed');
    const key = keyOf(scope);
    if (starts.has(key)) return starts.get(key);
    if (entries.has(key)) return;
    const pending = (async () => {
      const context = await contexts.resolve(scope);
      if (disposed) return;
      if (entries.size >= 32) throw new Error('Local history recorder scope limit exceeded');
      const entry: Recording = { stopped: false };
      entries.set(key, entry);
      const record = (): Promise<void> => {
        if (entry.stopped || entry.pending) return entry.pending ?? Promise.resolve();
        entry.pending = capture(scope, { kind: 'external' })
          .then((): void => undefined)
          .catch((error: unknown): void => {
            const status = statuses.get(key) ?? emptyStatus();
            status.errors = [...status.errors.slice(-19), String(error).slice(0, 500)];
            statuses.set(key, status);
            context.log(`[GitStorage] Recorder failed: ${String(error).slice(0, 500)}`);
          })
          .finally((): void => {
            entry.pending = undefined;
          });
        return entry.pending;
      };
      try {
        entry.watcher = watch(context.root, { recursive: false, persistent: false }, () => {
          clearTimeout(entry.debounce);
          entry.debounce = setTimeout(() => {
            void record();
          }, 250);
          entry.debounce.unref();
        });
        entry.watcher.on('error', (error) => {
          context.log(`[GitStorage] Watcher failed; bounded polling remains active: ${String(error).slice(0, 500)}`);
          const status = statuses.get(key) ?? emptyStatus();
          status.errors = [...status.errors.slice(-19), String(error).slice(0, 500)];
          statuses.set(key, status);
        });
      } catch (error) {
        context.log(`[GitStorage] Watcher unavailable; bounded polling remains active: ${String(error).slice(0, 500)}`);
      }
      entry.timer = setInterval(
        () => {
          void record();
        },
        Math.max(250, options.recorderIntervalMs ?? 3000)
      );
      entry.timer.unref();
      await record();
    })();
    starts.set(key, pending);
    try {
      await pending;
    } finally {
      starts.delete(key);
    }
  };
  const stop = async (scope: GitWorkbenchScope): Promise<void> => {
    const key = keyOf(scope);
    await starts.get(key)?.catch((): void => undefined);
    const entry = entries.get(key);
    if (!entry) return;
    entry.stopped = true;
    clearTimeout(entry.debounce);
    clearInterval(entry.timer);
    entry.watcher?.close();
    await entry.pending;
    entries.delete(key);
  };
  const status = async (scope: GitWorkbenchScope): Promise<HistoryRecorderStatus> => {
    await contexts.resolve(scope);
    return { recording: entries.has(keyOf(scope)), ...(statuses.get(keyOf(scope)) ?? emptyStatus()) };
  };
  const dispose = async (): Promise<void> => {
    disposed = true;
    await Promise.allSettled(starts.values());
    await Promise.all(
      [...entries].map(async ([key, entry]) => {
        entry.stopped = true;
        clearTimeout(entry.debounce);
        clearInterval(entry.timer);
        entry.watcher?.close();
        await entry.pending;
        entries.delete(key);
      })
    );
    statuses.clear();
  };
  return { capture, start, stop, status, dispose };
}
