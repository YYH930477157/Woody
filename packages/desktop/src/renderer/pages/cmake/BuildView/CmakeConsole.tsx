import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { Attention, CloseOne, Copy, Down, FileCode, Right } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { CmakeJob } from '@/common/types/cmake';
import {
  classifyOutputLines,
  parseCmakeProblems,
  projectRelativePath,
  resolveProblemPath,
  splitOutputLines,
  type CmakeProblem,
} from '../cmakeProblems';
import type { OpenFile } from '../CmakePanel';
import styles from './CmakeConsole.module.css';

export type ConsoleTab = 'problems' | 'output';
export type ConsoleViewState = {
  projectPath: string;
  jobKey: string;
  tab: ConsoleTab;
  highlight?: number;
};
const FOLLOW_THRESHOLD_PX = 40;

const baseName = (file: string) => file.split(/[\\/]/).pop() || file;
const location = (problem: CmakeProblem) =>
  problem.file
    ? `${baseName(problem.file)}${problem.line ? `:${problem.line}` : ''}${problem.column ? `:${problem.column}` : ''}`
    : '';

export default function CmakeConsole({
  job,
  output,
  truncated,
  pending,
  projectPath,
  onCopy,
  onOpenFile,
  errorText,
  viewState,
  onViewStateChange,
}: {
  job?: CmakeJob;
  output: string;
  truncated: boolean;
  pending: boolean;
  projectPath: string;
  onCopy: (text: string) => Promise<void>;
  onOpenFile?: OpenFile;
  errorText: (text: string) => string;
  viewState?: ConsoleViewState;
  onViewStateChange?: (state: ConsoleViewState) => void;
}) {
  const { t } = useTranslation();
  const lines = useMemo(() => splitOutputLines(output), [output]);
  const problems = useMemo(() => parseCmakeProblems(output), [output]);
  const kinds = useMemo(() => classifyOutputLines(lines), [lines]);
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const warnings = problems.length - errors;
  const [internalState, setInternalState] = useState<ConsoleViewState>();
  const currentState = onViewStateChange ? viewState : internalState;
  const updateState = onViewStateChange ?? setInternalState;
  const [behind, setBehind] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const hasOutput = output.length > 0;

  // A running job is read in the output; a failed one opens on what went wrong, while view switches keep the user's choice.
  const finishedWithProblems = job?.status === 'failed' && problems.length > 0;
  const jobKey = `${job?.id ?? ''}:${job?.status ?? ''}`;
  const matching =
    currentState?.projectPath === projectPath && currentState.jobKey === jobKey ? currentState : undefined;
  const tab: ConsoleTab =
    matching?.tab ??
    (job?.status === 'running'
      ? 'output'
      : finishedWithProblems
        ? 'problems'
        : currentState?.projectPath === projectPath
          ? currentState.tab
          : 'output');
  const highlight = matching?.highlight;
  const setConsoleView = (nextTab: ConsoleTab, nextHighlight?: number) => {
    updateState({ projectPath, jobKey, tab: nextTab, highlight: nextHighlight });
  };

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || tab !== 'output') return;
    if (highlight !== undefined) {
      element.querySelector(`[data-line="${highlight}"]`)?.scrollIntoView?.({ block: 'center' });
      return;
    }
    if (following.current) element.scrollTop = element.scrollHeight;
    else setBehind(true);
  }, [lines, tab, highlight]);

  const showInOutput = (problem: CmakeProblem) => {
    following.current = false;
    setConsoleView('output', problem.outputLine);
    requestAnimationFrame(() => {
      scroller.current?.querySelector(`[data-line="${problem.outputLine}"]`)?.scrollIntoView?.({ block: 'center' });
    });
  };
  const open = (problem: CmakeProblem) => {
    if (problem.file && onOpenFile)
      onOpenFile(resolveProblemPath(problem.file, projectPath), problem.line, problem.column);
    else showInOutput(problem);
  };
  const jumpToLatest = () => {
    following.current = true;
    setBehind(false);
    setConsoleView('output', undefined);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };

  const tabButton = (value: ConsoleTab, label: React.ReactNode) => (
    <Button
      type='text'
      size='small'
      aria-pressed={tab === value}
      className={classNames(styles.tab, tab === value && styles.tabActive)}
      onClick={() => setConsoleView(value, highlight)}
    >
      {label}
    </Button>
  );

  return (
    <section className={styles.console} aria-label={t('tools.cmake.output')}>
      <div className={styles.header}>
        {tabButton(
          'problems',
          <>
            {t('tools.cmake.problems')}
            <span className={classNames(styles.count, errors > 0 && styles.countError)}>
              <CloseOne theme='outline' size='12' fill='currentColor' />
              {errors}
            </span>
            <span className={classNames(styles.count, warnings > 0 && styles.countWarning)}>
              <Attention theme='outline' size='12' fill='currentColor' />
              {warnings}
            </span>
          </>
        )}
        {tabButton('output', t('tools.cmake.output'))}
        <span className={styles.summary} title={job?.buildDirectory}>
          {job?.buildDirectory && projectRelativePath(job.buildDirectory, projectPath)}
        </span>
        <Tooltip content={t('tools.cmake.copyOutput')}>
          <Button
            type='text'
            size='small'
            className={styles.iconButton}
            icon={<Copy theme='outline' size='14' fill='currentColor' />}
            aria-label={t('tools.cmake.copyOutput')}
            disabled={!hasOutput || pending}
            onClick={() => {
              void onCopy(output);
            }}
          />
        </Tooltip>
      </div>
      {truncated && <div className={styles.notice}>{t('tools.cmake.truncated')}</div>}
      {job?.error && problems.length === 0 && <div className={styles.errorBanner}>{errorText(job.error)}</div>}
      <div className={styles.body}>
        {tab === 'problems' ? (
          problems.length === 0 ? (
            <div className={styles.empty}>{t(job ? 'tools.cmake.noProblems' : 'tools.cmake.consoleIdle')}</div>
          ) : (
            <ul className={classNames(styles.scroll, styles.problems)} aria-label={t('tools.cmake.problems')}>
              {problems.map((problem) => (
                <li
                  key={`${problem.outputLine}-${problem.message}`}
                  role='button'
                  tabIndex={0}
                  className={styles.problem}
                  onClick={() => open(problem)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      open(problem);
                    }
                  }}
                >
                  <span
                    className={classNames(
                      styles.problemIcon,
                      problem.severity === 'error' ? styles.countError : styles.countWarning
                    )}
                  >
                    {problem.severity === 'error' ? (
                      <CloseOne theme='filled' size='14' fill='currentColor' />
                    ) : (
                      <Attention theme='filled' size='14' fill='currentColor' />
                    )}
                  </span>
                  <span className={styles.problemMessage}>
                    {problem.message}
                    {problem.file && <span className={styles.problemLocation}>{location(problem)}</span>}
                  </span>
                  <span className={styles.problemActions} onClick={(event) => event.stopPropagation()}>
                    {problem.file && onOpenFile && (
                      <Tooltip content={t('tools.cmake.openFile')}>
                        <Button
                          type='text'
                          size='mini'
                          className={styles.iconButton}
                          aria-label={t('tools.cmake.openFile')}
                          icon={<FileCode theme='outline' size='13' fill='currentColor' />}
                          onClick={() => open(problem)}
                        />
                      </Tooltip>
                    )}
                    <Tooltip content={t('tools.cmake.showInOutput')}>
                      <Button
                        type='text'
                        size='mini'
                        className={styles.iconButton}
                        aria-label={t('tools.cmake.showInOutput')}
                        icon={<Right theme='outline' size='13' fill='currentColor' />}
                        onClick={() => showInOutput(problem)}
                      />
                    </Tooltip>
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : hasOutput ? (
          <div
            ref={scroller}
            role='log'
            aria-label={t('tools.cmake.output')}
            tabIndex={0}
            className={classNames(styles.scroll, styles.output)}
            onScroll={(event) => {
              const element = event.currentTarget;
              following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
              if (following.current) setBehind(false);
            }}
          >
            {lines.map((line, index) => (
              <div
                key={index}
                data-line={index}
                className={classNames(
                  styles.line,
                  kinds[index] !== 'plain' && styles[kinds[index]],
                  highlight === index && styles.highlight
                )}
              >
                {line || ' '}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>{t(job ? 'tools.cmake.noOutput' : 'tools.cmake.consoleIdle')}</div>
        )}
        {tab === 'output' && behind && (
          <Button className={styles.jump} size='small' shape='round' icon={<Down />} onClick={jumpToLatest}>
            {t('tools.terminal.jumpLatest')}
          </Button>
        )}
      </div>
    </section>
  );
}
