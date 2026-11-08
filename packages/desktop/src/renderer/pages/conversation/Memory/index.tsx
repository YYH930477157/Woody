import React, { useEffect, useState } from 'react';
import { Alert, Button, Input, Switch, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import MemoryEditor from './MemoryEditor';
import { useMemoryPanel } from './useMemoryPanel';

export type MemoryPanelProps = {
  workspace?: string;
  /** The conversation open beside the panel, for "Distill now". */
  conversationId?: string;
  visible?: boolean;
  refreshToken?: number;
};

/** The aionrs agent's memories for this project: settings, search, edit, distill. */
export default function MemoryPanel({ workspace, conversationId, visible = true, refreshToken = 0 }: MemoryPanelProps) {
  const { t } = useTranslation();
  // aionrs names the memory folder after its conversation's workspace string, which can
  // differ from the explorer's display path; other agents have no aionrs memory to distill.
  const [aionrsWorkspace, setAionrsWorkspace] = useState<string | null>(null);
  useEffect(() => {
    setAionrsWorkspace(null);
    if (!conversationId || typeof window === 'undefined' || !window.electronAPI) return;
    let current = true;
    ipcBridge.memory.workspaceOf
      .invoke({ conversationId })
      .then((value) => current && setAionrsWorkspace(value))
      .catch((): undefined => undefined);
    return () => {
      current = false;
    };
  }, [conversationId]);
  const memoryWorkspace = aionrsWorkspace || workspace;
  const state = useMemoryPanel(memoryWorkspace, visible, refreshToken);
  const { project, settings, entries, busy, error, distilled } = state;
  const [editing, setEditing] = useState<string>();
  const desktop = typeof window !== 'undefined' && Boolean(window.electronAPI);
  if (!desktop) return <div className='p-16px text-t-secondary'>{t('conversation.codebaseMemory.desktopOnly')}</div>;
  if (!memoryWorkspace) return <div className='p-16px text-t-secondary'>{t('conversation.memory.noWorkspace')}</div>;

  const close = () => setEditing(undefined);
  return (
    <div className='h-full overflow-auto p-16px flex flex-col gap-12px text-t-primary'>
      {settings && (
        <div className='flex flex-col gap-8px'>
          {(['autoDistill', 'autoRecall'] as const).map((key) => (
            <div key={key} className='flex items-start justify-between gap-8px'>
              <div className='flex flex-col'>
                <span>{t(`conversation.memory.${key}`)}</span>
                <span className='text-12px text-t-secondary'>{t(`conversation.memory.${key}Hint`)}</span>
              </div>
              <Switch
                aria-label={t(`conversation.memory.${key}`)}
                checked={settings[key]}
                disabled={Boolean(busy)}
                onChange={(checked) => void state.updateSettings({ ...settings, [key]: checked })}
              />
            </div>
          ))}
        </div>
      )}
      <div className='flex flex-wrap items-center gap-8px'>
        <Button
          type='primary'
          size='small'
          disabled={!conversationId || !aionrsWorkspace || Boolean(busy)}
          loading={busy === 'distill'}
          onClick={() => conversationId && void state.distill(conversationId)}
        >
          {t('conversation.memory.distill')}
        </Button>
        <Button size='small' disabled={Boolean(busy)} onClick={() => setEditing('')}>
          {t('conversation.memory.add')}
        </Button>
        <Button size='small' loading={busy === 'open'} onClick={() => void state.openFolder()}>
          {t('conversation.memory.openFolder')}
        </Button>
      </div>
      <div className='text-12px text-t-secondary'>{t('conversation.memory.distillHint')}</div>
      {distilled && (
        <Alert
          type='success'
          content={t('conversation.memory.distillDone', { added: distilled.added, updated: distilled.updated })}
        />
      )}
      {error && <Alert type='error' content={error} />}
      {project && <div className='text-12px text-t-secondary break-all'>{project.directory}</div>}
      <Input.Search
        aria-label={t('conversation.memory.search')}
        placeholder={t('conversation.memory.search')}
        allowClear
        value={state.query}
        onChange={state.setQuery}
      />
      {editing === '' && (
        <MemoryEditor
          busy={busy === 'save'}
          onClose={close}
          onSave={(input) => void state.save(input).then((saved) => saved && close())}
        />
      )}
      {project && entries.length === 0 && (
        <div className='text-t-secondary'>
          {state.searching ? t('conversation.memory.noResults') : t('conversation.memory.empty')}
        </div>
      )}
      <div className='flex flex-col gap-8px'>
        {entries.map((entry) =>
          editing === entry.file ? (
            <MemoryEditor
              key={entry.file}
              entry={entry}
              busy={busy === 'save' || busy === 'remove'}
              onClose={close}
              onSave={(input) => void state.save(input).then((saved) => saved && close())}
              onRemove={() => void state.remove(entry.file).then(close)}
            />
          ) : (
            <div
              key={entry.file}
              role='button'
              tabIndex={0}
              aria-label={entry.name}
              className='flex flex-col gap-2px p-8px rd-6px cursor-pointer hover:bg-2 focus:bg-2 outline-none'
              onClick={() => setEditing(entry.file)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setEditing(entry.file);
              }}
            >
              <div className='flex items-center gap-6px min-w-0'>
                {entry.type && <Tag size='small'>{t(`conversation.memory.types.${entry.type}`)}</Tag>}
                <span className='font-medium truncate'>{entry.name}</span>
              </div>
              {entry.description && <span className='text-12px text-t-secondary'>{entry.description}</span>}
              <span className='text-12px text-t-secondary'>
                {t('conversation.memory.updatedAt', { time: new Date(entry.updatedAt).toLocaleString() })}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
