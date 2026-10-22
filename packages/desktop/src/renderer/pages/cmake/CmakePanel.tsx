import React, { useEffect, useState } from 'react';
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
import { Config, Copy, Tool, Pause, Play, Refresh, Save, TestTube } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeAction } from '@/common/types/cmake';
import { deepEqual } from '@/common/utils/deepEqual';
import CmakeSettings from './CmakeSettings';
import CmakeRecovery from './CmakeRecovery';
import CmakeTools from './CmakeTools';
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
  // A conflict comes from the chosen combination, so the selectors and the save-then-run actions stay usable to
  // repair it; unreadable or invalid variants files still block them.
  const variantsBlocked = !!project?.configurationError && project.diagnostic?.kind !== 'conflict';
  const [projectChange, setProjectChange] = useState<() => void>();
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    setLogOpen(job?.status === 'running' || job?.status === 'failed');
  }, [job?.id, job?.status]);
  const toolChecks = project?.toolChecks;
  const toolsChanged = !!draft && !!project && !deepEqual(draft.tools, project.config.tools);
  const toolsReady =
    !toolsChanged &&
    !!draft &&
    toolChecks?.length === Object.keys(draft.tools).length &&
    toolChecks.every((tool) => tool.status === 'found');
  const toolsBlocked = !toolsChanged && toolChecks?.some((tool) => tool.status !== 'found');
  const changeProject = (action: () => void) => {
    if (locked) return;
    if (draft && project && !deepEqual(draft, project.config)) {
      setProjectChange(() => action);
    } else action();
  };
  const errorText = (text: string) => {
    const match = /^(cmake\.[A-Za-z]+)(:[\s\S]*)?$/.exec(text);
    return match ? t(`tools.${match[1]}` as 'tools.cmake.failed', { defaultValue: match[1] }) + (match[2] || '') : text;
  };
  const actions: Array<[CmakeAction, React.ReactNode]> = [
    ['build', <Tool key='build' />],
    ['configure', <Config key='configure' />],
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
        {project && state.workspace?.projects.length === 1 ? (
          <h2 className={styles.projectTitle}>
            {project.projectPath
              .replace(/[\\/]+$/, '')
              .split(/[\\/]/)
              .pop() || project.projectPath}
          </h2>
        ) : (
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
                label:
                  candidate.relativePath === '.'
                    ? candidate.projectPath
                        .replace(/[\\/]+$/, '')
                        .split(/[\\/]/)
                        .pop() || candidate.projectPath
                    : candidate.relativePath,
                value: candidate.projectPath,
              })) || []
            }
          />
        )}
        <Tooltip content={t('tools.cmake.rescan')}>
          <Button
            icon={<Refresh />}
            aria-label={t('tools.cmake.rescan')}
            disabled={locked}
            onClick={() => changeProject(state.refresh)}
          />
        </Tooltip>
      </div>
      {state.workspace?.settingsDiagnostic && (
        <Alert
          type='warning'
          title={t('tools.cmake.sourceSettingsUnreadable')}
          content={errorText(state.workspace.settingsDiagnostic.message)}
        />
      )}
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
            <div className={styles.readiness}>
              <Tag color='green'>{t('tools.cmake.projectReady')}</Tag>
              <Tag color={project.configurationError ? 'red' : 'green'}>
                {t(project.configurationError ? 'tools.cmake.configurationBlocked' : 'tools.cmake.configurationReady')}
              </Tag>
              <Tag color={toolsReady ? 'green' : toolsBlocked ? 'red' : undefined}>
                {t(
                  toolsReady
                    ? 'tools.cmake.toolsReady'
                    : toolsBlocked
                      ? 'tools.cmake.toolsBlocked'
                      : 'tools.cmake.toolsUnchecked'
                )}
              </Tag>
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
          <Collapse bordered={false}>
            <Collapse.Item name='project' header={t('tools.cmake.projectDetails')}>
              <div className={styles.path}>
                {t('tools.cmake.workspaceDirectory')}:{' '}
                {project.workspacePath || state.workspace?.workspacePath || projectPath}
              </div>
              <div className={styles.path}>
                {t('tools.cmake.sourceDirectory')}: {project.projectPath}
              </div>
              <div className={styles.path}>
                {t('tools.cmake.variantsFile')}: {project.variantsFile || t('tools.cmake.defaultVariants')}
              </div>
              {project.buildDirectory && (
                <div className={styles.path}>
                  {t('tools.cmake.buildDirectory')}: {project.buildDirectory}
                </div>
              )}
            </Collapse.Item>
          </Collapse>
          <CmakeRecovery
            project={project}
            draft={draft}
            disabled={locked}
            onChange={state.setDraft}
            onReload={state.reloadConfiguration}
            onReveal={state.revealConfiguration}
            onCopy={state.copy}
            errorText={errorText}
          />
          <Tabs defaultActiveTab='build'>
            <Tabs.TabPane key='build' title={t('tools.gdb.buildTab')}>
              <div className={styles.panel}>
                {!!project.dimensions.length && (
                  <h3 className={styles.sectionTitle}>{t('tools.cmake.buildOptions')}</h3>
                )}
                <Form layout='vertical' className={styles.variants}>
                  {project.dimensions.map((dimension) => (
                    <Form.Item
                      key={dimension.name}
                      label={
                        <span>
                          {dimension.label}
                          {dimension.label !== dimension.name && (
                            <span className={styles.identifier}> {dimension.name}</span>
                          )}
                        </span>
                      }
                    >
                      <Select
                        aria-label={dimension.label}
                        disabled={locked || variantsBlocked}
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
                            {choice.label !== choice.id && <span className={styles.identifier}> {choice.id}</span>}
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
                      disabled={locked || variantsBlocked || (action === 'run' && !draft.runExecutable)}
                      onClick={() => {
                        void state.saveAndStart(action);
                      }}
                    >
                      {t(`tools.cmake.${action}`)}
                    </Button>
                  ))}
                  {running && (
                    <Button
                      icon={<Pause />}
                      disabled={!running || pending}
                      onClick={() => {
                        void state.cancel();
                      }}
                    >
                      {t('tools.cmake.cancel')}
                    </Button>
                  )}
                </div>
                {!draft.runExecutable && <div className={styles.muted}>{t('tools.cmake.runMissingExecutable')}</div>}
                <CmakeTools
                  checks={toolsChanged ? undefined : toolChecks}
                  tools={draft.tools}
                  disabled={locked}
                  invalid={!!project.configurationError}
                  onCheck={() => state.saveAndStart('check')}
                  errorText={errorText}
                />
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
                {job && (
                  <section className={styles.section}>
                    <div className={styles.header}>
                      <h3 className={styles.sectionTitle}>{t('tools.cmake.result')}</h3>
                      <Tag color={job.status === 'failed' ? 'red' : job.status === 'succeeded' ? 'green' : undefined}>
                        {t(`tools.cmake.${job.action}`)} · {t(`tools.cmake.${job.status}`)}
                      </Tag>
                    </div>
                    {job.finishedAt && Number.isFinite(Date.parse(job.startedAt)) && (
                      <div className={styles.muted}>
                        {t('tools.cmake.duration', {
                          seconds: Math.max(0, (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000).toFixed(
                            1
                          ),
                        })}
                      </div>
                    )}
                    {job.buildDirectory && (
                      <div className={styles.path}>
                        {t('tools.cmake.buildDirectory')}: {job.buildDirectory}
                      </div>
                    )}
                    {Object.keys(job.selection ?? {}).length > 0 && (
                      <div className={styles.path}>
                        {Object.entries(job.selection)
                          .map(([name, choice]) => `${name}=${choice}`)
                          .join(' · ')}
                      </div>
                    )}
                    {job.error && <Alert type='error' content={errorText(job.error)} />}
                    <Collapse
                      bordered={false}
                      activeKey={logOpen ? ['output'] : []}
                      onChange={(keys) => setLogOpen(keys.includes('output'))}
                    >
                      <Collapse.Item name='output' header={t('tools.cmake.output')}>
                        <div className={styles.logTools}>
                          <Tooltip content={t('tools.cmake.copyOutput')}>
                            <Button
                              icon={<Copy />}
                              aria-label={t('tools.cmake.copyOutput')}
                              disabled={!state.output || pending}
                              onClick={() => {
                                void state.copy(state.output);
                              }}
                            />
                          </Tooltip>
                        </div>
                        {state.truncated && <Alert type='warning' content={t('tools.cmake.truncated')} />}
                        <pre className={styles.output} aria-label={t('tools.cmake.output')} tabIndex={0}>
                          {state.output || t('tools.cmake.noOutput')}
                        </pre>
                      </Collapse.Item>
                    </Collapse>
                  </section>
                )}
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
