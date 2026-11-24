import React from 'react';
import { Button, Collapse, Form, Input, Select } from '@arco-design/web-react';
import { Save } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration, CmakeProject, CmakeReadOptions } from '@/common/types/cmake';
import { diagnosticText } from './ConfigurationActions';
import consoleStyles from '../BuildView/CmakeConsole.module.css';
import styles from '../CmakePanel.module.css';

const readerKeys = { auto: 'readerAuto', direct: 'readerDirect', powershell: 'readerPowershell' } as const;

/** How the variants file is read; saving these alone never persists other unsaved edits. */
export default function ReaderSettings({
  project,
  draft,
  disabled,
  onChange,
  onApply,
}: {
  project: CmakeProject;
  draft: CmakeConfiguration;
  disabled: boolean;
  onChange: (value: CmakeConfiguration) => void;
  onApply: (read: CmakeReadOptions) => Promise<void>;
}) {
  const { t } = useTranslation();
  const read = draft.read || { mode: 'auto', encoding: 'auto', powershellPath: '' };
  const hasDiagnostics = !!project.configurationError || (project.configurationWarnings?.length ?? 0) > 0;
  return (
    <>
      <Form layout='vertical' className={styles.formGrid} disabled={disabled}>
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
            onChange={(encoding: CmakeReadOptions['encoding']) => onChange({ ...draft, read: { ...read, encoding } })}
            options={(['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be'] as const).map((encoding) => ({
              value: encoding,
              label: encoding === 'auto' ? t('tools.cmake.encodingAuto') : encoding.toUpperCase(),
            }))}
          />
        </Form.Item>
        <Form.Item label={t('tools.cmake.powershellPath')} className={styles.formWide}>
          <Input
            aria-label={t('tools.cmake.powershellPath')}
            value={read.powershellPath}
            placeholder={t('tools.cmake.autoDetect')}
            onChange={(powershellPath) => onChange({ ...draft, read: { ...read, powershellPath } })}
          />
        </Form.Item>
      </Form>
      {project.readInfo?.executable && <div className={styles.muted}>{project.readInfo.executable}</div>}
      <div className={styles.cardActions}>
        <Button
          size='small'
          icon={<Save />}
          disabled={disabled}
          onClick={() => {
            void onApply(read);
          }}
        >
          {t('tools.cmake.applyReadSettings')}
        </Button>
      </div>
      {hasDiagnostics && (
        <Collapse bordered={false}>
          <Collapse.Item name='diagnostic' header={t('tools.cmake.diagnosticDetails')}>
            <pre className={consoleStyles.snippet}>{diagnosticText(project)}</pre>
          </Collapse.Item>
        </Collapse>
      )}
    </>
  );
}
