/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { ITodoItem, TodoSkippedEmail } from '@/common/types/todo/todoTypes';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import SkippedEmails from './components/SkippedEmails';
import TodoDetail, { TodoDetailPlaceholder } from './components/TodoDetail';
import TodoEditor from './components/TodoEditor';
import TodoList from './components/TodoList';
import TodoSidebar from './components/TodoSidebar';
import {
  buildSections,
  dayMarks,
  filterTodos,
  requesterCounts,
  startOfDay,
  subjectAsTitle,
  viewCounts,
  type TodoGroup,
  type TodoView,
} from './todoModel';
import { useTodos, type TodoDraft } from './useTodos';

// Page widths (px) at which the side columns fit beside a readable list.
const SIDEBAR_MIN_WIDTH = 900;
const DETAIL_COLUMN_MIN_WIDTH = 1240;

/**
 * Todo workspace: views, calendar and requesters on the left, grouped list in the middle,
 * details with steps and the source email on the right.
 */
const TodoPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const isDesktop = typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);
  const data = useTodos(isDesktop);
  const { todos } = data;

  const [view, setView] = useState<TodoView>('all');
  const [day, setDay] = useState<number | null>(null);
  const [requester, setRequester] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `restore`: the editor turns a skipped email into a todo.
  const [editor, setEditor] = useState<{ open: boolean; item: ITodoItem | null; restore?: TodoSkippedEmail }>({
    open: false,
    item: null,
  });
  const [skippedOpen, setSkippedOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    setWidth(element.offsetWidth);
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, [isDesktop]);
  const compact = isMobile || width < SIDEBAR_MIN_WIDTH;
  const detailColumn = !isMobile && width >= DETAIL_COLUMN_MIN_WIDTH;

  const now = Date.now();
  const counts = useMemo(() => viewCounts(todos), [todos]);
  const marks = useMemo(() => dayMarks(todos), [todos]);
  const requesters = useMemo(() => requesterCounts(todos), [todos]);
  const sections = useMemo(
    () => buildSections(filterTodos(todos, { view, day, requester, query })),
    [todos, view, day, requester, query]
  );
  const selected = todos.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !todos.some((item) => item.id === selectedId) && !data.loading) setSelectedId(null);
  }, [todos, selectedId, data.loading]);

  const formatDay = (value: number) =>
    new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(value));

  const groupTitle = (group: TodoGroup) =>
    group === 'today' ? t('todo.group.todayFull', { date: formatDay(now) }) : t(`todo.group.${group}`);

  // New todos follow what is on screen: the picked day, or the waiting / focus view.
  const createDefaults = useMemo<Partial<TodoDraft>>(
    () => ({
      due_at: day ?? (view === 'focus' ? startOfDay(Date.now()) : null),
      status: view === 'waiting' ? 'waiting' : 'pending',
    }),
    [day, view]
  );

  const restoreDefaults = useMemo<Partial<TodoDraft> | undefined>(
    () =>
      editor.restore && {
        title: subjectAsTitle(editor.restore.subject),
        requester: editor.restore.from,
        due_at: null,
        status: 'pending',
      },
    [editor.restore]
  );

  const saveDraft = useCallback(
    async (draft: TodoDraft, existing: ITodoItem | null) => {
      const result = await data.save(existing?.status === 'done' ? { ...draft, status: undefined } : draft, existing);
      if (result.ok && result.item) setSelectedId(result.item.id);
      return result.ok;
    },
    [data]
  );

  if (!isDesktop) {
    return (
      <div className='w-full h-full flex-center'>
        <Empty description={t('todo.desktopOnly')} />
      </div>
    );
  }

  const openCreate = () => setEditor({ open: true, item: null });
  const viewTitle = day !== null ? formatDay(day) : t(`todo.tab.${view}`);

  const detail = selected && (
    <TodoDetail
      item={selected}
      onClose={detailColumn ? undefined : () => setSelectedId(null)}
      onStatusChange={(status) => void data.setStatus(selected, status)}
      onUnblock={() => void data.unblock(selected)}
      onSubtasksChange={(subtasks) => void data.setSubtasks(selected, subtasks)}
      onEdit={() => setEditor({ open: true, item: selected })}
      onRemove={() => void data.remove(selected)}
      onNotMine={() => void data.dismiss(selected)}
    />
  );

  return (
    <div
      ref={rootRef}
      className='relative w-full h-full min-h-0 box-border flex overflow-hidden bg-base text-t-primary'
    >
      {!compact && (
        <TodoSidebar
          view={view}
          counts={counts}
          onViewChange={setView}
          marks={marks}
          selectedDay={day}
          onSelectDay={setDay}
          requesters={requesters}
          selectedRequester={requester}
          onSelectRequester={setRequester}
          onCreate={openCreate}
        />
      )}
      <TodoList
        title={viewTitle}
        view={view}
        onViewChange={(next) => {
          setDay(null);
          setView(next);
        }}
        compact={compact}
        query={query}
        onQueryChange={setQuery}
        dayLabel={day !== null ? formatDay(day) : null}
        onClearDay={() => setDay(null)}
        requester={requester}
        onClearRequester={() => setRequester(null)}
        scanInfo={data.scanInfo}
        scanning={data.scanning}
        onScan={() => void data.scan()}
        skippedCount={data.skipped.length}
        onOpenSkipped={() => setSkippedOpen(true)}
        onCreate={openCreate}
        onQuickAdd={
          view === 'done' && day === null
            ? null
            : (title) =>
                saveDraft(
                  {
                    title,
                    notes: '',
                    requester: requester ?? '',
                    due_at: createDefaults.due_at ?? null,
                    status: createDefaults.status,
                  },
                  null
                )
        }
        loading={data.loading}
        hasTodos={todos.length > 0}
        sections={sections}
        groupTitle={groupTitle}
        selectedId={selectedId}
        actions={{
          onSelect: (item) => setSelectedId(item.id),
          onToggle: (item, done) => void data.setDone(item, done),
          onUnblock: (item) => void data.unblock(item),
          onEdit: (item) => setEditor({ open: true, item }),
          onRemove: (item) => void data.remove(item),
        }}
      />
      {detailColumn ? (
        <aside
          className={
            selected
              ? 'w-380px shrink-0 min-h-0 border-l border-[var(--border-base)]'
              : 'w-320px shrink-0 min-h-0 border-l border-[var(--border-base)]'
          }
        >
          {detail || <TodoDetailPlaceholder />}
        </aside>
      ) : (
        detail && (
          <div
            className={
              isMobile
                ? 'absolute inset-0 z-20'
                : 'absolute right-0 top-0 bottom-0 z-20 w-380px max-w-full border-l border-[var(--border-base)] shadow-lg'
            }
          >
            {detail}
          </div>
        )
      )}
      <SkippedEmails
        open={skippedOpen}
        emails={data.skipped}
        onClose={() => setSkippedOpen(false)}
        onRestore={(email) => {
          setSkippedOpen(false);
          setEditor({ open: true, item: null, restore: email });
        }}
      />
      <TodoEditor
        open={editor.open}
        item={editor.item}
        defaults={restoreDefaults ?? createDefaults}
        heading={editor.restore ? t('todo.skipped.restore') : undefined}
        onCancel={() => {
          // Back to the list the email came from.
          if (editor.restore) setSkippedOpen(true);
          setEditor({ open: false, item: null });
        }}
        onSave={async (draft) => {
          if (editor.restore) {
            const result = await data.restore(editor.restore, draft);
            if (result.ok) {
              if (result.item) setSelectedId(result.item.id);
              setEditor({ open: false, item: null });
            }
            return result.ok;
          }
          const ok = await saveDraft(draft, editor.item);
          if (ok) setEditor({ open: false, item: null });
          return ok;
        }}
      />
    </div>
  );
};

export default TodoPage;
