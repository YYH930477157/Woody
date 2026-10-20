/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Button, Checkbox, Input, Popconfirm, Radio, Tag, Tooltip } from '@arco-design/web-react';
import { Close, Delete, Edit, Hourglass, Mail, Notes, Plus, Quote } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { ITodoItem, ITodoSubtask } from '@/common/types/todo/todoTypes';
import { dueInfo, formatDue, formatFullDate, parseNotes, requesterOf, subtaskProgress } from '../todoModel';
import styles from './TodoRow.module.css';

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-8px'>
      <div className='flex items-center justify-between text-12px font-500 text-t-tertiary'>
        {title}
        {extra}
      </div>
      {children}
    </section>
  );
}

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className='text-t-tertiary'>{label}</span>
      <span className='min-w-0 text-t-primary'>{children}</span>
    </>
  );
}

export default function TodoDetail({
  item,
  onClose,
  onStatusChange,
  onUnblock,
  onSubtasksChange,
  onEdit,
  onRemove,
}: {
  item: ITodoItem;
  onClose?: () => void;
  onStatusChange: (status: ITodoItem['status']) => void;
  onUnblock: () => void;
  onSubtasksChange: (subtasks: ITodoSubtask[]) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const [newStep, setNewStep] = useState('');
  const notes = parseNotes(item.notes);
  const structured = Boolean(notes.goal || notes.points.length || notes.quote);
  const requester = requesterOf(item);
  const progress = subtaskProgress(item);
  const due = dueInfo(item);
  const steps = item.subtasks ?? [];
  const addStep = () => {
    const text = newStep.trim();
    if (!text) return;
    onSubtasksChange([...steps, { id: crypto.randomUUID(), text, done: false }]);
    setNewStep('');
  };

  return (
    <div className='h-full min-h-0 flex flex-col bg-base'>
      <div className='shrink-0 flex items-center gap-4px px-12px h-56px border-b border-[var(--border-base)]'>
        <Radio.Group
          className='shrink-0 whitespace-nowrap'
          type='button'
          size='small'
          value={item.status}
          onChange={onStatusChange}
          options={(['pending', 'waiting', 'done'] as const).map((status) => ({
            value: status,
            label: t(`todo.drawer.status.${status}`),
          }))}
        />
        <span className='flex-1' />
        <Tooltip content={t('todo.edit')} mini>
          <Button
            size='small'
            type='text'
            aria-label={t('todo.edit')}
            icon={<Edit theme='outline' fill='currentColor' size='15' />}
            onClick={onEdit}
          />
        </Tooltip>
        <Popconfirm title={t('todo.confirmDelete')} onOk={onRemove} position='br'>
          <Button
            size='small'
            type='text'
            aria-label={t('todo.delete')}
            icon={<Delete theme='outline' fill='currentColor' size='15' />}
          />
        </Popconfirm>
        {onClose && (
          <Button
            size='small'
            type='text'
            aria-label={t('todo.detail.close')}
            icon={<Close theme='outline' fill='currentColor' size='15' />}
            onClick={onClose}
          />
        )}
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto px-20px py-18px flex flex-col gap-20px'>
        <div className='flex flex-col gap-12px'>
          <h2
            className={classNames(
              'm-0 text-17px leading-26px font-600 break-words',
              item.status === 'done' ? 'line-through text-t-tertiary' : 'text-t-primary'
            )}
          >
            {item.title}
          </h2>
          <div className='grid grid-cols-[72px_1fr] gap-x-12px gap-y-8px text-13px leading-20px'>
            <Property label={t('todo.detail.due')}>
              {due.kind === 'none' ? (
                <span className='text-t-tertiary'>{t('todo.dueNone')}</span>
              ) : (
                <span className='inline-flex flex-wrap items-center gap-6px'>
                  {formatFullDate(due.at, locale, Boolean(due.time))}
                  {item.status !== 'done' && (
                    <Tag
                      size='small'
                      color={due.kind === 'overdue' ? 'red' : due.kind === 'today' ? 'orange' : 'gray'}
                      bordered={false}
                    >
                      {formatDue({ ...due, time: undefined }, t, locale)}
                    </Tag>
                  )}
                </span>
              )}
            </Property>
            {requester && (
              <Property label={t('todo.drawer.requester')}>
                <span className='inline-flex items-center gap-6px'>
                  <span className='size-20px rd-full bg-fill-3 flex-center text-10px font-600 text-t-secondary'>
                    {requester.slice(0, 1)}
                  </span>
                  {requester}
                </span>
              </Property>
            )}
            <Property label={t('todo.detail.source')}>{t(`todo.source.${item.source}`)}</Property>
            <Property label={t('todo.detail.created')}>{formatFullDate(item.created_at, locale, true)}</Property>
            {item.status === 'done' && item.completed_at && (
              <Property label={t('todo.detail.completed')}>{formatFullDate(item.completed_at, locale, true)}</Property>
            )}
          </div>
        </div>

        {item.status === 'waiting' && (
          <div className='flex items-start gap-10px p-12px rd-10px bg-warning-light-1'>
            <Hourglass theme='outline' fill='currentColor' size='16' className='shrink-0 mt-2px text-warning' />
            <div className='flex-1 min-w-0 flex flex-col items-start gap-10px'>
              <div>
                <div className='text-13px font-500 text-t-primary'>{t('todo.drawer.waiting.title')}</div>
                <div className='mt-2px text-12px leading-18px text-t-secondary break-words'>
                  {item.blocked_reason || t('todo.drawer.waiting.default')}
                </div>
              </div>
              <Button size='small' type='primary' onClick={onUnblock}>
                {t('todo.unblockConfirm')}
              </Button>
            </div>
          </div>
        )}

        {item.notes && (
          <Section title={t('todo.drawer.summary')}>
            {structured ? (
              <div className='flex flex-col gap-12px text-13px leading-21px text-t-primary'>
                {notes.goal && <p className='m-0 font-500'>{notes.goal}</p>}
                {notes.points.length > 0 && (
                  <ul className='m-0 pl-18px flex flex-col gap-4px text-t-secondary'>
                    {notes.points.map((point, index) => (
                      <li key={index} className='break-words'>
                        {point}
                      </li>
                    ))}
                  </ul>
                )}
                {notes.quote && (
                  <blockquote className='m-0 flex gap-8px px-12px py-10px rd-8px bg-fill-1 text-12px leading-19px text-t-secondary'>
                    <Quote theme='outline' fill='currentColor' size='14' className='shrink-0 mt-2px text-t-tertiary' />
                    <span className='break-words'>{notes.quote}</span>
                  </blockquote>
                )}
                {notes.extra && <p className='m-0 whitespace-pre-line text-t-secondary'>{notes.extra}</p>}
              </div>
            ) : (
              <p className='m-0 text-13px leading-21px text-t-primary whitespace-pre-line break-words'>{item.notes}</p>
            )}
          </Section>
        )}

        <Section
          title={t('todo.drawer.subtasks')}
          extra={progress && <span className='tabular-nums'>{`${progress.done}/${progress.total}`}</span>}
        >
          {progress && (
            <div className='h-4px rd-full bg-fill-2 overflow-hidden'>
              <div
                className='h-full rd-full bg-success transition-all'
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
          {steps.length > 0 && (
            <div className='flex flex-col'>
              {steps.map((step) => (
                <div key={step.id} className='group flex items-start gap-10px py-6px'>
                  <Checkbox
                    className={styles.check}
                    checked={step.done}
                    onChange={(checked) =>
                      onSubtasksChange(
                        steps.map((current) => (current.id === step.id ? { ...current, done: checked } : current))
                      )
                    }
                  />
                  <span
                    className={classNames(
                      'flex-1 min-w-0 text-13px leading-20px break-words',
                      step.done ? 'line-through text-t-tertiary' : 'text-t-primary'
                    )}
                  >
                    {step.text}
                  </span>
                  <Button
                    size='mini'
                    type='text'
                    className='opacity-0 group-hover:opacity-100'
                    aria-label={t('todo.detail.removeStep')}
                    icon={<Close theme='outline' fill='currentColor' size='12' />}
                    onClick={() => onSubtasksChange(steps.filter((current) => current.id !== step.id))}
                  />
                </div>
              ))}
            </div>
          )}
          <Input
            size='small'
            value={newStep}
            maxLength={300}
            prefix={<Plus theme='outline' fill='currentColor' size='13' />}
            placeholder={t('todo.detail.addStep')}
            onChange={setNewStep}
            onPressEnter={addStep}
          />
        </Section>

        {item.email_ref && (
          <Section title={t('todo.drawer.email')}>
            <div className='flex gap-10px p-12px rd-10px border border-[var(--border-base)]'>
              <Mail theme='outline' fill='currentColor' size='16' className='shrink-0 mt-2px text-t-tertiary' />
              <div className='min-w-0 flex-1'>
                <div className='text-13px font-500 text-t-primary break-words'>{item.email_ref.subject}</div>
                <div className='mt-2px text-12px text-t-tertiary truncate'>
                  {item.email_ref.from} · {formatFullDate(item.email_ref.received_at, locale, true)}
                </div>
              </div>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/** Shown in the detail column before anything is selected. */
export function TodoDetailPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className='h-full flex flex-col items-center justify-center gap-10px px-24px text-center bg-base'>
      <span className='size-44px rd-12px bg-fill-2 flex-center text-t-tertiary'>
        <Notes theme='outline' fill='currentColor' size='22' />
      </span>
      <span className='text-13px leading-20px text-t-tertiary'>{t('todo.drawer.placeholder')}</span>
    </div>
  );
}
