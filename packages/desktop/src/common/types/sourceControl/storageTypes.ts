/** Persistent shelf metadata. Paths are relative to the resolved project root. */
export type ShelfFile = { path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R'; binary: boolean };
export type ShelfItem = { id: string; name: string; createdAt: number; deleted: boolean; files: ShelfFile[] };
export type ShelfCreateInput = { name: string; paths: string[]; rollback?: boolean };
export type ShelfApplyInput = { id: string; paths?: string[]; removeApplied?: boolean };
export type ShelfApplyResult = { applied: boolean; conflicts: boolean; message?: string; recoveryId?: string };
export type ShelfPatchInput = { id: string; paths?: string[] };
export type Changelist = { id: string; name: string; comment?: string };
export type ChangelistState = { lists: Changelist[]; activeId: string; assignments: Record<string, string> };
/** Explicit status keys; this has no relationship to the UI's checked files. */
export type ChangelistChange = { key: string; path: string };
export type ChangelistMutation =
  | { kind: 'create'; name: string; comment?: string; makeActive?: boolean }
  | { kind: 'edit'; id: string; name: string; comment?: string }
  | { kind: 'remove' | 'activate'; id: string }
  | { kind: 'move'; id: string; keys: string[] };
export type HistoryFile = { path: string; before?: string | null; after: string | null };
export type HistoryEvent = {
  id: string;
  createdAt: number;
  kind: 'save' | 'external' | 'label' | 'recovery' | 'restore';
  label?: string;
  files: HistoryFile[];
};
/** SHA-256 fingerprint of bytes, or 'missing'; content is the event's AFTER-state. */
export type HistoryContent = { exists: boolean; fingerprint: string; contentBase64?: string; size: number };
export type HistoryCaptureInput = { paths?: string[]; label?: string; kind?: 'save' | 'external' | 'label' };
export type HistoryQuery = { path?: string; limit?: number };
export type HistoryReadInput = { id: string; path: string };
/** `before` is the selected event's after-state; `current` is the current disk state. */
export type HistoryComparison = { before: HistoryContent; current: HistoryContent };
export type HistoryRestoreInput = {
  id: string;
  paths?: string[];
  /** Required current fingerprints from compare; stale previews are rejected before mutation. */
  expected: Record<string, string>;
};
export type HistoryRestoreResult = { restored: string[]; recoveryId: string };
export type HistoryRecorderStatus = { recording: boolean; limited: boolean; errors: string[]; fileCount: number };
