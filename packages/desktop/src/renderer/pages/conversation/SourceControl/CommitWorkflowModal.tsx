import { Button, Checkbox, Input, Modal, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

import type {
  CommitMessageFields,
  GitWorkflowState,
  GitWorkflowPrepareRequest,
} from '@/common/types/sourceControl/gitWorkflowTypes';
import type { CommitCheckOptions, StaticScanDiagnostic } from '@/common/types/sourceControl/staticScanTypes';

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
  checks?: CommitCheckOptions;
  checkConfigError?: string;
  onChecksChange: (checks: CommitCheckOptions) => void;
  onCancel: () => void;
  onDraft: () => void;
  onStart: () => void;
  onCommit: (push?: boolean) => void;
  onRetryPush: () => void;
  onMessageFieldsChange: (fields: CommitMessageFields) => void;
  mode?: GitWorkflowPrepareRequest['mode'];
  amendLoading?: boolean;
  onAmendChange?: (enabled: boolean) => void;
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
  checks,
  checkConfigError,
  onChecksChange,
  onCancel,
  onDraft,
  onStart,
  onCommit,
  onRetryPush,
  onMessageFieldsChange,
  mode,
  amendLoading = false,
  onAmendChange,
}) => {
  const { t } = useTranslation();
  const busy = isBusyState(state);
  const checksDisabled = busy || !checks || state === 'completed';
  const hasChecks = Boolean(checks?.scanners.length || checks?.compile);
  const hasManualMessage = (['reason', 'scope', 'solution', 'impact', 'tests'] as const).every(
    (field) => messageFields[field].trim().length > 0
  );
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
            <>
              <Button onClick={() => onCommit(true)}>{t('conversation.explorer.scm.commit.commitAndPush')}</Button>
              <Button type='primary' onClick={() => onCommit(false)}>
                {t('conversation.explorer.scm.commit.commitOnly')}
              </Button>
            </>
          ) : draftReady || hasManualMessage ? (
            <Button
              type='primary'
              disabled={resources.length === 0 || checksDisabled || amendLoading}
              onClick={onStart}
            >
              {t(
                hasChecks
                  ? 'conversation.explorer.scm.commit.runChecks'
                  : 'conversation.explorer.scm.commit.continueCommit'
              )}
            </Button>
          ) : (
            <Button type='primary' disabled={resources.length === 0 || busy || amendLoading} onClick={onDraft}>
              {t('conversation.explorer.scm.commit.generate')}
            </Button>
          )}
        </>
      }
      autoFocus
      focusLock
    >
      <div className='flex flex-col gap-10px'>
        {onAmendChange && (
          <div className='flex flex-col gap-6px'>
            <Checkbox
              checked={mode?.kind === 'amend'}
              disabled={busy || amendLoading || state === 'completed'}
              onChange={(enabled) => onAmendChange(enabled)}
            >
              {t('conversation.explorer.scm.commit.amend')}
            </Checkbox>
            {amendLoading && <Spin size={14} />}
            {mode?.kind === 'amend' && (
              <div className='text-12px text-warning'>
                {t('conversation.explorer.scm.commit.amendWarning')} <code>{mode.expectedHead.slice(0, 12)}</code>
              </div>
            )}
          </div>
        )}
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
        <div className='flex flex-col gap-6px' data-scm-commit-checks>
          <div className='text-12px text-t-tertiary'>{t('conversation.explorer.scm.commit.checks.title')}</div>
          <div className='flex flex-wrap gap-12px'>
            {(['clang-tidy', 'pc-lint'] as const).map((tool) => (
              <Checkbox
                key={tool}
                disabled={checksDisabled}
                checked={checks?.scanners.includes(tool) ?? false}
                onChange={(checked) =>
                  checks &&
                  onChecksChange({
                    ...checks,
                    scanners: checked
                      ? [...checks.scanners, tool]
                      : checks.scanners.filter((selected) => selected !== tool),
                  })
                }
              >
                {t(
                  tool === 'pc-lint'
                    ? 'conversation.explorer.scm.commit.checks.pcLint'
                    : 'conversation.explorer.scm.commit.checks.clangTidy'
                )}
              </Checkbox>
            ))}
            <Checkbox
              disabled={checksDisabled}
              checked={checks?.compile ?? false}
              onChange={(compile) => checks && onChecksChange({ ...checks, compile })}
            >
              {t('conversation.explorer.scm.commit.checks.compile')}
            </Checkbox>
          </div>
          <Checkbox
            disabled={checksDisabled || !checks?.scanners.length}
            checked={checks?.autoRepair ?? false}
            onChange={(autoRepair) => checks && onChecksChange({ ...checks, autoRepair })}
          >
            {t('conversation.explorer.scm.commit.checks.autoRepair')}
          </Checkbox>
          <div className='text-12px text-t-tertiary'>{t('conversation.explorer.scm.commit.checks.configHint')}</div>
          {checkConfigError ? (
            <div role='alert' className='text-12px text-danger'>
              <div>{t('conversation.explorer.scm.commit.checks.configFailed')}</div>
              <div>{checkConfigError}</div>
            </div>
          ) : !checks ? (
            <Spin size={14} />
          ) : !hasChecks ? (
            <div className='text-12px text-t-secondary'>{t('conversation.explorer.scm.commit.checks.none')}</div>
          ) : null}
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
