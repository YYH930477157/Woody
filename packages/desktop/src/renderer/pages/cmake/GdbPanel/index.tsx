import React, { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Switch, Tooltip } from '@arco-design/web-react';
import {
  Add,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Delete,
  FileCode,
  Pause,
  Play,
  PlayOne,
  Refresh,
  Save,
  Square,
} from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration } from '@/common/types/cmake';
import type { GdbReply, GdbSession } from '@/common/types/cmake/gdb';
import type { OpenFile } from '../CmakePanel';
import type { useGdb } from '../useGdb';
import panel from '../CmakePanel.module.css';
import styles from './GdbPanel.module.css';

type DebugState = ReturnType<typeof useGdb>;
type Reading = { id: string; revision: number; reply: GdbReply };
type Watch = { expression: string; reading?: Reading };
const reading = (reply?: GdbReply): Reading | undefined =>
  reply?.session?.state === 'stopped' ? { id: reply.session.id, revision: reply.session.revision, reply } : undefined;

function StatePill({ state }: { state: GdbSession['state'] | 'idle' }) {
  const { t } = useTranslation();
  return (
    <span
      role='status'
      className={classNames(
        panel.statusPill,
        (state === 'running' || state === 'starting' || state === 'stopping') && panel.statusRunning,
        state === 'stopped' && styles.statePaused,
        state === 'failed' && panel.statusFailed
      )}
    >
      <span className={panel.statusDot} />
      {t(`tools.gdb.${state}` as 'tools.gdb.start')}
    </span>
  );
}

/** Debug output, following the newest line unless the user scrolled up. */
function DebugOutput({ text, empty, label }: { text: string; empty: string; label: string }) {
  const scroller = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [text]);
  return (
    <pre
      ref={scroller}
      className={styles.output}
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      {text || <span className={styles.outputEmpty}>{empty}</span>}
    </pre>
  );
}

export default function GdbPanel({
  debug,
  draft,
  onChange,
  buildBusy,
  configurationInvalid = false,
  onOpenFile,
}: {
  debug: DebugState;
  draft: CmakeConfiguration;
  onChange: (value: CmakeConfiguration) => void;
  buildBusy: boolean;
  configurationInvalid?: boolean;
  onOpenFile?: OpenFile;
}) {
  const { t } = useTranslation();
  const [location, setLocation] = useState('');
  const [expression, setExpression] = useState('');
  const [watches, setWatches] = useState<Watch[]>([]);
  const [stack, setStack] = useState<Reading>();
  const [locals, setLocals] = useState<Reading>();
  const [memory, setMemory] = useState<Reading>();
  const [address, setAddress] = useState('');
  const [count, setCount] = useState(32);
  const { session, pending, active } = debug;
  const stopped = session?.state === 'stopped';
  const canInspect = stopped && !pending;
  const label = (key: string) => t(`tools.gdb.${key}` as 'tools.gdb.start');
  const errorText = (text: string) =>
    text.replace(/^((?:gdb|cmake)\.[A-Za-z]+)/, (key) => t(`tools.${key}` as 'tools.gdb.failed'));
  const current = (snapshot?: Reading) =>
    !!snapshot && stopped && snapshot.id === session.id && snapshot.revision === session.revision;
  const control = (key: string, icon: React.ReactNode, disabled: boolean, action: () => void) => (
    <Tooltip key={key} content={label(key)}>
      <Button aria-label={label(key)} icon={icon} disabled={disabled} onClick={action} />
    </Tooltip>
  );
  const smallControl = (key: string, icon: React.ReactNode, disabled: boolean, action: () => void) => (
    <Tooltip key={key} content={label(key)}>
      <Button size='mini' type='text' aria-label={label(key)} icon={icon} disabled={disabled} onClick={action} />
    </Tooltip>
  );
  async function refreshWatch(item: Watch) {
    const result = reading(await debug.execute({ operation: 'evaluate', expression: item.expression }));
    if (result)
      setWatches((previous) =>
        previous.map((watch) => (watch.expression === item.expression ? { ...watch, reading: result } : watch))
      );
  }
  function addWatch() {
    const value = expression.trim();
    if (!value || watches.some((watch) => watch.expression === value) || watches.length >= 30) return;
    setWatches((previous) => [...previous, { expression: value }]);
    setExpression('');
  }
  const frame = stopped ? session.frame : undefined;
  const frameFile = frame?.fullname || frame?.file;
  const frameLine = Number(frame?.line) || undefined;

  return (
    <>
      <div className={panel.toolbar}>
        <div className={panel.actions}>
          <Button
            type='primary'
            icon={<Play />}
            disabled={configurationInvalid || buildBusy || active || pending || !draft.runExecutable}
            onClick={() => {
              void debug.start(draft);
            }}
          >
            {label('start')}
          </Button>
          <Button
            status='danger'
            icon={<Square />}
            disabled={!active || pending || session?.state === 'stopping'}
            onClick={() => {
              void debug.execute({ operation: 'stop' });
            }}
          >
            {label('stop')}
          </Button>
          <div className={styles.controls}>
            {control('pause', <Pause />, session?.state !== 'running' || pending, () => {
              void debug.execute({ operation: 'pause' });
            })}
            {control('continue', <PlayOne />, !canInspect, () => {
              void debug.execute({ operation: 'continue' });
            })}
            {control('next', <ArrowRight />, !canInspect, () => {
              void debug.execute({ operation: 'next' });
            })}
            {control('step', <ArrowDown />, !canInspect, () => {
              void debug.execute({ operation: 'step' });
            })}
            {control('finish', <ArrowUp />, !canInspect, () => {
              void debug.execute({ operation: 'finish' });
            })}
          </div>
        </div>
        <div className={panel.toolbarEnd}>
          <StatePill state={session?.state || 'idle'} />
          <label className={styles.access}>
            <span>{label('aiAccess')}</span>
            <Switch
              size='small'
              aria-label={label('aiAccess')}
              checked={debug.aiEnabled}
              loading={pending}
              onChange={(enabled) => {
                void debug.setAiEnabled(enabled);
              }}
            />
          </label>
        </div>
      </div>
      {(debug.error || (session?.error && session.error !== debug.error)) && (
        <div className={panel.alerts}>
          {debug.error && <Alert type='error' content={errorText(debug.error)} />}
          {session?.error && session.error !== debug.error && <Alert type='error' content={errorText(session.error)} />}
        </div>
      )}
      <div className={panel.split}>
        <aside className={panel.sidebar}>
          <section className={panel.card} aria-label={label('launch')}>
            <div className={panel.cardHeader}>
              <h3 className={panel.cardTitle}>{label('launch')}</h3>
              <Tooltip content={t('tools.cmake.save')}>
                <Button
                  size='mini'
                  aria-label={t('tools.cmake.save')}
                  icon={<Save />}
                  disabled={active || pending || buildBusy}
                  onClick={() => {
                    void debug.save(draft);
                  }}
                />
              </Tooltip>
            </div>
            <Form layout='vertical' className={styles.form} disabled={active || pending || buildBusy}>
              <Form.Item label={label('gdbPath')}>
                <Input
                  aria-label={label('gdbPath')}
                  placeholder={t('tools.cmake.autoDetect')}
                  value={draft.gdbPath || ''}
                  onChange={(gdbPath) => onChange({ ...draft, gdbPath })}
                />
              </Form.Item>
              <Form.Item label={t('tools.cmake.runExecutable')}>
                <Input
                  aria-label={t('tools.cmake.runExecutable')}
                  placeholder={t('tools.cmake.runExecutablePlaceholder')}
                  value={draft.runExecutable}
                  onChange={(runExecutable) => onChange({ ...draft, runExecutable })}
                />
              </Form.Item>
              <Form.Item label={t('tools.cmake.runArguments')}>
                <Input.TextArea
                  aria-label={t('tools.cmake.runArguments')}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  value={draft.runArguments.join('\n')}
                  onChange={(value) => onChange({ ...draft, runArguments: value ? value.split('\n') : [] })}
                />
              </Form.Item>
            </Form>
          </section>
          <section className={panel.card} aria-label={label('breakpoints')}>
            <div className={panel.cardHeader}>
              <h3 className={panel.cardTitle}>{label('breakpoints')}</h3>
              <span className={panel.muted}>{session?.breakpoints.length ?? 0}</span>
            </div>
            <div className={styles.row}>
              <Input
                size='small'
                aria-label={label('location')}
                placeholder={label('location')}
                value={location}
                onChange={setLocation}
                disabled={!canInspect}
              />
              {control('addBreakpoint', <Add />, !canInspect || !location.trim(), () => {
                void debug.execute({ operation: 'breakpointAdd', location: location.trim() });
              })}
            </div>
            {session?.breakpoints.length ? (
              <ul className={styles.list}>
                {session.breakpoints.map((breakpoint) => (
                  <li className={styles.item} key={breakpoint.number}>
                    <span className={styles.badge}>{breakpoint.number}</span>
                    <code className={styles.grow}>
                      {breakpoint.location || `${breakpoint.file}:${breakpoint.line}`}
                    </code>
                    {smallControl('removeBreakpoint', <Delete />, !canInspect, () => {
                      void debug.execute({ operation: 'breakpointRemove', number: breakpoint.number });
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              <span className={panel.muted}>{label(stopped ? 'noBreakpoints' : 'inspectWhenPaused')}</span>
            )}
          </section>
          <section className={panel.card} aria-label={label('watches')}>
            <div className={panel.cardHeader}>
              <h3 className={panel.cardTitle}>{label('watches')}</h3>
              <span className={panel.muted}>{watches.length}</span>
            </div>
            <div className={styles.row}>
              <Input
                size='small'
                aria-label={label('expression')}
                placeholder={label('expression')}
                value={expression}
                onChange={setExpression}
                onPressEnter={addWatch}
              />
              {control(
                'addWatch',
                <Add />,
                !expression.trim() ||
                  watches.length >= 30 ||
                  watches.some((watch) => watch.expression === expression.trim()),
                addWatch
              )}
            </div>
            {watches.length > 0 && (
              <ul className={styles.list}>
                {watches.map((watch) => (
                  <li className={styles.item} key={watch.expression}>
                    <div className={styles.grow}>
                      <code>{watch.expression}</code>
                      <div className={current(watch.reading) ? styles.value : styles.stale}>
                        {current(watch.reading) ? watch.reading?.reply.value : label('stale')}
                      </div>
                    </div>
                    {smallControl('refresh', <Refresh />, !canInspect, () => {
                      void refreshWatch(watch);
                    })}
                    {smallControl('removeWatch', <Delete />, pending, () =>
                      setWatches((previous) => previous.filter((item) => item !== watch))
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
        <div className={panel.main}>
          <section className={classNames(panel.card, styles.location)} aria-label={label('frame')}>
            {frame ? (
              <>
                <div className={styles.frameFunc}>{frame.func || frame.addr}</div>
                {frameFile && (
                  <Button
                    type='text'
                    size='mini'
                    className={styles.frameFile}
                    icon={<FileCode />}
                    disabled={!onOpenFile}
                    onClick={() => onOpenFile?.(frameFile, frameLine)}
                  >
                    {frameFile.split(/[\\/]/).pop()}
                    {frame.line ? `:${frame.line}` : ''}
                  </Button>
                )}
                {session?.reason && (
                  <span className={panel.muted}>
                    {label('reason')}: {session.reason}
                  </span>
                )}
              </>
            ) : (
              <span className={panel.muted}>{label(session ? 'notPaused' : 'notStarted')}</span>
            )}
            {session?.executable && (
              <span className={classNames(panel.muted, styles.executable)} title={session.executable}>
                {label('executable')}: {session.executable.split(/[\\/]/).pop()}
              </span>
            )}
          </section>
          <div className={styles.inspection}>
            <section className={panel.card} aria-label={label('stack')}>
              <div className={panel.cardHeader}>
                <h3 className={panel.cardTitle}>{label('stack')}</h3>
                {smallControl('refreshStack', <Refresh />, !canInspect, () => {
                  void debug.execute({ operation: 'stack' }).then((reply) => setStack(reading(reply)));
                })}
              </div>
              {current(stack) ? (
                <ol className={styles.table}>
                  {stack?.reply.stack?.map((entry) => (
                    <li key={entry.level}>
                      <span className={styles.badge}>{entry.level}</span>
                      <code className={styles.grow}>{entry.func}</code>
                      <span className={styles.where}>
                        {(entry.fullname || entry.file || '').split(/[\\/]/).pop()}
                        {entry.line ? `:${entry.line}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className={styles.stale}>{label('stale')}</span>
              )}
            </section>
            <section className={panel.card} aria-label={label('locals')}>
              <div className={panel.cardHeader}>
                <h3 className={panel.cardTitle}>{label('locals')}</h3>
                {smallControl('refreshLocals', <Refresh />, !canInspect, () => {
                  void debug.execute({ operation: 'locals' }).then((reply) => setLocals(reading(reply)));
                })}
              </div>
              {current(locals) ? (
                <ul className={styles.table}>
                  {locals?.reply.variables?.map((variable, index) => (
                    <li key={`${variable.name}-${index}`}>
                      <code className={styles.name}>{variable.name}</code>
                      {variable.type && <span className={styles.where}>{variable.type}</span>}
                      <code className={classNames(styles.grow, styles.value)}>{variable.value}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.stale}>{label('stale')}</span>
              )}
            </section>
          </div>
          <section className={panel.card} aria-label={label('memory')}>
            <div className={panel.cardHeader}>
              <h3 className={panel.cardTitle}>{label('memory')}</h3>
            </div>
            <div className={styles.row}>
              <Input
                size='small'
                aria-label={label('address')}
                placeholder={label('address')}
                value={address}
                onChange={setAddress}
                disabled={!canInspect}
              />
              <InputNumber
                size='small'
                className={styles.count}
                aria-label={label('byteCount')}
                min={1}
                max={256}
                precision={0}
                value={count}
                onChange={(value) => setCount(value || 1)}
                disabled={!canInspect}
              />
              {control('readMemory', <Refresh />, !canInspect || !/^0x[0-9a-f]+$/i.test(address.trim()), () => {
                void debug
                  .execute({ operation: 'memory', address: address.trim(), count })
                  .then((reply) => setMemory(reading(reply)));
              })}
            </div>
            {current(memory) ? (
              <pre className={styles.memory}>
                {memory?.reply.memory?.map((block) => `${block.begin}: ${block.contents}`).join('\n')}
              </pre>
            ) : (
              <span className={styles.stale}>{label('stale')}</span>
            )}
          </section>
          <section className={styles.console} aria-label={label('output')}>
            <div className={styles.consoleHeader}>{label('output')}</div>
            {session?.outputTruncated && <div className={styles.consoleNotice}>{label('truncated')}</div>}
            <DebugOutput text={session?.output || ''} empty={label('noOutput')} label={label('output')} />
          </section>
        </div>
      </div>
    </>
  );
}
