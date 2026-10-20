import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { Robot, Terminal, Usb } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { applyNewlineMode } from '@/common/terminal/stream';
import type {
  TerminalConnection,
  TerminalProfile,
  TerminalSendRequest,
  TerminalSendResult,
  TerminalWait,
} from '@/common/types/terminal';
import IconText from './components/IconText';
import ProfileEditor, { newTerminalProfile } from './components/ProfileEditor';
import SessionHeader from './components/SessionHeader';
import SessionSidebar from './components/SessionSidebar';
import TerminalComposer, { type ComposerInputMode, type ComposerWait } from './components/TerminalComposer';
import TerminalOutput from './components/TerminalOutput';
import { describeProfile, displayedTerminalEvents, parseHexInput, renderTerminalEvents, toHex } from './terminalView';
import { useTerminal } from './useTerminal';
import {
  useTerminalPreferences,
  type QuickCommand,
  type TerminalEncoding,
  type TerminalEnding,
} from './useTerminalPreferences';

const ENDING_TEXT: Record<TerminalEnding, string> = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };
const ENDING_NEWLINES = { cr: 'cr', lf: 'lf', crlf: 'crlf' } as const;

type Result = { text: string; tone: 'normal' | 'error' };

// Closed sessions the user removed from the list. Connection ids only live as long as the app run,
// so keeping them for the window's lifetime survives leaving and reopening the page.
const dismissedSessions = new Set<string>();

export default function TerminalPanel({
  conversationId,
  cwd,
  embedded = false,
}: {
  conversationId?: string;
  cwd?: string;
  /** Hosted inside a drawer that already shows the title. */
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const label = (key: string, options?: Record<string, unknown>) => t(`tools.terminal.${key}`, options);
  const model = useTerminal();
  const prefs = useTerminalPreferences();
  const [editing, setEditing] = useState<{ profile: TerminalProfile; isNew: boolean }>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [liveBaud, setLiveBaud] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(dismissedSessions));
  const setSessionHidden = (id: string, hide: boolean) => {
    if (hide) dismissedSessions.add(id);
    else dismissedSessions.delete(id);
    setHidden(new Set(dismissedSessions));
  };
  const [inputMode, setInputMode] = useState<ComposerInputMode>('line');
  const [wait, setWait] = useState<ComposerWait>({ mode: 'none', value: '', timeoutMs: 3000 });
  const [slowSend, setSlowSend] = useState(false);
  const [sending, setSending] = useState(false);
  const [working, setWorking] = useState(false);

  const connections = useMemo(
    () => model.connections.filter((connection) => !hidden.has(connection.id)),
    [model.connections, hidden]
  );
  const selected = model.selected && !hidden.has(model.selected.id) ? model.selected : undefined;
  const kind = selected?.profile.kind ?? 'serial';
  const view = prefs.view[kind];
  const effectiveInputMode: ComposerInputMode = kind === 'shell' ? 'line' : inputMode;
  const encoding: TerminalEncoding = kind === 'shell' ? 'utf8' : view.encoding;
  const enabled = selected?.status === 'open' && selected.owner === 'manual';
  const baudRate = selected
    ? (liveBaud[selected.id] ?? (selected.profile.kind === 'serial' ? selected.profile.baudRate : undefined))
    : undefined;

  // Reopening the page lands on a live session instead of an empty view.
  useEffect(() => {
    if (model.selectedId && !hidden.has(model.selectedId)) return;
    const next = connections.find((connection) => connection.status === 'open') ?? connections[0];
    if (next?.id !== model.selectedId) model.setSelectedId(next?.id);
  }, [connections, hidden, model.selectedId, model.setSelectedId]);

  const localizeError = (message: string): string => {
    if (message.includes('terminal.mcpNotSelected')) return label('mcpNotSelected');
    if (message.includes('terminal.shellMissing')) return label('shellMissing');
    if (message.includes('terminal.disconnected') || message.includes('connection is closed'))
      return label('notConnected');
    if (message.includes('Take over the terminal')) return label('aiControlling');
    if (/access denied|resource busy|EBUSY/i.test(message)) return label('portBusy');
    if (/file not found|no such file|ENOENT|cannot open/i.test(message)) return label('portMissing');
    return message;
  };
  const run = async (action: () => Promise<unknown>) => {
    model.setError('');
    try {
      await action();
    } catch (error) {
      model.report(new Error(localizeError(error instanceof Error ? error.message : String(error))));
    }
  };
  const setResult = (id: string, result: Result) => setResults((previous) => ({ ...previous, [id]: result }));
  const describeResult = (response: TerminalSendResult): Result => ({
    tone: response.status === 'completed' ? 'normal' : 'error',
    text: [
      label(response.status === 'timeout' ? 'timeoutResult' : response.status),
      response.writePending ? label('writePending') : label('sentBytes', { count: response.writtenBytes }),
      ...(response.wait
        ? [
            label(response.wait.status === 'timeout' ? 'timeoutResult' : response.wait.status),
            label('receivedBytes', { count: response.wait.byteLength }),
          ]
        : []),
      ...(response.error ? [localizeError(response.error)] : []),
    ].join(' · '),
  });

  const openProfile = (profile: TerminalProfile) => {
    const existing = model.connections.find(
      (connection) => connection.profile.id === profile.id && connection.status === 'open'
    );
    if (existing) {
      setSessionHidden(existing.id, false);
      model.setSelectedId(existing.id);
      return;
    }
    setWorking(true);
    void run(async () => {
      const connection = await ipcBridge.terminal.open.invoke(profile);
      await model.refreshConnections();
      model.setSelectedId(connection.id);
    }).finally(() => setWorking(false));
  };

  const saveProfile = async (profile: TerminalProfile, connect: boolean) => {
    try {
      const saved = await ipcBridge.terminal.saveProfile.invoke(profile);
      await model.refreshProfiles();
      setEditing(undefined);
      if (connect) openProfile(saved);
    } catch (error) {
      model.report(new Error(localizeError(error instanceof Error ? error.message : String(error))));
    }
  };

  const reconnect = () => {
    if (!selected) return;
    const profile =
      selected.profile.kind === 'serial' && baudRate ? { ...selected.profile, baudRate } : selected.profile;
    const previous = selected;
    setWorking(true);
    void run(async () => {
      if (previous.status === 'open') await ipcBridge.terminal.close.invoke({ id: previous.id });
      const connection = await ipcBridge.terminal.open.invoke(profile);
      // The replaced session only duplicates the new one in the list.
      setSessionHidden(previous.id, true);
      await model.refreshConnections();
      model.setSelectedId(connection.id);
    }).finally(() => setWorking(false));
  };

  const changeBaud = (next: number) => {
    if (!selected || !Number.isInteger(next) || next < 1) return;
    const id = selected.id;
    const previous = baudRate;
    setLiveBaud((current) => ({ ...current, [id]: next }));
    void run(async () => {
      try {
        const updated = await ipcBridge.terminal.setBaud.invoke({ id, baudRate: next });
        if (updated.profile.kind === 'serial') {
          const confirmed = updated.profile.baudRate;
          setLiveBaud((current) => ({ ...current, [id]: confirmed }));
        }
      } catch (error) {
        setLiveBaud((current) => ({ ...current, [id]: previous ?? next }));
        throw error;
      }
    });
  };

  const waitCondition = (): TerminalWait | undefined => {
    if (kind !== 'serial' || wait.mode === 'none') return undefined;
    if (wait.mode === 'pattern') {
      return { mode: 'pattern', pattern: wait.value, patternEncoding: encoding, timeoutMs: wait.timeoutMs };
    }
    const amount = Number(wait.value);
    if (!Number.isInteger(amount) || amount < 1) throw new Error(label('waitInvalid'));
    return wait.mode === 'count'
      ? { mode: 'count', count: amount, timeoutMs: wait.timeoutMs }
      : { mode: 'idle', idleMs: amount, timeoutMs: wait.timeoutMs };
  };

  const transmit = async (connection: TerminalConnection, request: TerminalSendRequest) => {
    const response = await ipcBridge.terminal.send.invoke({
      id: connection.id,
      request: slowSend && connection.profile.kind === 'serial' ? { ...request, slow: true } : request,
    });
    setResult(connection.id, describeResult(response));
    model.refresh();
    return response;
  };

  const payload = (data: string, payloadEncoding: TerminalEncoding, ending: TerminalEnding): TerminalSendRequest => {
    if (payloadEncoding === 'hex') {
      const parsed = parseHexInput(data);
      if (parsed.ok === false) throw new Error(label(parsed.reason));
      return { data: parsed.hex, encoding: 'hex', ending };
    }
    // Multi-line text uses the selected line ending between lines too.
    const text = ending === 'none' ? data : applyNewlineMode(data, ENDING_NEWLINES[ending]);
    return { data: text, encoding: 'utf8', ending };
  };

  const send = () => {
    if (!selected || !enabled) return;
    const connection = selected;
    const data = drafts[connection.id] ?? '';
    setSending(true);
    void run(async () => {
      const request = { ...payload(data, encoding, view.ending), wait: waitCondition() };
      await transmit(connection, request);
      prefs.remember(connection.profile.kind, { data, encoding });
      setDrafts((previous) => ({ ...previous, [connection.id]: '' }));
    }).finally(() => setSending(false));
  };

  const sendKeys = (text: string) => {
    if (!selected || !enabled) return;
    const connection = selected;
    const data = text === '\n' ? ENDING_TEXT[view.ending] || '\r' : text;
    void run(() => transmit(connection, { data, encoding: 'utf8', ending: 'none' }));
  };

  const runQuick = (command: QuickCommand) => {
    if (!selected || !enabled) return;
    const connection = selected;
    void run(() => transmit(connection, payload(command.data, command.encoding, command.ending)));
  };

  const exportLog = async () => {
    if (!selected) return;
    const records = [];
    let cursor = 0;
    let more = true;
    let bytes = 0;
    let lost = false;
    // Snapshot bounded history; incoming data beyond the initial cursor limit is left for another export.
    let limit: number | undefined;
    while (more && bytes < 4 * 1024 * 1024 && records.length < 65536) {
      const batch = await ipcBridge.terminal.read.invoke({ id: selected.id, cursor });
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
          { connection: selected, exportedAt: new Date().toISOString(), lost, more, records: content },
          null,
          2
        ),
      ],
      { type: 'application/json;charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `woody-terminal-${selected.profile.name.replace(/[\\/:*?"<>|\s]+/g, '_')}-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const grant = (scope: 'connection' | 'profile') => {
    if (!conversationId || !selected) return;
    const connection = selected;
    setWorking(true);
    void run(async () => {
      await ipcBridge.terminal.grant.invoke({
        conversationId,
        language: i18n.language,
        ...(scope === 'profile' ? { profileId: connection.profile.id } : { connectionId: connection.id }),
      });
      setResult(connection.id, { text: label('granted'), tone: 'normal' });
    }).finally(() => setWorking(false));
  };

  const errorBanner = model.error && (
    <div className='shrink-0 px-16px pt-12px'>
      <Alert type='error' content={localizeError(model.error)} closable onClose={() => model.setError('')} />
    </div>
  );

  const startCard = (profile: TerminalProfile) => (
    <div
      key={profile.id}
      role='button'
      tabIndex={0}
      className='flex items-center gap-12px p-12px rd-10px border border-[var(--border-base)] bg-base cursor-pointer transition-colors hover:bg-fill-1 outline-none focus-visible:bg-fill-1'
      onClick={() => openProfile(profile)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openProfile(profile);
        }
      }}
    >
      <span className='size-36px shrink-0 rd-8px bg-fill-2 flex-center text-t-secondary'>
        {profile.kind === 'serial' ? (
          <Usb theme='outline' fill='currentColor' size='18' />
        ) : (
          <Terminal theme='outline' fill='currentColor' size='18' />
        )}
      </span>
      <div className='min-w-0'>
        <div className='truncate text-14px font-500 text-t-primary'>{profile.name}</div>
        <div className='truncate text-12px text-t-tertiary'>{describeProfile(profile, label('shellDefault'))}</div>
      </div>
    </div>
  );

  const emptyState =
    model.profiles.length === 0 ? (
      <div className='flex-1 flex-center px-24px'>
        <div className='max-w-440px flex flex-col items-center text-center gap-12px'>
          <div className='flex items-center gap-10px text-t-tertiary'>
            <span className='size-48px rd-12px bg-fill-2 flex-center'>
              <Usb theme='outline' fill='currentColor' size='24' />
            </span>
            <span className='size-48px rd-12px bg-fill-2 flex-center'>
              <Terminal theme='outline' fill='currentColor' size='24' />
            </span>
          </div>
          <div className='text-16px font-600 text-t-primary'>{label('welcomeTitle')}</div>
          <div className='text-13px leading-20px text-t-secondary'>{label('welcomeBody')}</div>
          <div className='flex gap-8px mt-4px'>
            <Button type='primary' onClick={() => setEditing({ profile: newTerminalProfile('serial'), isNew: true })}>
              <IconText icon={<Usb theme='outline' fill='currentColor' size='14' />}>{label('newSerial')}</IconText>
            </Button>
            <Button onClick={() => setEditing({ profile: newTerminalProfile('shell', cwd), isNew: true })}>
              <IconText icon={<Terminal theme='outline' fill='currentColor' size='14' />}>{label('newShell')}</IconText>
            </Button>
          </div>
        </div>
      </div>
    ) : (
      <div className='flex-1 min-h-0 overflow-y-auto px-32px py-40px'>
        <div className='max-w-720px mx-auto flex flex-col gap-16px'>
          <div>
            <div className='text-16px font-600 text-t-primary'>{label('pickProfileTitle')}</div>
            <div className='mt-4px text-13px text-t-tertiary'>{label('pickProfileBody')}</div>
          </div>
          <div className='grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-10px'>
            {model.profiles.map(startCard)}
          </div>
        </div>
      </div>
    );

  return (
    <div className='h-full min-h-0 box-border overflow-hidden flex bg-base text-t-primary'>
      <SessionSidebar
        title={embedded ? undefined : label('title')}
        profiles={model.profiles}
        connections={connections}
        selectedId={selected?.id}
        onSelect={model.setSelectedId}
        onOpenProfile={openProfile}
        onNewProfile={(profileKind) =>
          setEditing({
            profile: newTerminalProfile(profileKind, profileKind === 'shell' ? cwd : undefined),
            isNew: true,
          })
        }
        onEditProfile={(profile) => setEditing({ profile, isNew: false })}
        onDeleteProfile={(profile) =>
          void run(async () => {
            await ipcBridge.terminal.removeProfile.invoke({ id: profile.id });
            await model.refreshProfiles();
          })
        }
        onDisconnect={(connection) =>
          void run(async () => {
            await ipcBridge.terminal.close.invoke({ id: connection.id });
            await model.refreshConnections();
          })
        }
        onDismiss={(connection) => setSessionHidden(connection.id, true)}
      />
      <main className='flex-1 min-w-0 min-h-0 flex flex-col'>
        {errorBanner}
        {selected ? (
          <>
            <SessionHeader
              connection={selected}
              baudRate={baudRate}
              view={view}
              working={working}
              canGrant={Boolean(conversationId)}
              onBaudChange={changeBaud}
              onViewChange={(patch) => prefs.updateView(kind, patch)}
              onClear={model.clear}
              onExport={() => void run(exportLog)}
              onDisconnect={() =>
                void run(async () => {
                  await ipcBridge.terminal.close.invoke({ id: selected.id });
                  await model.refreshConnections();
                })
              }
              onReconnect={reconnect}
              onGrant={grant}
            />
            {selected.owner === 'ai' && selected.status === 'open' && (
              <div className='shrink-0 flex items-center gap-10px px-16px py-8px bg-primary-light-1 text-13px text-t-primary'>
                <Robot theme='outline' fill='currentColor' size='16' className='text-primary' />
                <span className='flex-1 min-w-0'>{label('aiControlling')}</span>
                <Button
                  size='small'
                  type='primary'
                  onClick={() =>
                    void run(async () => {
                      await ipcBridge.terminal.takeover.invoke({ id: selected.id });
                      await model.refreshConnections();
                    })
                  }
                >
                  {label('takeover')}
                </Button>
              </div>
            )}
            {model.lost && (
              <div className='shrink-0 px-16px py-6px text-12px text-warning bg-warning-light-1'>
                {label('historyLost')}
              </div>
            )}
            <TerminalOutput
              events={displayedTerminalEvents(model.events, kind === 'serial' && effectiveInputMode === 'keys')}
              view={view}
              emptyText={label(selected.status === 'open' ? 'waitingOutput' : 'closedOutput')}
              onResend={
                enabled
                  ? (frame) =>
                      void run(() => transmit(selected, { data: toHex(frame.bytes), encoding: 'hex', ending: 'none' }))
                  : undefined
              }
            />
            <TerminalComposer
              kind={kind}
              enabled={Boolean(enabled)}
              disabledReason={label(selected.status !== 'open' ? 'notConnected' : 'aiControlling')}
              value={drafts[selected.id] ?? ''}
              onValueChange={(value) => setDrafts((previous) => ({ ...previous, [selected.id]: value }))}
              encoding={encoding}
              onEncodingChange={(next) => prefs.updateView(kind, { encoding: next })}
              ending={view.ending}
              onEndingChange={(ending) => prefs.updateView(kind, { ending })}
              inputMode={effectiveInputMode}
              onInputModeChange={setInputMode}
              wait={wait}
              onWaitChange={setWait}
              slowSend={slowSend}
              onSlowSendChange={setSlowSend}
              sending={sending}
              history={prefs.history[kind]}
              onSend={send}
              onSendKeys={sendKeys}
              onCancelWait={() => void run(() => ipcBridge.terminal.cancel.invoke({ id: selected.id }))}
              onInterrupt={() => void run(() => ipcBridge.terminal.interrupt.invoke({ id: selected.id }))}
              quickCommands={prefs.quickCommands.filter((command) => command.kind === kind)}
              onRunQuick={runQuick}
              onSaveQuick={(name) =>
                prefs.saveQuickCommand({ kind, name, data: drafts[selected.id] ?? '', encoding, ending: view.ending })
              }
              onRemoveQuick={prefs.removeQuickCommand}
              counters={model.counters}
              result={results[selected.id]}
            />
          </>
        ) : (
          emptyState
        )}
      </main>
      <ProfileEditor
        profile={editing?.profile}
        isNew={editing?.isNew ?? true}
        onCancel={() => setEditing(undefined)}
        onSave={saveProfile}
      />
    </div>
  );
}
