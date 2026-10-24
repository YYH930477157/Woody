import React, { useState } from 'react';
import { Button, Collapse, Table, Tag } from '@arco-design/web-react';
import { Check } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeToolCheck, CmakeTools as Tools } from '@/common/types/cmake';
import styles from './CmakePanel.module.css';

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
  const hasFailures = !!checks?.some((check) => check.status !== 'found');
  const [detailsOpen, setDetailsOpen] = useState(hasFailures);
  // Follow failures during render rather than in an effect: an effect runs after the first commit and would undo a
  // click that lands before it.
  const [failuresShown, setFailuresShown] = useState(hasFailures);
  if (failuresShown !== hasFailures) {
    setFailuresShown(hasFailures);
    setDetailsOpen(hasFailures);
  }
  const labels = {
    cmake: 'cmakePath',
    ctest: 'ctestPath',
    cCompiler: 'cCompilerPath',
    cxxCompiler: 'cxxCompilerPath',
    make: 'makePath',
  } as const;
  const statuses = {
    found: 'toolFound',
    missing: 'toolMissing',
    failed: 'toolFailed',
    unchecked: 'toolUnchecked',
  } as const;
  const rows = (Object.keys(labels) as Array<keyof Tools>).map((name) => {
    const current = checks?.find((entry) => entry.name === name);
    return {
      name,
      path: current?.path || tools[name],
      version: current?.version,
      error: current?.error,
      status: current?.status || ('unchecked' as const),
    };
  });
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h3 className={styles.sectionTitle}>{t('tools.cmake.localTools')}</h3>
        <Button
          icon={<Check />}
          disabled={disabled}
          onClick={() => {
            void onCheck();
          }}
        >
          {t('tools.cmake.check')}
        </Button>
      </div>
      <Collapse
        bordered={false}
        activeKey={detailsOpen ? ['tools'] : []}
        onChange={(_key, keys) => setDetailsOpen(keys.includes('tools'))}
      >
        <Collapse.Item name='tools' header={t('tools.cmake.toolPathColumn')}>
          <Table
            size='small'
            pagination={false}
            rowKey='name'
            data={rows}
            className={styles.toolTable}
            columns={[
              {
                title: t('tools.cmake.toolColumn'),
                dataIndex: 'name',
                render: (name: keyof Tools) => t(`tools.cmake.${labels[name]}`),
              },
              {
                title: t('tools.cmake.toolPathColumn'),
                dataIndex: 'path',
                render: (_: unknown, row) => (
                  <div className={styles.path}>
                    <div>{row.path || t('tools.cmake.autoDetect')}</div>
                    {row.version && <div className={styles.muted}>{row.version}</div>}
                    {row.error && <div>{errorText(row.error)}</div>}
                  </div>
                ),
              },
              {
                title: t('tools.cmake.toolStatusColumn'),
                dataIndex: 'status',
                render: (status: keyof typeof statuses) => (
                  <Tag color={status === 'found' ? 'green' : status === 'unchecked' ? undefined : 'red'}>
                    {t(`tools.cmake.${statuses[status]}`)}
                  </Tag>
                ),
              },
            ]}
          />
        </Collapse.Item>
      </Collapse>
      <div className={styles.muted}>
        {t(invalid ? 'tools.cmake.toolCheckBaseEnvironment' : 'tools.cmake.toolCheckScope')}
      </div>
    </section>
  );
}
