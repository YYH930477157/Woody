import React, { Suspense, useCallback, useState } from 'react';
import { Button, Drawer, Spin } from '@arco-design/web-react';
import { Tool } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useLocalFilePreview } from '@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview';

const CmakePanel = React.lazy(() => import('./CmakePanel'));

/** Opens build problems and the paused source line in the preview beside the chat. */
function PanelWithPreview({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const openPreview = useLocalFilePreview(cwd);
  // The preview opens under this drawer; close the drawer so the file is in view.
  const openFile = useCallback(
    (filePath: string, line?: number, column?: number) => {
      onClose();
      void openPreview(filePath, { filePath, rawReference: filePath, line, column });
    },
    [onClose, openPreview]
  );
  return <CmakePanel key={cwd} projectPath={cwd || ''} onOpenFile={openFile} />;
}

export default function CmakeButton({ cwd }: { cwd?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const close = useCallback(() => setVisible(false), []);
  // Without a preview host (some embedded layouts) the panel works the same, minus opening files.
  const hasPreview = !!useOptionalPreviewContext();
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
        width='min(100vw, 1360px)'
        visible={visible}
        onCancel={close}
        footer={null}
        bodyStyle={{ padding: 0, overflow: 'hidden' }}
        unmountOnExit
      >
        <Suspense fallback={<Spin />}>
          {hasPreview ? (
            <PanelWithPreview cwd={cwd} onClose={close} />
          ) : (
            <CmakePanel key={cwd} projectPath={cwd || ''} />
          )}
        </Suspense>
      </Drawer>
    </>
  );
}
