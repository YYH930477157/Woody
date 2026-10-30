import React, { useCallback, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitStorage } from '@/common/adapter/ipcBridge';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { useRequest } from '../useRequest';
import { Loading, RequestError } from '../RequestState';
import { useStorageMutation } from './useStorageMutation';

/** Durable shelves and portable patches. Applying never implicitly deletes the saved patch. */
export function Shelves({
  scope,
  paths,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  paths: string[];
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const read = useCallback(() => gitStorage.shelfList.invoke({ scope }), [scope]);
  const request = useRequest(read);
  const [id, setId] = useState<string>();
  const [patch, setPatch] = useState('');
  const [feedback, setFeedback] = useState<string>();
  const [dialog, setDialog] = useState<'create' | 'import' | 'rename' | 'delete'>();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [rollback, setRollback] = useState(false);
  const [importPatch, setImportPatch] = useState('');
  const mutation = useStorageMutation(request.retry, onBusyChange);
  const item = request.data?.find((entry) => entry.id === id);
  const savePatch = () => {
    const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-patch;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item?.id ?? 'changes'}.patch`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const confirm = async () => {
    const ok = await mutation.run(async () => {
      if (dialog === 'create')
        await gitStorage.shelfCreate.invoke({ scope, request: { name, paths: selected, rollback } });
      if (dialog === 'import') await gitStorage.shelfImport.invoke({ scope, request: { name, patch: importPatch } });
      if (dialog === 'rename' && id) await gitStorage.shelfRename.invoke({ scope, id, name });
      if (dialog === 'delete' && id) {
        await gitStorage.shelfDelete.invoke({ scope, id, permanently: item?.deleted });
        setId(undefined);
        setPatch('');
      }
    });
    if (ok) setDialog(undefined);
  };
  return (
    <div className='flex flex-col gap-12px'>
      <div className='flex gap-8px flex-wrap'>
        <Button disabled={mutation.busy} onClick={request.retry}>
          {t('common.refresh')}
        </Button>
        <Button
          disabled={mutation.busy || paths.length === 0}
          onClick={() => {
            setName('');
            setSelected([]);
            setRollback(false);
            setDialog('create');
          }}
        >
          {t('conversation.gitWorkbench.storage.createShelf')}
        </Button>
        <Button
          disabled={mutation.busy}
          onClick={() => {
            setName('');
            setImportPatch('');
            setDialog('import');
          }}
        >
          {t('conversation.gitWorkbench.storage.importPatch')}
        </Button>
      </div>
      {mutation.error && <Alert type='error' content={mutation.error} />}
      {feedback && <Alert type='info' content={feedback} />}
      {request.loading && <Loading />}
      {request.error && <RequestError message={request.error} retry={request.retry} />}
      <div className='flex gap-12px flex-wrap'>
        <div className='flex flex-col gap-4px flex-1 min-w-180px max-h-440px overflow-auto'>
          {request.data?.length === 0 && <Empty description={t('conversation.gitWorkbench.storage.noShelves')} />}
          {request.data?.map((entry) => (
            <Button
              key={entry.id}
              disabled={mutation.busy}
              type={id === entry.id ? 'primary' : 'text'}
              onClick={() =>
                void mutation.run(async () => {
                  const data = await gitStorage.shelfRead.invoke({ scope, id: entry.id });
                  setId(entry.id);
                  setPatch(data.patch);
                  setFeedback(undefined);
                })
              }
            >
              {entry.name}
              {entry.deleted ? ` (${t('conversation.gitWorkbench.storage.deleted')})` : ''}
            </Button>
          ))}
        </div>
        <div className='flex-3 min-w-250px'>
          {item && (
            <>
              <div className='flex gap-8px flex-wrap'>
                {item.deleted ? (
                  <Button
                    disabled={mutation.busy}
                    onClick={() => void mutation.run(() => gitStorage.shelfRestore.invoke({ scope, id: item.id }))}
                  >
                    {t('conversation.gitWorkbench.storage.restoreShelf')}
                  </Button>
                ) : (
                  <Button
                    disabled={mutation.busy}
                    onClick={() =>
                      void mutation.run(async () => {
                        const result = await gitStorage.shelfApply.invoke({
                          scope,
                          request: { id: item.id, removeApplied: false },
                        });
                        setFeedback(
                          result.message ||
                            t(
                              result.applied
                                ? 'conversation.gitWorkbench.storage.applied'
                                : 'conversation.gitWorkbench.storage.retained'
                            )
                        );
                      })
                    }
                  >
                    {t('conversation.gitWorkbench.storage.apply')}
                  </Button>
                )}
                <Button
                  disabled={mutation.busy}
                  onClick={() => {
                    setName(item.name);
                    setDialog('rename');
                  }}
                >
                  {t('conversation.gitWorkbench.storage.rename')}
                </Button>
                <Button disabled={mutation.busy} onClick={savePatch}>
                  {t('conversation.gitWorkbench.storage.exportPatch')}
                </Button>
                <Button disabled={mutation.busy} status='danger' onClick={() => setDialog('delete')}>
                  {t('common.delete')}
                </Button>
              </div>
              <div className='text-12px text-t-secondary my-8px'>{new Date(item.createdAt).toLocaleString()}</div>
              {item.files.map((file) => (
                <div key={file.path} className='text-12px'>
                  {file.status} {file.oldPath ? `${file.oldPath} → ` : ''}
                  {file.path}
                </div>
              ))}
              <pre className='bg-2 text-t-primary p-8px max-h-360px overflow-auto'>{patch}</pre>
            </>
          )}
        </div>
      </div>
      <Modal
        visible={Boolean(dialog)}
        title={t(
          dialog === 'import'
            ? 'conversation.gitWorkbench.storage.importPatch'
            : dialog === 'delete'
              ? 'common.delete'
              : dialog === 'rename'
                ? 'common.rename'
                : 'conversation.gitWorkbench.storage.createShelf'
        )}
        onCancel={() => {
          if (!mutation.busy) setDialog(undefined);
        }}
        onOk={confirm}
        confirmLoading={mutation.busy}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{
          disabled:
            dialog !== 'delete' &&
            (!name.trim() ||
              (dialog === 'create' && selected.length === 0) ||
              (dialog === 'import' && !importPatch.trim())),
        }}
      >
        {dialog !== 'delete' && (
          <Input
            value={name}
            onChange={setName}
            disabled={mutation.busy}
            maxLength={200}
            aria-label={t('conversation.gitWorkbench.storage.name')}
            placeholder={t('conversation.gitWorkbench.storage.name')}
          />
        )}
        {dialog === 'create' && (
          <div className='flex flex-col gap-8px mt-12px'>
            <Checkbox.Group
              value={selected}
              onChange={(value) => setSelected(value.map(String))}
              disabled={mutation.busy}
            >
              <div className='flex flex-col max-h-250px overflow-auto'>
                {paths.map((file) => (
                  <Checkbox key={file} value={file}>
                    {file}
                  </Checkbox>
                ))}
              </div>
            </Checkbox.Group>
            <Checkbox checked={rollback} onChange={setRollback} disabled={mutation.busy}>
              {t('conversation.gitWorkbench.storage.rollback')}
            </Checkbox>
          </div>
        )}
        {dialog === 'import' && (
          <Input.TextArea
            className='mt-12px'
            value={importPatch}
            onChange={setImportPatch}
            disabled={mutation.busy}
            autoSize={{ minRows: 6, maxRows: 14 }}
            aria-label={t('conversation.gitWorkbench.storage.patch')}
          />
        )}
        {dialog === 'delete' && (
          <p>
            {t(
              item?.deleted
                ? 'conversation.gitWorkbench.storage.deletePermanently'
                : 'conversation.gitWorkbench.storage.deleteShelf'
            )}
          </p>
        )}
      </Modal>
    </div>
  );
}
