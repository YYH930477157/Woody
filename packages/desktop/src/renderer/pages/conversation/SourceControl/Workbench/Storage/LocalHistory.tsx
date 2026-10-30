import React, { useCallback, useState } from 'react';
import { Alert, Button, Empty, Input, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitStorage } from '@/common/adapter/ipcBridge';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { useRequest } from '../useRequest';
import { Loading, RequestError } from '../RequestState';
import { useStorageMutation } from './useStorageMutation';

function decode(content: string | undefined): string | undefined {
  if (content === undefined) return '';
  try {
    const bytes = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
    if (bytes.includes(0)) return undefined;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function Comparison({
  scope,
  id,
  path,
  refresh,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  id: string;
  path: string;
  refresh: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const read = useCallback(() => gitStorage.historyCompare.invoke({ scope, request: { id, path } }), [scope, id, path]);
  const comparison = useRequest(read);
  const mutation = useStorageMutation(() => {
    comparison.retry();
    refresh();
  }, onBusyChange);
  const [confirm, setConfirm] = useState(false);
  if (comparison.loading) return <Loading />;
  if (comparison.error) return <RequestError message={comparison.error} retry={comparison.retry} />;
  if (!comparison.data) return null;
  const captured = comparison.data;
  return (
    <div className='flex flex-col gap-8px min-w-0'>
      {mutation.error && <Alert type='error' content={mutation.error} />}
      <div className='flex gap-12px min-w-0'>
        {(['before', 'current'] as const).map((side) => {
          const content = captured[side];
          const text = decode(content.contentBase64);
          return (
            <div key={side} className='flex-1 min-w-0'>
              <h4>
                {t(
                  side === 'before'
                    ? 'conversation.gitWorkbench.storage.savedVersion'
                    : 'conversation.gitWorkbench.storage.currentVersion'
                )}
              </h4>
              <pre className='bg-2 text-t-primary p-8px max-h-400px overflow-auto whitespace-pre-wrap break-all'>
                {!content.exists
                  ? t('conversation.gitWorkbench.storage.missing')
                  : text === undefined
                    ? t('conversation.gitWorkbench.binary')
                    : text}
              </pre>
            </div>
          );
        })}
      </div>
      <Button disabled={mutation.busy} onClick={() => setConfirm(true)}>
        {t('conversation.gitWorkbench.storage.restoreFile')}
      </Button>
      <Modal
        visible={confirm}
        title={t('conversation.gitWorkbench.storage.restoreFile')}
        confirmLoading={mutation.busy}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => {
          if (!mutation.busy) setConfirm(false);
        }}
        onOk={async () => {
          const ok = await mutation.run(() =>
            gitStorage.historyRestore.invoke({
              scope,
              request: { id, paths: [path], expected: { [path]: captured.current.fingerprint } },
            })
          );
          if (ok) setConfirm(false);
        }}
      >
        {t('conversation.gitWorkbench.storage.restoreWarning')}
        <pre>{path}</pre>
      </Modal>
    </div>
  );
}

/** Recorded project edits, labels, comparison and guarded restoration. */
export function LocalHistory({
  scope,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const read = useCallback(
    async () => ({
      events: await gitStorage.historyList.invoke({ scope }),
      status: await gitStorage.historyStatus.invoke({ scope }),
    }),
    [scope]
  );
  const request = useRequest(read);
  const [selected, setSelected] = useState<{ id: string; path: string }>();
  const [label, setLabel] = useState('');
  const [restoring, setRestoring] = useState(false);
  const mutation = useStorageMutation(request.retry, onBusyChange);
  const restoreBusy = useCallback(
    (busy: boolean) => {
      setRestoring(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange]
  );
  const busy = mutation.busy || restoring;
  return (
    <div className='flex flex-col gap-12px min-h-0'>
      <div className='flex gap-8px'>
        <Button disabled={busy} onClick={request.retry}>
          {t('common.refresh')}
        </Button>
        <Input
          value={label}
          disabled={busy}
          onChange={setLabel}
          aria-label={t('conversation.gitWorkbench.storage.label')}
          placeholder={t('conversation.gitWorkbench.storage.label')}
          maxLength={200}
        />
        <Button
          disabled={busy || !label.trim()}
          onClick={() =>
            void mutation.run(async () => {
              await gitStorage.historyLabel.invoke({ scope, label });
              setLabel('');
            })
          }
        >
          {t('conversation.gitWorkbench.storage.addLabel')}
        </Button>
      </div>
      {mutation.error && <Alert type='error' content={mutation.error} />}
      {request.loading && <Loading />}
      {request.error && <RequestError message={request.error} retry={request.retry} />}
      {request.data?.status.limited && (
        <Alert type='warning' content={t('conversation.gitWorkbench.storage.recordingLimited')} />
      )}
      {request.data?.status.errors.map((error) => (
        <Alert key={error} type='warning' content={error} />
      ))}
      <div className='flex flex-wrap gap-12px min-h-0'>
        <div className='flex flex-col gap-4px max-h-440px overflow-auto min-w-180px flex-1'>
          {request.data?.events.length === 0 && (
            <Empty description={t('conversation.gitWorkbench.storage.noHistory')} />
          )}
          {request.data?.events.map((event) => (
            <section key={event.id} className='border-b border-b-base pb-8px'>
              <div className='text-12px text-t-secondary'>
                {new Date(event.createdAt).toLocaleString()} {event.label}
              </div>
              {event.files.map((file) => (
                <Button
                  key={file.path}
                  disabled={busy}
                  long
                  type={selected?.id === event.id && selected.path === file.path ? 'primary' : 'text'}
                  onClick={() => setSelected({ id: event.id, path: file.path })}
                >
                  {file.path}
                </Button>
              ))}
            </section>
          ))}
        </div>
        <div className='flex-3 min-w-250px'>
          {selected && (
            <Comparison
              key={`${selected.id}:${selected.path}`}
              scope={scope}
              {...selected}
              refresh={request.retry}
              onBusyChange={restoreBusy}
            />
          )}
        </div>
      </div>
    </div>
  );
}
