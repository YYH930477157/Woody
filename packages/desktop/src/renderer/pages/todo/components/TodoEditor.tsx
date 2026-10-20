/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Form, Input, Message, Modal, Radio } from '@arco-design/web-react';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import type { ITodoItem } from '@/common/types/todo/todoTypes';
import type { TodoDraft } from '../useTodos';

export default function TodoEditor({
  open,
  item,
  defaults,
  heading,
  onCancel,
  onSave,
}: {
  open: boolean;
  item: ITodoItem | null;
  /** Prefill for new todos, e.g. the day picked on the calendar. */
  defaults?: Partial<TodoDraft>;
  /** Overrides the "new todo" title, e.g. when turning an email into a todo. */
  heading?: string;
  onCancel: () => void;
  onSave: (draft: TodoDraft) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [requester, setRequester] = useState('');
  const [status, setStatus] = useState<'pending' | 'waiting'>('pending');
  const [saving, setSaving] = useState(false);
  // A ref, not state: two Enter presses in one tick must not both start a save.
  const savingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const due = item ? item.due_at : defaults?.due_at;
    setTitle(item?.title || defaults?.title || '');
    setNotes(item ? item.notes || '' : defaults?.notes || '');
    setDueDate(due ? dayjs(due).format('YYYY-MM-DD') : '');
    setRequester(item ? item.requester || item.email_ref?.from || '' : defaults?.requester || '');
    setStatus(item?.status === 'waiting' || (!item && defaults?.status === 'waiting') ? 'waiting' : 'pending');
  }, [open, item, defaults]);

  const submit = async () => {
    if (savingRef.current) return;
    if (!title.trim()) {
      Message.warning(t('todo.titleRequired'));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      // Keep the existing time of day when only the date is edited.
      const previous = item?.due_at ? dayjs(item.due_at) : null;
      const due_at = dueDate
        ? previous && previous.format('YYYY-MM-DD') === dueDate
          ? previous.valueOf()
          : dayjs(dueDate).valueOf()
        : null;
      await onSave({ title: title.trim(), notes: notes.trim(), due_at, requester: requester.trim(), status });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      title={item ? t('todo.edit') : heading || t('todo.new')}
      visible={open}
      onCancel={onCancel}
      onOk={() => void submit()}
      okText={t('todo.save')}
      cancelText={t('todo.cancel')}
      confirmLoading={saving}
      style={{ width: 560 }}
      unmountOnExit
    >
      <Form layout='vertical' className='grid grid-cols-6 gap-x-12px'>
        <Form.Item className='col-span-6' required label={t('todo.editor.title')}>
          <Input
            autoFocus
            value={title}
            onChange={setTitle}
            placeholder={t('todo.titlePlaceholder')}
            maxLength={200}
            onPressEnter={() => void submit()}
          />
        </Form.Item>
        <Form.Item className='col-span-3' label={t('todo.editor.requester')}>
          <Input
            value={requester}
            onChange={setRequester}
            placeholder={t('todo.editor.requesterPlaceholder')}
            maxLength={60}
          />
        </Form.Item>
        <Form.Item className='col-span-3' label={t('todo.due')}>
          {/* Native date input: avoids a date picker the upstream app has not validated. */}
          <Input type='date' value={dueDate} onChange={setDueDate} />
        </Form.Item>
        <Form.Item className='col-span-6' label={t('todo.editor.statusGroup')}>
          <Radio.Group
            type='button'
            value={status}
            onChange={setStatus}
            options={[
              { value: 'pending', label: t('todo.editor.statusActive') },
              { value: 'waiting', label: t('todo.editor.statusWaiting') },
            ]}
          />
        </Form.Item>
        <Form.Item className='col-span-6 !mb-0' label={t('todo.editor.notes')}>
          <Input.TextArea
            value={notes}
            onChange={setNotes}
            placeholder={t('todo.notesPlaceholder')}
            maxLength={2000}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
