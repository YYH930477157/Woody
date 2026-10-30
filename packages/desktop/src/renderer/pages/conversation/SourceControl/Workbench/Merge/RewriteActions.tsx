import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitOperationOutcome, GitOperationRequest } from '@/common/types/sourceControl/operationTypes';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { refreshRepo } from '../../scmStore';

type Kind = 'reword' | 'squash' | 'fixup' | 'drop';
type Pending = { kind: Kind; hashes: string[]; head: string; branch: string; message: string };
export function RewriteActions({
  scope,
  repoId,
  hashes,
  disabled,
  onBusyChange,
  onCompleted,
}: {
  scope: GitWorkbenchScope;
  repoId: string;
  hashes: string[];
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: (outcome: GitOperationOutcome) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const running = useRef(false);
  const submitting = useRef(false);
  const generation = useRef(0);
  const callbacks = useRef({ onBusyChange, onCompleted });
  callbacks.current = { onBusyChange, onCompleted };
  useEffect(
    () => () => {
      ++generation.current;
      callbacks.current.onBusyChange(false);
    },
    [scope, repoId]
  );
  const lock = (value: boolean) => {
    running.current = value;
    setBusy(value);
    callbacks.current.onBusyChange(value);
  };
  const choose = async (kind: Kind) => {
    if (running.current || disabled || hashes.length === 0) return;
    const target = [...hashes];
    const version = ++generation.current;
    lock(true);
    setError(undefined);
    try {
      const result = await gitWorkbench.operate.invoke({ scope, request: { kind: 'inspect' } });
      if (version !== generation.current) return;
      if (result.state !== 'complete' || !result.data?.head || !result.data.branch || result.data.operation)
        throw new Error(result.output || t('conversation.gitWorkbench.rewrite.unavailable'));
      let message = '';
      if (kind === 'reword' || kind === 'squash') {
        const details = await Promise.all(target.map((hash) => gitWorkbench.details.invoke({ scope, hash })));
        message = (kind === 'squash' ? details.toReversed() : details).map((detail) => detail.body).join('\n\n');
      }
      if (version !== generation.current) return;
      setPending({ kind, hashes: target, head: result.data.head, branch: result.data.branch, message });
      setBusy(false);
      // Keep the surrounding repository and selection frozen until confirmation closes.
    } catch (failure) {
      if (version === generation.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
        lock(false);
      }
    }
  };
  const cancel = () => {
    if (!busy) {
      setPending(undefined);
      lock(false);
    }
  };
  const run = async () => {
    if (submitting.current || busy || !pending) return;
    submitting.current = true;
    const target = pending;
    const version = ++generation.current;
    setPending(undefined);
    lock(true);
    const snapshot = { expectedHead: target.head, expectedBranch: target.branch, confirmed: true as const };
    const request: GitOperationRequest =
      target.kind === 'reword'
        ? { kind: 'history.reword', commit: target.hashes[0], message: target.message, ...snapshot }
        : target.kind === 'squash'
          ? { kind: 'history.squash', commits: target.hashes, message: target.message, ...snapshot }
          : { kind: target.kind === 'fixup' ? 'history.fixup' : 'history.drop', commits: target.hashes, ...snapshot };
    let result: GitOperationOutcome;
    try {
      result = await gitWorkbench.operate.invoke({ scope, request });
    } catch (failure) {
      result = { state: 'error', output: failure instanceof Error ? failure.message : String(failure) };
    }
    await refreshRepo(repoId).catch(() => {});
    submitting.current = false;
    if (version === generation.current) {
      lock(false);
      callbacks.current.onCompleted(result);
    }
  };
  return (
    <div className='flex flex-col gap-8px p-8px'>
      {error && <Alert type='error' content={error} />}
      <Space wrap>
        {(['reword', 'squash', 'fixup', 'drop'] as const).map((kind) => (
          <Button
            key={kind}
            size='small'
            disabled={
              disabled ||
              busy ||
              !!pending ||
              (kind === 'reword' ? hashes.length !== 1 : kind === 'drop' ? hashes.length < 1 : hashes.length < 2)
            }
            onClick={() => {
              void choose(kind);
            }}
          >
            {t(`conversation.gitWorkbench.rewrite.${kind}`)}
          </Button>
        ))}
      </Space>
      <Modal
        visible={!!pending}
        title={t('conversation.gitWorkbench.rewrite.confirm')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={cancel}
        onOk={run}
        confirmLoading={busy}
        okButtonProps={{
          disabled: !pending || ((pending.kind === 'reword' || pending.kind === 'squash') && !pending.message.trim()),
        }}
      >
        <Alert type='warning' content={t('conversation.gitWorkbench.rewrite.warning')} />
        <p>
          {t('conversation.gitWorkbench.rewrite.target', { branch: pending?.branch, head: pending?.head.slice(0, 8) })}
        </p>
        <pre className='max-h-160px overflow-auto whitespace-pre-wrap break-all'>{pending?.hashes.join('\n')}</pre>
        <p>{t('conversation.gitWorkbench.rewrite.constraints')}</p>
        {pending?.kind === 'fixup' && <p>{t('conversation.gitWorkbench.rewrite.fixupHint')}</p>}
        {pending && (pending.kind === 'reword' || pending.kind === 'squash') && (
          <Input.TextArea
            aria-label={t('conversation.gitWorkbench.rewrite.message')}
            value={pending.message}
            autoSize={{ minRows: 4, maxRows: 12 }}
            onChange={(message) => setPending((previous) => (previous ? { ...previous, message } : previous))}
          />
        )}
      </Modal>
    </div>
  );
}
