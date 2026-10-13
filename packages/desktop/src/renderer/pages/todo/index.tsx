/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Empty, Input, Message, Modal, Popconfirm, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Delete, Edit } from '@icon-park/react';
import classNames from 'classnames';
import dayjs from 'dayjs';
import { ipcBridge } from '@/common';
import type { ITodoItem, TodoStatusInfo } from '@/common/types/todo/todoTypes';
import SettingsPageHeader from '@renderer/pages/settings/components/SettingsPageHeader';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';

/**
 * 待办事项页:左侧月历(截止日期打点、点日筛选)+ 右侧分组列表,
 * 手动建待办 + 「扫描邮件」一键触发快照→agent 提取流水线。
 *
 * Todo page: month calendar (deadline dots, click-to-filter) on the left,
 * grouped list on the right; manual creation plus a one-click email scan that
 * runs the snapshot → agent extraction pipeline.
 */

const startOfDayMs = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : dayjs(value).startOf('day').valueOf();

const isSameDay = (a: number | null | undefined, b: number | undefined): boolean =>
  startOfDayMs(a) === dayjs(b).startOf('day').valueOf();

interface TodoEditorState {
  open: boolean;
  item: ITodoItem | null;
}

const TodoPage: React.FC = () => {
  const { t } = useTranslation();
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const isDesktop =
    typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);

  const [todos, setTodos] = useState<ITodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<TodoStatusInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [monthCursor, setMonthCursor] = useState(() => dayjs().startOf('month'));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [editor, setEditor] = useState<TodoEditorState>({ open: false, item: null });

  const refresh = useCallback(async () => {
    try {
      const [list, statusInfo] = await Promise.all([
        ipcBridge.todo.list.invoke(),
        ipcBridge.todo.status.invoke().catch((): TodoStatusInfo | null => null),
      ]);
      setTodos(list || []);
      setStatus(statusInfo);
    } catch (error) {
      console.error('[TodoPage] failed to load todos:', error);
      setTodos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [isDesktop, refresh]);

  const handleToggle = useCallback(async (item: ITodoItem, done: boolean) => {
    // 乐观更新:勾选是高频操作,不等 IPC 回包。
    // Optimistic update — checkbox toggling is high-frequency.
    setTodos((prev) =>
      prev.map((todo) => (todo.id === item.id ? { ...todo, status: done ? 'done' : 'pending' } : todo))
    );
    try {
      await ipcBridge.todo.setDone.invoke({ id: item.id, done });
    } catch (error) {
      Message.error(t('todo.opFailed'));
      void refresh();
    }
  }, [refresh, t]);

  const handleRemove = useCallback(
    async (item: ITodoItem) => {
      try {
        await ipcBridge.todo.remove.invoke({ id: item.id });
        setTodos((prev) => prev.filter((todo) => todo.id !== item.id));
      } catch (error) {
        Message.error(t('todo.opFailed'));
      }
    },
    [t]
  );

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await ipcBridge.todo.scanNow.invoke();
      if (result?.ok) {
        Message.success(t('todo.scan.started', { count: result.emails_fetched ?? 0 }));
      } else {
        Message.warning(result?.message || t('todo.scan.failed'));
      }
    } catch (error) {
      Message.error(t('todo.scan.failed'));
    } finally {
      setScanning(false);
      void refresh();
    }
  }, [refresh, t]);

  const handleEditorSave = useCallback(
    async (title: string, notes: string, dueDate: string) => {
      const due_at = dueDate ? dayjs(dueDate).valueOf() : null;
      try {
        if (editor.item) {
          await ipcBridge.todo.update.invoke({ id: editor.item.id, title, notes, due_at });
        } else {
          await ipcBridge.todo.create.invoke({ title, notes, due_at });
        }
        setEditor({ open: false, item: null });
        await refresh();
      } catch (error) {
        Message.error(t('todo.opFailed'));
      }
    },
    [editor.item, refresh, t]
  );

  const pending = useMemo(() => todos.filter((todo) => todo.status === 'pending'), [todos]);
  const done = useMemo(() => todos.filter((todo) => todo.status === 'done'), [todos]);

  /** 月历网格:6 周 × 7 天,从本月第一天所在周的周日开始。 */
  const calendarCells = useMemo(() => {
    const gridStart = monthCursor.startOf('week');
    return Array.from({ length: 42 }, (_, index) => gridStart.add(index, 'day'));
  }, [monthCursor]);

  const dayPendingCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const todo of pending) {
      const key = startOfDayMs(todo.due_at);
      if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [pending]);

  const grouped = useMemo(() => {
    if (selectedDay !== null) {
      return [
        {
          key: 'day',
          label: dayjs(selectedDay).format(isMobile ? 'M/D' : 'YYYY-MM-DD dddd'),
          items: todos.filter((todo) => isSameDay(todo.due_at, selectedDay)),
        },
      ];
    }
    const todayMs = dayjs().startOf('day').valueOf();
    const weekEndMs = dayjs().add(7, 'day').endOf('day').valueOf();
    const overdue: ITodoItem[] = [];
    const today: ITodoItem[] = [];
    const upcoming: ITodoItem[] = [];
    const later: ITodoItem[] = [];
    for (const todo of pending) {
      const due = todo.due_at;
      if (due === null || due === undefined) {
        later.push(todo);
      } else if (due < todayMs) {
        overdue.push(todo);
      } else if (isSameDay(due, todayMs)) {
        today.push(todo);
      } else if (due <= weekEndMs) {
        upcoming.push(todo);
      } else {
        later.push(todo);
      }
    }
    const byDue = (a: ITodoItem, b: ITodoItem) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity);
    return [
      { key: 'overdue', label: t('todo.group.overdue'), items: overdue.toSorted(byDue) },
      { key: 'today', label: t('todo.group.today'), items: today.toSorted(byDue) },
      { key: 'upcoming', label: t('todo.group.upcoming'), items: upcoming.toSorted(byDue) },
      { key: 'later', label: t('todo.group.later'), items: later.toSorted(byDue) },
      { key: 'done', label: t('todo.group.done'), items: done.toSorted((a, b) => (b.completed_at || 0) - (a.completed_at || 0)).slice(0, 20) },
    ].filter((group) => group.items.length > 0);
  }, [todos, pending, done, selectedDay, t, isMobile]);

  const dueChip = (item: ITodoItem) => {
    if (item.due_at === null || item.due_at === undefined) return null;
    const overdue = item.status === 'pending' && item.due_at < dayjs().startOf('day').valueOf();
    return (
      <Tag size='small' color={overdue ? 'red' : 'arcoblue'} className='shrink-0'>
        {dayjs(item.due_at).format(isMobile ? 'M/D' : 'MM-DD')}
      </Tag>
    );
  };

  const sourceTag = (item: ITodoItem) => {
    if (item.source === 'email') {
      return (
        <Tooltip content={item.email_ref?.subject || ''}>
          <Tag size='small' className='shrink-0 cursor-default'>
            {t('todo.source.email')}
          </Tag>
        </Tooltip>
      );
    }
    if (item.source === 'agent') {
      return (
        <Tag size='small' className='shrink-0'>
          {t('todo.source.agent')}
        </Tag>
      );
    }
    return null;
  };

  const lastScanText = status?.last_scan_at ? dayjs(status.last_scan_at).format('YYYY-MM-DD HH:mm') : null;

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden'>
      <div className={classNames('shrink-0 bg-1', isMobile ? 'px-16px pt-14px' : 'md:px-40px md:pt-32px')}>
        <div className='mx-auto w-full max-w-1000px'>
          <SettingsPageHeader
            title={t('todo.title')}
            description={
              lastScanText
                ? t('todo.lastScan', { time: lastScanText, status: status?.last_scan_status || '' })
                : t('todo.description')
            }
            actions={
              isDesktop ? (
                <div className='flex items-center gap-8px'>
                  <Button size='small' loading={scanning} onClick={() => void handleScan()}>
                    {t('todo.scan.button')}
                  </Button>
                  <Button size='small' type='primary' onClick={() => setEditor({ open: true, item: null })}>
                    {t('todo.new')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain'>
        <div className={classNames('mx-auto w-full max-w-1000px box-border', isMobile ? 'px-16px py-14px' : 'px-40px py-24px')}>
          {!isDesktop ? (
            <Empty description={t('todo.desktopOnly')} />
          ) : loading ? (
            <div className='flex-center py-80px'>
              <Spin size={24} />
            </div>
          ) : todos.length === 0 ? (
            <Empty description={t('todo.empty')} />
          ) : (
            <div className={classNames('flex gap-24px items-start', isMobile && 'flex-col')}>
              {/* 月历 / Month calendar */}
              <div className={classNames('shrink-0 rd-8px', isMobile ? 'w-full' : 'w-296px')}>
                <div className='flex items-center justify-between mb-8px'>
                  <Button
                    size='mini'
                    onClick={() => setMonthCursor((prev) => prev.subtract(1, 'month'))}
                    aria-label='previous month'
                  >
                    ‹
                  </Button>
                  <span className='text-14px font-[500] text-t-primary'>{monthCursor.format('YYYY-MM')}</span>
                  <Button size='mini' onClick={() => setMonthCursor((prev) => prev.add(1, 'month'))} aria-label='next month'>
                    ›
                  </Button>
                </div>
                <div className='grid grid-cols-7 gap-2px text-center'>
                  {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                    <div key={weekday} className='h-22px text-11px text-t-tertiary flex-center'>
                      {dayjs().day(weekday).format('dd')}
                    </div>
                  ))}
                  {calendarCells.map((cell) => {
                    const dayMs = cell.startOf('day').valueOf();
                    const inMonth = cell.month() === monthCursor.month();
                    const isToday = dayMs === dayjs().startOf('day').valueOf();
                    const isSelected = selectedDay === dayMs;
                    const pendingCount = dayPendingCounts.get(dayMs) || 0;
                    return (
                      <button
                        type='button'
                        key={dayMs}
                        className={classNames(
                          'relative h-38px rd-6px text-13px cursor-pointer transition-colors border-none',
                          inMonth ? 'text-t-primary' : 'text-t-tertiary op-40',
                          isSelected ? 'bg-primary-6 text-white' : 'hover:bg-fill-2'
                        )}
                        onClick={() => setSelectedDay((prev) => (prev === dayMs ? null : dayMs))}
                      >
                        <span className={classNames(isToday && !isSelected && 'font-bold text-primary-6')}>{cell.date()}</span>
                        {pendingCount > 0 && (
                          <span
                            className={classNames(
                              'absolute left-1/2 bottom-3px -translate-x-1/2 h-4px w-4px rd-full',
                              isSelected ? 'bg-white' : 'bg-primary-6'
                            )}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
                {selectedDay !== null && (
                  <div className='mt-8px flex justify-end'>
                    <Button size='mini' type='text' onClick={() => setSelectedDay(null)}>
                      {t('todo.clearDayFilter')}
                    </Button>
                  </div>
                )}
              </div>

              {/* 分组列表 / Grouped list */}
              <div className='flex-1 min-w-0 flex flex-col gap-18px'>
                {grouped.map((group) => (
                  <section key={group.key}>
                    <div className='flex items-center gap-8px mb-6px'>
                      <span
                        className={classNames(
                          'text-13px font-[500]',
                          group.key === 'overdue' ? 'text-danger-6' : 'text-t-secondary'
                        )}
                      >
                        {group.label}
                      </span>
                      <span className='text-12px text-t-tertiary'>{group.items.length}</span>
                    </div>
                    <div className='flex flex-col gap-4px'>
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          className={classNames(
                            'group/item flex items-start gap-10px px-10px py-8px rd-8px transition-colors',
                            item.status === 'done' ? 'op-60' : 'hover:bg-fill-2'
                          )}
                        >
                          <Checkbox
                            checked={item.status === 'done'}
                            onChange={(checked) => void handleToggle(item, checked)}
                            className='mt-2px shrink-0'
                          />
                          <div className='flex-1 min-w-0 cursor-pointer' onClick={() => setEditor({ open: true, item })}>
                            <div className={classNames('text-14px break-all', item.status === 'done' && 'line-through text-t-tertiary')}>
                              {item.title}
                            </div>
                            {item.notes && <div className='text-12px text-t-tertiary mt-2px line-clamp-2 break-all'>{item.notes}</div>}
                          </div>
                          <div className='flex items-center gap-6px shrink-0 mt-2px'>
                            {sourceTag(item)}
                            {dueChip(item)}
                            <Tooltip content={t('todo.edit')}>
                              <Button
                                size='mini'
                                type='text'
                                className='op-0 group-hover/item:op-100'
                                icon={<Edit theme='outline' size='14' />}
                                onClick={() => setEditor({ open: true, item })}
                              />
                            </Tooltip>
                            <Popconfirm title={t('todo.confirmDelete')} onOk={() => void handleRemove(item)}>
                              <Button
                                size='mini'
                                type='text'
                                status='danger'
                                className='op-0 group-hover/item:op-100'
                                icon={<Delete theme='outline' size='14' />}
                              />
                            </Popconfirm>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <TodoEditor
        open={editor.open}
        item={editor.item}
        onCancel={() => setEditor({ open: false, item: null })}
        onSave={(title, notes, dueDate) => void handleEditorSave(title, notes, dueDate)}
      />
    </div>
  );
};

const TodoEditor: React.FC<{
  open: boolean;
  item: ITodoItem | null;
  onCancel: () => void;
  onSave: (title: string, notes: string, dueDate: string) => void;
}> = ({ open, item, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(item?.title || '');
      setNotes(item?.notes || '');
      setDueDate(item?.due_at ? dayjs(item.due_at).format('YYYY-MM-DD') : '');
    }
  }, [open, item]);

  const handleOk = async () => {
    if (!title.trim()) {
      Message.warning(t('todo.titleRequired'));
      return;
    }
    setSaving(true);
    try {
      onSave(title.trim(), notes.trim(), dueDate);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={item ? t('todo.edit') : t('todo.new')}
      visible={open}
      onCancel={onCancel}
      onOk={() => void handleOk()}
      okText={t('todo.save')}
      cancelText={t('todo.cancel')}
      confirmLoading={saving}
      unmountOnExit
    >
      <div className='flex flex-col gap-12px py-4px'>
        <Input
          value={title}
          onChange={setTitle}
          placeholder={t('todo.titlePlaceholder')}
          maxLength={200}
          onPressEnter={() => void handleOk()}
        />
        <Input.TextArea value={notes} onChange={setNotes} placeholder={t('todo.notesPlaceholder')} maxLength={2000} autoSize={{ minRows: 3, maxRows: 8 }} />
        <div className='flex items-center gap-8px'>
          <span className='text-13px text-t-secondary shrink-0'>{t('todo.due')}</span>
          {/* 透传原生 date 输入,避免引入未被上游验证过的日期组件 */}
          {/* Native date input passthrough — avoids the unvetted date picker */}
          <Input type='date' value={dueDate} onChange={setDueDate} className='w-180px' />
          {dueDate && (
            <Button size='mini' type='text' onClick={() => setDueDate('')}>
              {t('todo.clearDue')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default TodoPage;
