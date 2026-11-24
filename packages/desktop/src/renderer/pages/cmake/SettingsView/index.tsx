import React from 'react';
import { Button, Checkbox, Form, Input, InputNumber } from '@arco-design/web-react';
import { Check, Save } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { deepEqual } from '@/common/utils/deepEqual';
import { ReadinessTag, TOOL_LABELS, ToolStatusIcon, toolReadiness, toolRows } from '../BuildView/CmakeTools';
import { ConfigurationActions, ReaderSettings } from '../Configuration';
import type { CmakeState } from '../useCmake';
import panel from '../CmakePanel.module.css';
import styles from './SettingsView.module.css';

/** Tool paths, build and run options, and how the variants file is read. Saved together with one button. */
export default function SettingsView({
  state,
  locked,
  dirty,
  errorText,
}: {
  state: CmakeState;
  locked: boolean;
  dirty: boolean;
  errorText: (text: string) => string;
}) {
  const { t } = useTranslation();
  const project = state.project!;
  const value = state.draft!;
  const onChange = state.setDraft;
  const checks = deepEqual(value.tools, project.config.tools) ? project.toolChecks : undefined;
  const rows = toolRows(value.tools, checks);

  return (
    <div className={styles.view}>
      <div className={styles.scroll}>
        <div className={styles.grid}>
          <section className={`${panel.card} ${styles.wide}`} aria-label={t('tools.cmake.localTools')}>
            <div className={panel.cardHeader}>
              <h3 className={panel.cardTitle}>{t('tools.cmake.localTools')}</h3>
              <div className={panel.cardActions}>
                <ReadinessTag readiness={toolReadiness(value.tools, checks)} />
                <Button
                  size='small'
                  icon={<Check />}
                  disabled={locked}
                  onClick={() => {
                    void state.saveAndStart('check');
                  }}
                >
                  {t('tools.cmake.check')}
                </Button>
              </div>
            </div>
            <Form layout='vertical' className={styles.tools} disabled={locked}>
              {rows.map((row) => (
                <Form.Item key={row.name} label={t(`tools.cmake.${TOOL_LABELS[row.name]}`)}>
                  <div className={styles.toolInput}>
                    <ToolStatusIcon status={row.status} />
                    <Input
                      aria-label={t(`tools.cmake.${TOOL_LABELS[row.name]}`)}
                      placeholder={t('tools.cmake.autoDetect')}
                      value={value.tools[row.name]}
                      onChange={(text) => onChange({ ...value, tools: { ...value.tools, [row.name]: text } })}
                    />
                  </div>
                  {(row.version || row.error) && (
                    <div className={row.error ? panel.toolBad : panel.muted}>
                      {row.error ? errorText(row.error) : row.version}
                    </div>
                  )}
                </Form.Item>
              ))}
            </Form>
            <div className={panel.muted}>
              {t(project.configurationError ? 'tools.cmake.toolCheckBaseEnvironment' : 'tools.cmake.toolCheckScope')}
            </div>
          </section>
          <section className={panel.card} aria-label={t('tools.cmake.buildSection')}>
            <h3 className={panel.cardTitle}>{t('tools.cmake.buildSection')}</h3>
            <Form layout='vertical' className={panel.formGrid} disabled={locked}>
              <Form.Item label={t('tools.cmake.target')} className={panel.formWide}>
                <Input
                  aria-label={t('tools.cmake.target')}
                  placeholder={t('tools.cmake.allTargets')}
                  value={value.target}
                  onChange={(target) => onChange({ ...value, target })}
                />
              </Form.Item>
              <Form.Item label={t('tools.cmake.jobs')}>
                <InputNumber
                  aria-label={t('tools.cmake.jobs')}
                  min={1}
                  max={32}
                  precision={0}
                  value={value.jobs}
                  onChange={(jobs) => onChange({ ...value, jobs: jobs || 1 })}
                />
              </Form.Item>
              <Form.Item label={t('tools.cmake.timeoutMinutes')}>
                <InputNumber
                  aria-label={t('tools.cmake.timeoutMinutes')}
                  min={1}
                  max={1440}
                  precision={0}
                  value={value.timeoutMs / 60000}
                  onChange={(minutes) => onChange({ ...value, timeoutMs: (minutes || 1) * 60000 })}
                />
              </Form.Item>
            </Form>
            <Checkbox
              disabled={locked}
              checked={value.require32Bit}
              onChange={(require32Bit) => onChange({ ...value, require32Bit })}
            >
              {t('tools.cmake.require32Bit')}
            </Checkbox>
          </section>
          <section className={panel.card} aria-label={t('tools.cmake.runSection')}>
            <h3 className={panel.cardTitle}>{t('tools.cmake.runSection')}</h3>
            <Form layout='vertical' disabled={locked}>
              <Form.Item label={t('tools.cmake.runExecutable')}>
                <Input
                  aria-label={t('tools.cmake.runExecutable')}
                  placeholder={t('tools.cmake.runExecutablePlaceholder')}
                  value={value.runExecutable}
                  onChange={(runExecutable) => onChange({ ...value, runExecutable })}
                />
              </Form.Item>
              <Form.Item label={t('tools.cmake.runArguments')}>
                <Input.TextArea
                  aria-label={t('tools.cmake.runArguments')}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  value={value.runArguments.join('\n')}
                  onChange={(text) =>
                    onChange({ ...value, runArguments: text ? text.replace(/\r\n?/g, '\n').split('\n') : [] })
                  }
                />
              </Form.Item>
            </Form>
          </section>
          <section className={`${panel.card} ${styles.wide}`} aria-label={t('tools.cmake.readSettings')}>
            <h3 className={panel.cardTitle}>{t('tools.cmake.readSettings')}</h3>
            <div className={panel.field}>
              <span className={panel.fieldLabel}>{t('tools.cmake.variantsFile')}</span>
              <span className={panel.fieldValue}>{project.variantsFile || t('tools.cmake.defaultVariants')}</span>
            </div>
            <ConfigurationActions
              project={project}
              disabled={locked}
              onReload={() => state.reloadConfiguration()}
              onReveal={state.revealConfiguration}
              onCopy={state.copy}
            />
            <ReaderSettings
              project={project}
              draft={value}
              disabled={locked}
              onChange={onChange}
              onApply={(read) => state.reloadConfiguration(read)}
            />
          </section>
        </div>
      </div>
      <footer className={styles.footer}>
        <span className={dirty ? styles.dirty : panel.muted}>
          {t(dirty ? 'tools.cmake.unsavedChanges' : 'tools.cmake.settingsSaved')}
        </span>
        <Button
          type='primary'
          icon={<Save />}
          disabled={locked}
          onClick={() => {
            void state.saveAndStart();
          }}
        >
          {t('tools.cmake.save')}
        </Button>
      </footer>
    </div>
  );
}
