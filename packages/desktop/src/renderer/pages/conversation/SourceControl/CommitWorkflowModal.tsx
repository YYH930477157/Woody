import { Button, Input, Modal, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type { CommitMessageFields, GitWorkflowState } from '@/common/types/sourceControl/gitWorkflowTypes';
import type { StaticScanDiagnostic } from '@/common/types/sourceControl/staticScanTypes';

import { resourceName, type ScmRepository, type ScmResource } from './scmModel';

export type CommitWorkflowModalProps = {
  visible: boolean;
  repo: ScmRepository;
  branch?: string;
  resources: ScmResource[];
  state: GitWorkflowState;
  statusMessage?: string;
  messageFields: CommitMessageFields;
  diagnostics: StaticScanDiagnostic[];
  output?: string;
  draftReady: boolean;
  onCancel: () => void;
  onDraft: () => void;
  onStart: () => void;
  onCommit: () => void;
  onRetryPush: () => void;
  onMessageFieldsChange: (fields: CommitMessageFields) => void;
};

const isBusyState = (state: GitWorkflowState): boolean =>
  state !== 'idle' &&
  state !== 'draft_ready' &&
  state !== 'confirmation' &&
  state !== 'blocked' &&
  state !== 'failed' &&
  state !== 'completed';

export const CommitWorkflowModal: React.FC<CommitWorkflowModalProps> = ({
  visible,
  repo,
  branch,
  resources,
  state,
  statusMessage,
  messageFields,
  diagnostics,
  output,
  draftReady,
  onCancel,
  onDraft,
  onStart,
  onCommit,
  onRetryPush,
  onMessageFieldsChange,
}) => {
  const { t } = useTranslation();
  const busy = isBusyState(state);
  const templateLabel = (field: keyof CommitMessageFields): string =>
    `【${t(`conversation.explorer.scm.commit.message.${field}`)}】`;
  const displayedFieldValue = (field: keyof CommitMessageFields): string =>
    `${templateLabel(field)}:${messageFields[field]}`;
  const stripDisplayedLabel = (field: keyof CommitMessageFields, value: string): string => {
    const prefix = `${templateLabel(field)}:`;
    return value.startsWith(prefix) ? value.slice(prefix.length).trimStart() : value;
  };
  const updateField = (field: keyof CommitMessageFields, value: string): void => {
    onMessageFieldsChange({ ...messageFields, [field]: stripDisplayedLabel(field, value) });
  };
  return (
    <Modal
      title={t('conversation.explorer.scm.commit.title')}
      visible={visible}
      onCancel={onCancel}
      mask={!busy}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.close')}</Button>
          {state === 'push' ? (
            <Button type='primary' onClick={onRetryPush}>
              {t('conversation.explorer.scm.commit.retryPush')}
            </Button>
          ) : state === 'confirmation' ? (
            <Button type='primary' onClick={onCommit}>
              {t('conversation.explorer.scm.commit.confirm')}
            </Button>
          ) : draftReady ? (
            <Button type='primary' disabled={resources.length === 0 || busy} onClick={onStart}>
              {t('conversation.explorer.scm.commit.submitForScan')}
            </Button>
          ) : (
            <Button type='primary' disabled={resources.length === 0 || busy} onClick={onDraft}>
              {t('conversation.explorer.scm.commit.generate')}
            </Button>
          )}
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
        <div className='flex flex-col gap-6px'>
          <div className='text-12px text-t-tertiary'>{t('conversation.explorer.scm.commit.messageTitle')}</div>
          {(['reason', 'scope', 'solution', 'impact', 'tests'] as const).map((field) => (
            <Input.TextArea
              key={field}
              autoSize={{ minRows: 1, maxRows: 3 }}
              value={displayedFieldValue(field)}
              placeholder={t(`conversation.explorer.scm.commit.message.${field}`)}
              onChange={(value) => updateField(field, value)}
              disabled={busy || state === 'completed'}
              aria-label={t(`conversation.explorer.scm.commit.message.${field}`)}
            />
          ))}
        </div>
        {diagnostics.length > 0 && (
          <div data-scm-commit-diagnostics className='flex flex-col gap-3px'>
            <div className='text-12px text-danger'>{t('conversation.explorer.scm.commit.diagnostics')}</div>
            {diagnostics.map((diagnostic, index) => (
              <div key={`${diagnostic.file}:${diagnostic.line}:${index}`} className='text-12px text-t-secondary'>
                {diagnostic.file}:{diagnostic.line}
                {diagnostic.column ? `:${diagnostic.column}` : ''} · {diagnostic.message}
                {diagnostic.rule ? ` [${diagnostic.rule}]` : ''}
              </div>
            ))}
          </div>
        )}
        {output && (
          <pre
            data-scm-workflow-output
            className='max-h-240px overflow-auto whitespace-pre-wrap break-all text-12px text-t-secondary'
          >
            {output}
          </pre>
        )}
      </div>
    </Modal>
  );
};
