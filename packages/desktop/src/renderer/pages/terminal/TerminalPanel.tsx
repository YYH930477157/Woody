import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Modal, Select, Switch } from '@arco-design/web-react';
import { Add, Refresh, Terminal } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import {
  applyNewlineMode,
  TERMINAL_BAUD_RATES,
  TERMINAL_INPUT_MODES,
  TERMINAL_NEWLINE_MODES,
  type TerminalInputMode,
  type TerminalNewlineMode,
  type TerminalOutputMode,
} from '@/common/terminal/stream';
import type { TerminalEvent, TerminalProfile, TerminalSendRequest, TerminalWait } from '@/common/types/terminal';
import TerminalConfig, { newTerminalProfile } from './TerminalConfig';
import { useTerminal } from './useTerminal';
import { renderTerminalEvents } from './terminalView';

export default function TerminalPanel({ conversationId, cwd }: { conversationId?: string; cwd?: string }) {
  const { t, i18n } = useTranslation();
  const label = (key: string) => t(`tools.terminal.${key}`);
  const model = useTerminal();
  const [editing, setEditing] = useState<TerminalProfile>();
  const [ports, setPorts] = useState<Array<{ path: string; manufacturer?: string }>>([]);
  const [profileId, setProfileId] = useState<string>();
  const [input, setInput] = useState('');
  const [encoding, setEncoding] = useState<'hex' | 'utf8'>('hex');
  const [outputMode, setOutputMode] = useState<TerminalOutputMode>('hex');
  const [inputMode, setInputMode] = useState<TerminalInputMode>('readlineHex');
  const [inputNewlines, setInputNewlines] = useState<TerminalNewlineMode>('crlf');
  const [outputNewlines, setOutputNewlines] = useState<TerminalNewlineMode>('keep');
  const [slowSend, setSlowSend] = useState(false);
  const [echoes, setEchoes] = useState<TerminalEvent[]>([]);
  const [liveBaud, setLiveBaud] = useState<number>();
  const [ending, setEnding] = useState<TerminalSendRequest['ending']>('none');
  const [waitMode, setWaitMode] = useState<'none' | TerminalWait['mode']>('none');
  const [waitValue, setWaitValue] = useState('1');
  const [timeoutMs, setTimeoutMs] = useState(3000);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');
  const [working, setWorking] = useState(false);
  const [configValid, setConfigValid] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const profile = model.profiles.find((item) => item.id === profileId);
  const serialSession = model.selected?.profile.kind === 'serial' ? model.selected.profile : undefined;
  const baudRate = liveBaud ?? serialSession?.baudRate;
  const typing = Boolean(serialSession) && (inputMode === 'normal' || inputMode === 'localEcho');
  const display = useMemo(
    () => renderTerminalEvents([...model.events, ...echoes], outputMode === 'text' ? false : outputMode, outputNewlines),
    [echoes, model.events, outputMode, outputNewlines]
  );
  useEffect(() => {
    if (outputRef.current && followOutput.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [display]);
  const run = async (action: () => Promise<unknown>) => {
    model.setError('');
    try {
      await action();
    } catch (error) {
      model.report(error);
    }
  };
  const refreshPorts = () => run(async () => setPorts(await ipcBridge.terminal.ports.invoke()));
  useEffect(() => {
    setEchoes([]);
    setLiveBaud(undefined);
    if (model.selected?.profile.kind === 'shell') {
      setEncoding('utf8');
      setOutputMode('text');
      setEnding('cr');
    } else {
      setEncoding('hex');
      setOutputMode('hex');
      setInputMode('readlineHex');
      setEnding('none');
    }
  }, [model.selectedId, model.selected?.profile.kind]);
  const manualOpen = model.selected?.status === 'open' && model.selected.owner === 'manual';
  const transmit = async (request: TerminalSendRequest, echoText?: string) => {
    if (!model.selectedId) return;
    const response = await ipcBridge.terminal.send.invoke({
      id: model.selectedId,
      request: slowSend && serialSession ? { ...request, slow: true } : request,
    });
    if (echoText !== undefined && inputMode === 'localEcho') {
      const bytes = new TextEncoder().encode(echoText);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      setEchoes((previous) => [
        ...previous,
        {
          cursor: -Date.now(),
          timestamp: Date.now(),
          direction: 'outgoing',
          source: 'manual',
          data: btoa(binary),
          byteLength: bytes.length,
        },
      ]);
    }
    setResult(
      `${label(response.status)} · ${response.writePending ? label('writePending') : t('tools.terminal.sentBytes', { count: response.writtenBytes })}${response.wait ? ` · ${label(response.wait.status)} · ${t('tools.terminal.receivedBytes', { count: response.wait.byteLength })}` : ''}${response.error ? ` · ${response.error}` : ''}`
    );
  };
  const serialWait = (): TerminalWait | undefined =>
    waitMode === 'none' || !serialSession
      ? undefined
      : {
          mode: waitMode,
          timeoutMs,
          ...(waitMode === 'count'
            ? { count: Number(waitValue) }
            : waitMode === 'pattern'
              ? { pattern: waitValue, patternEncoding: encoding }
              : { idleMs: Number(waitValue) }),
        };
  const send = async () => {
    if (!model.selectedId) return;
    const request: TerminalSendRequest =
      serialSession && inputMode === 'readline'
        ? { data: applyNewlineMode(`${input}\n`, inputNewlines), encoding: 'utf8', ending: 'none', wait: serialWait() }
        : { data: input, encoding, ending, wait: serialWait() };
    setSending(true);
    await run(async () => {
      await transmit(request, serialSession && inputMode === 'readline' ? request.data : undefined);
      if (serialSession && inputMode === 'readline') setInput('');
    });
    setSending(false);
  };
  const sendKey = (text: string) => {
    if (!manualOpen) return;
    const data = applyNewlineMode(text, inputNewlines);
    void run(() => transmit({ data, encoding: 'utf8', ending: 'none' }, data));
  };
  const changeBaud = (next: number) => {
    if (!model.selectedId || !Number.isInteger(next) || next < 1) return;
    const previous = baudRate;
    setLiveBaud(next);
    void run(async () => {
      try {
        const updated = await ipcBridge.terminal.setBaud.invoke({ id: model.selectedId!, baudRate: next });
        if (updated.profile.kind === 'serial') setLiveBaud(updated.profile.baudRate);
      } catch (error) {
        setLiveBaud(previous);
        throw error;
      }
    });
  };
  const reconnect = () => {
    if (!model.selected || model.selected.profile.kind !== 'serial') return;
    const profile = { ...model.selected.profile, ...(baudRate ? { baudRate } : {}) };
    const previousId = model.selected.id;
    const wasOpen = model.selected.status === 'open';
    setWorking(true);
    void run(async () => {
      if (wasOpen) await ipcBridge.terminal.close.invoke({ id: previousId });
      const connection = await ipcBridge.terminal.open.invoke(profile);
      model.setSelectedId(connection.id);
    }).finally(() => setWorking(false));
  };
  const exportLog = async () => {
    if (!model.selectedId) return;
    const records = [];
    let cursor = 0;
    let more = true;
    let bytes = 0;
    let lost = false;
    // Snapshot bounded history; incoming data beyond the initial cursor limit is left for another export.
    let limit: number | undefined;
    while (more && bytes < 4 * 1024 * 1024 && records.length < 65536) {
      const batch = await ipcBridge.terminal.read.invoke({ id: model.selectedId, cursor });
      records.push(...batch.events);
      bytes += batch.events.reduce((sum, event) => sum + event.byteLength, 0);
      lost ||= batch.lost;
      if (limit === undefined) limit = model.events.at(-1)?.cursor;
      cursor = batch.cursor;
      more = batch.more && (limit === undefined || cursor < limit);
    }
    const content = records.map((event) => ({ ...event, hex: renderTerminalEvents([event], true)[0].text }));
    const blob = new Blob(
      [
        JSON.stringify(
          { connection: model.selected, exportedAt: new Date().toISOString(), lost, more, records: content },
          null,
          2
        ),
      ],
      { type: 'application/json;charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `woody-terminal-${model.selectedId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const grant = async (profileOnly: boolean) => {
    if (!conversationId) return;
    setWorking(true);
    await run(async () => {
      await ipcBridge.terminal.grant.invoke({
        conversationId,
        language: i18n.language,
        ...(profileOnly ? { profileId } : { connectionId: model.selectedId }),
      });
      setResult(label('granted'));
    });
    setWorking(false);
  };
  const toolButton: React.CSSProperties = {
    border: 0,
    background: 'transparent',
    color: '#c5cdd8',
    height: 28,
    padding: '0 8px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
  };
  const baudOptions = (
    TERMINAL_BAUD_RATES.includes(baudRate || 0) || !baudRate ? TERMINAL_BAUD_RATES : [baudRate, ...TERMINAL_BAUD_RATES]
  ).map((value) => ({ value, label: String(value) }));
  return (
    <div className='h-full min-h-0 box-border overflow-hidden flex flex-col text-t-primary bg-1'>
      <div className='shrink-0 flex flex-wrap items-center gap-8px px-16px py-10px border-b border-solid border-border-2'>
        <Terminal theme='outline' size='18' />
        <span className='text-15px font-[600] shrink-0' title={label('description')}>
          {label('title')}
        </span>
        <Select
          className='flex-1 min-w-160px max-w-280px'
          size='small'
          placeholder={label('profiles')}
          aria-label={label('profiles')}
          value={profileId}
          onChange={setProfileId}
          options={model.profiles.map((item) => ({ label: item.name, value: item.id }))}
        />
        {model.connections.length > 0 && (
          <Select
            className='min-w-180px max-w-320px'
            size='small'
            placeholder={label('connections')}
            aria-label={label('connections')}
            value={model.selectedId}
            onChange={model.setSelectedId}
            options={model.connections.map((connection) => ({
              value: connection.id,
              label: `${connection.profile.name} · ${label(connection.status)} · ${label(connection.owner)}`,
            }))}
          />
        )}
        <Button
          size='small'
          type='primary'
          disabled={!profile || working}
          onClick={() => {
            if (!profile) return;
            setWorking(true);
            void run(async () => {
              const connection = await ipcBridge.terminal.open.invoke(profile);
              model.setSelectedId(connection.id);
            }).finally(() => setWorking(false));
          }}
        >
          {label('connect')}
        </Button>
        <Button size='small' disabled={!profile} onClick={() => setEditing(profile)}>
          {label('edit')}
        </Button>
        <Button
          size='small'
          type='text'
          disabled={!profile}
          onClick={() => {
            void run(async () => {
              await ipcBridge.terminal.removeProfile.invoke({ id: profileId! });
              setProfileId(undefined);
              await model.refreshProfiles();
            });
          }}
        >
          {label('removeProfile')}
        </Button>
        <Button size='small' type='text' icon={<Refresh theme='outline' size='15' />} onClick={() => void refreshPorts()}>
          {label('refreshPorts')}
        </Button>
        <Button
          size='small'
          type='primary'
          icon={<Add theme='outline' size='14' />}
          onClick={() => setEditing(newTerminalProfile('shell', cwd))}
        >
          {label('newProfile')}
        </Button>
      </div>
      {(model.error || model.lost) && (
        <div className='shrink-0 px-16px pt-8px flex flex-col gap-8px'>
          {model.error && (
            <Alert
              type='error'
              content={
                model.error.includes('terminal.mcpNotSelected')
                  ? label('mcpNotSelected')
                  : model.error.includes('terminal.shellMissing')
                    ? label('shellMissing')
                    : model.error
              }
              closable
              onClose={() => model.setError('')}
            />
          )}
          {model.lost && <Alert type='warning' content={label('historyLost')} />}
        </div>
      )}
      <div
        className='flex-1 min-h-0 m-12px rd-12px overflow-hidden flex flex-col'
        style={{ background: '#1c1e26', color: '#d7dde7', boxShadow: '0 16px 40px rgba(0,0,0,0.18)' }}
      >
        <div
          className='shrink-0 flex flex-wrap items-center gap-8px px-12px'
          style={{ minHeight: 40, background: 'rgba(255,255,255,0.04)' }}
        >
          <span
            aria-hidden
            className='inline-block w-8px h-8px rd-full shrink-0'
            style={{ background: model.selected?.status === 'open' ? '#3dd68c' : '#f07178' }}
          />
          <span className='font-mono text-13px font-[600]'>
            {serialSession
              ? `${serialSession.path} (${baudRate ?? serialSession.baudRate})`
              : model.selected
                ? model.selected.profile.name
                : label('title')}
          </span>
          {model.selected && (
            <span className='text-12px' style={{ color: '#8b95a7' }}>
              {label(model.selected.status)} · {label(model.selected.owner)}
            </span>
          )}
          <span className='flex-1' />
          {serialSession && (
            <Select
              size='mini'
              aria-label={label('baudLive')}
              style={{ width: 108 }}
              value={baudRate}
              disabled={!manualOpen}
              onChange={(value) => changeBaud(Number(value))}
              options={baudOptions}
            />
          )}
          <Select
            size='mini'
            aria-label={label('output')}
            value={outputMode}
            style={{ width: 108 }}
            onChange={(value) => setOutputMode(value as TerminalOutputMode)}
            options={[
              { value: 'text', label: label('text') },
              { value: 'hex', label: label('hex') },
              { value: 'hexdump', label: label('hexdump') },
            ]}
          />
          {model.selected && (
            <button
              type='button'
              style={toolButton}
              onClick={() => {
                void run(() => ipcBridge.terminal.takeover.invoke({ id: model.selectedId! }));
              }}
            >
              {label('takeover')}
            </button>
          )}
          {model.selected?.profile.kind === 'shell' && (
            <button
              type='button'
              style={{ ...toolButton, opacity: model.selected.owner === 'manual' ? 1 : 0.4 }}
              disabled={model.selected.owner !== 'manual'}
              onClick={() => {
                void run(() => ipcBridge.terminal.interrupt.invoke({ id: model.selectedId! }));
              }}
            >
              {label('interrupt')}
            </button>
          )}
          {model.selected && (
            <button
              type='button'
              style={toolButton}
              onClick={() => {
                void run(() => ipcBridge.terminal.cancel.invoke({ id: model.selectedId! }));
              }}
            >
              {label('cancelWait')}
            </button>
          )}
          {model.selected && (
            <button
              type='button'
              style={{ ...toolButton, opacity: manualOpen ? 1 : 0.4 }}
              disabled={!manualOpen}
              onClick={() => {
                void run(() => ipcBridge.terminal.close.invoke({ id: model.selectedId! }));
              }}
            >
              {label('disconnect')}
            </button>
          )}
          {serialSession && (
            <button
              type='button'
              style={{ ...toolButton, color: '#8fd4ff', opacity: model.selected?.owner === 'manual' && !working ? 1 : 0.4 }}
              disabled={model.selected?.owner !== 'manual' || working}
              onClick={reconnect}
            >
              {model.selected?.status === 'open' ? label('reconnect') : label('connect')}
            </button>
          )}
          <button type='button' style={toolButton} onClick={model.clear}>
            {label('clear')}
          </button>
          <button
            type='button'
            style={{ ...toolButton, opacity: model.selectedId ? 1 : 0.4 }}
            disabled={!model.selectedId}
            onClick={() => {
              void run(exportLog);
            }}
          >
            {label('export')}
          </button>
        </div>
        <div
          ref={outputRef}
          role='log'
          aria-label={label('output')}
          onScroll={(event) => {
            const target = event.currentTarget;
            followOutput.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          }}
          className='flex-1 min-h-160px overflow-auto px-16px py-12px font-mono text-13px leading-22px'
        >
          {display.length === 0 ? (
            <div className='h-full min-h-160px flex items-center justify-center text-13px' style={{ color: '#8b95a7' }}>
              {label(model.selected?.status === 'open' ? 'waitingOutput' : 'emptyOutput')}
            </div>
          ) : (
            display.map((event, index) => (
              <div key={`${event.cursor}-${index}`} className='whitespace-pre-wrap break-all'>
                <span
                  style={{
                    color:
                      event.direction === 'outgoing' ? '#e5c07b' : event.direction === 'system' ? '#8b95a7' : '#d7dde7',
                  }}
                >
                  {event.text || ' '}
                </span>
                {event.status === 'failed' && <span style={{ color: '#f07178' }}> {event.error}</span>}
              </div>
            ))
          )}
        </div>
        <div className='shrink-0 flex flex-col gap-8px px-12px py-10px' style={{ background: 'rgba(0,0,0,0.22)' }}>
          <div className='flex flex-wrap items-center gap-8px'>
            {serialSession && (
              <>
                <Select
                  size='mini'
                  aria-label={label('inputMode')}
                  style={{ width: 132 }}
                  value={inputMode}
                  onChange={(value) => setInputMode(value as TerminalInputMode)}
                  options={TERMINAL_INPUT_MODES.map((value) => ({ value, label: label(`inputMode_${value}`) }))}
                />
                {inputMode !== 'readlineHex' && (
                  <Select
                    size='mini'
                    aria-label={label('newlineIn')}
                    style={{ width: 148 }}
                    value={inputNewlines}
                    onChange={(value) => setInputNewlines(value as TerminalNewlineMode)}
                    options={TERMINAL_NEWLINE_MODES.map((value) => ({ value, label: label(`newline_${value}`) }))}
                  />
                )}
                <Select
                  size='mini'
                  aria-label={label('newlineOut')}
                  style={{ width: 148 }}
                  value={outputNewlines}
                  onChange={(value) => setOutputNewlines(value as TerminalNewlineMode)}
                  options={TERMINAL_NEWLINE_MODES.map((value) => ({ value, label: label(`newline_${value}`) }))}
                />
                <span className='inline-flex items-center gap-6px text-12px' style={{ color: '#8b95a7' }}>
                  <Switch size='small' checked={slowSend} onChange={setSlowSend} aria-label={label('slowSend')} />
                  {label('slowSend')}
                </span>
              </>
            )}
            {(!serialSession || inputMode === 'readlineHex') && (
              <>
                <Select
                  size='mini'
                  value={encoding}
                  style={{ width: 100 }}
                  onChange={setEncoding}
                  options={[
                    { value: 'hex', label: label('hex') },
                    { value: 'utf8', label: label('text') },
                  ]}
                />
                <Select
                  size='mini'
                  value={ending}
                  style={{ width: 120 }}
                  onChange={setEnding}
                  options={(['none', 'cr', 'lf', 'crlf'] as const).map((value) => ({
                    value,
                    label: label(`ending_${value}`),
                  }))}
                />
              </>
            )}
            {serialSession && (
              <Select
                size='mini'
                value={waitMode}
                style={{ width: 140 }}
                onChange={setWaitMode}
                options={(['none', 'count', 'pattern', 'idle'] as const).map((value) => ({
                  value,
                  label: label(`wait_${value}`),
                }))}
              />
            )}
            {serialSession && waitMode !== 'none' && (
              <>
                <Input
                  size='mini'
                  style={{ width: 120 }}
                  value={waitValue}
                  onChange={setWaitValue}
                  aria-label={label('waitValue')}
                  placeholder={label('waitValue')}
                />
                <InputNumber
                  size='mini'
                  style={{ width: 120 }}
                  value={timeoutMs}
                  min={1}
                  max={120000}
                  onChange={(value) => setTimeoutMs(value || 3000)}
                  suffix='ms'
                  aria-label={label('timeoutLabel')}
                />
              </>
            )}
            <span className='flex-1' />
            {conversationId ? (
              <>
                <button
                  type='button'
                  style={{ ...toolButton, opacity: !model.selectedId || model.selected?.status !== 'open' || working ? 0.4 : 1 }}
                  disabled={!model.selectedId || model.selected?.status !== 'open' || working}
                  onClick={() => {
                    void grant(false);
                  }}
                >
                  {label('grantConnection')}
                </button>
                <button
                  type='button'
                  style={{ ...toolButton, opacity: !profileId || working ? 0.4 : 1 }}
                  disabled={!profileId || working}
                  onClick={() => {
                    void grant(true);
                  }}
                >
                  {label('grantProfile')}
                </button>
              </>
            ) : (
              <span className='text-12px' style={{ color: '#8b95a7' }}>
                {label('grantHint')}
              </span>
            )}
          </div>
          <div className='flex items-end gap-8px'>
            <div className='flex-1 min-w-0'>
              {typing ? (
                <Input
                  aria-label={label('input')}
                  placeholder={label('inputHintNormal')}
                  readOnly
                  onKeyDown={(event) => {
                    if (event.ctrlKey || event.metaKey || event.altKey) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      sendKey('\n');
                    } else if (event.key === 'Backspace') {
                      event.preventDefault();
                      sendKey('\u007f');
                    } else if (event.key.length === 1) {
                      event.preventDefault();
                      sendKey(event.key);
                    }
                  }}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData('text');
                    if (!text) return;
                    event.preventDefault();
                    sendKey(text);
                  }}
                />
              ) : (
                <Input.TextArea
                  value={input}
                  onChange={setInput}
                  aria-label={label('input')}
                  placeholder={serialSession && inputMode === 'readline' ? label('inputHintReadline') : label('inputHint')}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  onKeyDown={(event) => {
                    if (serialSession && inputMode === 'readline' && event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
              )}
            </div>
            {!typing && (
              <Button
                type='primary'
                loading={sending}
                disabled={!manualOpen || (!(serialSession && inputMode === 'readline') && !input)}
                onClick={() => {
                  void send();
                }}
              >
                {label('send')}
              </Button>
            )}
          </div>
          {result && (
            <span className='text-12px' role='status' style={{ color: '#8b95a7' }}>
              {result}
            </span>
          )}
        </div>
      </div>
      <Modal
        title={label('profileConfig')}
        visible={!!editing}
        onCancel={() => setEditing(undefined)}
        okButtonProps={{ disabled: !configValid }}
        onOk={async () => {
          if (!editing) return;
          try {
            const saved = await ipcBridge.terminal.saveProfile.invoke(editing);
            await model.refreshProfiles();
            setProfileId(saved.id);
            setEditing(undefined);
          } catch (error) {
            model.report(error);
            throw error;
          }
        }}
      >
        {editing && (
          <TerminalConfig profile={editing} ports={ports} onChange={setEditing} onValidityChange={setConfigValid} />
        )}
        <Alert type='info' content={label('defaultsHint')} />
      </Modal>
    </div>
  );
}
