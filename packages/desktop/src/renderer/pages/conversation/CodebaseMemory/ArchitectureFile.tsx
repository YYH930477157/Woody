import React from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { CodebaseMemoryArchitecture } from '@/common/types/codebaseMemory/types';

type ArchitectureFileProps = {
  architecture?: CodebaseMemoryArchitecture;
  disabled: boolean;
  generating: boolean;
  onGenerate: () => void;
};

/** The project's .woody/architecture.md: generate it once, then it follows every index. */
export default function ArchitectureFile({ architecture, disabled, generating, onGenerate }: ArchitectureFileProps) {
  const { t } = useTranslation();
  const generatedAt = architecture?.generatedAt;
  return (
    <div className='flex flex-col gap-6px'>
      <div className='flex items-center justify-between gap-8px'>
        <span>{t('conversation.codebaseMemory.architecture.title')}</span>
        <Button size='small' disabled={disabled} loading={generating} onClick={onGenerate}>
          {generatedAt
            ? t('conversation.codebaseMemory.architecture.update')
            : t('conversation.codebaseMemory.architecture.generate')}
        </Button>
      </div>
      <div className='text-12px text-t-secondary'>{t('conversation.codebaseMemory.architecture.hint')}</div>
      {generatedAt !== undefined && (
        <div className='text-12px text-t-secondary'>
          {t('conversation.codebaseMemory.architecture.summary', {
            time: new Date(generatedAt).toLocaleString(),
            tasks: architecture?.tasks ?? 0,
            tables: architecture?.tables ?? 0,
          })}
        </div>
      )}
      {architecture?.error && (
        <Alert
          type='warning'
          content={t('conversation.codebaseMemory.architecture.failed', { error: architecture.error })}
        />
      )}
    </div>
  );
}
