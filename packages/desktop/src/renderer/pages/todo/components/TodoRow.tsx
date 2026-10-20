/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Checkbox, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Delete, Edit, Hourglass, ListCheckbox, Mail, PlayOne } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { ITodoItem } from '@/common/types/todo/todoTypes';
import { dueInfo, formatDue, requesterOf, subtaskProgress, summaryOf } from '../todoModel';
import styles from './TodoRow.module.css';

const DUE_TONE = {
  none: 'text-t-tertiary',
  overdue: 'text-danger font-500',
  today: 'text-warning font-500',
  tomorrow: 'text-t-secondary',
  week: 'text-t-secondary',
  later: 'text-t-tertiary',
} as const;

export default function TodoRow({
  item,
  selected,
  onSelect,
  onToggle,
  onUnblock,
  onEdit,
  onRemove,
}: {
  item: ITodoItem;
  selected: boolean;
  onSelect: () => void;
  onToggle: (done: boolean) => void;
  onUnblock: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const done = item.status === 'done';
  const waiting = item.status === 'waiting';
  const due = dueInfo(item);
  const requester = requesterOf(item);
  const progress = subtaskProgress(item);
  const summary = summaryOf(item);
  const completedAt =
    done && item.completed_at
      ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(item.completed_at))
      : null;
  const meta = [
    waiting && (
      <span key='waiting' className='inline-flex items-center gap-4px text-warning min-w-0'>
        <Hourglass theme='outline' fill='currentColor' size='12' className='shrink-0' />
        <span className='truncate'>{item.blocked_reason || t('todo.drawer.waiting.default')}</span>
      </span>
    ),
    (requester || item.source === 'email') && (
      <span key='requester' className='shrink-0 inline-flex items-center gap-4px max-w-140px min-w-0'>
        {item.source === 'email' && (
          <Tooltip content={item.email_ref?.subject} mini>
            <Mail theme='outline' fill='currentColor' size='12' className='shrink-0' />
          </Tooltip>
        )}
        {requester && <span className='truncate'>{requester}</span>}
      </span>
    ),
    progress && (
      <span key='steps' className='shrink-0 inline-flex items-center gap-3px tabular-nums'>
        <ListCheckbox theme='outline' fill='currentColor' size='12' />
        {progress.done}/{progress.total}
      </span>
    ),
    summary && !waiting && (
      <span key='summary' className='min-w-0 truncate'>
        {summary}
      </span>
    ),
  ].filter(Boolean);

  return (
    <div
      role='button'
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      className={classNames(
        'group relative flex items-start gap-12px px-14px py-10px cursor-pointer transition-colors outline-none',
        selected ? 'bg-fill-2' : 'hover:bg-fill-1 focus-visible:bg-fill-1'
      )}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter') onSelect();
        else if (event.key === ' ') {
          event.preventDefault();
          onToggle(!done);
        }
      }}
    >
      {selected && <span aria-hidden className='absolute left-0 top-8px bottom-8px w-3px rd-r-3px bg-primary' />}
      <Tooltip content={done ? t('todo.markUndone') : t('todo.markDone')} mini>
        <span className='pt-1px' onClick={(event) => event.stopPropagation()}>
          <Checkbox className={styles.check} checked={done} onChange={onToggle} />
        </span>
      </Tooltip>
      <div className='flex-1 min-w-0'>
        <div
          className={classNames(
            'truncate text-14px leading-22px',
            done ? 'line-through text-t-tertiary' : 'text-t-primary font-500'
          )}
        >
          {item.title}
        </div>
        {meta.length > 0 && (
          <div className='flex items-center gap-8px mt-2px text-12px leading-18px text-t-tertiary min-w-0'>
            {meta.flatMap((node, index) =>
              index === 0
                ? [node]
                : [
                    <span key={`dot-${index}`} className='shrink-0 select-none'>
                      ·
                    </span>,
                    node,
                  ]
            )}
          </div>
        )}
      </div>
      <div className='shrink-0 flex items-center gap-4px h-22px'>
        <div
          className='hidden group-hover:flex group-focus-within:flex items-center'
          onClick={(event) => event.stopPropagation()}
        >
          {waiting && (
            <Tooltip content={t('todo.unblockConfirm')} mini>
              <Button
                size='mini'
                type='text'
                aria-label={t('todo.unblockConfirm')}
                icon={<PlayOne theme='outline' fill='currentColor' size='14' />}
                onClick={onUnblock}
              />
            </Tooltip>
          )}
          <Tooltip content={t('todo.edit')} mini>
            <Button
              size='mini'
              type='text'
              aria-label={t('todo.edit')}
              icon={<Edit theme='outline' fill='currentColor' size='14' />}
              onClick={onEdit}
            />
          </Tooltip>
          <Popconfirm title={t('todo.confirmDelete')} onOk={onRemove} position='br'>
            <Button
              size='mini'
              type='text'
              aria-label={t('todo.delete')}
              icon={<Delete theme='outline' fill='currentColor' size='14' />}
            />
          </Popconfirm>
        </div>
        <span
          className={classNames(
            'text-12px whitespace-nowrap tabular-nums',
            done ? 'text-t-tertiary' : DUE_TONE[due.kind]
          )}
        >
          {completedAt
            ? t('todo.row.completedAt', { date: completedAt })
            : due.kind === 'none'
              ? ''
              : formatDue(due, t, locale)}
        </span>
      </div>
    </div>
  );
}
