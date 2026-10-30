import { useEffect } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { ProjectDetailDto } from '@/common/types/project';
import type { ChatFileRef } from '@/common/types/chatFile';
import { isElectronDesktop } from '@renderer/utils/platform';

let tracking = Promise.resolve();
/** One recorder owner per native window, independent of the visible explorer tab. */
export function useProjectHistory(projectId: string | null): void {
  const desktop = isElectronDesktop();
  const { data } = useSWR<ProjectDetailDto>(desktop && projectId ? `explorer-project/${projectId}` : null, () =>
    ipcBridge.project.get.invoke({ project_id: projectId! })
  );
  const roots = JSON.stringify(
    data?.explorer.entries.map((entry) => [entry.pe_id, entry.display_path, entry.runtime_status])
  );
  useEffect(() => {
    if (!desktop || !ipcBridge.gitStorage?.historyTrack) return;
    const track = (id: string | null) => {
      tracking = tracking.catch(() => {}).then(() => ipcBridge.gitStorage.historyTrack.invoke({ projectId: id }));
      void tracking.catch((error: unknown) => console.error('[GitHistory]', error));
    };
    track(projectId);
    return () => track(null);
  }, [desktop, projectId, roots]);
}

/** A rejected or failed editor write never records a successful save. */
export async function recordProjectSave(projectId: string | null, file: ChatFileRef): Promise<void> {
  if (!projectId || file.kind !== 'project' || !isElectronDesktop() || !ipcBridge.gitStorage?.historyCapture) return;
  await tracking.catch(() => {});
  await ipcBridge.gitStorage.historyCapture.invoke({
    scope: { projectId, peId: file.pe_id, relativePath: '' },
    request: { paths: [file.relative_path], kind: 'save' },
  });
}
