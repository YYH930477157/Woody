import React from 'react';
import { Alert, Button, Collapse, Form, Input, Select } from '@arco-design/web-react';
import { Copy, FolderOpen, Refresh, Save } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration, CmakeProject, CmakeReadOptions } from '@/common/types/cmake';
import styles from './CmakePanel.module.css';

export default function CmakeRecovery({
  project,
  draft,
  disabled,
  onChange,
  onReload,
  onReveal,
  onCopy,
  errorText,
}: {
  project: CmakeProject;
  draft: CmakeConfiguration;
  disabled: boolean;
  onChange: (value: CmakeConfiguration) => void;
  onReload: (read?: CmakeReadOptions) => Promise<void>;
  onReveal: () => Promise<void>;
  onCopy: (text: string) => Promise<void>;
  errorText: (text: string) => string;
}) {
  const { t } = useTranslation();
  const read = draft.read || { mode: 'auto', encoding: 'auto', powershellPath: '' };
  const diagnostic = project.diagnostic;
  const issueKeys = {
    read: 'issueRead',
    syntax: 'issueSyntax',
    unsupported: 'issueUnsupported',
    conflict: 'issueConflict',
  } as const;
  const readerKeys = { auto: 'readerAuto', direct: 'readerDirect', powershell: 'readerPowershell' } as const;
  const diagnosticText = JSON.stringify(
    {
      projectPath: project.projectPath,
      configurationError: project.configurationError,
      diagnostic,
      readInfo: project.readInfo,
    },
    null,
    2
  );
  return (
    <section className={styles.section}>
      {project.configurationError && (
        <Alert
          type='error'
          title={t(`tools.cmake.${issueKeys[diagnostic?.kind || 'read']}`)}
          content={
            <div className={styles.path}>
              {diagnostic?.file && <strong>{diagnostic.file.split(/[\\/]/).pop()}</strong>}
              <div>{errorText(diagnostic?.message || project.configurationError)}</div>
              {diagnostic?.line && (
                <div>
                  {diagnostic.column
                    ? t('tools.cmake.location', { line: diagnostic.line, column: diagnostic.column })
                    : t('tools.cmake.lineLocation', { line: diagnostic.line })}
                </div>
              )}
            </div>
          }
        />
      )}
      <div className={styles.toolbar}>
        <Button
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
            icon={<FolderOpen />}
            disabled={disabled}
            onClick={() => {
              void onReveal();
            }}
          >
            {t('tools.cmake.revealConfiguration')}
          </Button>
        )}
        {project.configurationError && (
          <Button
            icon={<Copy />}
            disabled={disabled}
            onClick={() => {
              void onCopy(diagnosticText);
            }}
          >
            {t('tools.cmake.copyDiagnostic')}
          </Button>
        )}
      </div>
      {project.readInfo && (
        <div className={styles.muted}>
          {t('tools.cmake.effectiveReader', {
            reader: t(`tools.cmake.${readerKeys[project.readInfo.reader]}`),
            encoding: project.readInfo.encoding,
          })}
        </div>
      )}
      <Collapse bordered={false}>
        <Collapse.Item name='reader' header={t('tools.cmake.readSettings')}>
          <Form layout='vertical' className={styles.settings} disabled={disabled}>
            <Form.Item label={t('tools.cmake.readerMode')}>
              <Select
                aria-label={t('tools.cmake.readerMode')}
                value={read.mode}
                onChange={(mode: CmakeReadOptions['mode']) => onChange({ ...draft, read: { ...read, mode } })}
                options={(['auto', 'powershell', 'direct'] as const).map((mode) => ({
                  value: mode,
                  label: t(`tools.cmake.${readerKeys[mode]}`),
                }))}
              />
            </Form.Item>
            <Form.Item label={t('tools.cmake.readEncoding')}>
              <Select
                aria-label={t('tools.cmake.readEncoding')}
                value={read.encoding}
                onChange={(encoding: CmakeReadOptions['encoding']) =>
                  onChange({ ...draft, read: { ...read, encoding } })
                }
                options={(['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'] as const).map((encoding) => ({
                  value: encoding,
                  label: encoding === 'auto' ? t('tools.cmake.encodingAuto') : encoding.toUpperCase(),
                }))}
              />
            </Form.Item>
            <Form.Item label={t('tools.cmake.powershellPath')}>
              <Input
                aria-label={t('tools.cmake.powershellPath')}
                value={read.powershellPath}
                placeholder={t('tools.cmake.autoDetect')}
                onChange={(powershellPath) => onChange({ ...draft, read: { ...read, powershellPath } })}
              />
            </Form.Item>
          </Form>
          {project.readInfo?.executable && <div className={styles.path}>{project.readInfo.executable}</div>}
          <Button
            icon={<Save />}
            disabled={disabled}
            onClick={() => {
              void onReload(read);
            }}
          >
            {t('tools.cmake.applyReadSettings')}
          </Button>
        </Collapse.Item>
        {project.configurationError && (
          <Collapse.Item name='diagnostic' header={t('tools.cmake.diagnosticDetails')}>
            <pre className={styles.output}>{diagnosticText}</pre>
          </Collapse.Item>
        )}
      </Collapse>
    </section>
  );
}
