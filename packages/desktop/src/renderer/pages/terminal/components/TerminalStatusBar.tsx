import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import { Download, Time, Upload } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { TerminalConnection } from '@/common/types/terminal';
import { formatByteRate, formatByteSize, formatDuration } from '../terminalView';
import type { TerminalCounters } from '../useTerminal';
import { useTerminalStats } from '../useTerminalStats';

/** Connection time and traffic for the selected session; frame counts and rates matter for serial links. */
export default function TerminalStatusBar({
  connection,
  counters,
}: {
  connection: TerminalConnection;
  counters: TerminalCounters;
}) {
  const { t } = useTranslation();
  const label = (key: string, options?: Record<string, unknown>) => t(`tools.terminal.${key}`, options);
  const { rates, now } = useTerminalStats(counters, connection.id);
  const open = connection.status === 'open';
  const serial = connection.profile.kind === 'serial';
  const traffic = (
    direction: 'rx' | 'tx',
    icon: React.ReactNode,
    bytes: number,
    rate: number,
    frames: number,
    tone: string
  ) => (
    <Tooltip content={label(direction === 'rx' ? 'statsReceived' : 'statsSent')} mini>
      <span className='inline-flex items-center gap-6px tabular-nums' aria-label={label(`${direction}Badge`)}>
        <span className={classNames('inline-flex items-center gap-3px font-600', tone)}>
          {icon}
          {label(`${direction}Badge`)}
        </span>
        <span className='text-t-primary'>{formatByteSize(bytes)}</span>
        {serial && (
          <>
            <span className='text-t-tertiary'>·</span>
            <span>{formatByteRate(open ? rate : 0)}</span>
            <span className='text-t-tertiary'>·</span>
            <span>{label('frameCount', { count: frames })}</span>
          </>
        )}
      </span>
    </Tooltip>
  );
  return (
    <div
      role='status'
      className='shrink-0 flex items-center gap-16px px-16px h-28px border-t border-[var(--border-base)] bg-1 text-12px text-t-secondary overflow-hidden whitespace-nowrap'
    >
      <span className='inline-flex items-center gap-6px'>
        <span className={classNames('size-7px rd-full', open ? 'bg-success' : 'bg-6')} />
        {open ? label('open') : label('closed')}
        {open && (
          <span className='inline-flex items-center gap-3px tabular-nums text-t-tertiary'>
            <Time theme='outline' fill='currentColor' size='12' />
            {formatDuration(now - connection.createdAt)}
          </span>
        )}
      </span>
      {traffic(
        'rx',
        <Download theme='outline' fill='currentColor' size='12' />,
        counters.rx,
        rates.rx,
        counters.rxFrames,
        'text-success'
      )}
      {traffic(
        'tx',
        <Upload theme='outline' fill='currentColor' size='12' />,
        counters.tx,
        rates.tx,
        counters.txFrames,
        'text-primary'
      )}
    </div>
  );
}
