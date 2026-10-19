import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, InputNumber, Modal, Select, Space, Tag } from '@arco-design/web-react';
import { Add, Clear, Download, Refresh, Terminal } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TerminalProfile, TerminalSendRequest, TerminalWait } from '@/common/types/terminal';
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
  const [hexView, setHexView] = useState(true);
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
  const display = useMemo(() => renderTerminalEvents(model.events, hexView), [model.events, hexView]);
  useEffect(() => {
    if (outputRef.current && followOutput.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [model.events]);
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
    if (model.selected?.profile.kind === 'shell') {
      setEncoding('utf8');
      setHexView(false);
      setEnding('cr');
    } else {
      setEncoding('hex');
      setHexView(true);
      setEnding('none');
    }
  }, [model.selectedId, model.selected?.profile.kind]);
  const send = async () => {
    if (!model.selectedId) return;
    setSending(true);
    await run(async () => {
      const wait: TerminalWait | undefined =
        waitMode === 'none' || model.selected?.profile.kind === 'shell'
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
      const response = await ipcBridge.terminal.send.invoke({
        id: model.selectedId!,
        request: { data: input, encoding, ending, wait },
      });
      setResult(
        `${label(response.status)} · ${response.writePending ? label('writePending') : t('tools.terminal.sentBytes', { count: response.writtenBytes })}${response.wait ? ` · ${label(response.wait.status)} · ${t('tools.terminal.receivedBytes', { count: response.wait.byteLength })}` : ''}${response.error ? ` · ${response.error}` : ''}`
      );
    });
    setSending(false);
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
  return (
    <div className='h-full min-h-0 box-border overflow-y-auto flex flex-col gap-16px px-16px py-20px text-t-primary bg-1'>
      <div className='flex items-start justify-between gap-16px shrink-0'>
        <div className='min-w-0'>
          <div className='flex items-center gap-8px text-18px font-bold text-t-primary'>
            <Terminal theme='outline' size='20' />
            <span>{label('title')}</span>
          </div>
          <p className='m-0 mt-6px text-13px text-t-secondary'>{label('description')}</p>
        </div>
        <Button
          type='primary'
          icon={<Add theme='outline' size='16' />}
          onClick={() => setEditing(newTerminalProfile('shell', cwd))}
        >
          {label('newProfile')}
        </Button>
      </div>
      <div className='shrink-0 border border-solid border-border-2 rd-8px p-14px flex flex-col gap-12px'>
        <div className='flex flex-wrap items-center gap-8px'>
          <span className='w-88px shrink-0 text-12px text-t-secondary'>{label('profiles')}</span>
          <Select
            className='flex-1 min-w-180px'
            placeholder={label('profiles')}
            aria-label={label('profiles')}
            value={profileId}
            onChange={setProfileId}
            options={model.profiles.map((item) => ({ label: item.name, value: item.id }))}
          />
          <Button
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
          <Button disabled={!profile} onClick={() => setEditing(profile)}>
            {label('edit')}
          </Button>
          <Button
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
          <Button
            type='text'
            icon={<Refresh theme='outline' size='15' />}
            onClick={() => {
              void refreshPorts();
            }}
          >
            {label('refreshPorts')}
          </Button>
        </div>
        <div className='flex flex-wrap items-center gap-8px'>
          <span className='w-88px shrink-0 text-12px text-t-secondary'>{label('connections')}</span>
          <Select
            className='flex-1 min-w-180px'
            placeholder={label('connections')}
            aria-label={label('connections')}
            value={model.selectedId}
            onChange={model.setSelectedId}
            options={model.connections.map((connection) => ({
              value: connection.id,
              label: `${connection.profile.name} · ${label(connection.status)} · ${label(connection.owner)}`,
            }))}
          />
        </div>
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
        {model.selected && (
          <Space wrap>
            <Tag color={model.selected.status === 'open' ? 'green' : undefined}>{label(model.selected.status)}</Tag>
            <Tag>{label(model.selected.owner)}</Tag>
            <span className='text-12px text-t-secondary'>
              {model.selected.profile.kind === 'serial'
                ? `${model.selected.profile.path} · ${model.selected.profile.baudRate} · ${model.selected.profile.dataBits}/${label(model.selected.profile.parity)}/${model.selected.profile.stopBits}`
                : `${model.selected.profile.executable || label('autoShell')} · ${model.selected.profile.cwd || cwd || ''}`}
            </span>
            <Button
              size='small'
              onClick={() => {
                void run(() => ipcBridge.terminal.takeover.invoke({ id: model.selectedId! }));
              }}
            >
              {label('takeover')}
            </Button>
            <Button
              size='small'
              onClick={() => {
                void run(() => ipcBridge.terminal.cancel.invoke({ id: model.selectedId! }));
              }}
            >
              {label('cancelWait')}
            </Button>
            <Button
              size='small'
              disabled={model.selected.owner !== 'manual' || model.selected.profile.kind !== 'shell'}
              onClick={() => {
                void run(() => ipcBridge.terminal.interrupt.invoke({ id: model.selectedId! }));
              }}
            >
              {label('interrupt')}
            </Button>
            <Button
              size='small'
              onClick={() => {
                void run(() => ipcBridge.terminal.close.invoke({ id: model.selectedId! }));
              }}
            >
              {label('disconnect')}
            </Button>
          </Space>
        )}
      </div>
      <div className='flex-1 min-h-220px flex flex-col overflow-hidden border border-solid border-border-2 rd-8px'>
        <div className='shrink-0 flex flex-wrap items-center justify-between gap-8px px-14px py-10px border-b border-solid border-border-2'>
          <span className='text-13px font-[600]'>{label('output')}</span>
          <Space wrap>
            <Select
              size='small'
              value={hexView ? 'hex' : 'utf8'}
              style={{ width: 100 }}
              onChange={(value) => setHexView(value === 'hex')}
              options={[
                { value: 'hex', label: label('hex') },
                { value: 'utf8', label: label('text') },
              ]}
            />
            <Button type='text' size='small' icon={<Clear theme='outline' size='15' />} onClick={model.clear}>
              {label('clear')}
            </Button>
            <Button
              type='text'
              size='small'
              icon={<Download theme='outline' size='15' />}
              disabled={!model.selectedId}
              onClick={() => {
                void run(exportLog);
              }}
            >
              {label('export')}
            </Button>
          </Space>
        </div>
        <div
          ref={outputRef}
          role='log'
          aria-label={label('output')}
          onScroll={(event) => {
            const target = event.currentTarget;
            followOutput.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
          }}
          className='flex-1 min-h-0 overflow-auto bg-fill-1 p-14px font-mono text-12px leading-20px'
        >
          {display.length === 0 ? (
            <div className='h-full min-h-120px flex items-center justify-center'>
              <Empty
                icon={<Terminal theme='outline' size='32' />}
                description={label(model.selected?.status === 'open' ? 'waitingOutput' : 'emptyOutput')}
              />
            </div>
          ) : (
            display.map((event) => (
              <div key={event.cursor} className='whitespace-pre-wrap break-all'>
                <span className='text-t-tertiary'>
                  {new Date(event.timestamp).toLocaleTimeString()} {label(event.direction)} {label(event.source)} (
                  {event.byteLength}){' '}
                </span>
                <span>{event.text}</span>
                {event.status === 'failed' && (
                  <span className='text-danger'>
                    {' '}
                    {label('failed')}: {event.error}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        <div className='shrink-0 flex flex-wrap items-center justify-between gap-8px px-14px py-8px border-t border-solid border-border-2'>
          <span className='text-12px text-t-tertiary'>{label('viewLimit')}</span>
        </div>
      </div>
      <div className='shrink-0 border border-solid border-border-2 rd-8px p-14px flex flex-col gap-12px'>
        <div className='flex flex-wrap items-center justify-between gap-8px'>
          <span className='text-13px font-[600]'>{label('input')}</span>
          <Space wrap>
            {conversationId ? (
              <>
                <Button
                  type='text'
                  size='small'
                  disabled={!model.selectedId || model.selected?.status !== 'open' || working}
                  onClick={() => {
                    void grant(false);
                  }}
                >
                  {label('grantConnection')}
                </Button>
                <Button
                  type='text'
                  size='small'
                  disabled={!profileId || working}
                  onClick={() => {
                    void grant(true);
                  }}
                >
                  {label('grantProfile')}
                </Button>
              </>
            ) : (
              <span className='text-12px text-t-tertiary'>{label('grantHint')}</span>
            )}
          </Space>
        </div>
        <Space wrap>
          <Select
            value={encoding}
            style={{ width: 110 }}
            onChange={setEncoding}
            options={[
              { value: 'hex', label: label('hex') },
              { value: 'utf8', label: label('text') },
            ]}
          />
          <Select
            value={ending}
            style={{ width: 140 }}
            onChange={setEnding}
            options={(['none', 'cr', 'lf', 'crlf'] as const).map((value) => ({
              value,
              label: label(`ending_${value}`),
            }))}
          />
          {model.selected?.profile.kind === 'serial' && (
            <>
              <Select
                value={waitMode}
                style={{ width: 160 }}
                onChange={setWaitMode}
                options={(['none', 'count', 'pattern', 'idle'] as const).map((value) => ({
                  value,
                  label: label(`wait_${value}`),
                }))}
              />
              {waitMode !== 'none' && (
                <>
                  <Input
                    style={{ width: 140 }}
                    value={waitValue}
                    onChange={setWaitValue}
                    aria-label={label('waitValue')}
                    placeholder={label('waitValue')}
                  />
                  <InputNumber
                    style={{ width: 140 }}
                    value={timeoutMs}
                    min={1}
                    max={120000}
                    onChange={(value) => setTimeoutMs(value || 3000)}
                    suffix='ms'
                    aria-label={label('timeoutLabel')}
                  />
                </>
              )}
            </>
          )}
        </Space>
        <Input.TextArea
          value={input}
          onChange={setInput}
          aria-label={label('input')}
          placeholder={label('inputHint')}
          autoSize={{ minRows: 2, maxRows: 6 }}
        />
        <div className='flex items-center justify-between gap-12px'>
          <span className='text-12px text-t-secondary' role='status'>
            {result}
          </span>
          <Button
            type='primary'
            loading={sending}
            disabled={
              !model.selectedId || model.selected?.status !== 'open' || model.selected.owner !== 'manual' || !input
            }
            onClick={() => {
              void send();
            }}
          >
            {label('send')}
          </Button>
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
