import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Copy, Down, Redo, Robot } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { formatHexdump } from '@/common/terminal/stream';
import type { TerminalEvent } from '@/common/types/terminal';
import {
  buildTextLines,
  formatClock,
  groupTerminalFrames,
  toHex,
  type TerminalFrame,
  type TerminalTextLine,
} from '../terminalView';
import type { TerminalViewPreferences } from '../useTerminalPreferences';
import IconText from './IconText';

const FOLLOW_THRESHOLD_PX = 48;

function Badge({ frame }: { frame: TerminalFrame }) {
  const { t } = useTranslation();
  const outgoing = frame.direction === 'outgoing';
  return (
    <span
      className={classNames(
        'shrink-0 select-none inline-flex items-center gap-3px h-18px mt-1px px-6px rd-4px text-11px font-600 leading-none',
        outgoing ? 'bg-primary-light-1 text-primary' : 'bg-success-light-1 text-success'
      )}
    >
      {outgoing && frame.source === 'ai' && <Robot theme='outline' fill='currentColor' size='11' />}
      {t(outgoing ? 'tools.terminal.txBadge' : 'tools.terminal.rxBadge')}
    </span>
  );
}

function Divider({ timestamp, error, showTime }: { timestamp: number; error?: string; showTime: boolean }) {
  const { t } = useTranslation();
  return (
    <div className='flex items-center gap-10px my-8px text-12px text-t-tertiary select-none'>
      <span className='h-1px flex-1 bg-3' />
      <span>
        {showTime && `${formatClock(timestamp)} · `}
        {t('tools.terminal.disconnectedLine')}
        {error ? ` · ${error}` : ''}
      </span>
      <span className='h-1px flex-1 bg-3' />
    </div>
  );
}

function TextLine({ line, showTime }: { line: TerminalTextLine; showTime: boolean }) {
  return (
    <div className='flex gap-12px min-h-20px font-mono'>
      {showTime && <span className='shrink-0 select-none text-t-tertiary'>{formatClock(line.timestamp)}</span>}
      <div className='min-w-0 flex-1 whitespace-pre-wrap break-all'>
        {line.segments.map((segment, index) => (
          <span key={index} className={segment.direction === 'outgoing' ? 'text-primary' : undefined}>
            {segment.text}
          </span>
        ))}
        {line.error && <span className='text-danger'> {line.error}</span>}
      </div>
    </div>
  );
}

function FrameRow({
  frame,
  hexdump,
  showTime,
  onResend,
}: {
  frame: TerminalFrame;
  hexdump: boolean;
  showTime: boolean;
  onResend?: (frame: TerminalFrame) => void;
}) {
  const { t } = useTranslation();
  const hex = toHex(frame.bytes);
  const copy = () => {
    void navigator.clipboard.writeText(hex).then(
      () => Message.success(t('common.copySuccess')),
      (): void => undefined
    );
  };
  return (
    <div className='group flex items-start gap-10px -mx-8px px-8px py-3px rd-6px hover:bg-fill-1'>
      {showTime && (
        <span className='shrink-0 select-none font-mono text-t-tertiary'>{formatClock(frame.timestamp)}</span>
      )}
      <Badge frame={frame} />
      <div className='min-w-0 flex-1'>
        {hexdump ? (
          <div className='font-mono whitespace-pre overflow-x-auto'>{formatHexdump(frame.bytes)}</div>
        ) : (
          <div className='font-mono break-all'>{hex}</div>
        )}
        {frame.status === 'failed' && frame.error && <div className='text-12px text-danger'>{frame.error}</div>}
      </div>
      <span className='shrink-0 select-none text-12px leading-20px text-t-tertiary tabular-nums'>
        {t('tools.terminal.byteCount', { count: frame.bytes.length })}
      </span>
      <div className='shrink-0 flex items-center gap-2px opacity-0 group-hover:opacity-100 transition-opacity'>
        <Tooltip content={t('common.copy')} mini>
          <Button
            size='mini'
            type='text'
            aria-label={t('common.copy')}
            icon={<Copy theme='outline' fill='currentColor' size='13' />}
            onClick={copy}
          />
        </Tooltip>
        {onResend && frame.direction === 'outgoing' && frame.bytes.length > 0 && (
          <Tooltip content={t('tools.terminal.resend')} mini>
            <Button
              size='mini'
              type='text'
              aria-label={t('tools.terminal.resend')}
              icon={<Redo theme='outline' fill='currentColor' size='13' />}
              onClick={() => onResend(frame)}
            />
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export default function TerminalOutput({
  events,
  view,
  emptyText,
  onResend,
}: {
  events: TerminalEvent[];
  view: TerminalViewPreferences;
  emptyText: string;
  onResend?: (frame: TerminalFrame) => void;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  const lines = useMemo(
    () => (view.display === 'text' ? buildTextLines(events, view.receiveNewlines) : []),
    [events, view.display, view.receiveNewlines]
  );
  const frames = useMemo(
    () => (view.display === 'text' ? [] : groupTerminalFrames(events, view.frameGapMs)),
    [events, view.display, view.frameGapMs]
  );
  const empty = view.display === 'text' ? lines.length === 0 : frames.length === 0;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else setBehind(true);
  }, [lines, frames]);

  useEffect(() => {
    // Switching the presentation re-lays out everything; keep the newest data in view.
    following.current = true;
    setBehind(false);
  }, [view.display]);

  const jumpToLatest = () => {
    const element = scroller.current;
    if (!element) return;
    following.current = true;
    setBehind(false);
    element.scrollTop = element.scrollHeight;
  };

  if (empty) {
    return (
      <div
        role='log'
        aria-label={t('tools.terminal.output')}
        className='flex-1 min-h-160px flex-center px-20px text-13px text-t-tertiary select-none'
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div className='relative flex-1 min-h-0'>
      <div
        ref={scroller}
        role='log'
        aria-label={t('tools.terminal.output')}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD_PX;
          if (following.current) setBehind(false);
        }}
        className='h-full overflow-auto px-20px py-12px text-13px leading-20px text-t-primary'
      >
        {view.display === 'text'
          ? lines.map((line) =>
              line.system ? (
                <Divider key={line.key} timestamp={line.timestamp} error={line.error} showTime={view.timestamps} />
              ) : (
                <TextLine key={line.key} line={line} showTime={view.timestamps} />
              )
            )
          : frames.map((frame) =>
              frame.direction === 'system' ? (
                <Divider key={frame.key} timestamp={frame.timestamp} error={frame.error} showTime={view.timestamps} />
              ) : (
                <FrameRow
                  key={frame.key}
                  frame={frame}
                  hexdump={view.display === 'hexdump'}
                  showTime={view.timestamps}
                  onResend={onResend}
                />
              )
            )}
      </div>
      {behind && (
        <Button
          className='!absolute right-20px bottom-12px shadow-md'
          size='small'
          shape='round'
          onClick={jumpToLatest}
        >
          <IconText icon={<Down theme='outline' fill='currentColor' size='14' />}>
            {t('tools.terminal.jumpLatest')}
          </IconText>
        </Button>
      )}
    </div>
  );
}
