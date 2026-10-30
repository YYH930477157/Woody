import React, { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Select, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import type { GitMergeFinishRequest } from '@/common/types/sourceControl/mergeTypes';
import { splitText } from '@/common/git/merge/mergeModel';
import { Loading, RequestError } from '../RequestState';
import { useMergeEditor } from './useMergeEditor';
import { MergePane } from './MergePane';
import styles from './Merge.module.css';

export function ConflictEditor({
  scope,
  repoId,
  file,
  onFinished,
  onBusyChange,
}: {
  scope: GitWorkbenchScope;
  repoId: string;
  file: string;
  onFinished: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const state = useMergeEditor(scope, repoId, file, onFinished);
  const [reviewed, setReviewed] = useState(false);
  const [change, setChange] = useState(0);
  const [pending, setPending] = useState<GitMergeFinishRequest['resolution'] | 'rebuild' | 'discard' | 'recover'>();
  const text = (key: string) => t(`conversation.gitWorkbench.merge.${key}`);
  useEffect(() => {
    onBusyChange(state.busy || state.dirty);
  }, [state.busy, state.dirty, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  if (state.loading) return <Loading />;
  if (!state.document || !state.editor)
    return state.error ? <RequestError message={state.error} retry={state.retry} /> : null;
  const { document, editor } = state;
  const current = editor.model.changes[change];
  const range = editor.model.states[change];
  const canFinish = !document.binary && (reviewed || (!editor.manual && editor.model.unresolved.length === 0));
  return (
    <div className={styles.editor}>
      <strong className='break-all'>{file}</strong>
      {document.recoveryStale && <Alert type='warning' content={text('recoveryStale')} />}
      {document.recoveryResult !== undefined && !document.binary && (
        <Alert
          type='warning'
          content={
            <Space wrap>
              <span>{text('recoveryAvailable')}</span>
              <Button disabled={state.busy} onClick={() => setPending('recover')}>
                {text('recover')}
              </Button>
            </Space>
          }
        />
      )}
      {document.operation === 'rebase' && <Alert type='info' content={text('rebaseSides')} />}
      {state.error && <Alert type='error' content={state.error} />}
      {state.dirty && <Alert type='warning' content={text('unsaved')} />}
      {document.binary ? (
        <Alert type='info' content={text('binary')} />
      ) : (
        <>
          {editor.manual && <Alert type='info' content={text('manual')} />}
          <div className={styles.changes}>
            <Button disabled={state.busy} onClick={() => setPending('rebuild')}>
              {text('rebuild')}
            </Button>
            {!editor.manual && (
              <>
                <span>
                  {text('remaining')}: {editor.model.unresolved.length}
                </span>
                <Select
                  aria-label={text('change')}
                  value={change}
                  onChange={setChange}
                  style={{ width: 190 }}
                  options={editor.model.changes.map((item) => ({
                    value: item.index,
                    label: `${item.index + 1} · ${text(item.kind)}`,
                  }))}
                />
                <Button
                  disabled={state.busy || !current || !current.leftChange || range?.resolvedLeft}
                  onClick={() => {
                    setReviewed(false);
                    state.accept(change, 'left');
                  }}
                >
                  {text('acceptOursChange')}
                </Button>
                <Button
                  disabled={state.busy || !current || !current.rightChange || range?.resolvedRight}
                  onClick={() => {
                    setReviewed(false);
                    state.accept(change, 'right');
                  }}
                >
                  {text('acceptTheirsChange')}
                </Button>
              </>
            )}
          </div>
          <div className={styles.panes}>
            <MergePane
              title={`${text('ours')}${document.stages.ours.deleted ? ` · ${text('deleted')}` : ''}`}
              value={splitText(document.stages.ours.text ?? '').lines.join('\n')}
              file={file}
              line={!editor.manual ? current?.left[0] : undefined}
            />
            <MergePane
              title={`${text('result')} · ${document.crlf ? 'CRLF' : 'LF'}`}
              value={state.text}
              file={file}
              readOnly={state.busy}
              onChange={(value) => {
                setReviewed(false);
                state.edit(value);
              }}
              line={!editor.manual ? range?.start : undefined}
            />
            <MergePane
              title={`${text('theirs')}${document.stages.theirs.deleted ? ` · ${text('deleted')}` : ''}`}
              value={splitText(document.stages.theirs.text ?? '').lines.join('\n')}
              file={file}
              line={!editor.manual ? current?.right[0] : undefined}
            />
          </div>
          <Checkbox checked={reviewed} disabled={state.busy} onChange={setReviewed}>
            {text('reviewed')}
          </Checkbox>
        </>
      )}
      <Space wrap>
        <Button
          disabled={state.busy || document.binary || !state.dirty}
          loading={state.busy}
          onClick={() => void state.save()}
        >
          {text('save')}
        </Button>
        <Button disabled={state.busy || !state.dirty} onClick={() => setPending('discard')}>
          {text('discard')}
        </Button>
        <Button type='primary' disabled={state.busy || !canFinish} onClick={() => setPending('result')}>
          {text('finish')}
        </Button>
        <Button disabled={state.busy} onClick={() => setPending('ours')}>
          {text('useOurs')}
        </Button>
        <Button disabled={state.busy} onClick={() => setPending('theirs')}>
          {text('useTheirs')}
        </Button>
        <Button status='danger' disabled={state.busy} onClick={() => setPending('delete')}>
          {text('deleteFile')}
        </Button>
      </Space>
      <Modal
        visible={!!pending}
        title={text('confirm')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onCancel={() => setPending(undefined)}
        onOk={() => {
          const action = pending;
          setPending(undefined);
          if (action === 'rebuild') {
            setReviewed(false);
            state.rebuild();
          } else if (action === 'discard') {
            setReviewed(false);
            state.discard();
          } else if (action === 'recover') {
            setReviewed(false);
            state.recover();
          } else if (action) void state.finish(action, reviewed);
        }}
      >
        <p>{pending && text(`confirmActions.${pending}`)}</p>
        <code className='break-all'>{file}</code>
      </Modal>
    </div>
  );
}
