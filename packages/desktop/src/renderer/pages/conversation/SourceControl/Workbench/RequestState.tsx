import React from 'react';
import { Button, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

export function RequestError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role='alert' className='p-12px text-danger break-words'>
      <p>{t('conversation.gitWorkbench.loadFailed')}</p>
      <p>{message}</p>
      <Button size='small' onClick={retry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div role='status' className='flex items-center gap-8px p-12px text-t-secondary'>
      <Spin size={16} />
      {t('common.loading')}
    </div>
  );
}
