/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { Left, Right } from '@icon-park/react';
import classNames from 'classnames';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { startOfDay, type DayMark } from '../todoModel';

const MARK_CLASS: Record<DayMark, string> = { focus: 'bg-danger', waiting: 'bg-warning', planned: 'bg-primary' };

export default function MiniCalendar({
  marks,
  selectedDay,
  onSelectDay,
}: {
  marks: Map<number, Set<DayMark>>;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const [month, setMonth] = useState(() => dayjs().startOf('month'));
  const today = startOfDay(Date.now());
  const cells = useMemo(() => {
    const start = month.startOf('week');
    return Array.from({ length: 42 }, (_, index) => start.add(index, 'day'));
  }, [month]);
  const weekdays = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
    return cells.slice(0, 7).map((cell) => format.format(cell.toDate()));
  }, [cells, locale]);
  const title = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(month.toDate());

  return (
    <div className='select-none'>
      <div className='flex items-center justify-between px-4px mb-4px'>
        <span className='text-13px font-600 text-t-primary'>{title}</span>
        <div className='flex items-center'>
          <Tooltip content={t('todo.cal.prev')} mini>
            <Button
              size='mini'
              type='text'
              aria-label={t('todo.cal.prev')}
              icon={<Left theme='outline' fill='currentColor' size='14' />}
              onClick={() => setMonth((current) => current.subtract(1, 'month'))}
            />
          </Tooltip>
          <Button
            size='mini'
            type='text'
            onClick={() => {
              setMonth(dayjs().startOf('month'));
              onSelectDay(today);
            }}
          >
            {t('todo.cal.today')}
          </Button>
          <Tooltip content={t('todo.cal.next')} mini>
            <Button
              size='mini'
              type='text'
              aria-label={t('todo.cal.next')}
              icon={<Right theme='outline' fill='currentColor' size='14' />}
              onClick={() => setMonth((current) => current.add(1, 'month'))}
            />
          </Tooltip>
        </div>
      </div>
      <div className='grid grid-cols-7 text-center'>
        {weekdays.map((weekday, index) => (
          <div key={index} className='h-22px leading-22px text-11px text-t-tertiary'>
            {weekday}
          </div>
        ))}
        {cells.map((cell) => {
          const day = cell.valueOf();
          const inMonth = cell.month() === month.month();
          const isToday = day === today;
          const selected = day === selectedDay;
          const dayMarks = marks.get(day);
          return (
            <div
              key={day}
              role='button'
              tabIndex={0}
              aria-pressed={selected}
              aria-label={cell.format('YYYY-MM-DD')}
              className='h-32px flex-center cursor-pointer outline-none group'
              onClick={() => onSelectDay(selected ? null : day)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectDay(selected ? null : day);
                }
              }}
            >
              <span
                className={classNames(
                  'relative size-28px rd-full flex-center text-12px transition-colors',
                  selected
                    ? 'bg-primary text-white font-600'
                    : isToday
                      ? 'text-primary font-600 border border-[var(--primary)]'
                      : inMonth
                        ? day < today
                          ? 'text-t-tertiary group-hover:bg-fill-2'
                          : 'text-t-primary group-hover:bg-fill-2'
                        : 'text-t-disabled group-hover:bg-fill-2'
                )}
              >
                {cell.date()}
                {dayMarks && (
                  <span className='absolute bottom-2px left-1/2 -translate-x-1/2 flex gap-2px'>
                    {(['focus', 'waiting', 'planned'] as const)
                      .filter((mark) => dayMarks.has(mark))
                      .map((mark) => (
                        <i
                          key={mark}
                          className={classNames('block size-4px rd-full', selected ? 'bg-white' : MARK_CLASS[mark])}
                        />
                      ))}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className='flex items-center gap-12px px-4px mt-6px text-11px text-t-tertiary'>
        {(['focus', 'waiting', 'planned'] as const).map((mark) => (
          <span key={mark} className='inline-flex items-center gap-4px'>
            <i className={classNames('block size-6px rd-full', MARK_CLASS[mark])} />
            {t(`todo.cal.${mark}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
