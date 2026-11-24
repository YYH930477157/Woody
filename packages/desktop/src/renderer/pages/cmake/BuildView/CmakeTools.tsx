import React from 'react';
import { Button, Tag, Tooltip } from '@arco-design/web-react';
import { Check, CheckOne, CloseOne, Help } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { CmakeToolCheck, CmakeTools as Tools } from '@/common/types/cmake';
import styles from '../CmakePanel.module.css';

export const TOOL_LABELS = {
  cmake: 'cmakePath',
  ctest: 'ctestPath',
  cCompiler: 'cCompilerPath',
  cxxCompiler: 'cxxCompilerPath',
  make: 'makePath',
} as const;
const STATUS_LABELS = {
  found: 'toolFound',
  missing: 'toolMissing',
  failed: 'toolFailed',
  unchecked: 'toolUnchecked',
} as const;

export type ToolReadiness = 'toolsReady' | 'toolsBlocked' | 'toolsUnchecked';

/** `checks` is left out when the paths changed since the last check, so an old report never reads as current. */
export function toolReadiness(tools: Tools, checks?: CmakeToolCheck[]): ToolReadiness {
  if (checks?.some((check) => check.status !== 'found')) return 'toolsBlocked';
  if (checks?.length === Object.keys(tools).length) return 'toolsReady';
  return 'toolsUnchecked';
}

export function ReadinessTag({ readiness }: { readiness: ToolReadiness }) {
  const { t } = useTranslation();
  return (
    <Tag size='small' color={readiness === 'toolsReady' ? 'green' : readiness === 'toolsBlocked' ? 'red' : undefined}>
      {t(`tools.cmake.${readiness}`)}
    </Tag>
  );
}

export function ToolStatusIcon({ status }: { status: keyof typeof STATUS_LABELS }) {
  const { t } = useTranslation();
  return (
    <Tooltip content={t(`tools.cmake.${STATUS_LABELS[status]}`)}>
      <span
        className={classNames(
          styles.toolIcon,
          status === 'found' ? styles.toolFound : status === 'unchecked' ? styles.toolIdle : styles.toolBad
        )}
        aria-label={t(`tools.cmake.${STATUS_LABELS[status]}`)}
      >
        {status === 'found' ? (
          <CheckOne theme='filled' size='14' fill='currentColor' />
        ) : status === 'unchecked' ? (
          <Help theme='outline' size='14' fill='currentColor' />
        ) : (
          <CloseOne theme='filled' size='14' fill='currentColor' />
        )}
      </span>
    </Tooltip>
  );
}

export function toolRows(tools: Tools, checks?: CmakeToolCheck[]) {
  return (Object.keys(TOOL_LABELS) as Array<keyof Tools>).map((name) => {
    const current = checks?.find((entry) => entry.name === name);
    return {
      name,
      path: current?.path || tools[name],
      version: current?.version,
      error: current?.error,
      status: current?.status || ('unchecked' as const),
    };
  });
}

export default function CmakeTools({
  checks,
  tools,
  disabled,
  invalid,
  onCheck,
  errorText,
}: {
  checks?: CmakeToolCheck[];
  tools: Tools;
  disabled: boolean;
  invalid: boolean;
  onCheck: () => Promise<void>;
  errorText: (text: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <section className={styles.card} aria-label={t('tools.cmake.localTools')}>
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{t('tools.cmake.localTools')}</h3>
        <ReadinessTag readiness={toolReadiness(tools, checks)} />
      </div>
      <ul className={styles.toolList}>
        {toolRows(tools, checks).map((row) => (
          <li key={row.name} className={styles.toolRow}>
            <ToolStatusIcon status={row.status} />
            <div className={styles.field}>
              <span className={styles.toolName}>{t(`tools.cmake.${TOOL_LABELS[row.name]}`)}</span>
              <span className={styles.toolPath}>{row.path || t('tools.cmake.autoDetect')}</span>
              {row.error && <span className={styles.toolBad}>{errorText(row.error)}</span>}
            </div>
            {row.version && <span className={styles.toolVersion}>{row.version}</span>}
          </li>
        ))}
      </ul>
      <div className={styles.cardActions}>
        <Button
          size='small'
          icon={<Check />}
          disabled={disabled}
          onClick={() => {
            void onCheck();
          }}
        >
          {t('tools.cmake.check')}
        </Button>
      </div>
      <div className={styles.muted}>
        {t(invalid ? 'tools.cmake.toolCheckBaseEnvironment' : 'tools.cmake.toolCheckScope')}
      </div>
    </section>
  );
}
