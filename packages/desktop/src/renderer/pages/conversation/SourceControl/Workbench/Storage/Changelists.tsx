import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type { ChangelistChange, ChangelistMutation } from '@/common/types/sourceControl/storageTypes';
import { useRequest } from '../useRequest';
import { useStorageMutation } from './useStorageMutation';

/** Assignment is independent from the checked-file selection used by Woody commits. */
export function useChangelists(scope: GitWorkbenchScope | undefined, changes: ChangelistChange[]) {
  const signature = JSON.stringify(changes);
  const scopeKey = JSON.stringify(scope);
  const stableScope = useMemo(() => scope, [scopeKey]);
  const read = useCallback(async () => {
    if (!stableScope || !ipcBridge.gitStorage?.changelistSync) return undefined;
    return ipcBridge.gitStorage.changelistSync.invoke({
      scope: stableScope,
      changes: JSON.parse(signature) as ChangelistChange[],
    });
  }, [stableScope, signature]);
  const request = useRequest(read);
  const [filter, setFilter] = useState('all');
  useEffect(() => setFilter('all'), [scopeKey]);
  const mutation = useStorageMutation(request.retry);
  const mutate = async (command: ChangelistMutation) => {
    if (!stableScope) return false;
    return mutation.run(() => ipcBridge.gitStorage.changelistMutate.invoke({ scope: stableScope, request: command }));
  };
  return {
    ...request,
    filter,
    setFilter,
    mutation,
    mutate,
    includes: (key: string) => filter === 'all' || request.data?.assignments[key] === filter,
  };
}

export function Changelists({
  controller,
  selectedKeys,
  disabled,
}: {
  controller: ReturnType<typeof useChangelists>;
  selectedKeys: string[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [dialog, setDialog] = useState<'create' | 'edit' | 'remove'>();
  const state = controller.data;
  if (!state) return controller.error ? <Alert type='warning' content={controller.error} /> : null;
  const busy = disabled || controller.mutation.busy || controller.loading;
  const display = (id: string, value: string) =>
    id === 'default' && value === 'Changes' ? t('conversation.gitWorkbench.storage.defaultList') : value;
  const options = state.lists.map((list) => ({ value: list.id, label: display(list.id, list.name) }));
  const selectedList = state.lists.find((list) => list.id === controller.filter);
  return (
    <div className='p-8px flex flex-col gap-4px border-b border-b-base'>
      {controller.mutation.error && <Alert type='error' content={controller.mutation.error} />}
      <div className='flex gap-4px items-center'>
        <Select
          size='small'
          aria-label={t('conversation.gitWorkbench.storage.changelists')}
          disabled={busy}
          value={controller.filter}
          options={[{ value: 'all', label: t('conversation.gitWorkbench.storage.allChanges') }, ...options]}
          onChange={controller.setFilter}
        />
        <Button
          size='small'
          disabled={busy}
          onClick={() => {
            setName('');
            setDialog('create');
          }}
        >
          {t('conversation.gitWorkbench.storage.newList')}
        </Button>
      </div>
      <div className='flex gap-4px flex-wrap'>
        <Select
          size='small'
          aria-label={t('conversation.gitWorkbench.storage.activeList')}
          disabled={busy}
          value={state.activeId}
          options={options}
          onChange={(id) => void controller.mutate({ kind: 'activate', id })}
        />
        <Select
          size='small'
          aria-label={t('conversation.gitWorkbench.storage.moveSelected')}
          placeholder={t('conversation.gitWorkbench.storage.moveSelected')}
          disabled={busy || selectedKeys.length === 0}
          value={undefined}
          options={options}
          onChange={(id) => void controller.mutate({ kind: 'move', id, keys: selectedKeys })}
        />
        {selectedList && (
          <>
            <Button
              size='small'
              disabled={busy}
              onClick={() => {
                setName(selectedList.name);
                setDialog('edit');
              }}
            >
              {t('conversation.gitWorkbench.storage.rename')}
            </Button>
            <Button size='small' disabled={busy || state.lists.length < 2} onClick={() => setDialog('remove')}>
              {t('conversation.gitWorkbench.storage.removeList')}
            </Button>
          </>
        )}
      </div>
      <Modal
        visible={Boolean(dialog)}
        title={t('conversation.gitWorkbench.storage.changelists')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={controller.mutation.busy}
        onCancel={() => {
          if (!controller.mutation.busy) setDialog(undefined);
        }}
        okButtonProps={{ disabled: busy || (dialog !== 'remove' && !name.trim()) }}
        onOk={async () => {
          const ok = await controller.mutate(
            dialog === 'create'
              ? { kind: 'create', name }
              : dialog === 'edit'
                ? { kind: 'edit', id: controller.filter, name }
                : { kind: 'remove', id: controller.filter }
          );
          if (ok) {
            if (dialog === 'remove') controller.setFilter('all');
            setDialog(undefined);
          }
        }}
      >
        {dialog === 'remove' ? (
          <p>{selectedList?.name}</p>
        ) : (
          <Input
            value={name}
            onChange={setName}
            maxLength={200}
            aria-label={t('conversation.gitWorkbench.storage.name')}
          />
        )}
      </Modal>
    </div>
  );
}
