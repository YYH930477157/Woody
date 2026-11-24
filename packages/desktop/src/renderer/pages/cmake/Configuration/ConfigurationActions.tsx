import React from 'react';
import { Button } from '@arco-design/web-react';
import { Copy, FolderOpen, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeProject } from '@/common/types/cmake';
import styles from '../CmakePanel.module.css';

const readerKeys = { auto: 'readerAuto', direct: 'readerDirect', powershell: 'readerPowershell' } as const;

/** The JSON a user can paste into a bug report when the variants file will not load. */
export function diagnosticText(project: CmakeProject): string {
  return JSON.stringify(
    {
      projectPath: project.projectPath,
      configurationError: project.configurationError,
      configurationWarnings: project.configurationWarnings ?? [],
      diagnostic: project.diagnostic,
      readInfo: project.readInfo,
    },
    null,
    2
  );
}

/** Reload or locate the variants file, and say how it was read. */
export default function ConfigurationActions({
  project,
  disabled,
  onReload,
  onReveal,
  onCopy,
  onShowReaderSettings,
}: {
  project: CmakeProject;
  disabled: boolean;
  onReload: () => Promise<void>;
  onReveal: () => Promise<void>;
  onCopy: (text: string) => Promise<void>;
  /** Shown as a link when the reader settings live in another view. */
  onShowReaderSettings?: () => void;
}) {
  const { t } = useTranslation();
  const hasDiagnostics = !!project.configurationError || (project.configurationWarnings?.length ?? 0) > 0;
  return (
    <>
      {project.readInfo && (
        <div className={styles.muted}>
          {t('tools.cmake.effectiveReader', {
            reader: t(`tools.cmake.${readerKeys[project.readInfo.reader]}`),
            encoding: project.readInfo.encoding,
          })}
        </div>
      )}
      <div className={styles.cardActions}>
        <Button
          size='small'
          icon={<Refresh />}
          disabled={disabled}
          onClick={() => {
            void onReload();
          }}
        >
          {t('tools.cmake.reloadConfiguration')}
        </Button>
        {project.variantsFile && (
          <Button
            size='small'
            icon={<FolderOpen />}
            disabled={disabled}
            onClick={() => {
              void onReveal();
            }}
          >
            {t('tools.cmake.revealConfiguration')}
          </Button>
        )}
        {hasDiagnostics && (
          <Button
            size='small'
            icon={<Copy />}
            disabled={disabled}
            onClick={() => {
              void onCopy(diagnosticText(project));
            }}
          >
            {t('tools.cmake.copyDiagnostic')}
          </Button>
        )}
        {onShowReaderSettings && (
          <Button size='small' type='text' onClick={onShowReaderSettings}>
            {t('tools.cmake.readSettings')}
          </Button>
        )}
      </div>
    </>
  );
}
