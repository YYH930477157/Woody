import React, { useCallback, useEffect, useState } from 'react';
import { Button, Message, Modal } from '@arco-design/web-react';
import { RightBranchOne } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitOperationOutcome, TeamWorktreeInfo } from '@/common/types/sourceControl/operationTypes';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';

type Notice = { tone: 'success' | 'warning' | 'error'; text: string };

/** Reasons with their own explanation; anything else shows Git's message. */
const REASON_KEYS: Record<string, string> = {
  dirtyWorktree: 'conversation.gitWorkbench.teamWorktree.dirtyWorktree',
  baseLocalChanges: 'conversation.gitWorkbench.teamWorktree.baseLocalChanges',
  baseBusy: 'conversation.gitWorkbench.teamWorktree.baseBusy',
  operationInProgress: 'conversation.gitWorkbench.teamWorktree.operationInProgress',
  baseMissing: 'conversation.gitWorkbench.teamWorktree.baseMissing',
  unmerged: 'conversation.gitWorkbench.teamWorktree.unmerged',
  removeFailed: 'conversation.gitWorkbench.teamWorktree.removeFailed',
  branchKept: 'conversation.gitWorkbench.teamWorktree.branchKept',
};
const ERROR_REASONS = new Set(['removeFailed', 'branchKept']);
const TONE_CLASS: Record<Notice['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
};

/**
 * Shown above a team's separate workspace in the Git panel: the team branch, the branch it
 * merges back into, and the actions that finish the work there. Renders nothing for any
 * other repository.
 */
export const TeamWorktreeBar: React.FC<{
  scope: GitWorkbenchScope;
  /** Changes whenever the repository status changes, so the counts stay current. */
  revision?: unknown;
}> = ({ scope, revision }) => {
  const { t } = useTranslation();
  const [info, setInfo] = useState<TeamWorktreeInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const load = useCallback(async () => {
    try {
      setInfo(await gitWorkbench.teamWorktreeDescribe.invoke({ scope }));
    } catch {
      setInfo(null);
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load, revision]);

  if (!info) return null;
  const values = (outcome?: GitOperationOutcome) => ({
    base: info.base,
    branch: info.branch,
    files: (outcome?.files ?? []).join(', '),
    message: outcome?.output ?? '',
  });
  const explain = (outcome: GitOperationOutcome): Notice => {
    if (outcome.state === 'complete')
      return {
        tone: 'success',
        text:
          outcome.reason === 'upToDate'
            ? t('conversation.gitWorkbench.teamWorktree.upToDate', values())
            : t('conversation.gitWorkbench.teamWorktree.merged', values()),
      };
    if (outcome.state === 'conflict')
      return { tone: 'warning', text: t('conversation.gitWorkbench.teamWorktree.conflict', values(outcome)) };
    const reasonKey = outcome.reason ? REASON_KEYS[outcome.reason] : undefined;
    if (reasonKey)
      return { tone: ERROR_REASONS.has(outcome.reason!) ? 'error' : 'warning', text: t(reasonKey, values(outcome)) };
    return { tone: 'error', text: t('conversation.gitWorkbench.teamWorktree.failed', values(outcome)) };
  };
  const fail = (error: unknown): Notice => ({
    tone: 'error',
    text: t('conversation.gitWorkbench.teamWorktree.failed', {
      message: error instanceof Error ? error.message : String(error),
    }),
  });

  const merge = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      setNotice(explain(await gitWorkbench.teamWorktreeMerge.invoke({ scope })));
    } catch (error) {
      setNotice(fail(error));
    } finally {
      setBusy(false);
      void load();
    }
  };

  const unmerged = !info.baseExists || info.ahead > 0;
  const remove = () => {
    Modal.confirm({
      title: t('conversation.gitWorkbench.teamWorktree.removeTitle'),
      content: (
        <div className='flex flex-col gap-8px'>
          <div className='break-all'>
            {t('conversation.gitWorkbench.teamWorktree.removeContent', { path: info.worktree, branch: info.branch })}
          </div>
          {unmerged && (
            <div className='text-danger'>
              {t('conversation.gitWorkbench.teamWorktree.removeUnmerged', { count: info.ahead, base: info.base })}
            </div>
          )}
        </div>
      ),
      okText: t('conversation.gitWorkbench.teamWorktree.removeConfirm'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        setBusy(true);
        setNotice(undefined);
        try {
          const outcome = await gitWorkbench.teamWorktreeRemove.invoke({ scope, discard: unmerged });
          if (outcome.state === 'complete')
            Message.success(t('conversation.gitWorkbench.teamWorktree.removed', { branch: info.branch }));
          else setNotice(explain(outcome));
        } catch (error) {
          setNotice(fail(error));
        } finally {
          setBusy(false);
          void load();
        }
      },
    });
  };

  const state = info.operation
    ? t('conversation.gitWorkbench.teamWorktree.resolving', { base: info.base })
    : info.dirty
      ? t('conversation.gitWorkbench.teamWorktree.dirty')
      : null;
  return (
    <div
      data-testid='team-worktree-bar'
      className='flex flex-col gap-4px px-12px py-6px border-b border-b-base text-12px'
    >
      <div className='flex items-center gap-6px min-w-0'>
        <RightBranchOne theme='outline' size='12' className='flex-shrink-0 text-t-tertiary' />
        <span className='flex-1 min-w-0 truncate text-t-secondary' title={info.worktree}>
          {t('conversation.gitWorkbench.teamWorktree.summary', { branch: info.branch, base: info.base })}
        </span>
        {info.baseExists && (
          <span className='flex-shrink-0 text-t-tertiary'>
            {t('conversation.gitWorkbench.teamWorktree.counts', { ahead: info.ahead, behind: info.behind })}
          </span>
        )}
      </div>
      <div className='flex flex-wrap items-center gap-6px'>
        <Button
          size='mini'
          type='primary'
          loading={busy}
          disabled={busy || !info.baseExists || info.dirty || Boolean(info.operation) || info.ahead === 0}
          onClick={() => void merge()}
        >
          {t('conversation.gitWorkbench.teamWorktree.merge', { base: info.base })}
        </Button>
        <Button size='mini' status='danger' disabled={busy || info.dirty || Boolean(info.operation)} onClick={remove}>
          {t('conversation.gitWorkbench.teamWorktree.remove')}
        </Button>
        {state && <span className='text-t-tertiary'>{state}</span>}
      </div>
      {notice && (
        <div data-team-worktree-notice={notice.tone} className={`break-all ${TONE_CLASS[notice.tone]}`}>
          {notice.text}
        </div>
      )}
    </div>
  );
};
