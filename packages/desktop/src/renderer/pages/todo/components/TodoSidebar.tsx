/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button } from '@arco-design/web-react';
import { CalendarThirty, CheckOne, Fire, Hourglass, Inbox, Plus } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { DayMark, TodoView } from '../todoModel';
import MiniCalendar from './MiniCalendar';

const VIEWS: Array<{ key: TodoView; icon: React.ReactNode; tone: string }> = [
  { key: 'all', icon: <Inbox theme='outline' fill='currentColor' size='16' />, tone: 'text-t-secondary' },
  { key: 'focus', icon: <Fire theme='outline' fill='currentColor' size='16' />, tone: 'text-danger' },
  { key: 'waiting', icon: <Hourglass theme='outline' fill='currentColor' size='16' />, tone: 'text-warning' },
  { key: 'upcoming', icon: <CalendarThirty theme='outline' fill='currentColor' size='16' />, tone: 'text-primary' },
  { key: 'done', icon: <CheckOne theme='outline' fill='currentColor' size='16' />, tone: 'text-success' },
];

function NavRow({
  active,
  onClick,
  children,
  label,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div
      role='button'
      tabIndex={0}
      aria-label={label}
      aria-pressed={active}
      className={classNames(
        'flex items-center gap-10px h-34px px-10px rd-8px cursor-pointer transition-colors outline-none text-13px',
        active ? 'bg-fill-3 text-t-primary font-500' : 'text-t-secondary hover:bg-fill-2 focus-visible:bg-fill-2'
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className='flex items-center justify-between h-28px px-10px mt-14px mb-2px text-12px font-500 text-t-tertiary'>
      {text}
      {action}
    </div>
  );
}

export default function TodoSidebar({
  view,
  counts,
  onViewChange,
  marks,
  selectedDay,
  onSelectDay,
  requesters,
  selectedRequester,
  onSelectRequester,
  onCreate,
}: {
  view: TodoView;
  counts: Record<TodoView, number>;
  onViewChange: (view: TodoView) => void;
  marks: Map<number, Set<DayMark>>;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
  requesters: Array<{ name: string; count: number }>;
  selectedRequester: string | null;
  onSelectRequester: (name: string | null) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className='w-264px shrink-0 min-h-0 flex flex-col bg-1 border-r border-[var(--border-base)]'>
      <div className='shrink-0 flex items-center justify-between gap-8px px-16px h-56px'>
        <span className='text-15px font-600 text-t-primary truncate'>{t('todo.title')}</span>
        <Button size='small' type='primary' onClick={onCreate}>
          <span className='inline-flex items-center gap-6px'>
            <Plus theme='outline' fill='currentColor' size='14' />
            <span>{t('todo.new')}</span>
          </span>
        </Button>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto px-10px pb-16px'>
        <nav className='flex flex-col gap-2px'>
          {VIEWS.map((item) => (
            <NavRow
              key={item.key}
              label={t(`todo.tab.${item.key}`)}
              active={view === item.key && selectedDay === null}
              onClick={() => {
                onSelectDay(null);
                onViewChange(item.key);
              }}
            >
              <span className={classNames('shrink-0 flex', item.tone)}>{item.icon}</span>
              <span className='flex-1 min-w-0 truncate'>{t(`todo.tab.${item.key}`)}</span>
              <span
                className={classNames(
                  'text-12px tabular-nums',
                  item.key === 'focus' && counts.focus > 0 ? 'text-danger font-600' : 'text-t-tertiary'
                )}
              >
                {counts[item.key] || ''}
              </span>
            </NavRow>
          ))}
        </nav>

        <SectionTitle text={t('todo.nav.calendar')} />
        <div className='px-4px'>
          <MiniCalendar marks={marks} selectedDay={selectedDay} onSelectDay={onSelectDay} />
        </div>

        <SectionTitle
          text={t('todo.filter.sender')}
          action={
            selectedRequester && (
              <Button size='mini' type='text' onClick={() => onSelectRequester(null)}>
                {t('todo.senderClear')}
              </Button>
            )
          }
        />
        {requesters.length === 0 ? (
          <div className='px-10px text-12px text-t-tertiary'>{t('todo.senderEmpty')}</div>
        ) : (
          <div className='flex flex-col gap-2px'>
            {requesters.slice(0, 12).map((requester) => (
              <NavRow
                key={requester.name}
                label={requester.name}
                active={selectedRequester === requester.name}
                onClick={() => onSelectRequester(selectedRequester === requester.name ? null : requester.name)}
              >
                <span className='size-22px shrink-0 rd-full bg-fill-3 flex-center text-11px font-600 text-t-secondary'>
                  {requester.name.slice(0, 1)}
                </span>
                <span className='flex-1 min-w-0 truncate'>{requester.name}</span>
                <span className='text-12px tabular-nums text-t-tertiary'>{requester.count}</span>
              </NavRow>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
