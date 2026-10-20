/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { Button, Drawer, Empty, Tag } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { EmailSkipReason, TodoSkippedEmail } from '@/common/types/todo/todoTypes';
import { formatFullDate } from '../todoModel';

const REASONS: EmailSkipReason[] = ['not_mine', 'fyi', 'automated', 'tracked', 'other'];

const REASON_COLOR: Record<EmailSkipReason, string> = {
  not_mine: 'arcoblue',
  fyi: 'gray',
  automated: 'gray',
  tracked: 'green',
  other: 'gray',
};

/** Emails the scan kept off the todo list, with why; any of them can still become a todo. */
export default function SkippedEmails({
  open,
  emails,
  onClose,
  onRestore,
}: {
  open: boolean;
  emails: TodoSkippedEmail[];
  onClose: () => void;
  onRestore: (email: TodoSkippedEmail) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || 'en-US';
  const [reason, setReason] = useState<EmailSkipReason | 'all'>('all');
  const counts = useMemo(() => {
    const map = new Map<EmailSkipReason, number>();
    for (const email of emails) map.set(email.reason, (map.get(email.reason) ?? 0) + 1);
    return map;
  }, [emails]);
  const active = reason !== 'all' && !counts.has(reason) ? 'all' : reason;
  const shown = active === 'all' ? emails : emails.filter((email) => email.reason === active);

  return (
    <Drawer
      title={t('todo.skipped.title')}
      width='min(460px, 100vw)'
      visible={open}
      onCancel={onClose}
      footer={null}
      unmountOnExit
    >
      <div className='flex flex-col gap-14px'>
        <p className='m-0 text-12px leading-19px text-t-tertiary'>{t('todo.skipped.hint')}</p>
        {counts.size > 1 && (
          <div className='flex flex-wrap gap-6px'>
            {(['all', ...REASONS.filter((key) => counts.has(key))] as const).map((key) => (
              <Tag
                key={key}
                checkable
                checked={active === key}
                color={active === key ? 'arcoblue' : undefined}
                onCheck={() => setReason(key)}
              >
                <span className='inline-flex items-center gap-4px'>
                  {key === 'all' ? t('todo.skipped.all') : t(`todo.skipped.reason.${key}`)}
                  <span className='tabular-nums opacity-70'>{key === 'all' ? emails.length : counts.get(key)}</span>
                </span>
              </Tag>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <div className='py-48px'>
            <Empty description={t('todo.skipped.empty')} />
          </div>
        ) : (
          <div className='rd-12px border border-[var(--border-base)] overflow-hidden'>
            {shown.map((email, index) => (
              <div
                key={email.message_id}
                className={
                  index > 0
                    ? 'flex gap-12px px-14px py-12px border-t border-[var(--border-light)]'
                    : 'flex gap-12px px-14px py-12px'
                }
              >
                <div className='flex-1 min-w-0 flex flex-col gap-4px'>
                  <span className='text-13px leading-20px font-500 text-t-primary line-clamp-2 break-words'>
                    {email.subject || t('todo.skipped.noSubject')}
                  </span>
                  <span className='text-12px text-t-tertiary truncate'>
                    {[email.from, formatFullDate(email.received_at, locale, true)].filter(Boolean).join(' · ')}
                  </span>
                  <div className='flex flex-wrap items-center gap-6px mt-2px'>
                    <Tag size='small' bordered={false} color={REASON_COLOR[email.reason] ?? 'gray'}>
                      {t(`todo.skipped.reason.${REASONS.includes(email.reason) ? email.reason : 'other'}`)}
                    </Tag>
                    {email.owner && (
                      <span className='text-12px text-t-secondary'>
                        {t('todo.skipped.owner', { name: email.owner })}
                      </span>
                    )}
                    {email.by === 'user' && (
                      <span className='text-12px text-t-tertiary'>{t('todo.skipped.byUser')}</span>
                    )}
                  </div>
                  {email.note && (
                    <span className='text-12px leading-18px text-t-secondary break-words'>{email.note}</span>
                  )}
                </div>
                <Button size='mini' className='shrink-0 self-start' onClick={() => onRestore(email)}>
                  <span className='inline-flex items-center gap-4px'>
                    <Plus theme='outline' fill='currentColor' size='12' />
                    <span>{t('todo.skipped.restore')}</span>
                  </span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
