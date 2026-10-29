import React, { useRef, useState } from 'react';
import { Button, Dropdown, Menu, Message, Tooltip } from '@arco-design/web-react';
import { FolderClose, MoreOne, Plus } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { getSelectedWorkspace, selectWorkspace } from '@/renderer/components/workspace/workspaceSelection';
import {
  confirmWorkspaceLeave,
  publishWorkspaceDetail,
} from '@/renderer/components/workspace/WorkspaceManager/lifecycle';
import { getCurrentProject } from '../explorer/currentProjectStore';
import WorkspaceCollapse from '../components/WorkspaceCollapse';
import type { WorkspaceGroup } from './types';

type Props = React.PropsWithChildren<{
  group: WorkspaceGroup;
  expanded: boolean;
  onToggle: () => void;
  collapsed: boolean;
  isMobile: boolean;
  onArchive: (name: string, conversations: TChatConversation[]) => void;
}>;

/** Keep managed project identity and metadata independent of its mutable default folder. */
const WorkspaceHistoryGroup = ({ group, expanded, onToggle, collapsed, isMobile, onArchive, children }: Props) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: detail } = useSWR(group.project_id ? `explorer-project/${group.project_id}` : null, () =>
    ipcBridge.project.get.invoke({ project_id: group.project_id! })
  );
  const name = detail?.name || group.display_name;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const newConversation = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      // Resolve first so an unavailable target cannot disturb the current draft.
      const target = group.project_id ? await ipcBridge.project.get.invoke({ project_id: group.project_id }) : null;
      const leaving = new Set([getCurrentProject(), getSelectedWorkspace()?.project_id]);
      for (const projectId of leaving) {
        if (projectId && projectId !== target?.project_id && !(await confirmWorkspaceLeave(projectId))) return;
      }
      if (target) await publishWorkspaceDetail(target);
      selectWorkspace(target);
      if (target) await navigate('/guid');
      else await navigate('/guid', { state: { workspace: group.workspace } });
    } catch {
      Message.error(t('conversation.managedWorkspace.failed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const actionClass = classNames(
    '!p-0 !min-w-0 !text-t-secondary hover:!text-t-primary !size-20px !rd-4px sider-action-btn',
    isMobile ? 'flex' : 'hidden group-hover:flex'
  );
  const projectMenu = (
    <Menu
      onClickMenuItem={(key) => {
        if (key === 'archive') onArchive(name, group.conversations);
      }}
    >
      <Menu.Item key='archive'>
        <span className='flex items-center gap-8px'>
          <FolderClose theme='outline' size='14' />
          {t('conversation.history.archiveProject')}
        </span>
      </Menu.Item>
    </Menu>
  );
  return (
    <div className='min-w-0'>
      <WorkspaceCollapse
        expanded={expanded}
        onToggle={onToggle}
        siderCollapsed={collapsed}
        stickyHeader
        stickyTop={28}
        header={<span className='text-14px font-[500] truncate flex-1 text-t-primary min-w-0'>{name}</span>}
        trailing={
          <span className='flex items-center gap-6px'>
            <Tooltip content={t('conversation.history.newConversationInProject')} position='top'>
              <Button
                type='text'
                size='mini'
                aria-label={t('conversation.history.newConversationInProject')}
                className={actionClass}
                loading={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void newConversation();
                }}
                icon={<Plus theme='outline' size='14' fill='currentColor' className='block leading-none' />}
              />
            </Tooltip>
            <Dropdown
              droplist={projectMenu}
              trigger='click'
              position='br'
              getPopupContainer={() => document.body}
              unmountOnExit={false}
            >
              <Button
                type='text'
                size='mini'
                aria-label={t('conversation.history.projectsSection')}
                className={actionClass}
                onClick={(event) => event.stopPropagation()}
                icon={<MoreOne theme='outline' size='14' fill='currentColor' className='block leading-none' />}
              />
            </Dropdown>
          </span>
        }
      >
        {children}
      </WorkspaceCollapse>
    </div>
  );
};
export default WorkspaceHistoryGroup;
