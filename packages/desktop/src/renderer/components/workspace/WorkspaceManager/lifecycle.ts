import React from 'react';
import { Button, Message, Modal } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import i18n from '@/renderer/services/i18n';
import type { PreviewContextValue } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { getSelectedWorkspace, selectWorkspace } from '../workspaceSelection';
import { buildWorkspaceUpdate, dirtyRootTabs } from './model';
import type { ProjectDetailDto } from '@/common/types/project';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { mutate } from 'swr';

let beforeDiscard: ((projectId: string) => Promise<boolean>) | null = null;
let afterDiscard: ((projectId: string) => void) | null = null;
/** Register the app-level editor guard while its preview provider is mounted. */
export const registerWorkspaceDiscardGuard = (
  guard: (projectId: string) => Promise<boolean>,
  afterSuccess?: (projectId: string) => void
): (() => void) => {
  beforeDiscard = guard;
  afterDiscard = afterSuccess || null;
  return () => {
    if (beforeDiscard === guard) {
      beforeDiscard = null;
      afterDiscard = null;
    }
  };
};

/** Publish the authoritative response to both consumers of workspace metadata. */
export const publishWorkspaceDetail = async (detail: ProjectDetailDto): Promise<void> => {
  await mutate(`explorer-project/${detail.project_id}`, detail, false);
  if (getSelectedWorkspace()?.project_id === detail.project_id) selectWorkspace(detail);
};

/** The backend creates root identity; only the first addition initializes a default. */
export const addWorkspaceRoot = async (detail: ProjectDetailDto, uri: string): Promise<ProjectDetailDto> => {
  const body = buildWorkspaceUpdate(detail);
  const next = await ipcBridge.project.updateWorkspace.invoke({
    project_id: detail.project_id,
    ...body,
    roots: [...body.roots, { uri }],
  });
  if (detail.explorer.entries.length === 0 && next.explorer.entries.length === 1 && !next.workspace?.default_pe_id) {
    return ipcBridge.project.updateWorkspace.invoke({
      project_id: detail.project_id,
      ...buildWorkspaceUpdate(next),
      default_pe_id: next.explorer.entries[0].pe_id,
    });
  }
  return next;
};

/** A shared three-way prompt for draft configuration and unsaved editors. */
export const askWorkspaceDecision = (message: string): Promise<'save' | 'discard' | 'cancel'> =>
  new Promise((resolve) => {
    const finish = (decision: 'save' | 'discard' | 'cancel'): void => {
      modal.close();
      resolve(decision);
    };
    const modal = Modal.confirm({
      title: i18n.t('conversation.managedWorkspace.unsavedTitle'),
      content: message,
      onCancel: () => resolve('cancel'),
      footer: React.createElement(
        'div',
        { className: 'flex justify-end gap-8px' },
        React.createElement(Button, { onClick: () => finish('cancel') }, i18n.t('common.cancel')),
        React.createElement(
          Button,
          { onClick: () => finish('discard') },
          i18n.t('conversation.managedWorkspace.discard')
        ),
        React.createElement(Button, { type: 'primary', onClick: () => finish('save') }, i18n.t('common.save'))
      ),
    });
  });

export const saveWorkspaceConfiguration = async (projectId: string, saveAs = false): Promise<boolean> => {
  const state = await ipcBridge.project.getWorkspace.invoke({ project_id: projectId });
  let path = state.config_path;
  if (saveAs || !path) path = await ipcBridge.dialog.saveWorkspaceFile.invoke({ defaultPath: path || undefined });
  if (!path) return false;
  const workspace = await ipcBridge.project.saveWorkspace.invoke({ project_id: projectId, path });
  await mutate(
    `explorer-project/${projectId}`,
    (current: ProjectDetailDto | undefined) => (current ? { ...current, workspace } : current),
    false
  );
  const selected = getSelectedWorkspace();
  if (selected?.project_id === projectId) selectWorkspace({ ...selected, workspace });
  return true;
};

/** Returns false on cancellation or failed persistence, so callers must keep the current workspace. */
const confirmWorkspaceLeaveOnce = async (projectId: string): Promise<boolean> => {
  try {
    const state = await ipcBridge.project.getWorkspace.invoke({ project_id: projectId });
    if (!state.managed || !state.dirty) return true;
    const decision = await askWorkspaceDecision(i18n.t('conversation.managedWorkspace.unsavedConfiguration'));
    if (decision === 'cancel') return false;
    if (decision === 'save') return await saveWorkspaceConfiguration(projectId);
    if (beforeDiscard && !(await beforeDiscard(projectId))) return false;
    const restored = await ipcBridge.project.discardWorkspace.invoke({ project_id: projectId });
    afterDiscard?.(projectId);
    await publishWorkspaceDetail(restored);
    return true;
  } catch (error) {
    if (isBackendHttpError(error) && error.status === 404) {
      try {
        const detail = await ipcBridge.project.get.invoke({ project_id: projectId });
        if (!detail.workspace?.managed) return true;
      } catch {
        /* An unavailable or deleted project is not proof that its draft is safe to discard. */
      }
    }
    Message.error(i18n.t('conversation.managedWorkspace.failed'));
    return false;
  }
};

const pendingDecisions = new Map<string, Promise<boolean>>();
/** Share a pending prompt between navigation, workspace selection, and native quit. */
export const confirmWorkspaceLeave = (projectId: string): Promise<boolean> => {
  const pending = pendingDecisions.get(projectId);
  if (pending) return pending;
  const decision = confirmWorkspaceLeaveOnce(projectId).finally(() => pendingDecisions.delete(projectId));
  pendingDecisions.set(projectId, decision);
  return decision;
};

/** Protect preview contents before removing or relocating their root. */
export const confirmRootEditors = async (preview: PreviewContextValue | null, rootIds: string[]): Promise<boolean> => {
  if (!preview) return true;
  const dirty = dirtyRootTabs(preview.tabs, rootIds);
  if (dirty.length) {
    const decision = await askWorkspaceDecision(
      i18n.t('conversation.managedWorkspace.unsavedEditors', { count: dirty.length })
    );
    if (decision === 'cancel') return false;
    if (decision === 'save') {
      for (const tab of dirty) if (!(await preview.saveContent(tab.id))) return false;
    }
  }
  return true;
};

/** Close affected editors only after their root mutation has succeeded. */
export const closeRootEditors = (preview: PreviewContextValue | null, rootIds: string[]): void => {
  if (!preview) return;
  for (const tab of preview.tabs) {
    const ref = tab.metadata?.fileRef;
    if (ref?.kind === 'project' && rootIds.includes(ref.pe_id)) preview.closeTab(tab.id);
  }
};
