import type { ChatFileRef } from '@/common/types/chatFile';
import type { ProjectDetailDto, WorkspaceUpdate } from '@/common/types/project';

/** Convert a native path without treating reserved characters as URI syntax. */
export const pathToFileUri = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((part, index) => (index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)))
    .join('/');
  return normalized.startsWith('//') ? `file:${encoded}` : `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
};

export const buildWorkspaceUpdate = (detail: ProjectDetailDto): WorkspaceUpdate => ({
  name: detail.name,
  roots: detail.explorer.entries.map((entry) => ({
    pe_id: entry.pe_id,
    uri: pathToFileUri(entry.display_path),
    display_name: entry.display_name || undefined,
  })),
  default_pe_id:
    detail.workspace?.default_pe_id ?? (detail.workspace?.managed ? null : detail.explorer.workspace_pe_id || null),
});

export const moveWorkspaceRoot = (update: WorkspaceUpdate, peId: string, direction: -1 | 1): WorkspaceUpdate => {
  const index = update.roots.findIndex((root) => root.pe_id === peId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= update.roots.length) return update;
  const roots = [...update.roots];
  [roots[index], roots[target]] = [roots[target], roots[index]];
  return { ...update, roots };
};

export const removeWorkspaceRoot = (update: WorkspaceUpdate, peId: string): WorkspaceUpdate => ({
  ...update,
  roots: update.roots.filter((root) => root.pe_id !== peId),
  default_pe_id: update.default_pe_id === peId ? null : update.default_pe_id,
});

export const searchableWorkspaceRoots = (detail: ProjectDetailDto) =>
  detail.explorer.entries
    .filter((entry) => entry.runtime_status === 'available')
    .map((entry) => ({ pe_id: entry.pe_id, relative_path: '', rootPath: entry.display_path }));

type EditableTab = { id: string; isDirty?: boolean; metadata?: { fileRef?: ChatFileRef } };
export const dirtyRootTabs = <T extends EditableTab>(tabs: T[], roots: string[]): T[] =>
  tabs.filter(
    (tab) => tab.isDirty && tab.metadata?.fileRef?.kind === 'project' && roots.includes(tab.metadata.fileRef.pe_id)
  );
