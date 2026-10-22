import React, { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { Add, ArrowDown, ArrowRight, ArrowUp, Delete, Pause, Play, Refresh, Save, Square } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { CmakeConfiguration } from '@/common/types/cmake';
import type { GdbReply } from '@/common/types/cmake/gdb';
import type { useGdb } from '../useGdb';
import styles from './GdbPanel.module.css';

type DebugState = ReturnType<typeof useGdb>;
type Reading = { id: string; revision: number; reply: GdbReply };
type Watch = { expression: string; reading?: Reading };
const reading = (reply?: GdbReply): Reading | undefined =>
  reply?.session?.state === 'stopped' ? { id: reply.session.id, revision: reply.session.revision, reply } : undefined;

export default function GdbPanel({
  debug,
  draft,
  onChange,
  buildBusy,
  configurationInvalid = false,
}: {
  debug: DebugState;
  draft: CmakeConfiguration;
  onChange: (value: CmakeConfiguration) => void;
  buildBusy: boolean;
  configurationInvalid?: boolean;
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
  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <Tooltip content={t('tools.cmake.save')}>
          <Button
            aria-label={t('tools.cmake.save')}
            icon={<Save />}
            disabled={active || pending || buildBusy}
            onClick={() => {
              void debug.save(draft);
            }}
          />
        </Tooltip>
        {control(
          'start',
          <Play />,
          configurationInvalid || buildBusy || active || pending || !draft.runExecutable,
          () => {
            void debug.start(draft);
          }
        )}
        {control('stop', <Square />, !active || pending || session?.state === 'stopping', () => {
          void debug.execute({ operation: 'stop' });
        })}
        {control('pause', <Pause />, session?.state !== 'running' || pending, () => {
          void debug.execute({ operation: 'pause' });
        })}
        {control('continue', <Play />, !canInspect, () => {
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
        <Tag>{label(session?.state || 'idle')}</Tag>
        <label className={styles.access}>
          <span>{label('aiAccess')}</span>
          <Switch
            aria-label={label('aiAccess')}
            checked={debug.aiEnabled}
            loading={pending}
            onChange={(enabled) => {
              void debug.setAiEnabled(enabled);
            }}
          />
        </label>
      </div>
      {debug.error && <Alert type='error' content={errorText(debug.error)} />}
      {session?.error && session.error !== debug.error && <Alert type='error' content={errorText(session.error)} />}
      <Form className={styles.settings} layout='vertical' disabled={active || pending || buildBusy}>
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
            value={draft.runExecutable}
            onChange={(runExecutable) => onChange({ ...draft, runExecutable })}
          />
        </Form.Item>
        <Form.Item label={t('tools.cmake.runArguments')}>
          <Input.TextArea
            aria-label={t('tools.cmake.runArguments')}
            value={draft.runArguments.join('\n')}
            onChange={(value) => onChange({ ...draft, runArguments: value ? value.split('\n') : [] })}
          />
        </Form.Item>
      </Form>
      {session && (
        <div className={styles.metadata}>
          <div>
            {label('executable')}: {session.executable}
          </div>
          <div>
            {t('tools.cmake.buildDirectory')}: {session.buildDirectory}
          </div>
          {stopped && session.frame && (
            <div>
              {label('frame')}: {session.frame.func} {session.frame.fullname || session.frame.file}:{session.frame.line}
            </div>
          )}
          {session.reason && (
            <div>
              {label('reason')}: {session.reason}
            </div>
          )}
        </div>
      )}
      <div className={styles.inspection}>
        <section className={styles.section} aria-label={label('breakpoints')}>
          <strong>{label('breakpoints')}</strong>
          <div className={styles.row}>
            <Input
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
          {session?.breakpoints.map((breakpoint) => (
            <div className={styles.row} key={breakpoint.number}>
              <code className={styles.grow}>
                {breakpoint.number}: {breakpoint.location || `${breakpoint.file}:${breakpoint.line}`}
              </code>
              {control('removeBreakpoint', <Delete />, !canInspect, () => {
                void debug.execute({ operation: 'breakpointRemove', number: breakpoint.number });
              })}
            </div>
          ))}
        </section>
        <section className={styles.section} aria-label={label('watches')}>
          <strong>{label('watches')}</strong>
          <div className={styles.row}>
            <Input
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
          {watches.map((watch) => (
            <div className={styles.row} key={watch.expression}>
              <div className={styles.grow}>
                <code>{watch.expression}</code>
                <div className={current(watch.reading) ? styles.value : styles.stale}>
                  {current(watch.reading) ? watch.reading?.reply.value : label('stale')}
                </div>
              </div>
              {control('refresh', <Refresh />, !canInspect, () => {
                void refreshWatch(watch);
              })}
              {control('removeWatch', <Delete />, pending, () =>
                setWatches((previous) => previous.filter((item) => item !== watch))
              )}
            </div>
          ))}
        </section>
        <section className={styles.section} aria-label={label('stack')}>
          <div className={styles.row}>
            <strong className={styles.grow}>{label('stack')}</strong>
            {control('refreshStack', <Refresh />, !canInspect, () => {
              void debug.execute({ operation: 'stack' }).then((reply) => setStack(reading(reply)));
            })}
          </div>
          {current(stack) ? (
            <div className={styles.values}>
              {stack?.reply.stack?.map((frame) => (
                <div key={frame.level}>
                  <code>
                    {frame.level}: {frame.func} {frame.fullname || frame.file}:{frame.line}
                  </code>
                </div>
              ))}
            </div>
          ) : (
            <span className={styles.stale}>{label('stale')}</span>
          )}
        </section>
        <section className={styles.section} aria-label={label('locals')}>
          <div className={styles.row}>
            <strong className={styles.grow}>{label('locals')}</strong>
            {control('refreshLocals', <Refresh />, !canInspect, () => {
              void debug.execute({ operation: 'locals' }).then((reply) => setLocals(reading(reply)));
            })}
          </div>
          {current(locals) ? (
            <div className={styles.values}>
              {locals?.reply.variables?.map((variable, index) => (
                <div key={`${variable.name}-${index}`}>
                  <code>
                    {variable.name}
                    {variable.type ? ` (${variable.type})` : ''}: {variable.value}
                  </code>
                </div>
              ))}
            </div>
          ) : (
            <span className={styles.stale}>{label('stale')}</span>
          )}
        </section>
      </div>
      <section className={styles.section} aria-label={label('memory')}>
        <strong>{label('memory')}</strong>
        <div className={styles.row}>
          <Input
            aria-label={label('address')}
            placeholder={label('address')}
            value={address}
            onChange={setAddress}
            disabled={!canInspect}
          />
          <InputNumber
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
          <pre className={styles.values}>
            {memory?.reply.memory?.map((block) => `${block.begin}: ${block.contents}`).join('\n')}
          </pre>
        ) : (
          <span className={styles.stale}>{label('stale')}</span>
        )}
      </section>
      {session?.outputTruncated && <Alert type='warning' content={label('truncated')} />}
      <pre className={styles.output} aria-label={label('output')} tabIndex={0}>
        {session?.output || label('noOutput')}
      </pre>
    </div>
  );
}
