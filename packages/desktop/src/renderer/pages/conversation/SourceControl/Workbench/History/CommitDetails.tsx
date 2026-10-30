import React, { useCallback, useState } from 'react';
import { Button, Empty, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { Loading, RequestError } from '../RequestState';
import { useRequest } from '../useRequest';
import { FileHistory } from './FileHistory';
import styles from '../Workbench.module.css';

function FileDiff({ scope, hash, file }: { scope: GitWorkbenchScope; hash: string; file: string }) {
  const { t } = useTranslation();
  const read = useCallback(() => gitWorkbench.diff.invoke({ scope, hash, file }), [scope, hash, file]);
  const request = useRequest(read);
  if (request.loading) return <Loading />;
  if (request.error) return <RequestError message={request.error} retry={request.retry} />;
  if (request.data?.binary) return <Empty description={t('conversation.gitWorkbench.binary')} />;
  if (!request.data?.patch) return <Empty description={t('conversation.gitWorkbench.noDiff')} />;
  return (
    <>
      {request.data.truncated && (
        <p role='status' className='text-warning'>
          {t('conversation.gitWorkbench.truncatedDiff')}
        </p>
      )}
      <pre className={styles.patch} aria-label={t('conversation.gitWorkbench.diff')}>
        {request.data.patch.split('\n').map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith('+')
                ? styles.addition
                : line.startsWith('-')
                  ? styles.deletion
                  : line.startsWith('@@')
                    ? styles.hunk
                    : undefined
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    </>
  );
}

export function CommitDetails({ scope, hash }: { scope: GitWorkbenchScope; hash: string }) {
  const { t } = useTranslation();
  const read = useCallback(() => gitWorkbench.details.invoke({ scope, hash }), [scope, hash]);
  const request = useRequest(read);
  const [file, setFile] = useState<string>();
  const [fileView, setFileView] = useState<'diff' | 'history'>('diff');
  if (request.loading) return <Loading />;
  if (request.error) return <RequestError message={request.error} retry={request.retry} />;
  if (!request.data) return null;
  return (
    <>
      <div className={styles.commitMessage}>
        <code className='text-12px break-all text-t-secondary'>{hash}</code>
        <pre>{request.data.body}</pre>
      </div>
      <h3>{t('conversation.gitWorkbench.files')}</h3>
      <div className={styles.files}>
        {request.data.files.length === 0 && <Empty description={t('conversation.gitWorkbench.noFiles')} />}
        {request.data.files.map((item) => (
          <Button
            key={item.path}
            long
            type={file === item.path ? 'primary' : 'text'}
            className={styles.fileButton}
            title={item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}
            onClick={() => {
              setFile(item.path);
              setFileView('diff');
            }}
          >
            <Tag size='small'>{item.status}</Tag>
            <span className='truncate'>{item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}</span>
          </Button>
        ))}
      </div>
      <h3>{t('conversation.gitWorkbench.diff')}</h3>
      {file ? (
        <>
          <div className='flex gap-4px'>
            <Button size='mini' type={fileView === 'diff' ? 'primary' : 'text'} onClick={() => setFileView('diff')}>
              {t('conversation.gitWorkbench.diff')}
            </Button>
            <Button
              size='mini'
              type={fileView === 'history' ? 'primary' : 'text'}
              onClick={() => setFileView('history')}
            >
              {t('conversation.gitWorkbench.fileHistory.title')}
            </Button>
          </div>
          {fileView === 'diff' ? (
            <FileDiff key={file} scope={scope} hash={hash} file={file} />
          ) : (
            <FileHistory scope={scope} file={file} onClose={() => setFileView('diff')} />
          )}
        </>
      ) : (
        <Empty description={t('conversation.gitWorkbench.selectFile')} />
      )}
    </>
  );
}
