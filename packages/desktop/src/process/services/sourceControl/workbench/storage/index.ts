import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type {
  ChangelistChange,
  ChangelistMutation,
  HistoryCaptureInput,
  HistoryQuery,
  HistoryReadInput,
  HistoryRestoreInput,
  ShelfApplyInput,
  ShelfCreateInput,
  ShelfPatchInput,
} from '@/common/types/sourceControl/storageTypes';
import { mutateChangelists, readChangelists, syncChangelists } from './changelists';
import { createStorageContext, nameSchema, type StorageOptions } from './core';
import { compareHistory, listHistory, readHistory, restoreHistory } from './history';
import { createHistoryRecorder } from './recorder';
import { applyShelf, createShelf, exportShelf, importShelf, listShelves, readShelf, updateShelf } from './shelf';

export type { StorageOptions } from './core';

/** Project-scoped persistent storage. The host supplies the registered-root resolver and userData directory. */
export function createGitStorageService(options: StorageOptions) {
  const contexts = createStorageContext(options);
  const recorder = createHistoryRecorder(contexts, options);
  return {
    shelfList: (scope: GitWorkbenchScope) => contexts.run(scope, listShelves),
    shelfRead: (scope: GitWorkbenchScope, id: string) => contexts.run(scope, (context) => readShelf(context, id)),
    shelfCreate: (scope: GitWorkbenchScope, input: ShelfCreateInput) =>
      contexts.run(scope, (context) => createShelf(context, input), true),
    shelfRename: (scope: GitWorkbenchScope, id: string, name: string) =>
      contexts.run(scope, (context) => updateShelf(context, id, { name })),
    shelfDelete: (scope: GitWorkbenchScope, id: string, permanently = false) =>
      contexts.run(scope, (context) => updateShelf(context, id, { deleted: true, permanently })),
    shelfRestore: (scope: GitWorkbenchScope, id: string) =>
      contexts.run(scope, (context) => updateShelf(context, id, { deleted: false })),
    shelfApply: (scope: GitWorkbenchScope, input: ShelfApplyInput) =>
      contexts.run(scope, (context) => applyShelf(context, input), true),
    shelfImport: (scope: GitWorkbenchScope, input: { name: string; patch: string }) =>
      contexts.run(scope, (context) => importShelf(context, input)),
    shelfExport: (scope: GitWorkbenchScope, input: ShelfPatchInput) =>
      contexts.run(scope, (context) => exportShelf(context, input)),
    changelistRead: (scope: GitWorkbenchScope) => contexts.run(scope, readChangelists),
    changelistSync: (scope: GitWorkbenchScope, changes: ChangelistChange[]) =>
      contexts.run(scope, (context) => syncChangelists(context, changes)),
    changelistMutate: (scope: GitWorkbenchScope, input: ChangelistMutation) =>
      contexts.run(scope, (context) => mutateChangelists(context, input)),
    historyList: (scope: GitWorkbenchScope, query?: HistoryQuery) =>
      contexts.run(scope, (context) => listHistory(context, query)),
    historyCapture: (scope: GitWorkbenchScope, input?: HistoryCaptureInput) => recorder.capture(scope, input),
    historyLabel: async (scope: GitWorkbenchScope, label: string) =>
      (await recorder.capture(scope, { label: nameSchema.parse(label), kind: 'label' }))[0],
    historyRead: (scope: GitWorkbenchScope, input: HistoryReadInput) =>
      contexts.run(scope, (context) => readHistory(context, input)),
    historyCompare: (scope: GitWorkbenchScope, input: HistoryReadInput) =>
      contexts.run(scope, (context) => compareHistory(context, input)),
    historyRestore: (scope: GitWorkbenchScope, input: HistoryRestoreInput) =>
      contexts.run(scope, (context) => restoreHistory(context, input), true),
    historyStart: recorder.start,
    historyStop: recorder.stop,
    historyStatus: recorder.status,
    dispose: recorder.dispose,
  };
}
