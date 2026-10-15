/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Empty,
  Input,
  Message,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Tooltip,
} from '@arco-design/web-react';
import { Calendar, Delete, Edit, Mail, Plus, Search } from '@icon-park/react';
import classNames from 'classnames';
import dayjs from 'dayjs';
import { ipcBridge } from '@/common';
import type { ITodoItem, ITodoSubtask, TodoStatusInfo } from '@/common/types/todo/todoTypes';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';

/**
 * 待办工作台(三栏):
 *   左 — 今日/逾期、等待确认统计卡 + 紧凑月历(三色打点、点日筛选)+ 要求人筛选
 *   中 — 状态标签页 + 筛选条(日期/要求人/关键词)+ 分组任务卡片流
 *   右 — 详情抽屉:状态切换、等待解除、步骤清单勾选、要求人、来源邮件
 * 布局参考用户提供的「智能邮件待办工作台」原型,配色换成应用主题令牌。
 */

type TabKey = 'all' | 'focus' | 'waiting' | 'upcoming' | 'done';
type GroupKey = 'overdue' | 'today' | 'waiting' | 'upcoming' | 'done';

const startOfDayMs = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : dayjs(value).startOf('day').valueOf();

const isSameDay = (a: number | null | undefined, b: number): boolean =>
  startOfDayMs(a) === dayjs(b).startOf('day').valueOf();

/** 语义分组:done > waiting > 按截止日(逾期/今天/其余含无截止)。 */
const groupOf = (item: ITodoItem): GroupKey => {
  if (item.status === 'done') return 'done';
  if (item.status === 'waiting') return 'waiting';
  const today = dayjs().startOf('day').valueOf();
  if (item.due_at === null || item.due_at === undefined) return 'upcoming';
  if (item.due_at < today) return 'overdue';
  if (isSameDay(item.due_at, today)) return 'today';
  return 'upcoming';
};

/** 卡片摘要行:优先取 notes 里「要做什么」行,退回首行/邮件主题。 */
const summaryOf = (item: ITodoItem): string => {
  if (item.notes) {
    const match = item.notes.match(/^要做什么[:：]\s*(.+)$/m);
    if (match?.[1]) return match[1].trim();
    const firstLine = item.notes
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !/^(要求人|截止|关键点|原文关键句)[:：]/.test(line));
    if (firstLine) return firstLine;
  }
  return item.email_ref?.subject || '';
};

const requesterOf = (item: ITodoItem): string | null => {
  const name = item.requester || item.email_ref?.from || '';
  return name.trim() || null;
};

const TodoPage: React.FC = () => {
  const { t } = useTranslation();
  const isMobile = useLayoutContext()?.isMobile ?? false;
  const isDesktop = typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);

  const [todos, setTodos] = useState<ITodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<TodoStatusInfo | null>(null);
  const [scanning, setScanning] = useState(false);

  // 视图状态:标签页 + 日历选中日 + 要求人 + 关键词 + 选中任务(右抽屉)
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [monthCursor, setMonthCursor] = useState(() => dayjs().startOf('month'));
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ open: boolean; item: ITodoItem | null }>({ open: false, item: null });

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

  const handleToggle = useCallback(
    async (item: ITodoItem, done: boolean) => {
      // 乐观更新:勾选是高频操作,不等 IPC 回包。
      setTodos((prev) =>
        prev.map((todo) =>
          todo.id === item.id
            ? { ...todo, status: done ? 'done' : 'pending', completed_at: done ? Date.now() : null }
            : todo
        )
      );
      try {
        await ipcBridge.todo.setDone.invoke({ id: item.id, done });
      } catch (error) {
        Message.error(t('todo.opFailed'));
        void refresh();
      }
    },
    [refresh, t]
  );

  /** 等待确认 → 激活:转 pending,过期/无截止的顺带锚定到今天。 */
  const handleUnblock = useCallback(
    async (item: ITodoItem) => {
      const today = dayjs().startOf('day').valueOf();
      const due_at = item.due_at && item.due_at >= today ? item.due_at : today;
      setTodos((prev) =>
        prev.map((todo) =>
          todo.id === item.id ? { ...todo, status: 'pending', due_at, blocked_reason: undefined } : todo
        )
      );
      try {
        await ipcBridge.todo.update.invoke({ id: item.id, status: 'pending', due_at, blocked_reason: '' });
      } catch (error) {
        Message.error(t('todo.opFailed'));
        void refresh();
      }
    },
    [refresh, t]
  );

  const handleStatusChange = useCallback(
    async (item: ITodoItem, next: 'pending' | 'waiting' | 'done') => {
      if (next === 'done' || next === 'pending' || next === 'waiting') {
        if (next === 'done') {
          await handleToggle(item, true);
          return;
        }
        setTodos((prev) => prev.map((todo) => (todo.id === item.id ? { ...todo, status: next } : todo)));
        try {
          await ipcBridge.todo.update.invoke({ id: item.id, status: next });
        } catch (error) {
          Message.error(t('todo.opFailed'));
          void refresh();
        }
      }
    },
    [handleToggle, refresh, t]
  );

  /** 子任务勾选:整包替换(subtasks 契约为全量写)。 */
  const handleSubtaskToggle = useCallback(
    async (item: ITodoItem, subtaskId: string, done: boolean) => {
      const subtasks: ITodoSubtask[] = (item.subtasks || []).map((sub) =>
        sub.id === subtaskId ? { ...sub, done } : sub
      );
      setTodos((prev) => prev.map((todo) => (todo.id === item.id ? { ...todo, subtasks } : todo)));
      try {
        await ipcBridge.todo.update.invoke({ id: item.id, subtasks });
      } catch (error) {
        Message.error(t('todo.opFailed'));
        void refresh();
      }
    },
    [refresh, t]
  );

  const handleRemove = useCallback(
    async (item: ITodoItem) => {
      try {
        await ipcBridge.todo.remove.invoke({ id: item.id });
        setTodos((prev) => prev.filter((todo) => todo.id !== item.id));
        if (selectedId === item.id) setSelectedId(null);
      } catch (error) {
        Message.error(t('todo.opFailed'));
      }
    },
    [selectedId, t]
  );

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await ipcBridge.todo.scanNow.invoke();
      if (result?.ok) {
        Message.success(t('todo.scan.started', { count: result.emails_fetched ?? 0 }));
      } else if (result?.message === 'no_scan_job') {
        Message.warning(t('todo.scan.noJob', { count: result.emails_fetched ?? 0 }));
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
    async (payload: {
      title: string;
      notes: string;
      dueDate: string;
      requester: string;
      statusGroup: 'pending' | 'waiting';
    }) => {
      const due_at = payload.dueDate ? dayjs(payload.dueDate).valueOf() : null;
      try {
        if (editor.item) {
          await ipcBridge.todo.update.invoke({
            id: editor.item.id,
            title: payload.title,
            notes: payload.notes,
            due_at,
            requester: payload.requester,
            status: payload.statusGroup,
          });
        } else {
          await ipcBridge.todo.create.invoke({
            title: payload.title,
            notes: payload.notes,
            due_at,
            requester: payload.requester,
            status: payload.statusGroup,
          });
        }
        setEditor({ open: false, item: null });
        await refresh();
      } catch (error) {
        Message.error(t('todo.opFailed'));
      }
    },
    [editor.item, refresh, t]
  );

  // ----- 派生数据 -----

  const byGroup = useMemo(() => {
    const map = new Map<GroupKey, ITodoItem[]>();
    (['overdue', 'today', 'waiting', 'upcoming', 'done'] as GroupKey[]).forEach((key) => map.set(key, []));
    for (const todo of todos) map.get(groupOf(todo))?.push(todo);
    const byDue = (a: ITodoItem, b: ITodoItem) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity);
    map.forEach((items) => items.sort((a, b) => ((a.status === 'done') === (b.status === 'done') ? byDue(a, b) : 0)));
    const done = map.get('done') || [];
    done.sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
    return map;
  }, [todos]);

  const openCount = todos.length - (byGroup.get('done')?.length || 0);
  const focusCount = (byGroup.get('overdue')?.length || 0) + (byGroup.get('today')?.length || 0);
  const waitingCount = byGroup.get('waiting')?.length || 0;
  const upcomingCount = byGroup.get('upcoming')?.length || 0;
  const doneCount = byGroup.get('done')?.length || 0;

  /** 要求人聚合(未完成项)。 */
  const senders = useMemo(() => {
    const map = new Map<string, number>();
    for (const todo of todos) {
      if (todo.status === 'done') continue;
      const name = requesterOf(todo);
      if (name) map.set(name, (map.get(name) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [todos]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return todos.filter((item) => {
      if (activeTab === 'focus' && groupOf(item) !== 'overdue' && groupOf(item) !== 'today') return false;
      if (activeTab === 'waiting' && groupOf(item) !== 'waiting') return false;
      if (activeTab === 'upcoming' && groupOf(item) !== 'upcoming') return false;
      if (activeTab === 'done' && groupOf(item) !== 'done') return false;
      if (selectedDay !== null && !isSameDay(item.due_at, selectedDay)) return false;
      if (selectedSender && requesterOf(item) !== selectedSender) return false;
      if (query) {
        const haystack = [item.title, item.notes, requesterOf(item), item.email_ref?.subject, item.email_ref?.from]
          .filter(Boolean)
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [todos, activeTab, selectedDay, selectedSender, searchQuery]);

  const groupedSections = useMemo(() => {
    return (['overdue', 'today', 'waiting', 'upcoming', 'done'] as GroupKey[])
      .map((key) => ({ key, items: filtered.filter((item) => groupOf(item) === key) }))
      .filter((section) => section.items.length > 0);
  }, [filtered]);

  const visibleSections = useMemo(() => {
    // 「全部」视图下收起已完成,除非有日期/搜索筛选(原型行为)。
    if (activeTab === 'all' && selectedDay === null && !searchQuery.trim() && selectedSender === null) {
      return groupedSections.filter((section) => section.key !== 'done');
    }
    return groupedSections;
  }, [groupedSections, activeTab, selectedDay, searchQuery, selectedSender]);

  const selected = useMemo(() => todos.find((todo) => todo.id === selectedId) ?? null, [todos, selectedId]);

  const hasAnyFilter = selectedDay !== null || selectedSender !== null || searchQuery.trim() !== '';

  const resetAllFilters = useCallback(() => {
    setSelectedDay(null);
    setSelectedSender(null);
    setSearchQuery('');
  }, []);

  /** 月历网格:6 周 × 7 天。 */
  const calendarCells = useMemo(() => {
    const gridStart = monthCursor.startOf('week');
    return Array.from({ length: 42 }, (_, index) => gridStart.add(index, 'day'));
  }, [monthCursor]);

  const dayGroups = useMemo(() => {
    const map = new Map<number, Set<GroupKey>>();
    for (const todo of todos) {
      if (todo.status === 'done') continue;
      const key = startOfDayMs(todo.due_at);
      if (key === null) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(todo.status === 'waiting' ? 'waiting' : groupOf(todo));
    }
    return map;
  }, [todos]);

  const lastScanText = status?.last_scan_at ? dayjs(status.last_scan_at).format('YYYY-MM-DD HH:mm') : null;

  if (!isDesktop) {
    return (
      <div className='w-full h-full flex-center'>
        <Empty description={t('todo.desktopOnly')} />
      </div>
    );
  }

  // ----- 渲染 -----

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'all', label: t('todo.tab.all'), count: openCount },
    { key: 'focus', label: t('todo.tab.focus'), count: focusCount },
    { key: 'waiting', label: t('todo.tab.waiting'), count: waitingCount },
    { key: 'upcoming', label: t('todo.tab.upcoming'), count: upcomingCount },
    { key: 'done', label: t('todo.tab.done'), count: doneCount },
  ];

  const groupTitle = (key: GroupKey): string =>
    key === 'today' ? t('todo.group.todayFull', { date: dayjs().format('M月D日 ddd') }) : t(`todo.group.${key}`);

  const groupDotClass: Record<GroupKey, string> = {
    overdue: 'bg-danger-6',
    today: 'bg-warning-5',
    waiting: 'bg-warning-6',
    upcoming: 'bg-primary-6',
    done: 'bg-success-6',
  };

  const dueBadge = (item: ITodoItem) => {
    if (item.due_at === null || item.due_at === undefined) {
      return (
        <span className='px-6px py-1px rd-4px text-11px text-t-tertiary bg-fill-2 shrink-0'>{t('todo.dueNone')}</span>
      );
    }
    const group = groupOf(item);
    const color =
      group === 'overdue' ? 'red' : group === 'today' ? 'orange' : group === 'waiting' ? 'gold' : 'arcoblue';
    return (
      <Tag size='small' color={color} className='shrink-0 cursor-default'>
        {dayjs(item.due_at).format(isMobile ? 'M/D' : 'MM-DD')}
      </Tag>
    );
  };

  const cardSubtaskPill = (item: ITodoItem) => {
    const total = item.subtasks?.length || 0;
    if (!total) return null;
    const finished = item.subtasks!.filter((sub) => sub.done).length;
    return (
      <span
        className='inline-flex items-center gap-4px text-11px text-t-tertiary shrink-0'
        title={t('todo.drawer.subtaskProgress')}
      >
        <span className='tabular-nums'>
          {finished}/{total}
        </span>
      </span>
    );
  };

  const renderCard = (item: ITodoItem) => {
    const isDone = item.status === 'done';
    const isWaiting = item.status === 'waiting';
    const isSelected = selectedId === item.id;
    const requester = requesterOf(item);
    return (
      <div
        key={item.id}
        className={classNames(
          'group/item bg-1 rd-10px border border-solid cursor-pointer transition-all px-12px py-10px',
          isSelected ? 'border-primary-6 bg-primary-1' : 'border-border-2 hover:border-primary-5',
          isDone && 'op-60'
        )}
        onClick={() => setSelectedId(item.id)}
      >
        <div className='flex items-start gap-10px'>
          <Tooltip content={isDone ? t('todo.markUndone') : t('todo.markDone')}>
            <Checkbox
              checked={isDone}
              indeterminate={isWaiting}
              onChange={(checked) => void handleToggle(item, checked)}
              className='mt-1px shrink-0'
              onClick={(event) => event.stopPropagation()}
            />
          </Tooltip>

          <div className='flex-1 min-w-0'>
            {/* 行 1:标题 + 右侧元信息 */}
            <div className='flex items-center justify-between gap-8px'>
              <div className='flex items-center gap-8px min-w-0'>
                <span
                  className={classNames(
                    'text-13px font-[600] truncate',
                    isDone ? 'line-through text-t-tertiary' : 'text-t-primary'
                  )}
                >
                  {item.title}
                </span>
                {item.source === 'email' && (
                  <Tooltip content={item.email_ref?.subject || ''}>
                    <Mail theme='outline' size='12' className='shrink-0 text-t-tertiary' />
                  </Tooltip>
                )}
              </div>
              <div className='flex items-center gap-6px shrink-0'>
                {requester && (
                  <span className='inline-flex items-center px-6px py-1px rd-4px text-11px text-t-secondary bg-fill-2 max-w-140px truncate'>
                    {requester}
                  </span>
                )}
                {isWaiting && (
                  <span className='px-6px py-1px rd-4px text-11px text-warning-6 bg-warning-1 border border-solid border-warning-5 shrink-0'>
                    {t('todo.group.waiting')}
                  </span>
                )}
                {dueBadge(item)}
              </div>
            </div>

            {/* 行 2:摘要 + 微操作 */}
            <div className='mt-4px flex items-center justify-between gap-8px'>
              <p className='text-12px text-t-tertiary truncate'>{summaryOf(item)}</p>
              <div className='flex items-center gap-8px shrink-0'>
                {isWaiting && (
                  <Button
                    size='mini'
                    type='outline'
                    status='warning'
                    title={t('todo.unblockTip')}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUnblock(item);
                    }}
                  >
                    ⚡ {t('todo.unblock')}
                  </Button>
                )}
                {cardSubtaskPill(item)}
                <Tooltip content={t('todo.edit')}>
                  <Button
                    size='mini'
                    type='text'
                    className='op-0 group-hover/item:op-100'
                    icon={<Edit theme='outline' size='13' />}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditor({ open: true, item });
                    }}
                  />
                </Tooltip>
                <Popconfirm title={t('todo.confirmDelete')} onOk={() => void handleRemove(item)}>
                  <Button
                    size='mini'
                    type='text'
                    status='danger'
                    className='op-0 group-hover/item:op-100'
                    icon={<Delete theme='outline' size='13' />}
                    onClick={(event) => event.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden'>
      {/* 顶栏:标题 + 搜索 + 扫描 + 新建 */}
      <div
        className={classNames(
          'shrink-0 bg-1 border-b border-solid border-border-2 flex items-center justify-between gap-12px',
          isMobile ? 'px-16px py-8px' : 'px-24px py-8px'
        )}
      >
        <div className='flex items-baseline gap-8px min-w-0'>
          <span className='text-14px font-bold text-t-primary shrink-0'>{t('todo.title')}</span>
          {!isMobile && lastScanText && (
            <span className='text-11px text-t-tertiary truncate'>
              {t('todo.lastScanShort', { time: lastScanText, status: status?.last_scan_status || '' })}
            </span>
          )}
        </div>
        <div className='flex items-center gap-8px shrink-0'>
          <Input
            size='small'
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={t('todo.searchPlaceholder')}
            prefix={<Search theme='outline' size='13' className='text-t-tertiary' />}
            allowClear
            className='w-180px'
          />
          <Button size='small' loading={scanning} onClick={() => void handleScan()}>
            {t('todo.scan.button')}
          </Button>
          <Button
            size='small'
            type='primary'
            icon={<Plus theme='outline' size='13' />}
            onClick={() => setEditor({ open: true, item: null })}
          >
            {!isMobile && t('todo.new')}
          </Button>
        </div>
      </div>

      <div className='flex-1 flex min-h-0 overflow-hidden relative'>
        {/* 左栏:统计卡 + 月历 + 要求人筛选(移动端隐藏) */}
        {!isMobile && (
          <aside className='w-232px shrink-0 bg-1 border-r border-solid border-border-2 overflow-y-auto p-12px flex flex-col gap-14px'>
            <div className='grid grid-cols-2 gap-8px'>
              <Button
                type='text'
                className={classNames(
                  '!h-auto !p-10px !block text-left !rd-10px border border-solid',
                  activeTab === 'focus'
                    ? 'border-danger-6 bg-danger-1'
                    : 'border-danger-5 bg-danger-1 hover:bg-danger-2'
                )}
                onClick={() => setActiveTab('focus')}
              >
                <div className='flex items-center justify-between'>
                  <span className='text-11px font-[600] text-danger-6'>{t('todo.stat.focus')}</span>
                  <span className='w-6px h-6px rd-full bg-danger-6' />
                </div>
                <div className='text-18px font-bold text-t-primary mt-2px'>{focusCount}</div>
              </Button>
              <Button
                type='text'
                className={classNames(
                  '!h-auto !p-10px !block text-left !rd-10px border border-solid',
                  activeTab === 'waiting'
                    ? 'border-warning-6 bg-warning-1'
                    : 'border-warning-5 bg-warning-1 hover:bg-warning-2'
                )}
                onClick={() => setActiveTab('waiting')}
              >
                <div className='flex items-center justify-between'>
                  <span className='text-11px font-[600] text-warning-6'>{t('todo.stat.waiting')}</span>
                  <span className='w-6px h-6px rd-full bg-warning-6' />
                </div>
                <div className='text-18px font-bold text-t-primary mt-2px'>{waitingCount}</div>
              </Button>
            </div>

            {/* 月历 */}
            <div className='bg-fill-1 rd-10px p-10px border border-solid border-border-2'>
              <div className='flex items-center justify-between mb-6px'>
                <span className='text-12px font-[600] text-t-primary'>{monthCursor.format('YYYY-MM')}</span>
                <div className='flex items-center gap-2px'>
                  <Button
                    size='mini'
                    type='text'
                    onClick={() => setMonthCursor((prev) => prev.subtract(1, 'month'))}
                    aria-label='previous month'
                  >
                    ‹
                  </Button>
                  <Button
                    size='mini'
                    type='text'
                    onClick={() => setMonthCursor((prev) => prev.add(1, 'month'))}
                    aria-label='next month'
                  >
                    ›
                  </Button>
                  <Button
                    size='mini'
                    type='text'
                    onClick={() => {
                      setMonthCursor(dayjs().startOf('month'));
                      setSelectedDay(dayjs().startOf('day').valueOf());
                    }}
                  >
                    {t('todo.cal.today')}
                  </Button>
                </div>
              </div>
              <div className='grid grid-cols-7 gap-2px text-center'>
                {[0, 1, 2, 3, 4, 5, 6].map((weekday) => (
                  <div key={weekday} className='h-18px text-10px text-t-tertiary flex-center'>
                    {dayjs().day(weekday).format('dd')}
                  </div>
                ))}
                {calendarCells.map((cell) => {
                  const dayMs = cell.startOf('day').valueOf();
                  const inMonth = cell.month() === monthCursor.month();
                  const isToday = dayMs === dayjs().startOf('day').valueOf();
                  // 本月已过去的日子(今天之前)整体降一点存在感;今天高亮成胶囊。
                  const isPast = dayMs < dayjs().startOf('day').valueOf();
                  const isSelected = selectedDay === dayMs;
                  const groups = dayGroups.get(dayMs);
                  return (
                    <Button
                      type='text'
                      size='mini'
                      key={dayMs}
                      className={classNames(
                        '!h-32px !w-full !p-0 relative !rd-6px text-11px flex flex-col items-center justify-center border border-solid',
                        isSelected
                          ? 'bg-primary-6 border-primary-6 text-white font-bold'
                          : isToday
                            ? 'bg-primary-1 border-primary-6 text-primary-6 font-bold'
                            : isPast && inMonth
                              ? 'border-transparent text-t-tertiary op-70'
                              : inMonth
                                ? 'border-transparent text-t-primary'
                                : 'border-transparent text-t-tertiary op-40'
                      )}
                      onClick={() => {
                        setSelectedDay((prev) => (prev === dayMs ? null : dayMs));
                        if (selectedDay !== dayMs) setActiveTab('all');
                      }}
                    >
                      <span>{cell.date()}</span>
                      <span className='flex items-center gap-2px mt-1px h-4px'>
                        {groups?.has('overdue') && (
                          <i className={classNames('w-4px h-4px rd-full', isSelected ? 'bg-white' : 'bg-danger-6')} />
                        )}
                        {groups?.has('today') && (
                          <i className={classNames('w-4px h-4px rd-full', isSelected ? 'bg-white' : 'bg-warning-5')} />
                        )}
                        {groups?.has('waiting') && (
                          <i className={classNames('w-4px h-4px rd-full', isSelected ? 'bg-white' : 'bg-warning-6')} />
                        )}
                        {groups?.has('upcoming') && (
                          <i className={classNames('w-4px h-4px rd-full', isSelected ? 'bg-white' : 'bg-primary-6')} />
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <div className='mt-8px pt-6px border-t border-solid border-border-2 flex items-center justify-between'>
                <div className='flex items-center gap-8px text-10px text-t-tertiary'>
                  <span className='inline-flex items-center gap-3px'>
                    <i className='w-4px h-4px rd-full bg-danger-6 inline-block' />
                    {t('todo.cal.focus')}
                  </span>
                  <span className='inline-flex items-center gap-3px'>
                    <i className='w-4px h-4px rd-full bg-warning-6 inline-block' />
                    {t('todo.cal.waiting')}
                  </span>
                  <span className='inline-flex items-center gap-3px'>
                    <i className='w-4px h-4px rd-full bg-primary-6 inline-block' />
                    {t('todo.cal.planned')}
                  </span>
                </div>
                {selectedDay !== null && (
                  <Button size='mini' type='text' onClick={() => setSelectedDay(null)}>
                    {t('todo.clearDayFilter')}
                  </Button>
                )}
              </div>
            </div>

            {/* 要求人筛选 */}
            <div>
              <div className='flex items-center justify-between mb-6px'>
                <span className='text-11px font-[600] text-t-tertiary uppercase tracking-wider'>
                  {t('todo.senderFilter')}
                </span>
                {selectedSender && (
                  <Button size='mini' type='text' onClick={() => setSelectedSender(null)}>
                    {t('todo.senderClear')}
                  </Button>
                )}
              </div>
              <div className='flex flex-col gap-2px'>
                {senders.slice(0, 12).map((sender) => {
                  const active = selectedSender === sender.name;
                  return (
                    <Button
                      type='text'
                      size='mini'
                      key={sender.name}
                      className={classNames(
                        '!w-full !justify-between !px-8px !py-4px !rd-6px text-12px border border-solid',
                        active
                          ? 'bg-primary-1 border-primary-6 text-primary-6 font-[600]'
                          : 'border-transparent text-t-secondary'
                      )}
                      onClick={() => setSelectedSender((prev) => (prev === sender.name ? null : sender.name))}
                    >
                      <span className='flex items-center gap-6px min-w-0'>
                        <span className='w-18px h-18px rd-full bg-fill-2 text-10px font-bold text-t-secondary flex-center shrink-0'>
                          {sender.name.slice(0, 1)}
                        </span>
                        <span className='truncate'>{sender.name}</span>
                      </span>
                      <span
                        className={classNames(
                          'text-11px px-6px rd-full',
                          active ? 'bg-primary-6 text-white' : 'bg-fill-2 text-t-tertiary'
                        )}
                      >
                        {sender.count}
                      </span>
                    </Button>
                  );
                })}
                {senders.length === 0 && (
                  <span className='text-11px text-t-tertiary px-8px'>{t('todo.senderEmpty')}</span>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* 中栏:标签页 + 筛选条 + 分组任务流 */}
        <main className='flex-1 flex flex-col min-w-0 bg-fill-1 overflow-hidden'>
          <div className='shrink-0 bg-1 border-b border-solid border-border-2 px-20px py-6px flex items-center justify-between gap-8px overflow-x-auto'>
            <div className='inline-flex items-center gap-2px bg-fill-2 p-2px rd-8px'>
              {tabs.map((tab) => (
                <Button
                  type='text'
                  size='mini'
                  key={tab.key}
                  className={classNames(
                    '!px-10px !py-3px !rd-6px text-11px font-[500] whitespace-nowrap',
                    activeTab === tab.key ? 'bg-1 text-t-primary shadow-sm' : 'text-t-secondary'
                  )}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.key === 'focus' && <span className='w-4px h-4px rd-full bg-danger-6' />}
                  {tab.key === 'waiting' && <span className='w-4px h-4px rd-full bg-warning-6' />}
                  {tab.key === 'upcoming' && <span className='w-4px h-4px rd-full bg-primary-6' />}
                  {tab.label}
                  <span
                    className={classNames(
                      'px-4px rd-full text-10px',
                      activeTab === tab.key ? 'bg-fill-2 text-t-secondary' : 'text-t-tertiary'
                    )}
                  >
                    {tab.count}
                  </span>
                </Button>
              ))}
            </div>
          </div>

          {hasAnyFilter && (
            <div className='shrink-0 bg-primary-1 border-b border-solid border-primary-2 px-20px py-4px flex items-center justify-between gap-8px text-11px text-primary-6'>
              <div className='flex items-center gap-6px flex-wrap'>
                {selectedDay !== null && (
                  <Tag closable size='small' color='arcoblue' onClose={() => setSelectedDay(null)}>
                    📅 {t('todo.filter.date')}: {dayjs(selectedDay).format('M月D日')}
                  </Tag>
                )}
                {selectedSender && (
                  <Tag closable size='small' color='orange' onClose={() => setSelectedSender(null)}>
                    👤 {t('todo.filter.sender')}: {selectedSender}
                  </Tag>
                )}
                {searchQuery.trim() && (
                  <Tag
                    closable
                    size='small'
                    onClose={() => {
                      setSearchQuery('');
                    }}
                  >
                    🔍 {t('todo.filter.search')}: {searchQuery.trim()}
                  </Tag>
                )}
              </div>
              <Button size='mini' type='outline' className='shrink-0' onClick={resetAllFilters}>
                {t('todo.filter.clearAll')}
              </Button>
            </div>
          )}

          <div className='flex-1 overflow-y-auto overscroll-contain px-20px py-14px'>
            {loading ? (
              <div className='flex-center py-80px'>
                <Spin size={24} />
              </div>
            ) : todos.length === 0 ? (
              <Empty className='py-60px' description={t('todo.empty')} />
            ) : visibleSections.length === 0 ? (
              <div className='bg-1 rd-12px border border-solid border-border-2 p-40px text-center mt-20px'>
                <Calendar theme='outline' size='28' className='text-t-tertiary' />
                <p className='text-13px font-[600] text-t-primary mt-8px'>{t('todo.emptyFiltered.title')}</p>
                <p className='text-12px text-t-tertiary mt-4px'>{t('todo.emptyFiltered.hint')}</p>
                <Button
                  size='small'
                  type='primary'
                  className='mt-12px'
                  onClick={() => {
                    resetAllFilters();
                    setActiveTab('all');
                  }}
                >
                  {t('todo.filter.clearAll')}
                </Button>
              </div>
            ) : (
              <div className='flex flex-col gap-16px max-w-900px mx-auto w-full'>
                {visibleSections.map((section) => (
                  <section key={section.key}>
                    <div className='flex items-center gap-6px mb-8px px-2px'>
                      <span className={classNames('w-6px h-6px rd-full', groupDotClass[section.key])} />
                      <h2
                        className={classNames(
                          'text-12px font-[600] tracking-wide',
                          section.key === 'overdue' && 'text-danger-6',
                          section.key === 'waiting' && 'text-warning-6',
                          section.key !== 'overdue' && section.key !== 'waiting' && 'text-t-secondary'
                        )}
                      >
                        {groupTitle(section.key)}
                      </h2>
                      <span className='px-6px rd-full text-10px font-[600] bg-fill-2 text-t-secondary'>
                        {section.items.length}
                      </span>
                    </div>
                    <div className={classNames('flex gap-6px', isMobile ? 'flex-col' : 'flex-col')}>
                      {section.items.map(renderCard)}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </main>

        {/* 右栏:详情抽屉(移动端全屏浮层) */}
        {(selected || isMobile === false) && (
          <TodoDrawer
            item={selected}
            isMobile={isMobile}
            onClose={() => setSelectedId(null)}
            onEdit={(item) => setEditor({ open: true, item })}
            onStatusChange={(next) => selected && void handleStatusChange(selected, next)}
            onUnblock={() => selected && void handleUnblock(selected)}
            onSubtaskToggle={(subtaskId, done) => selected && void handleSubtaskToggle(selected, subtaskId, done)}
            onRemove={() => selected && void handleRemove(selected)}
          />
        )}
      </div>

      <TodoEditor
        open={editor.open}
        item={editor.item}
        onCancel={() => setEditor({ open: false, item: null })}
        onSave={handleEditorSave}
      />
    </div>
  );
};

/** 右侧详情抽屉:状态切换 / 等待解除 / 步骤清单 / 要求人 / 来源邮件。 */
const TodoDrawer: React.FC<{
  item: ITodoItem | null;
  isMobile: boolean;
  onClose: () => void;
  onEdit: (item: ITodoItem) => void;
  onStatusChange: (next: 'pending' | 'waiting' | 'done') => void;
  onUnblock: () => void;
  onSubtaskToggle: (subtaskId: string, done: boolean) => void;
  onRemove: () => void;
}> = ({ item, isMobile, onClose, onEdit, onStatusChange, onUnblock, onSubtaskToggle, onRemove }) => {
  const { t } = useTranslation();

  if (!item) {
    return (
      <aside className='w-320px shrink-0 bg-1 border-l border-solid border-border-2 hidden lg:flex flex-col justify-center items-center gap-8px'>
        <Calendar theme='outline' size='24' className='text-t-tertiary' />
        <span className='text-12px text-t-tertiary px-16px text-center'>{t('todo.drawer.placeholder')}</span>
      </aside>
    );
  }

  const statusValue =
    item.status === 'done'
      ? 'done'
      : item.status === 'waiting'
        ? 'waiting'
        : groupOf(item) === 'today' || groupOf(item) === 'overdue'
          ? 'pending'
          : 'pending';
  const requester = requesterOf(item);
  const dueText = item.due_at ? dayjs(item.due_at).format('YYYY-MM-DD dddd') : t('todo.dueNone');

  const body = (
    <div className='flex-1 min-w-0 flex flex-col overflow-hidden'>
      <div className='px-16px py-8px border-b border-solid border-border-2 flex items-center justify-between gap-8px shrink-0 bg-fill-1'>
        <span className='text-11px font-[600] text-t-tertiary uppercase tracking-wider truncate'>
          {t('todo.drawer.title')}
        </span>
        <div className='flex items-center gap-6px shrink-0'>
          <Select
            size='mini'
            value={statusValue}
            onChange={(value) => onStatusChange(value as 'pending' | 'waiting' | 'done')}
            className='w-130px'
          >
            <Select.Option value='pending'>{t('todo.drawer.status.pending')}</Select.Option>
            <Select.Option value='waiting'>{t('todo.drawer.status.waiting')}</Select.Option>
            <Select.Option value='done'>{t('todo.drawer.status.done')}</Select.Option>
          </Select>
          {isMobile && (
            <Button size='mini' type='text' onClick={onClose}>
              ✕
            </Button>
          )}
        </div>
      </div>

      <div className='flex-1 overflow-y-auto p-16px flex flex-col gap-14px'>
        <div>
          <div className='flex items-center gap-6px mb-6px'>
            {item.source === 'email' && (
              <Tag size='small' color='arcoblue'>
                {t('todo.source.email')}
              </Tag>
            )}
            {item.source === 'agent' && <Tag size='small'>{t('todo.source.agent')}</Tag>}
            {item.source === 'manual' && <Tag size='small'>{t('todo.source.manual')}</Tag>}
          </div>
          <h2
            className={classNames(
              'text-15px font-bold text-t-primary leading-snug break-all',
              item.status === 'done' && 'line-through text-t-tertiary'
            )}
          >
            {item.title}
          </h2>
          <div className='mt-6px flex items-center gap-8px text-12px text-t-secondary'>
            <span>
              📅 {t('todo.detail.due')}: <strong className='text-t-primary'>{dueText}</strong>
            </span>
          </div>
        </div>

        {item.status === 'waiting' && (
          <div className='p-10px rd-10px bg-warning-1 border border-solid border-warning-5 flex items-center justify-between gap-8px'>
            <div className='text-12px text-warning-6 min-w-0'>
              <div className='font-bold'>⏳ {t('todo.drawer.waiting.title')}</div>
              <div className='text-11px mt-2px break-all'>
                {item.blocked_reason || t('todo.drawer.waiting.default')}
              </div>
            </div>
            <Button size='mini' type='primary' status='warning' className='shrink-0' onClick={onUnblock}>
              {t('todo.unblockConfirm')}
            </Button>
          </div>
        )}

        {item.notes && (
          <div className='flex flex-col gap-4px'>
            <h3 className='text-11px font-[600] text-t-secondary'>{t('todo.drawer.summary')}</h3>
            <div className='p-10px rd-10px bg-fill-1 border border-solid border-border-2 text-12px text-t-primary leading-relaxed whitespace-pre-line break-all'>
              {item.notes}
            </div>
          </div>
        )}

        {item.subtasks && item.subtasks.length > 0 && (
          <div className='flex flex-col gap-4px'>
            <div className='flex items-center justify-between'>
              <h3 className='text-11px font-[600] text-t-secondary'>{t('todo.drawer.subtasks')}</h3>
              <span className='text-10px text-t-tertiary'>{t('todo.drawer.subtasksHint')}</span>
            </div>
            <div className='border border-solid border-border-2 rd-10px p-4px flex flex-col'>
              {item.subtasks.map((sub) => (
                <label
                  key={sub.id}
                  className='flex items-start gap-8px p-6px rd-6px hover:bg-fill-2 cursor-pointer transition-colors'
                >
                  <Checkbox
                    checked={sub.done}
                    onChange={(checked) => onSubtaskToggle(sub.id, checked)}
                    className='mt-1px shrink-0'
                  />
                  <span
                    className={classNames(
                      'text-12px leading-relaxed break-all',
                      sub.done ? 'line-through text-t-tertiary' : 'text-t-primary'
                    )}
                  >
                    {sub.text}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}

        {requester && (
          <div className='flex flex-col gap-4px'>
            <h3 className='text-11px font-[600] text-t-secondary'>{t('todo.drawer.requester')}</h3>
            <div className='flex items-center gap-8px px-10px py-6px rd-8px bg-fill-1 border border-solid border-border-2 text-12px'>
              <span className='w-24px h-24px rd-full bg-fill-3 text-11px font-bold text-t-primary flex-center shrink-0'>
                {requester.slice(0, 1)}
              </span>
              <div className='min-w-0'>
                <div className='font-[600] text-t-primary truncate'>{requester}</div>
                {item.email_ref?.from && (
                  <div className='text-10px text-t-tertiary truncate'>{item.email_ref.from}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {item.email_ref && (
          <div className='flex flex-col gap-4px'>
            <h3 className='text-11px font-[600] text-t-secondary'>{t('todo.drawer.email')}</h3>
            <div className='p-10px rd-10px bg-fill-1 border border-solid border-border-2 flex flex-col gap-4px'>
              <div className='flex items-center justify-between gap-8px'>
                <span className='text-12px font-[600] text-t-primary truncate'>{item.email_ref.from}</span>
                <span className='text-10px text-t-tertiary shrink-0'>
                  {dayjs(item.email_ref.received_at).format('YYYY-MM-DD HH:mm')}
                </span>
              </div>
              <div className='text-12px font-[500] text-t-primary break-all'>{item.email_ref.subject}</div>
            </div>
          </div>
        )}

        <div className='text-11px text-t-tertiary'>
          {t('todo.detail.created')}: {dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}
        </div>

        <div className='flex justify-end gap-8px pt-4px'>
          <Popconfirm title={t('todo.confirmDelete')} onOk={onRemove}>
            <Button size='small' status='danger'>
              {t('todo.delete')}
            </Button>
          </Popconfirm>
          <Button size='small' type='primary' icon={<Edit theme='outline' size='13' />} onClick={() => onEdit(item)}>
            {t('todo.edit')}
          </Button>
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return <div className='absolute inset-0 z-20 bg-1 flex flex-col'>{body}</div>;
  }

  return <aside className='w-320px shrink-0 bg-1 border-l border-solid border-border-2 flex flex-col'>{body}</aside>;
};

/** 新建/编辑弹窗:标题 + 要求人 + 截止 + 状态分组 + 说明。 */
const TodoEditor: React.FC<{
  open: boolean;
  item: ITodoItem | null;
  onCancel: () => void;
  onSave: (payload: {
    title: string;
    notes: string;
    dueDate: string;
    requester: string;
    statusGroup: 'pending' | 'waiting';
  }) => Promise<void>;
}> = ({ open, item, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [requester, setRequester] = useState('');
  const [statusGroup, setStatusGroup] = useState<'pending' | 'waiting'>('pending');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(item?.title || '');
      setNotes(item?.notes || '');
      setDueDate(item?.due_at ? dayjs(item.due_at).format('YYYY-MM-DD') : '');
      setRequester(item?.requester || item?.email_ref?.from || '');
      setStatusGroup(item?.status === 'waiting' ? 'waiting' : 'pending');
    }
  }, [open, item]);

  const handleOk = async () => {
    if (saving) {
      return;
    }
    if (!title.trim()) {
      Message.warning(t('todo.titleRequired'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        notes: notes.trim(),
        dueDate,
        requester: requester.trim(),
        statusGroup,
      });
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
        <div className='grid grid-cols-3 gap-8px'>
          <div className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('todo.editor.requester')}</span>
            <Input
              value={requester}
              onChange={setRequester}
              placeholder={t('todo.editor.requesterPlaceholder')}
              maxLength={60}
            />
          </div>
          <div className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('todo.due')}</span>
            {/* 透传原生 date 输入,避免引入未被上游验证过的日期组件 */}
            <Input type='date' value={dueDate} onChange={setDueDate} />
          </div>
          <div className='flex flex-col gap-4px'>
            <span className='text-12px text-t-secondary'>{t('todo.editor.statusGroup')}</span>
            <Select value={statusGroup} onChange={(value) => setStatusGroup(value as 'pending' | 'waiting')}>
              <Select.Option value='pending'>{t('todo.editor.statusActive')}</Select.Option>
              <Select.Option value='waiting'>{t('todo.editor.statusWaiting')}</Select.Option>
            </Select>
          </div>
        </div>
        <Input.TextArea
          value={notes}
          onChange={setNotes}
          placeholder={t('todo.notesPlaceholder')}
          maxLength={2000}
          autoSize={{ minRows: 3, maxRows: 8 }}
        />
      </div>
    </Modal>
  );
};

export default TodoPage;
