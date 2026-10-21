import React, { Suspense, useState } from 'react';
import { Button, Drawer, Spin } from '@arco-design/web-react';
import { Tool } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const CmakePanel = React.lazy(() => import('./CmakePanel'));
export default function CmakeButton({ cwd }: { cwd?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  if (!window.electronAPI) return null;
  return (
    <>
      <Button
        type='text'
        size='small'
        icon={<Tool size={17} />}
        title={t('tools.cmake.title')}
        aria-label={t('tools.cmake.title')}
        onClick={() => setVisible(true)}
      />
      <Drawer
        title={t('tools.cmake.title')}
        width='min(100vw, 1100px)'
        visible={visible}
        onCancel={() => setVisible(false)}
        footer={null}
        unmountOnExit
      >
        <Suspense fallback={<Spin />}>
          <CmakePanel key={cwd} projectPath={cwd || ''} />
        </Suspense>
      </Drawer>
    </>
  );
}
