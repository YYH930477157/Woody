import { useSyncExternalStore } from 'react';
import type { ProjectDetailDto } from '@/common/types/project';

let selectedWorkspace: ProjectDetailDto | null = null;
const listeners = new Set<() => void>();
const STORAGE_KEY = 'woody.selectedWorkspace';
export const getSelectedWorkspace = (): ProjectDetailDto | null => selectedWorkspace;
export const subscribeSelectedWorkspace = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Publish the workspace used for the next conversation; existing chats keep their binding. */
export const selectWorkspace = (detail: ProjectDetailDto | null): void => {
  selectedWorkspace = detail;
  try {
    if (detail) localStorage.setItem(STORAGE_KEY, detail.project_id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Selection still works when local storage is unavailable. */
  }
  for (const listener of listeners) listener();
};
/** Restore identity from storage, then fetch authoritative roots from the backend. */
export const hydrateSelectedWorkspace = async (load: (id: string) => Promise<ProjectDetailDto>): Promise<void> => {
  if (selectedWorkspace) return;
  let id: string | null;
  try {
    id = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!id) return;
  const detail = await load(id);
  if (!selectedWorkspace && detail.project_id === id) selectWorkspace(detail);
};
export const useSelectedWorkspace = (): ProjectDetailDto | null =>
  useSyncExternalStore(subscribeSelectedWorkspace, getSelectedWorkspace, getSelectedWorkspace);
