import React, { useRef, useState } from 'react';
import { Button, Input, InputNumber, Popover, Radio, Select, Switch, Tooltip } from '@arco-design/web-react';
import { Close, Keyboard, Lightning, SendOne, SettingTwo } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { TerminalWait } from '@/common/types/terminal';
import { formatByteSize, parseHexInput } from '../terminalView';
import type {
  HistoryEntry,
  QuickCommand,
  TerminalEncoding,
  TerminalEnding,
  TerminalKind,
} from '../useTerminalPreferences';
import IconText from './IconText';

export type ComposerInputMode = 'line' | 'keys' | 'keysEcho';
export type ComposerWait = { mode: 'none' | TerminalWait['mode']; value: string; timeoutMs: number };

const ENDINGS: TerminalEnding[] = ['none', 'cr', 'lf', 'crlf'];

/** Byte count or the reason the payload cannot be sent. */
export function inspectPayload(
  data: string,
  encoding: TerminalEncoding
): { ok: true; bytes: number } | { ok: false; reason: string } {
  if (encoding === 'hex') {
    const parsed = parseHexInput(data);
    return parsed.ok === false ? { ok: false, reason: parsed.reason } : { ok: true, bytes: parsed.bytes };
  }
  return { ok: true, bytes: new TextEncoder().encode(data).length };
}

export default function TerminalComposer({
  kind,
  enabled,
  disabledReason,
  value,
  onValueChange,
  encoding,
  onEncodingChange,
  ending,
  onEndingChange,
  inputMode,
  onInputModeChange,
  wait,
  onWaitChange,
  slowSend,
  onSlowSendChange,
  sending,
  history,
  onSend,
  onSendKeys,
  onCancelWait,
  onInterrupt,
  quickCommands,
  onRunQuick,
  onSaveQuick,
  onRemoveQuick,
  counters,
  result,
}: {
  kind: TerminalKind;
  enabled: boolean;
  disabledReason?: string;
  value: string;
  onValueChange: (value: string) => void;
  encoding: TerminalEncoding;
  onEncodingChange: (encoding: TerminalEncoding) => void;
  ending: TerminalEnding;
  onEndingChange: (ending: TerminalEnding) => void;
  inputMode: ComposerInputMode;
  onInputModeChange: (mode: ComposerInputMode) => void;
  wait: ComposerWait;
  onWaitChange: (wait: ComposerWait) => void;
  slowSend: boolean;
  onSlowSendChange: (slow: boolean) => void;
  sending: boolean;
  history: HistoryEntry[];
  onSend: () => void;
  onSendKeys: (text: string) => void;
  onCancelWait: () => void;
  onInterrupt: () => void;
  quickCommands: QuickCommand[];
  onRunQuick: (command: QuickCommand) => void;
  onSaveQuick: (name: string) => void;
  onRemoveQuick: (id: string) => void;
  counters: { rx: number; tx: number };
  result?: { text: string; tone: 'normal' | 'error' };
}) {
  const { t } = useTranslation();
  const label = (key: string, options?: Record<string, unknown>) => t(`tools.terminal.${key}`, options);
  const serial = kind === 'serial';
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [quickName, setQuickName] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const draftBeforeHistory = useRef('');
  const inspection = inspectPayload(value, encoding);
  const sendable =
    enabled && !sending && inspection.ok && (inspection.bytes > 0 || ending !== 'none' || kind === 'shell');

  const recall = (direction: 1 | -1) => {
    if (history.length === 0) return false;
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + direction));
    if (next === historyIndex) return false;
    if (historyIndex === -1) draftBeforeHistory.current = value;
    setHistoryIndex(next);
    if (next === -1) onValueChange(draftBeforeHistory.current);
    else {
      onValueChange(history[next].data);
      if (serial && history[next].encoding !== encoding) onEncodingChange(history[next].encoding);
    }
    return true;
  };

  const submit = () => {
    if (!sendable) return;
    setHistoryIndex(-1);
    onSend();
  };

  const sendOptions = (
    <div className='w-280px flex flex-col gap-14px py-2px text-13px'>
      <div className='flex flex-col gap-6px'>
        <span className='text-12px text-t-tertiary'>{label('inputMode')}</span>
        <Radio.Group
          type='button'
          size='small'
          value={inputMode}
          onChange={onInputModeChange}
          options={[
            { value: 'line', label: label('inputMode_readline') },
            { value: 'keys', label: label('inputMode_normal') },
            { value: 'keysEcho', label: label('inputMode_localEcho') },
          ]}
        />
      </div>
      <div className='flex flex-col gap-6px'>
        <span className='text-12px text-t-tertiary'>{label('waitReply')}</span>
        <Select
          size='small'
          value={wait.mode}
          onChange={(mode) => onWaitChange({ ...wait, mode })}
          options={(['none', 'count', 'pattern', 'idle'] as const).map((mode) => ({
            value: mode,
            label: label(`wait_${mode}`),
          }))}
        />
        {wait.mode !== 'none' && (
          <div className='flex gap-8px'>
            <Input
              size='small'
              value={wait.value}
              placeholder={label(`waitPlaceholder_${wait.mode}`)}
              aria-label={label('waitValue')}
              onChange={(next) => onWaitChange({ ...wait, value: next })}
            />
            <InputNumber
              size='small'
              className='!w-120px shrink-0'
              min={1}
              max={120000}
              suffix='ms'
              value={wait.timeoutMs}
              aria-label={label('timeoutLabel')}
              onChange={(timeoutMs) => onWaitChange({ ...wait, timeoutMs: Number(timeoutMs) || 3000 })}
            />
          </div>
        )}
      </div>
      <div className='flex items-center justify-between gap-12px'>
        <span>{label('slowSend')}</span>
        <Switch size='small' checked={slowSend} onChange={onSlowSendChange} />
      </div>
    </div>
  );

  const quickPopover = (
    <div className='w-240px flex flex-col gap-10px'>
      <Input
        size='small'
        autoFocus
        value={quickName}
        maxLength={32}
        placeholder={label('quickName')}
        onChange={setQuickName}
        onPressEnter={() => {
          onSaveQuick(quickName.trim() || value.trim().slice(0, 18));
          setQuickOpen(false);
        }}
      />
      <div className='flex justify-end gap-8px'>
        <Button size='mini' onClick={() => setQuickOpen(false)}>
          {t('common.cancel')}
        </Button>
        <Button
          size='mini'
          type='primary'
          onClick={() => {
            onSaveQuick(quickName.trim() || value.trim().slice(0, 18));
            setQuickOpen(false);
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );

  const status = !enabled
    ? { text: disabledReason ?? '', error: false }
    : inspection.ok === false
      ? { text: label(inspection.reason), error: true }
      : {
          text: [
            ...(value ? [label('byteCount', { count: inspection.bytes })] : []),
            inputMode === 'line'
              ? label(value.includes('\n') ? 'hintMultiline' : 'hintLine')
              : label('inputHintNormal'),
          ].join(' · '),
          error: false,
        };

  return (
    <div className='shrink-0 flex flex-col gap-8px px-16px pt-10px pb-10px border-t border-[var(--border-base)] bg-base'>
      {quickCommands.length > 0 && (
        <div className='flex items-center gap-6px overflow-x-auto pb-2px'>
          <Lightning theme='outline' fill='currentColor' size='14' className='shrink-0 text-t-tertiary' />
          {quickCommands.map((command) => (
            <div
              key={command.id}
              className='group shrink-0 inline-flex items-center rd-6px bg-fill-2 hover:bg-fill-3 transition-colors'
            >
              <Tooltip
                content={<span className='font-mono'>{command.data || label(`ending_${command.ending}`)}</span>}
                mini
              >
                <Button
                  size='mini'
                  type='text'
                  className='!text-t-primary !px-8px'
                  disabled={!enabled}
                  onClick={() => onRunQuick(command)}
                >
                  {command.name}
                </Button>
              </Tooltip>
              <Button
                size='mini'
                type='text'
                className='!w-18px !px-0 opacity-0 group-hover:opacity-100'
                aria-label={label('removeQuick')}
                icon={<Close theme='outline' fill='currentColor' size='10' />}
                onClick={() => onRemoveQuick(command.id)}
              />
            </div>
          ))}
        </div>
      )}
      <div className='flex items-end gap-8px'>
        {serial && inputMode === 'line' && (
          <Radio.Group
            type='button'
            value={encoding}
            onChange={onEncodingChange}
            disabled={!enabled}
            options={[
              { value: 'hex', label: label('hex') },
              { value: 'utf8', label: label('encodingText') },
            ]}
          />
        )}
        {!serial && (
          <Tooltip content={label('interrupt')} mini>
            <Button disabled={!enabled} onClick={onInterrupt} className='font-mono'>
              {label('interruptShort')}
            </Button>
          </Tooltip>
        )}
        <div className='flex-1 min-w-0'>
          {inputMode === 'line' ? (
            <Input.TextArea
              value={value}
              disabled={!enabled}
              aria-label={label('input')}
              placeholder={
                enabled
                  ? label(serial ? (encoding === 'hex' ? 'placeholderHex' : 'placeholderText') : 'placeholderShell')
                  : disabledReason
              }
              autoSize={{ minRows: 1, maxRows: 6 }}
              spellCheck={false}
              // Typed payloads read best monospaced; localized placeholders keep the UI font.
              className={classNames(value && 'font-mono', !inspection.ok && enabled && '!border-[var(--danger)]')}
              onChange={(next) => {
                setHistoryIndex(-1);
                onValueChange(next);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !value.includes('\n')) {
                  if (recall(event.key === 'ArrowUp' ? 1 : -1)) event.preventDefault();
                }
              }}
            />
          ) : (
            <Input
              readOnly
              disabled={!enabled}
              aria-label={label('input')}
              prefix={<Keyboard theme='outline' fill='currentColor' size='14' />}
              placeholder={enabled ? label('placeholderKeys') : disabledReason}
              onKeyDown={(event) => {
                if (event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSendKeys('\n');
                } else if (event.key === 'Backspace') {
                  event.preventDefault();
                  onSendKeys('\u007f');
                } else if (event.key === 'Tab') {
                  event.preventDefault();
                  onSendKeys('\t');
                } else if (event.key.length === 1) {
                  event.preventDefault();
                  onSendKeys(event.key);
                }
              }}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text');
                if (!text) return;
                event.preventDefault();
                onSendKeys(text);
              }}
            />
          )}
        </div>
        {inputMode === 'line' && (
          <>
            <Select
              className='!w-112px shrink-0'
              value={ending}
              disabled={!enabled}
              onChange={onEndingChange}
              aria-label={label('ending')}
              options={ENDINGS.map((item) => ({ value: item, label: label(`ending_${item}`) }))}
            />
            <Popover
              trigger='click'
              position='top'
              popupVisible={quickOpen}
              onVisibleChange={(visible) => {
                setQuickOpen(visible && Boolean(value.trim()) && inspection.ok);
                if (visible) setQuickName('');
              }}
              title={label('saveQuick')}
              content={quickPopover}
            >
              <Tooltip content={label('saveQuick')} mini>
                <Button
                  aria-label={label('saveQuick')}
                  disabled={!value.trim() || !inspection.ok}
                  icon={<Lightning theme='outline' fill='currentColor' size='15' />}
                />
              </Tooltip>
            </Popover>
            {sending && wait.mode !== 'none' ? (
              <Button status='danger' onClick={onCancelWait}>
                {label('stopWaiting')}
              </Button>
            ) : (
              <Button type='primary' loading={sending} disabled={!sendable} onClick={submit}>
                <IconText icon={<SendOne theme='outline' fill='currentColor' size='14' />}>{label('send')}</IconText>
              </Button>
            )}
          </>
        )}
      </div>
      <div className='flex items-center gap-12px min-h-18px text-12px text-t-tertiary'>
        <span className={classNames('truncate', status.error && 'text-danger')}>{status.text}</span>
        <span className='flex-1' />
        {result && (
          <span className={classNames('truncate max-w-[45%]', result.tone === 'error' && 'text-danger')} role='status'>
            {result.text}
          </span>
        )}
        <span className='shrink-0 tabular-nums'>
          {label('rxBadge')} {formatByteSize(counters.rx)} · {label('txBadge')} {formatByteSize(counters.tx)}
        </span>
        {serial && (
          <Popover trigger='click' position='tr' title={label('sendOptions')} content={sendOptions}>
            <Button size='mini' type='text' className='!text-t-secondary'>
              <IconText icon={<SettingTwo theme='outline' fill='currentColor' size='13' />}>
                {label('sendOptions')}
              </IconText>
            </Button>
          </Popover>
        )}
      </div>
    </div>
  );
}
