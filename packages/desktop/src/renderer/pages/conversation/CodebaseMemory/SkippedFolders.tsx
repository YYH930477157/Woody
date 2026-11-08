import React, { useState } from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { CodebaseMemorySkippedFolder } from '@/common/types/codebaseMemory/types';

type SkippedFoldersProps = {
  folders: CodebaseMemorySkippedFolder[];
  disabled: boolean;
  including: boolean;
  onInclude: (folder: string) => void;
};

/** Source folders the indexer skipped by name, each with a way to index it after all. */
export default function SkippedFolders({ folders, disabled, including, onInclude }: SkippedFoldersProps) {
  const { t } = useTranslation();
  const [clicked, setClicked] = useState<string>();
  return (
    <Alert
      type='info'
      title={t('conversation.codebaseMemory.skipped.title')}
      content={
        <div className='flex flex-col gap-8px'>
          <span>{t('conversation.codebaseMemory.skipped.hint')}</span>
          {folders.map((folder) => (
            <div key={folder.path} className='flex flex-col gap-4px'>
              <div className='flex items-center justify-between gap-8px'>
                <div className='flex flex-col min-w-0'>
                  <span className='break-all text-t-primary'>{folder.path}</span>
                  <span className='text-12px text-t-secondary'>
                    {t('conversation.codebaseMemory.skipped.files', {
                      number: folder.more ? `${folder.files}+` : String(folder.files),
                    })}
                  </span>
                </div>
                {!folder.requested && !folder.manual && (
                  <Button
                    size='mini'
                    disabled={disabled}
                    loading={including && clicked === folder.path}
                    onClick={() => {
                      setClicked(folder.path);
                      onInclude(folder.path);
                    }}
                  >
                    {t('conversation.codebaseMemory.skipped.include')}
                  </Button>
                )}
              </div>
              {folder.requested && (
                <span className='text-12px text-t-secondary'>
                  {t('conversation.codebaseMemory.skipped.stillSkipped')}
                </span>
              )}
              {folder.manual && (
                <span className='text-12px text-t-secondary break-all'>
                  {t('conversation.codebaseMemory.skipped.manual', { line: `!/${folder.path}/` })}
                </span>
              )}
            </div>
          ))}
        </div>
      }
    />
  );
}
