/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionFolderState } from '@/common/adapter/ipcBridge';
import { Checkbox } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React from 'react';

const VISIBLE_FOLDERS = 3;

type SessionFoldersChoiceProps = {
  folders: SessionFolderState[];
  /** Passed in: the dialog content renders outside this page's React tree. */
  t: TFunction;
  onChange: (checked: boolean) => void;
};

/** The delete dialog's opt-in for moving the deleted chats' folders to the trash. Off by default. */
const SessionFoldersChoice: React.FC<SessionFoldersChoiceProps> = ({ folders, t, onChange }) => {
  const [checked, setChecked] = React.useState(false);
  const hidden = folders.length - VISIBLE_FOLDERS;
  return (
    <div className='mt-12px flex flex-col gap-6px text-left'>
      <Checkbox
        checked={checked}
        onChange={(value: boolean) => {
          setChecked(value);
          onChange(value);
        }}
      >
        {t('settings.archived.trashSessionFolders', { count: folders.length })}
      </Checkbox>
      <div className='pl-24px flex flex-col gap-2px text-12px text-t-secondary'>
        {folders.slice(0, VISIBLE_FOLDERS).map((folder) => (
          <div key={folder.dir} className='break-all'>
            {folder.dir}
            {' · '}
            {t('settings.archived.sessionFolderFiles', { count: folder.files })}
          </div>
        ))}
        {hidden > 0 ? <div>{t('settings.archived.sessionFoldersMore', { count: hidden })}</div> : null}
      </div>
    </div>
  );
};

export default SessionFoldersChoice;
