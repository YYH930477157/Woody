import React, { Suspense, useState } from 'react';
import { Button, Drawer, Spin } from '@arco-design/web-react';
import { Terminal } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const TerminalPanel = React.lazy(() => import('./TerminalPanel'));

export default function TerminalButton({ conversationId, cwd }: { conversationId?: string; cwd?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  if (!window.electronAPI) return null;
  return (
    <>
      <Button
        type='text'
        size='small'
        icon={<Terminal size={17} />}
        title={t('tools.terminal.title')}
        aria-label={t('tools.terminal.title')}
        onClick={() => setVisible(true)}
      />
      <Drawer
        title={t('tools.terminal.title')}
        width='85%'
        visible={visible}
        onCancel={() => setVisible(false)}
        footer={null}
        unmountOnExit
      >
        <Suspense fallback={<Spin />}>
          <TerminalPanel conversationId={conversationId} cwd={cwd} />
        </Suspense>
      </Drawer>
    </>
  );
}
