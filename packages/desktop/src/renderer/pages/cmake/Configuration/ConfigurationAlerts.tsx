import React from 'react';
import { Alert } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { CmakeProject } from '@/common/types/cmake';
import styles from '../CmakePanel.module.css';

const issueKeys = {
  read: 'issueRead',
  syntax: 'issueSyntax',
  unsupported: 'issueUnsupported',
  conflict: 'issueConflict',
} as const;

/** What is wrong with the variants file, shown above every view because it blocks builds and debugging. */
export default function ConfigurationAlerts({
  project,
  errorText,
}: {
  project: CmakeProject;
  errorText: (text: string) => string;
}) {
  const { t } = useTranslation();
  const diagnostic = project.diagnostic;
  const warnings = project.configurationWarnings ?? [];
  return (
    <>
      {project.configurationError && (
        <Alert
          type='error'
          title={t(`tools.cmake.${issueKeys[diagnostic?.kind || 'read']}`)}
          content={
            <div className={styles.fieldValue}>
              {diagnostic?.file && <strong>{diagnostic.file.split(/[\\/]/).pop()}</strong>}
              <div>{errorText(diagnostic?.message || project.configurationError)}</div>
              {diagnostic?.supportedFields && (
                <div>
                  {t('tools.cmake.supportedVariantFields')}: <code>{diagnostic.supportedFields.join(', ')}</code>
                </div>
              )}
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
      {warnings.length > 0 && (
        <Alert
          type='warning'
          title={t('tools.cmake.variantCompatibility')}
          content={
            <div className={styles.fieldValue}>
              {project.variantsFile && <strong>{project.variantsFile.split(/[\\/]/).pop()}</strong>}
              <ul>
                {warnings.map((warning) => (
                  <li key={warning.fieldPath}>
                    <code>{warning.fieldPath}</code>: <span>{t(`tools.cmake.${warning.code}`)}</span>
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      )}
    </>
  );
}
