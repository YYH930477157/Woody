import { Button, Modal, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type { GitWorkflowState } from '@/common/types/sourceControl/gitWorkflowTypes';

import { resourceName, type ScmRepository, type ScmResource } from './scmModel';

export type CommitWorkflowModalProps = {
  visible: boolean;
  repo: ScmRepository;
  branch?: string;
  resources: ScmResource[];
  state: GitWorkflowState;
  statusMessage?: string;
  onCancel: () => void;
  onStart: () => void;
};

const isBusyState = (state: GitWorkflowState): boolean =>
  state !== 'idle' && state !== 'confirmation' && state !== 'blocked' && state !== 'failed' && state !== 'completed';

export const CommitWorkflowModal: React.FC<CommitWorkflowModalProps> = ({
  visible,
  repo,
  branch,
  resources,
  state,
  statusMessage,
  onCancel,
  onStart,
}) => {
  const { t } = useTranslation();
  const busy = isBusyState(state);
  return (
    <Modal
      title={t('conversation.explorer.scm.commit.title')}
      visible={visible}
      onCancel={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button type='primary' disabled={resources.length === 0 || busy} onClick={onStart}>
            {t('conversation.explorer.scm.commit.start')}
          </Button>
        </>
      }
      autoFocus
      focusLock
    >
      <div className='flex flex-col gap-10px'>
        <div className='text-13px text-t-secondary'>
          {t('conversation.explorer.scm.commit.repository', { repository: repo.pe_name || repo.label })}
          {branch ? ` · ${branch}` : ''}
        </div>
        <div className='text-12px text-t-tertiary'>{t('conversation.explorer.scm.commit.selectedFiles')}</div>
        <div data-scm-commit-files className='max-h-180px overflow-auto flex flex-col gap-3px'>
          {resources.map((resource) => (
            <div key={`${resource.file.pe_id}:${resource.file.relative_path}`} className='text-13px text-t-primary'>
              {resourceName(resource)}
            </div>
          ))}
        </div>
        <div data-scm-commit-state className='flex items-center gap-6px text-12px text-t-secondary'>
          {busy && <Spin size={14} />}
          <span>{statusMessage ?? t(`conversation.explorer.scm.commit.states.${state}`)}</span>
        </div>
      </div>
    </Modal>
  );
};
