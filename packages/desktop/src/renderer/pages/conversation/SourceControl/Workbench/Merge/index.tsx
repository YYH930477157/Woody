import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Modal, Select, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type { GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import { useRequest } from '../useRequest';
import { Loading, RequestError } from '../RequestState';
import { useOperations } from '../Operations/useOperations';
import { ConflictEditor } from './ConflictEditor';
import styles from './Merge.module.css';

export function Merge({
  scope,
  repoId,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  repoId: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const read = useCallback(() => gitWorkbench.mergeList.invoke({ scope }), [scope]);
  const list = useRequest(read);
  const operations = useOperations(scope, repoId);
  const [file, setFile] = useState('');
  const [editorBusy, setEditorBusy] = useState(false);
  const [pending, setPending] = useState<GitOperationRequest>();
  const busy = operations.busy || editorBusy;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const refresh = useCallback(() => {
    list.retry();
    operations.refresh();
  }, [list.retry, operations.refresh]);
  const selected = list.data?.files.includes(file) ? file : list.data?.files[0];
  const operation = operations.data?.operation;
  const recoverable =
    operation === 'merge' || operation === 'rebase' || operation === 'cherry-pick' || operation === 'revert';
  const text = (key: string) => t(`conversation.gitWorkbench.merge.${key}`);
  const recover = (kind: 'history.continue' | 'history.abort') => {
    if (recoverable && operations.data?.head)
      setPending({
        kind,
        operation,
        expectedHead: operations.data.head,
        expectedBranch: operations.data.branch,
        confirmed: true,
      });
  };
  return (
    <div className={styles.editor}>
      <Space wrap>
        <Button disabled={busy} onClick={refresh}>
          {t('common.refresh')}
        </Button>
        {recoverable && (
          <>
            <span>
              {text('active')}: {operation}
            </span>
            <Button
              disabled={busy || list.loading || operations.loading || !list.data || list.data.files.length > 0}
              onClick={() => recover('history.continue')}
            >
              {text('continue')}
            </Button>
            <Button status='danger' disabled={busy || operations.loading} onClick={() => recover('history.abort')}>
              {text('abort')}
            </Button>
          </>
        )}
      </Space>
      {operations.error && <RequestError message={operations.error} retry={operations.refresh} />}
      {operations.outcome && (
        <Alert
          type={operations.outcome.state === 'complete' ? 'success' : 'warning'}
          content={
            <pre className={styles.output}>
              {operations.outcome.output ||
                t(`conversation.gitWorkbench.operations.outcomes.${operations.outcome.state}`)}
            </pre>
          }
        />
      )}
      {list.loading && <Loading />}
      {list.error && <RequestError message={list.error} retry={list.retry} />}
      {!list.loading && list.data?.files.length === 0 && <Empty description={text(recoverable ? 'ready' : 'empty')} />}
      {!!list.data?.files.length && (
        <Select
          aria-label={text('files')}
          value={selected}
          disabled={busy}
          onChange={setFile}
          options={list.data.files.map((path) => ({ label: path, value: path }))}
        />
      )}
      {!list.loading && selected && (
        <ConflictEditor
          key={selected}
          scope={scope}
          repoId={repoId}
          file={selected}
          onFinished={refresh}
          onBusyChange={setEditorBusy}
        />
      )}
      <Modal
        visible={!!pending}
        title={text('confirm')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => setPending(undefined)}
        onOk={async () => {
          const request = pending;
          setPending(undefined);
          if (request) {
            await operations.run(request);
            list.retry();
          }
        }}
      >
        <p>{text(pending?.kind === 'history.abort' ? 'confirmAbort' : 'confirmContinue')}</p>
        <code>
          {operation} · {operations.data?.head}
        </code>
      </Modal>
    </div>
  );
}
