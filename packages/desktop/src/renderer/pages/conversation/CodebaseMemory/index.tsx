import React, { useEffect, useState } from 'react';
import { Alert, Button, Collapse, Select, Spin, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useCodebaseMemory } from './useCodebaseMemory';

export type CodebaseMemoryPanelProps = { repoPaths: Record<string, string>; visible?: boolean; refreshToken?: number };

function FolderMemory({
  repoPath,
  visible,
  refreshToken,
}: {
  repoPath: string;
  visible: boolean;
  refreshToken: number;
}) {
  const { t } = useTranslation();
  const state = useCodebaseMemory(repoPath, visible, refreshToken);
  const { status, draft, dirty, loading, busy, error, readFailed, updateDraft, run } = state;
  const activeError = error || status?.error;
  const running = status?.phase === 'running';
  const locked = loading || Boolean(busy) || readFailed || !status;
  const phaseKeys = {
    idle: 'conversation.codebaseMemory.phase.idle',
    running: 'conversation.codebaseMemory.phase.running',
    succeeded: 'conversation.codebaseMemory.phase.succeeded',
    failed: 'conversation.codebaseMemory.phase.failed',
    cancelled: 'conversation.codebaseMemory.phase.cancelled',
  } as const;
  return (
    <div className='flex flex-col gap-12px'>
      <div className='text-12px text-t-secondary break-all'>{repoPath}</div>
      <div className='text-12px text-t-secondary'>.woody/codebase-memory.json</div>
      <div className='flex items-center justify-between gap-8px'>
        <span>{t('conversation.codebaseMemory.enabled')}</span>
        <Switch
          aria-label={t('conversation.codebaseMemory.enabled')}
          checked={draft.enabled}
          disabled={locked || running}
          onChange={(enabled) => updateDraft({ ...draft, enabled })}
        />
      </div>
      <label className='flex flex-col gap-6px'>
        <span>{t('conversation.codebaseMemory.mode')}</span>
        <Select
          aria-label={t('conversation.codebaseMemory.mode')}
          value={draft.mode}
          disabled={locked || running}
          onChange={(mode: 'fast' | 'moderate' | 'full') => updateDraft({ ...draft, mode })}
          options={[
            { value: 'fast', label: t('conversation.codebaseMemory.modes.fast') },
            { value: 'moderate', label: t('conversation.codebaseMemory.modes.moderate') },
            { value: 'full', label: t('conversation.codebaseMemory.modes.full') },
          ]}
        />
      </label>
      <div className='flex flex-wrap gap-8px'>
        <Button disabled={locked || running || !dirty} loading={busy === 'save'} onClick={() => void run('save')}>
          {t('common.save')}
        </Button>
        {running ? (
          <Button disabled={Boolean(busy)} loading={busy === 'cancel'} onClick={() => void run('cancel')}>
            {t('common.cancel')}
          </Button>
        ) : (
          <Button
            type='primary'
            disabled={locked || dirty || !status?.config.enabled || !status?.available}
            loading={busy === 'start'}
            onClick={() => void run('start')}
          >
            {t('conversation.codebaseMemory.start')}
          </Button>
        )}
      </div>
      {dirty && <div className='text-12px text-t-secondary'>{t('conversation.codebaseMemory.unsaved')}</div>}
      <Alert type='info' content={t('conversation.codebaseMemory.newConversationHint')} />
      {loading && <Spin />}
      {status && !status.available && <Alert type='warning' content={t('conversation.codebaseMemory.unavailable')} />}
      {activeError && <Alert type='error' content={activeError} />}
      {readFailed && <Button onClick={() => void state.reload()}>{t('conversation.codebaseMemory.reload')}</Button>}
      {status && !(activeError && status.phase === 'succeeded') && (
        <div role='status'>{t(phaseKeys[status.phase])}</div>
      )}
      {(status?.log || (!activeError && status?.summary)) && (
        <Collapse bordered={false} defaultActiveKey={[]}>
          <Collapse.Item name='output' header={t('conversation.codebaseMemory.output')}>
            {!activeError && status?.summary && (
              <div className='text-t-secondary whitespace-pre-wrap break-words'>{status.summary}</div>
            )}
            {status?.log && (
              <pre className='m-0 p-8px bg-2 text-t-primary text-12px whitespace-pre-wrap break-words max-h-320px overflow-auto'>
                {status.log}
              </pre>
            )}
          </Collapse.Item>
        </Collapse>
      )}
    </div>
  );
}

/** Folder-scoped architecture setup and manual indexing in the project explorer. */
export default function CodebaseMemoryPanel({ repoPaths, visible = true, refreshToken = 0 }: CodebaseMemoryPanelProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');
  const [visited, setVisited] = useState<string[]>([]);
  const folders = [...new Set(Object.values(repoPaths).filter(Boolean))];
  const repoPath = folders.includes(selected) ? selected : folders[0];
  const desktop = typeof window !== 'undefined' && Boolean(window.electronAPI);
  useEffect(() => {
    if (repoPath) setVisited((previous) => (previous.includes(repoPath) ? previous : [...previous, repoPath]));
  }, [repoPath]);
  if (!desktop) return <div className='p-16px text-t-secondary'>{t('conversation.codebaseMemory.desktopOnly')}</div>;
  if (!repoPath) return <div className='p-16px text-t-secondary'>{t('conversation.codebaseMemory.noFolder')}</div>;
  return (
    <div className='h-full overflow-auto p-16px flex flex-col gap-12px text-t-primary'>
      {folders.length > 1 && (
        <Select
          aria-label={t('conversation.codebaseMemory.folder')}
          value={repoPath}
          onChange={setSelected}
          options={folders.map((path) => ({ value: path, label: path }))}
        />
      )}
      {folders
        .filter((path) => path === repoPath || visited.includes(path))
        .map((path) => (
          <div key={path} hidden={path !== repoPath}>
            <FolderMemory repoPath={path} visible={visible && path === repoPath} refreshToken={refreshToken} />
          </div>
        ))}
    </div>
  );
}
