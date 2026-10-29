import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router-dom';
import { Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import i18n from '@/renderer/services/i18n';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { getSelectedWorkspace } from '../workspaceSelection';
import {
  closeRootEditors,
  confirmRootEditors,
  confirmWorkspaceLeave,
  registerWorkspaceDiscardGuard,
} from './lifecycle';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { canLeaveWorkspaceForRoute } from './navigation';

type GuardWindow = Window & { __confirmWorkspaceClose?: () => Promise<boolean> };

/** Guard router transitions (including browser back) and native close while the backend is alive. */
const WorkspaceNavigationGuard = (): null => {
  const preview = useOptionalPreviewContext();
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    const affectedRoots = new Map<string, string[]>();
    return registerWorkspaceDiscardGuard(
      async (project_id) => {
        const detail = await ipcBridge.project.get.invoke({ project_id });
        affectedRoots.set(
          project_id,
          detail.explorer.entries.map((root) => root.pe_id)
        );
        return confirmRootEditors(
          previewRef.current,
          detail.explorer.entries.map((root) => root.pe_id)
        );
      },
      (projectId) => {
        closeRootEditors(previewRef.current, affectedRoots.get(projectId) || []);
        affectedRoots.delete(projectId);
      }
    );
  }, []);
  const source = useRef<string | null>(null);
  const pending = useRef(false);
  const blocker = useBlocker(
    useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => {
      if (!isElectronDesktop() || currentLocation.pathname === nextLocation.pathname) return false;
      source.current =
        getCurrentProject() ||
        (currentLocation.pathname === '/guid' ? getSelectedWorkspace()?.project_id || null : null);
      return Boolean(source.current);
    }, [])
  );
  useEffect(() => {
    if (blocker.state !== 'blocked' || pending.current) return;
    pending.current = true;
    void canLeaveWorkspaceForRoute(
      source.current,
      blocker.location.pathname,
      getSelectedWorkspace()?.project_id || null,
      async (id) => (await ipcBridge.conversation.get.invoke({ id })).project_id || null,
      confirmWorkspaceLeave
    )
      .then((allowed) => {
        if (allowed) blocker.proceed();
        else blocker.reset();
      })
      .catch(() => {
        Message.error(i18n.t('conversation.managedWorkspace.failed'));
        blocker.reset();
      })
      .finally(() => {
        pending.current = false;
      });
  }, [blocker]);
  useEffect(() => {
    if (!isElectronDesktop()) return;
    const target = window as GuardWindow;
    const confirm = async (): Promise<boolean> => {
      const current = getCurrentProject();
      const selected = getSelectedWorkspace()?.project_id;
      if (current && !(await confirmWorkspaceLeave(current))) return false;
      return !selected || selected === current || (await confirmWorkspaceLeave(selected));
    };
    target.__confirmWorkspaceClose = confirm;
    return () => {
      if (target.__confirmWorkspaceClose === confirm) delete target.__confirmWorkspaceClose;
    };
  }, []);
  return null;
};
export default WorkspaceNavigationGuard;
