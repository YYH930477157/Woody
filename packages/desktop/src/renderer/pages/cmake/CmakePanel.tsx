import React, { useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Form,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  Tabs,
  Tooltip,
} from '@arco-design/web-react';
import { Check, Config, Tool, Pause, Play, Refresh, Save, TestTube } from '@icon-park/react';
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
  const debug = useGdb(state.project?.projectPath || '');
  const { project, draft, job, pending } = state;
  const running = job?.status === 'running' || project?.latestJob?.status === 'running';
  const locked = running || pending || debug.active || debug.pending || state.discovering;
  const [projectChange, setProjectChange] = useState<() => void>();
  const changeProject = (action: () => void) => {
    if (locked) return;
    if (draft && project && JSON.stringify(draft) !== JSON.stringify(project.config)) {
      setProjectChange(() => action);
    } else action();
  };
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
      <Modal
        title={t('tools.cmake.unsavedChanges')}
        visible={!!projectChange}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: locked }}
        onCancel={() => setProjectChange(undefined)}
        onOk={() => {
          if (locked) return;
          projectChange?.();
          setProjectChange(undefined);
        }}
      >
        {t('tools.cmake.discardChanges')}
      </Modal>
      <div className={styles.projectSelector}>
        <Select
          aria-label={t('tools.cmake.project')}
          placeholder={t('tools.cmake.selectProject')}
          value={state.workspace?.selectedProjectPath}
          loading={state.discovering}
          disabled={locked || !state.workspace?.projects.length}
          onChange={(value: string) => {
            const selected = state.workspace?.projects.find((candidate) => candidate.projectPath === value);
            if (selected && value !== state.workspace?.selectedProjectPath)
              changeProject(() => state.selectProject(selected.relativePath));
          }}
          options={
            state.workspace?.projects.map((candidate) => ({
              label: candidate.relativePath,
              value: candidate.projectPath,
            })) || []
          }
        />
        <Tooltip content={t('tools.cmake.rescan')}>
          <Button
            icon={<Refresh />}
            aria-label={t('tools.cmake.rescan')}
            disabled={locked}
            onClick={() => changeProject(state.refresh)}
          />
        </Tooltip>
      </div>
      {state.error && <Alert type='error' content={errorText(state.error)} />}
      {!draft || !project ? (
        !state.error &&
        (state.discovering ? (
          <Spin />
        ) : (
          <Empty
            description={t(
              state.workspace?.projects.length ? 'tools.cmake.selectProject' : 'tools.cmake.projectMissing'
            )}
          />
        ))
      ) : (
        <>
          {project.invalidSelections?.length ? (
            <Alert
              type='warning'
              content={`${t('tools.cmake.selectionChanged')}: ${project.invalidSelections.join(', ')}`}
            />
          ) : null}
          <div className={styles.header}>
            <div className={styles.path}>
              <div>
                {t('tools.cmake.workspaceDirectory')}:{' '}
                {project.workspacePath || state.workspace?.workspacePath || projectPath}
              </div>
              <div>
                {t('tools.cmake.sourceDirectory')}: {project.projectPath}
              </div>
              <div>
                {t('tools.cmake.variantsFile')}: {project.variantsFile || t('tools.cmake.defaultVariants')}
              </div>
            </div>
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
          {project.configurationError && (
            <Alert type='error' className={styles.path} content={errorText(project.configurationError)} />
          )}
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
                      disabled={locked || !!project.configurationError || (action === 'run' && !draft.runExecutable)}
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
                key={project.projectPath}
                debug={debug}
                draft={draft}
                onChange={state.setDraft}
                buildBusy={running || pending}
                configurationInvalid={!!project.configurationError}
              />
            </Tabs.TabPane>
          </Tabs>
        </>
      )}
    </div>
  );
}
