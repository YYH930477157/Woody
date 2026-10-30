import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitOperationOutcome, GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { useRequest } from '../useRequest';
import { RequestError } from '../RequestState';
import { refreshRepo } from '../../scmStore';

type StartKind = 'merge' | 'cherry-pick' | 'revert' | 'rebase';
export function HistoryActions({
  scope,
  repoId,
  hash,
  disabled,
  onBusyChange,
  onCompleted,
}: {
  scope: GitWorkbenchScope;
  repoId: string;
  hash: string;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: (outcome: GitOperationOutcome) => void;
}) {
  const { t } = useTranslation();
  const inspect = useCallback(async () => {
    const result = await gitWorkbench.operate.invoke({ scope, request: { kind: 'inspect' } });
    if (result.state !== 'complete') throw new Error(result.output);
    return result.data;
  }, [scope]);
  const snapshot = useRequest(inspect);
  const [pending, setPending] = useState<GitOperationRequest>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);
  const choose = (kind: StartKind) => {
    if (snapshot.data?.head && snapshot.data.branch)
      setPending({
        kind,
        target: hash,
        expectedHead: snapshot.data.head,
        expectedBranch: snapshot.data.branch,
        confirmed: true,
      });
  };
  const run = async () => {
    if (running.current || !pending) return;
    const request = pending;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setPending(undefined);
    let outcome: GitOperationOutcome;
    try {
      outcome = await gitWorkbench.operate.invoke({ scope, request });
    } catch (failure) {
      outcome = { state: 'error', output: failure instanceof Error ? failure.message : String(failure) };
    }
    await refreshRepo(repoId).catch(() => {});
    running.current = false;
    if (alive.current) {
      setBusy(false);
      onBusyChange(false);
      onCompleted(outcome);
    }
  };
  return (
    <div className='flex flex-col gap-8px'>
      {snapshot.error && <RequestError message={snapshot.error} retry={snapshot.retry} />}
      <Space wrap>
        {(['merge', 'cherry-pick', 'revert', 'rebase'] as const).map((kind) => (
          <Button
            key={kind}
            size='small'
            disabled={disabled || busy || snapshot.loading || !snapshot.data?.branch || !!snapshot.data.operation}
            onClick={() => choose(kind)}
          >
            {t(`conversation.gitWorkbench.operations.${kind}`)}
          </Button>
        ))}
      </Space>
      <Modal
        visible={!!pending}
        title={t('conversation.gitWorkbench.merge.confirm')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => setPending(undefined)}
        onOk={run}
      >
        <p>
          {t('conversation.gitWorkbench.merge.confirmHistory', {
            operation: pending?.kind,
            branch: snapshot.data?.branch,
          })}
        </p>
        <code className='break-all'>{hash}</code>
        {pending?.kind === 'rebase' && <p>{t('conversation.gitWorkbench.merge.rebaseWarning')}</p>}
      </Modal>
    </div>
  );
}
