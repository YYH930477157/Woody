import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Empty, Input, Tag } from '@arco-design/web-react';
import type { GitOperationOutcome } from '@/common/types/sourceControl/operationTypes';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { HistoryList } from './HistoryList';
import { Loading, RequestError } from '../RequestState';
import { useRequest } from '../useRequest';
import { useHistoryFilters } from './useHistoryFilters';
import styles from '../Workbench.module.css';

export function HistoryView({
  scope,
  repoId,
  onBusyChange,
  onResolve,
  canRewrite = true,
}: {
  scope: GitWorkbenchScope;
  repoId?: string;
  onBusyChange?: (busy: boolean) => void;
  onResolve?: () => void;
  canRewrite?: boolean;
}) {
  const { t } = useTranslation();
  const { filters, setFilter, reset } = useHistoryFilters(scope);
  const { text, ref, author, path, since, until } = filters;
  const [settled, setSettled] = useState({ text, author, path });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => setSettled({ text, author, path }), 250);
    return () => clearTimeout(timer);
  }, [text, author, path, busy]);
  const [revision, setRevision] = useState(0);
  const [outcome, setOutcome] = useState<GitOperationOutcome>();
  const busyChange = useCallback(
    (value: boolean) => {
      setBusy(value);
      onBusyChange?.(value);
    },
    [onBusyChange]
  );
  const readRefs = useCallback(() => gitWorkbench.refs.invoke({ scope }), [scope]);
  const refs = useRequest(readRefs);
  const query = useMemo(
    () => ({
      text: settled.text.trim() || undefined,
      ref: ref || undefined,
      author: settled.author.trim() || undefined,
      path: settled.path.trim() || undefined,
      since: since || undefined,
      until: until || undefined,
    }),
    [settled.text, ref, settled.author, settled.path, since, until]
  );
  return (
    <div className={styles.history}>
      {outcome && (
        <Alert
          type={outcome.state === 'complete' ? 'success' : 'warning'}
          content={
            <div>
              <pre className='whitespace-pre-wrap break-all max-h-140px overflow-auto'>
                {outcome.output || t(`conversation.gitWorkbench.operations.outcomes.${outcome.state}`)}
              </pre>
              {outcome.state === 'conflict' && (
                <Button onClick={onResolve}>{t('conversation.gitWorkbench.merge.title')}</Button>
              )}
            </div>
          }
        />
      )}
      <div className={styles.toolbar}>
        <Input
          disabled={busy}
          aria-label={t('conversation.gitWorkbench.search')}
          placeholder={t('conversation.gitWorkbench.search')}
          value={text}
          onChange={(value) => setFilter('text', value)}
          allowClear
        />
        <Button
          disabled={busy}
          icon={<Refresh />}
          onClick={() => {
            refs.retry();
            setRevision((value) => value + 1);
          }}
        >
          {t('common.refresh')}
        </Button>
      </div>
      <div className={styles.filters}>
        <Input
          disabled={busy}
          aria-label={t('conversation.gitWorkbench.author')}
          placeholder={t('conversation.gitWorkbench.author')}
          value={author}
          onChange={(value) => setFilter('author', value)}
          allowClear
        />
        <Input
          disabled={busy}
          aria-label={t('conversation.gitWorkbench.path')}
          placeholder={t('conversation.gitWorkbench.path')}
          value={path}
          onChange={(value) => setFilter('path', value)}
          allowClear
        />
        <DatePicker
          disabled={busy}
          inputProps={{ 'aria-label': t('conversation.gitWorkbench.since') }}
          placeholder={t('conversation.gitWorkbench.since')}
          value={since || undefined}
          format='YYYY-MM-DD'
          onChange={(value) => setFilter('since', value ?? '')}
          allowClear
        />
        <DatePicker
          disabled={busy}
          inputProps={{ 'aria-label': t('conversation.gitWorkbench.until') }}
          placeholder={t('conversation.gitWorkbench.until')}
          value={until || undefined}
          format='YYYY-MM-DD'
          onChange={(value) => setFilter('until', value ?? '')}
          allowClear
        />
        <Button disabled={busy} onClick={reset}>
          {t('conversation.gitWorkbench.clearFilters')}
        </Button>
      </div>
      <div className={styles.workspace}>
        <aside className={styles.branches} aria-label={t('conversation.gitWorkbench.branches')}>
          <h3>{t('conversation.gitWorkbench.branches')}</h3>
          <Button disabled={busy} long type={!ref ? 'primary' : 'text'} onClick={() => setFilter('ref', '')}>
            {t('conversation.gitWorkbench.allRefs')}
          </Button>
          {refs.loading && <Loading />}
          {refs.error && <RequestError message={refs.error} retry={refs.retry} />}
          {refs.data?.length === 0 && <Empty description={t('conversation.gitWorkbench.noRefs')} />}
          {(['local', 'remote', 'tag'] as const).map((kind) => {
            const group = refs.data?.filter((item) => item.type === kind) ?? [];
            return (
              group.length > 0 && (
                <section key={kind}>
                  <h4>{t(`conversation.gitWorkbench.refTypes.${kind}`)}</h4>
                  {group.map((item) => (
                    <Button
                      disabled={busy}
                      key={item.fullName}
                      long
                      type={ref === item.fullName ? 'primary' : 'text'}
                      className={styles.refButton}
                      title={item.fullName}
                      onClick={() => setFilter('ref', item.fullName)}
                    >
                      <span className='truncate'>{item.name}</span>
                      {item.current && <Tag size='small'>{t('conversation.gitWorkbench.current')}</Tag>}
                    </Button>
                  ))}
                </section>
              )
            );
          })}
        </aside>
        <HistoryList
          key={JSON.stringify([query, revision])}
          scope={scope}
          query={query}
          repoId={repoId}
          canRewrite={canRewrite}
          busy={busy}
          onBusyChange={busyChange}
          onCompleted={(result) => {
            setOutcome(result);
            refs.retry();
            setRevision((value) => value + 1);
          }}
        />
      </div>
    </div>
  );
}
