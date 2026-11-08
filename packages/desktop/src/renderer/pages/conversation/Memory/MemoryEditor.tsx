import React, { useState } from 'react';
import { Button, Input, Popconfirm, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { MemoryEntry, MemoryInput, MemoryType } from '@/common/types/memory';

const TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

type MemoryEditorProps = {
  entry?: MemoryEntry;
  busy: boolean;
  onSave: (input: MemoryInput) => void;
  onRemove?: () => void;
  onClose: () => void;
};

/** Edit one memory, or write a new one when `entry` is absent. */
export default function MemoryEditor({ entry, busy, onSave, onRemove, onClose }: MemoryEditorProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(entry?.name ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [type, setType] = useState<MemoryType | undefined>(entry?.type ?? 'project');
  const [body, setBody] = useState(entry?.body ?? '');
  const valid = name.trim() !== '' && body.trim() !== '';
  return (
    <div className='flex flex-col gap-6px p-8px rd-6px bg-2'>
      <Input
        aria-label={t('conversation.memory.fields.name')}
        placeholder={t('conversation.memory.fields.name')}
        value={name}
        onChange={setName}
      />
      <Input
        aria-label={t('conversation.memory.fields.description')}
        placeholder={t('conversation.memory.fields.description')}
        value={description}
        onChange={setDescription}
      />
      <Select
        aria-label={t('conversation.memory.fields.type')}
        value={type}
        onChange={(value: MemoryType) => setType(value)}
        options={TYPES.map((value) => ({ value, label: t(`conversation.memory.types.${value}`) }))}
      />
      <Input.TextArea
        aria-label={t('conversation.memory.fields.body')}
        placeholder={t('conversation.memory.fields.body')}
        value={body}
        onChange={setBody}
        autoSize={{ minRows: 4, maxRows: 14 }}
      />
      <div className='flex flex-wrap items-center gap-8px'>
        <Button
          type='primary'
          size='small'
          disabled={!valid}
          loading={busy}
          onClick={() => onSave({ file: entry?.file, name, description, type, body })}
        >
          {t('common.save')}
        </Button>
        <Button size='small' onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {entry && onRemove && (
          <Popconfirm title={t('conversation.memory.removeConfirm')} onOk={onRemove}>
            <Button size='small' status='danger' disabled={busy}>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        )}
      </div>
    </div>
  );
}
