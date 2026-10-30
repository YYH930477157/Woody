/**
 * Graph lanes and history/detail layout derive from IdeaGitTool.
 * Upstream declares Apache-2.0; see resources/third-party/ideagittool/PROVENANCE.md.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { gitWorkbench } from '@/common/adapter/ipcBridge';
import { GraphLayout } from '@/common/git/graph';
import type { GraphRow } from '@/common/git/graphTypes';
import type { GitHistoryPage, GitHistoryQuery, GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { CommitDetails } from './CommitDetails';
import { HistoryActions } from '../Merge/HistoryActions';
import { RewriteActions } from '../Merge/RewriteActions';
import type { GitOperationOutcome } from '@/common/types/sourceControl/operationTypes';
import { Loading, RequestError } from '../RequestState';
import styles from '../Workbench.module.css';

const LANE = 14;
const ROW_HEIGHT = 36;
const colors = ['var(--primary)', 'var(--success)', 'var(--warning)', 'var(--danger)', 'var(--info)'];
const laneColor = (lane: number) => colors[lane % colors.length];

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  return (
    <svg aria-hidden='true' width={width} height={ROW_HEIGHT} className={styles.graph}>
      {row.edges.map((edge, index) => (
        <line
          key={index}
          data-graph-edge=''
          x1={edge.fromLane * LANE + 9}
          x2={edge.toLane * LANE + 9}
          y1={(edge.fromY * ROW_HEIGHT) / 2}
          y2={(edge.toY * ROW_HEIGHT) / 2}
          stroke={laneColor(edge.color)}
          strokeWidth={1.6}
          strokeDasharray={edge.dashed ? '3 3' : undefined}
        />
      ))}
      <circle cx={row.lane * LANE + 9} cy={ROW_HEIGHT / 2} r={4} fill={laneColor(row.color)} />
    </svg>
  );
}

export function HistoryList({
  scope,
  query,
  repoId,
  busy: operationBusy,
  onBusyChange,
  onCompleted,
  canRewrite = true,
}: {
  scope: GitWorkbenchScope;
  query: GitHistoryQuery;
  repoId?: string;
  busy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onCompleted?: (outcome: GitOperationOutcome) => void;
  canRewrite?: boolean;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<GitHistoryPage>({ commits: [], hasMore: false, nextSkip: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const generation = useRef(0);
  const busy = useRef(false);
  const nextSkip = useRef(0);
  const snapshot = useRef<string | undefined>(undefined);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const request = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await gitWorkbench.history.invoke({
        scope,
        query: { ...query, skip: nextSkip.current, limit: 100, snapshot: snapshot.current },
      });
      if (request !== generation.current) return;
      nextSkip.current = result.nextSkip;
      snapshot.current = result.snapshot;
      setPage((previous) => {
        const hashes = new Set(previous.commits.map((commit) => commit.hash));
        return {
          ...result,
          commits: [...previous.commits, ...result.commits.filter((commit) => !hashes.has(commit.hash))],
        };
      });
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (request === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [scope, query]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
      busy.current = false;
    };
  }, [load]);
  // A text filter omits ancestors; drawing their connections would imply false adjacency.
  const filtered = Boolean(query.text || query.author || query.path || query.noMerges || query.since || query.until);
  const graph = useMemo(() => {
    const layout = new GraphLayout(new Set(page.commits.map((commit) => commit.hash)));
    return page.commits.map((commit) => layout.add(commit.hash, filtered ? [] : commit.parents));
  }, [page.commits, filtered]);
  const width = Math.max(1, ...graph.map((row) => row.width)) * LANE + 8;
  return (
    <div className={styles.results}>
      <section className={styles.log} aria-label={t('conversation.gitWorkbench.commits')}>
        {repoId && onBusyChange && onCompleted && (
          <>
            {!canRewrite && <Alert type='warning' content={t('conversation.gitWorkbench.rewrite.requiresGit240')} />}
            <RewriteActions
              scope={scope}
              repoId={repoId}
              hashes={page.commits.filter((commit) => checked.has(commit.hash)).map((commit) => commit.hash)}
              disabled={operationBusy || !canRewrite}
              onBusyChange={onBusyChange}
              onCompleted={onCompleted}
            />
          </>
        )}
        {filtered && (
          <p className='text-12px text-t-secondary px-12px'>{t('conversation.gitWorkbench.filteredGraph')}</p>
        )}
        <div className={styles.commitRows}>
          {page.commits.map((commit, index) => (
            <div key={commit.hash} className={styles.commitRow}>
              <Checkbox
                disabled={operationBusy}
                checked={checked.has(commit.hash)}
                aria-label={t('conversation.gitWorkbench.rewrite.select', { hash: commit.hash.slice(0, 8) })}
                onChange={(value) =>
                  setChecked((previous) => {
                    const next = new Set(previous);
                    if (value) next.add(commit.hash);
                    else next.delete(commit.hash);
                    return next;
                  })
                }
              />
              <GraphCell row={graph[index]} width={width} />
              <Button
                disabled={operationBusy}
                type={selected === commit.hash ? 'primary' : 'text'}
                className={styles.commitButton}
                onClick={() => setSelected(commit.hash)}
                title={`${commit.subject}\n${commit.hash}\n${commit.authorName} · ${new Date(commit.authorDate * 1000).toLocaleString()}`}
              >
                <span className={styles.subject}>{commit.subject}</span>
                {commit.refs.map((ref) => (
                  <Tag key={ref} size='small'>
                    {ref}
                  </Tag>
                ))}
                <span className={styles.author}>{commit.authorName}</span>
                <code>{commit.hash.slice(0, 8)}</code>
              </Button>
            </div>
          ))}
          {!loading && !error && page.commits.length === 0 && (
            <Empty description={t('conversation.gitWorkbench.empty')} />
          )}
          {loading && <Loading />}
          {error && (
            <RequestError
              message={error}
              retry={() => {
                void load();
              }}
            />
          )}
          {page.hasMore && !error && (
            <Button
              long
              loading={loading}
              disabled={loading || operationBusy}
              onClick={() => {
                void load();
              }}
            >
              {t('conversation.gitWorkbench.loadMore')}
            </Button>
          )}
        </div>
      </section>
      <section className={styles.details} aria-label={t('conversation.gitWorkbench.details')}>
        {selected ? (
          <React.Fragment key={selected}>
            {repoId && onBusyChange && onCompleted && (
              <HistoryActions
                scope={scope}
                repoId={repoId}
                hash={selected}
                disabled={operationBusy}
                onBusyChange={onBusyChange}
                onCompleted={onCompleted}
              />
            )}
            <CommitDetails scope={scope} hash={selected} />
          </React.Fragment>
        ) : (
          <Empty description={t('conversation.gitWorkbench.selectCommit')} />
        )}
      </section>
    </div>
  );
}
