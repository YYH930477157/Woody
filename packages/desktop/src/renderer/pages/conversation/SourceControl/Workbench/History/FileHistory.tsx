import React, { useCallback, useState } from 'react';
import { Alert, Button, Empty, Tabs, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import { projectFileRef } from '@/common/types/chatFile';
import type { GitCommitDiff, GitHistoryCommit, GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { usePreviewContext } from '../../../Preview';
import { Loading, RequestError } from '../RequestState';
import { useRequest } from '../useRequest';
import styles from '../Workbench.module.css';

const fileReference = (scope: GitWorkbenchScope, file: string) =>
  projectFileRef(scope.peId, [scope.relativePath, file].filter(Boolean).join('/'));

/** File-local history, blame and historical source routed into Woody's shared preview. */
export function FileHistory({ scope, file, onClose }: { scope: GitWorkbenchScope; file: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { openPreview } = usePreviewContext();
  const [selected, setSelected] = useState<GitHistoryCommit>();
  const [diff, setDiff] = useState<GitCommitDiff>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const historyRead = useCallback(
    () => gitWorkbench.fileHistory.invoke({ scope, query: { path: file, limit: 100 } }),
    [scope, file]
  );
  const history = useRequest(historyRead);
  const blameRead = useCallback(() => gitWorkbench.blame.invoke({ scope, file }), [scope, file]);
  const blame = useRequest(blameRead);

  const openRevision = async (commit: GitHistoryCommit): Promise<void> => {
    setSelected(commit);
    setError(undefined);
    setBusy(true);
    try {
      const [content, comparison] = await Promise.all([
        gitWorkbench.readRevision.invoke({
          scope,
          anchor: { kind: 'revision', revision: commit.hash },
          file,
        }),
        gitWorkbench.diff.invoke({ scope, hash: commit.hash, file }),
      ]);
      setDiff(comparison);
      if (!content.exists) {
        setError(t('conversation.gitWorkbench.fileHistory.missing'));
        return;
      }
      if (content.binary) {
        setError(t('conversation.gitWorkbench.binary'));
        return;
      }
      openPreview(content.content ?? '', 'code', {
        title: `${file} @ ${commit.hash.slice(0, 8)}`,
        file_name: file.split('/').pop() || file,
        fileRef: fileReference(scope, file),
        editable: false,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const commitRows = history.data?.commits ?? [];
  return (
    <div className='flex flex-col gap-8px min-w-0'>
      <div className='flex items-center justify-between gap-8px'>
        <strong className='truncate'>{file}</strong>
        <Button size='mini' onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      {error && <Alert type='warning' content={error} />}
      <Tabs defaultActiveTab='history'>
        <Tabs.TabPane key='history' title={t('conversation.gitWorkbench.fileHistory.title')}>
          {history.loading && <Loading />}
          {history.error && <RequestError message={history.error} retry={history.retry} />}
          {!history.loading && commitRows.length === 0 && (
            <Empty description={t('conversation.gitWorkbench.fileHistory.empty')} />
          )}
          <div className='flex flex-col gap-4px max-h-220px overflow-auto'>
            {commitRows.map((commit) => (
              <Button
                key={commit.hash}
                long
                type={selected?.hash === commit.hash ? 'primary' : 'text'}
                disabled={busy}
                onClick={() => void openRevision(commit)}
              >
                <code>{commit.hash.slice(0, 8)}</code>
                <span className='truncate'>{commit.subject}</span>
                <span className='text-12px text-t-tertiary'>{commit.authorName}</span>
              </Button>
            ))}
          </div>
          {diff && (
            <section>
              <h4>{t('conversation.gitWorkbench.fileHistory.diffTitle')}</h4>
              <pre className={styles.patch} aria-label={t('conversation.gitWorkbench.diff')}>
                {diff.patch || t('conversation.gitWorkbench.fileHistory.noChanges')}
              </pre>
            </section>
          )}
        </Tabs.TabPane>
        <Tabs.TabPane key='blame' title={t('conversation.gitWorkbench.fileHistory.blame')}>
          {blame.loading && <Loading />}
          {blame.error && <RequestError message={blame.error} retry={blame.retry} />}
          <div className='max-h-300px overflow-auto font-mono text-12px'>
            {blame.data?.map((line) => (
              <div key={line.line} className='grid grid-cols-[38px_72px_96px_minmax(0,1fr)] gap-4px py-1px'>
                <span className='text-t-tertiary text-right'>{line.line}</span>
                <span className='truncate'>
                  {line.committed ? line.hash.slice(0, 8) : t('conversation.gitWorkbench.fileHistory.uncommitted')}
                </span>
                <span className='truncate text-t-secondary'>{line.author}</span>
                <span className='whitespace-pre'>{line.content}</span>
              </div>
            ))}
          </div>
        </Tabs.TabPane>
      </Tabs>
    </div>
  );
}
