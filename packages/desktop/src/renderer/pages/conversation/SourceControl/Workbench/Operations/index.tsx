import React, { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Space, Tabs, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { Loading, RequestError } from '../RequestState';
import { useOperations } from './useOperations';

/** Repository actions use server-validated snapshots from the state displayed to the user. */
export function Operations({
  scope,
  repoId,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  repoId: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const state = useOperations(scope, repoId);
  useEffect(() => {
    onBusyChange?.(state.busy);
  }, [state.busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [refName, setRefName] = useState('');
  const [remoteName, setRemoteName] = useState('');
  const [pending, setPending] = useState<{ request: GitOperationRequest; target: string }>();
  const label = (kind: GitOperationRequest['kind']) => t(`conversation.gitWorkbench.operations.${kind}`);
  const text = (
    key: 'name' | 'url' | 'reference' | 'message' | 'includeUntracked' | 'confirm' | 'noHead' | 'activeOperation'
  ) => t(`conversation.gitWorkbench.operations.${key}`);
  const run = (request: GitOperationRequest, target?: string) => {
    if (target) setPending({ request, target });
    else void state.run(request);
  };
  const { data } = state;
  const head = data?.head;
  const selected = data?.refs.find((ref) => ref.fullName === refName) ?? data?.refs[0];
  const remote = data?.remotes.find((item) => item.name === remoteName) ?? data?.remotes[0];
  const disabled = state.busy || state.loading || !data;
  const button = (kind: GitOperationRequest['kind'], action: () => void, unavailable = false, danger = false) => (
    <Button
      key={kind}
      size='small'
      status={danger ? 'danger' : undefined}
      disabled={disabled || unavailable}
      onClick={action}
    >
      {label(kind)}
    </Button>
  );
  return (
    <div className='flex flex-col gap-12px min-h-280px'>
      <Space>
        {state.canCancel && <Button onClick={() => void state.cancel()}>{t('common.cancel')}</Button>}
        <Button disabled={state.busy} loading={state.loading} onClick={state.refresh}>
          {t('common.refresh')}
        </Button>
        <Tag>{data?.branch ?? head?.slice(0, 10) ?? text('noHead')}</Tag>
        {data?.operation && (
          <Tag color='orange'>
            {text('activeOperation')}: {data.operation}
          </Tag>
        )}
      </Space>
      {state.loading && !data && <Loading />}
      {state.error && <RequestError message={state.error} retry={state.refresh} />}
      {state.outcome && (
        <Alert
          type={
            state.outcome.state === 'complete' ? 'success' : state.outcome.state === 'conflict' ? 'warning' : 'error'
          }
          content={
            <div>
              <strong>{t(`conversation.gitWorkbench.operations.outcomes.${state.outcome.state}`)}</strong>
              {state.outcome.data?.truncated && <p>{t('conversation.gitWorkbench.truncatedDiff')}</p>}
              <pre className='whitespace-pre-wrap break-all max-h-200px overflow-auto'>
                {state.outcome.output}
                {state.outcome.data?.patch}
              </pre>
              {state.outcome.files?.map((file) => (
                <div key={file}>{file}</div>
              ))}
            </div>
          }
        />
      )}
      <Tabs defaultActiveTab='refs'>
        <Tabs.TabPane key='refs' title={t('conversation.gitWorkbench.branches')}>
          <div className='flex flex-col gap-12px'>
            <Select
              aria-label={text('reference')}
              value={selected?.fullName}
              onChange={setRefName}
              options={
                data?.refs.map((ref) => ({ value: ref.fullName, label: `${ref.name}${ref.current ? ' •' : ''}` })) ?? []
              }
            />
            <Input aria-label={text('name')} placeholder={text('name')} value={name} onChange={setName} />
            <Space wrap>
              {button(
                'branch.create',
                () =>
                  head &&
                  run({
                    kind: 'branch.create',
                    name: name.trim(),
                    startPoint: selected?.hash ?? head,
                    expectedHead: head,
                  }),
                !head || !name.trim()
              )}
              {button(
                'branch.switch',
                () => head && selected && run({ kind: 'branch.switch', name: selected.name, expectedHead: head }),
                !head || selected?.type !== 'local' || selected.current
              )}
              {button(
                'branch.rename',
                () =>
                  head &&
                  selected &&
                  run(
                    {
                      kind: 'branch.rename',
                      name: selected.name,
                      newName: name.trim(),
                      expectedRef: selected.hash,
                      expectedHead: head,
                      confirmed: true,
                    },
                    `${selected.name} → ${name.trim()}`
                  ),
                !head || !name.trim() || selected?.type !== 'local'
              )}
              {button(
                'branch.delete',
                () =>
                  head &&
                  selected &&
                  run(
                    {
                      kind: 'branch.delete',
                      name: selected.name,
                      expectedRef: selected.hash,
                      expectedHead: head,
                      confirmed: true,
                    },
                    selected.name
                  ),
                !head || selected?.type !== 'local' || selected.current,
                true
              )}
              {button(
                'tag.create',
                () => head && run({ kind: 'tag.create', name: name.trim(), target: selected?.hash ?? head }),
                !head || !name.trim()
              )}
              {button(
                'tag.delete',
                () =>
                  selected &&
                  run(
                    {
                      kind: 'tag.delete',
                      name: selected.name,
                      expectedRef: selected.objectHash ?? selected.hash,
                      confirmed: true,
                    },
                    selected.name
                  ),
                selected?.type !== 'tag',
                true
              )}
            </Space>
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='remote' title={label('remote.list')}>
          <div className='flex flex-col gap-12px'>
            <Select
              aria-label={label('remote.list')}
              value={remote?.name}
              onChange={setRemoteName}
              options={data?.remotes.map((item) => ({ value: item.name, label: item.name })) ?? []}
            />
            {remote && <div className='text-t-secondary break-all'>{remote.fetchUrl}</div>}
            <Space wrap>
              {button('fetch', () => remote && run({ kind: 'fetch', remote: remote.name }), !remote)}
              {button(
                'pull',
                () =>
                  head &&
                  remote &&
                  data?.branch &&
                  run({ kind: 'pull', remote: remote.name, branch: data.branch, expectedHead: head }),
                !head || !remote || !data?.branch
              )}
              {button(
                'push',
                () =>
                  head &&
                  remote &&
                  data?.branch &&
                  run(
                    { kind: 'push', remote: remote.name, branch: data.branch, expectedHead: head, confirmed: true },
                    `${data.branch} → ${remote.name}`
                  ),
                !head || !remote || !data?.branch
              )}
            </Space>
            <Input aria-label={text('name')} placeholder={text('name')} value={name} onChange={setName} />
            <Input aria-label={text('url')} placeholder={text('url')} value={url} onChange={setUrl} />
            <Space wrap>
              {button(
                'remote.add',
                () => run({ kind: 'remote.add', name: name.trim(), url: url.trim() }),
                !name.trim() || !url.trim()
              )}
              {button(
                'remote.setUrl',
                () =>
                  remote &&
                  run(
                    {
                      kind: 'remote.setUrl',
                      name: remote.name,
                      url: url.trim(),
                      expectedUrl: remote.fetchUrl,
                      confirmed: true,
                    },
                    remote.name
                  ),
                !remote || !url.trim()
              )}
              {button(
                'remote.remove',
                () =>
                  remote &&
                  run(
                    { kind: 'remote.remove', name: remote.name, expectedUrl: remote.fetchUrl, confirmed: true },
                    remote.name
                  ),
                !remote,
                true
              )}
            </Space>
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='stash' title={label('stash.list')}>
          <div className='flex flex-col gap-12px'>
            <Input aria-label={text('message')} placeholder={text('message')} value={message} onChange={setMessage} />
            <Checkbox checked={includeUntracked} onChange={setIncludeUntracked}>
              {text('includeUntracked')}
            </Checkbox>
            {button(
              'stash.save',
              () => head && run({ kind: 'stash.save', message, includeUntracked, expectedHead: head }),
              !head
            )}
            {!data?.stashes.length && <Empty />}
            {data?.stashes.map((stash) => (
              <div key={stash.hash} className='p-12px border border-base rounded-8px'>
                <p>
                  {stash.ref}: {stash.subject}
                </p>
                <Space wrap>
                  {button('stash.show', () => run({ kind: 'stash.show', ref: stash.ref, expectedRef: stash.hash }))}
                  {button(
                    'stash.apply',
                    () =>
                      head && run({ kind: 'stash.apply', ref: stash.ref, expectedRef: stash.hash, expectedHead: head }),
                    !head
                  )}
                  {button(
                    'stash.pop',
                    () =>
                      head &&
                      run(
                        {
                          kind: 'stash.pop',
                          ref: stash.ref,
                          expectedRef: stash.hash,
                          expectedHead: head,
                          confirmed: true,
                        },
                        stash.ref
                      ),
                    !head
                  )}
                  {button(
                    'stash.drop',
                    () =>
                      run({ kind: 'stash.drop', ref: stash.ref, expectedRef: stash.hash, confirmed: true }, stash.ref),
                    false,
                    true
                  )}
                </Space>
              </div>
            ))}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='trees' title={label('worktree.list')}>
          {data?.worktrees.map((tree) => (
            <div key={tree.path} className='p-12px border-b border-b-base'>
              <div className='break-all'>{tree.path}</div>
              <code>{tree.branch ?? tree.head?.slice(0, 10)}</code>
              {tree.locked && <Tag>{t('conversation.gitWorkbench.operations.locked')}</Tag>}
            </div>
          ))}
        </Tabs.TabPane>
      </Tabs>
      <Modal
        visible={!!pending}
        title={pending ? label(pending.request.kind) : ''}
        okText={text('confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => setPending(undefined)}
        onOk={() => {
          if (pending) {
            void state.run(pending.request);
            setPending(undefined);
          }
        }}
      >
        {pending?.target}
      </Modal>
    </div>
  );
}
