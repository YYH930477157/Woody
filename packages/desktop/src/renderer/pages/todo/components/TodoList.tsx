/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Button, Empty, Input, Radio, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Calendar, Mail, Plus, Search, User } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { ITodoItem, TodoStatusInfo } from '@/common/types/todo/todoTypes';
import type { TodoGroup, TodoView } from '../todoModel';
import TodoRow from './TodoRow';

const GROUP_TONE: Record<TodoGroup, string> = {
  overdue: 'bg-danger',
  today: 'bg-warning',
  waiting: 'bg-warning',
  upcoming: 'bg-primary',
  done: 'bg-success',
};

export type TodoRowActions = {
  onSelect: (item: ITodoItem) => void;
  onToggle: (item: ITodoItem, done: boolean) => void;
  onUnblock: (item: ITodoItem) => void;
  onEdit: (item: ITodoItem) => void;
  onRemove: (item: ITodoItem) => void;
};

export default function TodoList({
  title,
  view,
  onViewChange,
  compact,
  query,
  onQueryChange,
  dayLabel,
  onClearDay,
  requester,
  onClearRequester,
  scanInfo,
  scanning,
  onScan,
  onCreate,
  onQuickAdd,
  loading,
  hasTodos,
  sections,
  groupTitle,
  selectedId,
  actions,
}: {
  title: string;
  view: TodoView;
  onViewChange: (view: TodoView) => void;
  compact: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  dayLabel: string | null;
  onClearDay: () => void;
  requester: string | null;
  onClearRequester: () => void;
  scanInfo: TodoStatusInfo | null;
  scanning: boolean;
  onScan: () => void;
  onCreate: () => void;
  onQuickAdd: ((title: string) => Promise<boolean>) | null;
  loading: boolean;
  hasTodos: boolean;
  sections: Array<{ group: TodoGroup; items: ITodoItem[] }>;
  groupTitle: (group: TodoGroup) => string;
  selectedId: string | null;
  actions: TodoRowActions;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const filtered = Boolean(dayLabel || requester || query.trim());
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  const scanFailed = scanInfo?.last_scan_status?.startsWith('snapshot-failed') ?? false;
  const lastScan = scanInfo?.last_scan_at
    ? new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(scanInfo.last_scan_at))
    : null;

  const quickAdd = async () => {
    const text = draft.trim();
    if (!text || adding || !onQuickAdd) return;
    setAdding(true);
    try {
      if (await onQuickAdd(text)) setDraft('');
    } finally {
      setAdding(false);
    }
  };

  return (
    <main className='flex-1 min-w-0 min-h-0 flex flex-col bg-base'>
      <div className='shrink-0 flex items-center gap-12px px-24px h-56px border-b border-[var(--border-base)]'>
        <div className='min-w-0 flex items-baseline gap-8px'>
          <span className='text-15px font-600 text-t-primary truncate'>{title}</span>
          {!loading && <span className='text-13px text-t-tertiary tabular-nums'>{total}</span>}
        </div>
        <span className='flex-1' />
        <Input
          size='small'
          className='!w-220px'
          value={query}
          onChange={onQueryChange}
          allowClear
          placeholder={t('todo.searchPlaceholder')}
          prefix={<Search theme='outline' fill='currentColor' size='14' />}
        />
        <Tooltip
          content={
            lastScan
              ? t(scanFailed ? 'todo.scan.lastFailed' : 'todo.scan.lastAt', { time: lastScan })
              : t('todo.emailScan.never')
          }
          mini
        >
          <Button size='small' loading={scanning} onClick={onScan}>
            <span className='inline-flex items-center gap-6px'>
              <span className='relative flex'>
                <Mail theme='outline' fill='currentColor' size='14' />
                {scanFailed && <i className='absolute -right-2px -top-2px size-6px rd-full bg-danger' />}
              </span>
              {!compact && <span>{t('todo.scan.button')}</span>}
            </span>
          </Button>
        </Tooltip>
        {compact && (
          <Button
            size='small'
            type='primary'
            aria-label={t('todo.new')}
            icon={<Plus theme='outline' fill='currentColor' size='14' />}
            onClick={onCreate}
          />
        )}
      </div>

      {compact && (
        <div className='shrink-0 px-16px py-8px overflow-x-auto border-b border-[var(--border-base)]'>
          <Radio.Group
            type='button'
            size='small'
            value={view}
            onChange={onViewChange}
            options={(['all', 'focus', 'waiting', 'upcoming', 'done'] as const).map((key) => ({
              value: key,
              label: t(`todo.tab.${key}`),
            }))}
          />
        </div>
      )}

      {filtered && (
        <div className='shrink-0 flex items-center gap-8px flex-wrap px-24px py-8px border-b border-[var(--border-base)]'>
          {dayLabel && (
            <Tag
              closable
              bordered={false}
              onClose={onClearDay}
              icon={<Calendar theme='outline' fill='currentColor' size='12' />}
            >
              {dayLabel}
            </Tag>
          )}
          {requester && (
            <Tag
              closable
              bordered={false}
              onClose={onClearRequester}
              icon={<User theme='outline' fill='currentColor' size='12' />}
            >
              {requester}
            </Tag>
          )}
          {query.trim() && (
            <Tag
              closable
              bordered={false}
              onClose={() => onQueryChange('')}
              icon={<Search theme='outline' fill='currentColor' size='12' />}
            >
              {query.trim()}
            </Tag>
          )}
          <Button
            size='mini'
            type='text'
            onClick={() => {
              onClearDay();
              onClearRequester();
              onQueryChange('');
            }}
          >
            {t('todo.filter.clearAll')}
          </Button>
        </div>
      )}

      <div className='flex-1 min-h-0 overflow-y-auto overscroll-contain'>
        <div
          className={classNames(
            'max-w-860px mx-auto flex flex-col gap-20px',
            compact ? 'px-12px py-12px' : 'px-24px py-18px'
          )}
        >
          {onQuickAdd && hasTodos && (
            <Input
              value={draft}
              onChange={setDraft}
              onPressEnter={() => void quickAdd()}
              disabled={adding}
              maxLength={200}
              placeholder={t('todo.quickAddPlaceholder')}
              prefix={<Plus theme='outline' fill='currentColor' size='15' />}
              aria-label={t('todo.quickAddPlaceholder')}
            />
          )}

          {loading ? (
            <div className='flex-center py-80px'>
              <Spin size={24} />
            </div>
          ) : !hasTodos ? (
            <div className='py-60px flex flex-col items-center gap-14px'>
              <Empty description={t('todo.empty')} />
              <div className='flex gap-8px'>
                <Button type='primary' onClick={onCreate}>
                  <span className='inline-flex items-center gap-6px'>
                    <Plus theme='outline' fill='currentColor' size='14' />
                    <span>{t('todo.emptyCreate')}</span>
                  </span>
                </Button>
                <Button loading={scanning} onClick={onScan}>
                  <span className='inline-flex items-center gap-6px'>
                    <Mail theme='outline' fill='currentColor' size='14' />
                    <span>{t('todo.scan.button')}</span>
                  </span>
                </Button>
              </div>
            </div>
          ) : sections.length === 0 ? (
            <div className='py-60px flex flex-col items-center gap-6px text-center'>
              <span className='text-14px font-500 text-t-primary'>
                {filtered ? t('todo.emptyFiltered.title') : t('todo.emptyView')}
              </span>
              {filtered && <span className='text-13px text-t-tertiary'>{t('todo.emptyFiltered.hint')}</span>}
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.group} className='flex flex-col gap-8px'>
                <div className='flex items-center gap-8px px-4px'>
                  <i className={classNames('block size-7px rd-full', GROUP_TONE[section.group])} />
                  <h3
                    className={classNames(
                      'm-0 text-13px font-600',
                      section.group === 'overdue' ? 'text-danger' : 'text-t-primary'
                    )}
                  >
                    {groupTitle(section.group)}
                  </h3>
                  <span className='text-12px text-t-tertiary tabular-nums'>{section.items.length}</span>
                </div>
                <div className='rd-12px border border-[var(--border-base)] overflow-hidden'>
                  {section.items.map((item, index) => (
                    <div key={item.id} className={classNames(index > 0 && 'border-t border-[var(--border-light)]')}>
                      <TodoRow
                        item={item}
                        selected={item.id === selectedId}
                        onSelect={() => actions.onSelect(item)}
                        onToggle={(done) => actions.onToggle(item, done)}
                        onUnblock={() => actions.onUnblock(item)}
                        onEdit={() => actions.onEdit(item)}
                        onRemove={() => actions.onRemove(item)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
