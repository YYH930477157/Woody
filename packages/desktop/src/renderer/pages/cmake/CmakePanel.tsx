import React from 'react';
import { Alert, Button, Collapse, Empty, Form, Select, Spin, Switch, Tag, Tabs } from '@arco-design/web-react';
import { Check, Config, Tool, Pause, Play, Save, TestTube } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeAction } from '@/common/types/cmake';
import CmakeSettings from './CmakeSettings';
import { useCmake } from './useCmake';
import { useGdb } from './useGdb';
import GdbPanel from './GdbPanel';
import styles from './CmakePanel.module.css';

export default function CmakePanel({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation();
  const state = useCmake(projectPath);
  const debug = useGdb(projectPath);
  const { project, draft, job, pending } = state;
  const running = job?.status === 'running' || project?.latestJob?.status === 'running';
  const locked = running || pending || debug.active || debug.pending;
  const errorText = (text: string) => {
    const match = /^(cmake\.[A-Za-z]+)(:[\s\S]*)?$/.exec(text);
    return match ? t(`tools.${match[1]}` as 'tools.cmake.failed', { defaultValue: match[1] }) + (match[2] || '') : text;
  };
  const actions: Array<[CmakeAction, React.ReactNode]> = [
    ['check', <Check key='check' />],
    ['configure', <Config key='configure' />],
    ['build', <Tool key='build' />],
    ['test', <TestTube key='test' />],
    ['run', <Play key='run' />],
  ];
  if (!projectPath) return <Empty description={t('tools.cmake.noProject')} />;
  return (
    <div className={styles.panel}>
      {state.error && <Alert type='error' content={errorText(state.error)} />}
      {!draft || !project ? (
        !state.error && <Spin />
      ) : (
        <>
          {project.invalidSelections?.length ? (
            <Alert
              type='warning'
              content={`${t('tools.cmake.selectionChanged')}: ${project.invalidSelections.join(', ')}`}
            />
          ) : null}
          <div className={styles.header}>
            <strong className={styles.path}>{project.projectPath}</strong>
            <label className={styles.access}>
              <span>{t('tools.cmake.aiAccess')}</span>
              <Switch
                aria-label={t('tools.cmake.aiAccess')}
                checked={state.aiEnabled}
                loading={pending}
                onChange={(enabled) => {
                  void state.setAiEnabled(enabled);
                }}
              />
            </label>
          </div>
          <Tabs defaultActiveTab='build'>
            <Tabs.TabPane key='build' title={t('tools.gdb.buildTab')}>
              <div className={styles.panel}>
                <Form layout='vertical' className={styles.variants}>
                  {project.dimensions.map((dimension) => (
                    <Form.Item key={dimension.name} label={dimension.label}>
                      <Select
                        aria-label={dimension.label}
                        disabled={locked}
                        value={
                          (running ? (job || project.latestJob)?.selection?.[dimension.name] : undefined) ??
                          draft.selections[dimension.name] ??
                          project.selection[dimension.name]
                        }
                        onChange={(value: string) =>
                          state.setDraft({ ...draft, selections: { ...draft.selections, [dimension.name]: value } })
                        }
                      >
                        {dimension.choices.map((choice) => (
                          <Select.Option key={choice.id} value={choice.id}>
                            {choice.label}
                          </Select.Option>
                        ))}
                      </Select>
                    </Form.Item>
                  ))}
                </Form>
                <div className={styles.toolbar}>
                  {actions.map(([action, icon]) => (
                    <Button
                      key={action}
                      icon={icon}
                      type={action === 'build' ? 'primary' : 'secondary'}
                      disabled={locked || (action === 'run' && !draft.runExecutable)}
                      onClick={() => {
                        void state.saveAndStart(action);
                      }}
                    >
                      {t(`tools.cmake.${action}`)}
                    </Button>
                  ))}
                  <Button
                    icon={<Pause />}
                    disabled={!running || pending}
                    onClick={() => {
                      void state.cancel();
                    }}
                  >
                    {t('tools.cmake.cancel')}
                  </Button>
                  {job && (
                    <Tag color={job.status === 'failed' ? 'red' : job.status === 'succeeded' ? 'green' : undefined}>
                      {t(`tools.cmake.${job.action}`)} · {t(`tools.cmake.${job.status}`)}
                    </Tag>
                  )}
                </div>
                <Collapse bordered={false}>
                  <Collapse.Item header={t('tools.cmake.settings')} name='settings'>
                    <CmakeSettings value={draft} onChange={state.setDraft} disabled={locked} />
                    <Button
                      icon={<Save />}
                      disabled={locked}
                      onClick={() => {
                        void state.saveAndStart();
                      }}
                    >
                      {t('tools.cmake.save')}
                    </Button>
                  </Collapse.Item>
                </Collapse>
                <div className={styles.path}>
                  {t('tools.cmake.buildDirectory')}: {job?.buildDirectory || project.buildDirectory}
                </div>
                {job?.selection && (
                  <div className={styles.path}>
                    {Object.entries(job.selection)
                      .map(([name, choice]) => `${name}=${choice}`)
                      .join(' · ')}
                  </div>
                )}
                {job?.error && <Alert type='error' content={errorText(job.error)} />}
                {state.truncated && <Alert type='warning' content={t('tools.cmake.truncated')} />}
                <pre className={styles.output} aria-label={t('tools.cmake.output')} tabIndex={0}>
                  {state.output || t('tools.cmake.noOutput')}
                </pre>
              </div>
            </Tabs.TabPane>
            <Tabs.TabPane key='debug' title={t('tools.gdb.debugTab')}>
              <GdbPanel
                key={projectPath}
                debug={debug}
                draft={draft}
                onChange={state.setDraft}
                buildBusy={running || pending}
              />
            </Tabs.TabPane>
          </Tabs>
        </>
      )}
    </div>
  );
}
