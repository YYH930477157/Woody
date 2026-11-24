import React, { useEffect, useState } from 'react';
import { Button, Select, Tag } from '@arco-design/web-react';
import { Config, Pause, Play, TestTube, Tool } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { CmakeAction, CmakeJob } from '@/common/types/cmake';
import { deepEqual } from '@/common/utils/deepEqual';
import { projectRelativePath } from '../cmakeProblems';
import type { OpenFile } from '../CmakePanel';
import { ConfigurationActions } from '../Configuration';
import type { CmakeState } from '../useCmake';
import CmakeConsole, { type ConsoleViewState } from './CmakeConsole';
import CmakeTools from './CmakeTools';
import styles from '../CmakePanel.module.css';

const SECONDARY_ACTIONS: Array<[CmakeAction, React.ReactNode]> = [
  ['configure', <Config key='configure' />],
  ['test', <TestTube key='test' />],
  ['run', <Play key='run' />],
];

function seconds(job: CmakeJob, now: number): number | undefined {
  const started = Date.parse(job.startedAt);
  if (!Number.isFinite(started)) return undefined;
  const finished = job.finishedAt ? Date.parse(job.finishedAt) : now;
  return Number.isFinite(finished) ? Math.max(0, (finished - started) / 1000) : undefined;
}

/** What the last job is doing, with a live clock while it runs. */
function JobStatus({ job }: { job?: CmakeJob }) {
  const { t } = useTranslation();
  const running = job?.status === 'running';
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!job) return null;
  const elapsed = seconds(job, running ? now : Date.now());
  return (
    <span
      role='status'
      className={classNames(
        styles.statusPill,
        running && styles.statusRunning,
        job.status === 'succeeded' && styles.statusSucceeded,
        job.status === 'failed' && styles.statusFailed
      )}
    >
      <span className={styles.statusDot} />
      {t(`tools.cmake.${job.action}`)} · {t(`tools.cmake.${job.status}`)}
      {elapsed !== undefined && ` · ${t('tools.cmake.duration', { seconds: elapsed.toFixed(running ? 0 : 1) })}`}
    </span>
  );
}

export default function BuildView({
  state,
  locked,
  running,
  errorText,
  onShowSettings,
  onOpenFile,
  consoleState,
  onConsoleStateChange,
}: {
  state: CmakeState;
  locked: boolean;
  running: boolean;
  errorText: (text: string) => string;
  onShowSettings: () => void;
  onOpenFile?: OpenFile;
  consoleState?: ConsoleViewState;
  onConsoleStateChange?: (state: ConsoleViewState) => void;
}) {
  const { t } = useTranslation();
  const project = state.project!;
  const draft = state.draft!;
  const job = state.job;
  // A conflict comes from the chosen combination, so the selectors and the save-then-run actions stay usable to
  // repair it; unreadable or invalid variants files still block them.
  const variantsBlocked = !!project.configurationError && project.diagnostic?.kind !== 'conflict';
  const toolsChanged = !deepEqual(draft.tools, project.config.tools);
  const blocked = locked || variantsBlocked;
  const start = (action: CmakeAction) => {
    void state.saveAndStart(action);
  };

  return (
    <>
      <div className={styles.toolbar}>
        {project.dimensions.map((dimension) => (
          // A div, not a label element: Chromium forwards a label click to the Select's input and closes its popup.
          <div key={dimension.name} className={styles.variant}>
            <span className={styles.variantLabel} title={dimension.description || dimension.name}>
              {dimension.label}
              {dimension.label !== dimension.name && <span className={styles.identifier}> {dimension.name}</span>}
            </span>
            <Select
              aria-label={dimension.label}
              disabled={blocked}
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
          </div>
        ))}
        <div className={styles.actions}>
          <Button type='primary' icon={<Tool />} disabled={blocked} onClick={() => start('build')}>
            {t('tools.cmake.build')}
          </Button>
          {SECONDARY_ACTIONS.map(([action, icon]) => (
            <Button
              key={action}
              icon={icon}
              disabled={blocked || (action === 'run' && !draft.runExecutable)}
              onClick={() => start(action)}
            >
              {t(`tools.cmake.${action}`)}
            </Button>
          ))}
          {running && (
            <Button
              status='danger'
              icon={<Pause />}
              disabled={state.pending}
              onClick={() => {
                void state.cancel();
              }}
            >
              {t('tools.cmake.cancel')}
            </Button>
          )}
        </div>
        <div className={styles.toolbarEnd}>
          <JobStatus job={job || project.latestJob} />
        </div>
      </div>
      <div className={styles.split}>
        <aside className={styles.sidebar}>
          <section className={styles.card} aria-label={t('tools.cmake.projectDetails')}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>{t('tools.cmake.projectDetails')}</h3>
              <Tag size='small' color={project.configurationError ? 'red' : 'green'}>
                {t(project.configurationError ? 'tools.cmake.configurationBlocked' : 'tools.cmake.configurationReady')}
              </Tag>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('tools.cmake.sourceDirectory')}</span>
              <span className={styles.pathValue} title={project.projectPath}>
                {project.projectPath}
              </span>
            </div>
            {project.buildDirectory && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('tools.cmake.buildDirectory')}</span>
                <span className={styles.pathValue} title={project.buildDirectory}>
                  {projectRelativePath(project.buildDirectory, project.projectPath)}
                </span>
              </div>
            )}
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('tools.cmake.variantsFile')}</span>
              <span className={styles.pathValue} title={project.variantsFile}>
                {project.variantsFile
                  ? projectRelativePath(project.variantsFile, project.projectPath)
                  : t('tools.cmake.defaultVariants')}
              </span>
            </div>
            <ConfigurationActions
              project={project}
              disabled={locked}
              onReload={() => state.reloadConfiguration()}
              onReveal={state.revealConfiguration}
              onCopy={state.copy}
              onShowReaderSettings={onShowSettings}
            />
          </section>
          <CmakeTools
            checks={toolsChanged ? undefined : project.toolChecks}
            tools={draft.tools}
            disabled={locked}
            invalid={!!project.configurationError}
            onCheck={() => state.saveAndStart('check')}
            errorText={errorText}
          />
          <section className={styles.card} aria-label={t('tools.cmake.runSection')}>
            <div className={styles.cardHeader}>
              <h3 className={styles.cardTitle}>{t('tools.cmake.runSection')}</h3>
              <Button size='mini' type='text' onClick={onShowSettings}>
                {t('tools.cmake.editSettings')}
              </Button>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('tools.cmake.runExecutable')}</span>
              <span className={draft.runExecutable ? styles.fieldValue : styles.muted}>
                {draft.runExecutable || t('tools.cmake.runMissingExecutable')}
              </span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('tools.cmake.target')}</span>
              <span className={styles.fieldValue}>{draft.target || t('tools.cmake.allTargets')}</span>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('tools.cmake.jobs')}</span>
              <span className={styles.fieldValue}>{draft.jobs}</span>
            </div>
          </section>
        </aside>
        <div className={styles.main}>
          <CmakeConsole
            job={job}
            output={state.output}
            truncated={state.truncated}
            pending={state.pending}
            projectPath={project.projectPath}
            onCopy={state.copy}
            onOpenFile={onOpenFile}
            errorText={errorText}
            viewState={consoleState}
            onViewStateChange={onConsoleStateChange}
          />
        </div>
      </div>
    </>
  );
}
