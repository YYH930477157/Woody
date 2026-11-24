import React, { useState } from 'react';
import { Alert, Button, Empty, Modal, Radio, Select, Spin, Switch, Tooltip } from '@arco-design/web-react';
import { Refresh, Tool } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration } from '@/common/types/cmake';
import { deepEqual } from '@/common/utils/deepEqual';
import BuildView from './BuildView';
import type { ConsoleViewState } from './BuildView/CmakeConsole';
import { ConfigurationAlerts } from './Configuration';
import GdbPanel from './GdbPanel';
import SettingsView from './SettingsView';
import { useCmake } from './useCmake';
import { useGdb } from './useGdb';
import styles from './CmakePanel.module.css';

export type CmakeView = 'build' | 'debug' | 'settings';
export type OpenFile = (filePath: string, line?: number, column?: number) => void;

const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/** Everything but the build options: those are picked in the toolbar and saved with the next run. */
const settingsChanged = (draft?: CmakeConfiguration, saved?: CmakeConfiguration) =>
  !!draft && !!saved && !deepEqual({ ...draft, selections: saved.selections }, saved);

export default function CmakePanel({ projectPath, onOpenFile }: { projectPath: string; onOpenFile?: OpenFile }) {
  const { t } = useTranslation();
  const state = useCmake(projectPath);
  const debug = useGdb(state.project?.projectPath || '', state.acceptSaved);
  const { project, draft, job, pending } = state;
  const running = job?.status === 'running' || project?.latestJob?.status === 'running';
  const locked = running || pending || debug.active || debug.pending || state.discovering;
  const [view, setView] = useState<CmakeView>('build');
  const [consoleState, setConsoleState] = useState<ConsoleViewState>();
  const [projectChange, setProjectChange] = useState<() => void>();
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
  if (!projectPath) return <Empty className={styles.state} description={t('tools.cmake.noProject')} />;
  const single = !!project && state.workspace?.projects.length === 1;
  const dirty = settingsChanged(draft, project?.config);

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
      <header className={styles.header}>
        <div className={styles.project}>
          <span className={styles.projectIcon}>
            <Tool theme='outline' size='16' fill='currentColor' />
          </span>
          {single && project ? (
            <h2 className={styles.projectTitle}>{folderName(project.projectPath)}</h2>
          ) : (
            <Select
              className={styles.projectSelect}
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
                  label: candidate.relativePath === '.' ? folderName(candidate.projectPath) : candidate.relativePath,
                  value: candidate.projectPath,
                })) || []
              }
            />
          )}
          <Tooltip content={t('tools.cmake.rescan')}>
            <Button
              size='small'
              type='text'
              icon={<Refresh />}
              aria-label={t('tools.cmake.rescan')}
              disabled={locked}
              onClick={() => changeProject(state.refresh)}
            />
          </Tooltip>
        </div>
        {project && draft && (
          <Radio.Group
            type='button'
            value={view}
            onChange={(next: CmakeView) => setView(next)}
            options={[
              { value: 'build', label: t('tools.gdb.buildTab') },
              { value: 'debug', label: t('tools.gdb.debugTab') },
              {
                value: 'settings',
                label: (
                  <span>
                    {t('tools.cmake.settings')}
                    {dirty && <span className={styles.dirtyDot} aria-label={t('tools.cmake.unsavedChanges')} />}
                  </span>
                ),
              },
            ]}
          />
        )}
        {project && (
          <label className={styles.headerEnd}>
            <span>{t('tools.cmake.aiAccess')}</span>
            <Switch
              size='small'
              aria-label={t('tools.cmake.aiAccess')}
              checked={state.aiEnabled}
              loading={pending}
              onChange={(enabled) => {
                void state.setAiEnabled(enabled);
              }}
            />
          </label>
        )}
      </header>
      <div className={styles.alerts}>
        {state.workspace?.settingsDiagnostic && (
          <Alert
            type='warning'
            title={t('tools.cmake.sourceSettingsUnreadable')}
            content={errorText(state.workspace.settingsDiagnostic.message)}
          />
        )}
        {state.error && <Alert type='error' content={errorText(state.error)} />}
        {project?.invalidSelections?.length ? (
          <Alert
            type='warning'
            content={`${t('tools.cmake.selectionChanged')}: ${project.invalidSelections.join(', ')}`}
          />
        ) : null}
        {project && <ConfigurationAlerts project={project} errorText={errorText} />}
      </div>
      {!draft || !project ? (
        !state.error && (
          <div className={styles.state}>
            {state.discovering ? (
              <Spin />
            ) : (
              <Empty
                description={t(
                  state.workspace?.projects.length ? 'tools.cmake.selectProject' : 'tools.cmake.projectMissing'
                )}
              />
            )}
          </div>
        )
      ) : view === 'build' ? (
        <BuildView
          state={state}
          locked={locked}
          running={running}
          errorText={errorText}
          onShowSettings={() => setView('settings')}
          onOpenFile={onOpenFile}
          consoleState={consoleState}
          onConsoleStateChange={setConsoleState}
        />
      ) : view === 'debug' ? (
        <GdbPanel
          key={project.projectPath}
          projectPath={project.projectPath}
          debug={debug}
          draft={draft}
          onChange={state.setDraft}
          buildBusy={running || pending}
          configurationInvalid={!!project.configurationError}
          onOpenFile={onOpenFile}
        />
      ) : (
        <SettingsView state={state} locked={locked} dirty={dirty} errorText={errorText} />
      )}
    </div>
  );
}
