import React from 'react';
import {
  Button,
  Dropdown,
  InputNumber,
  Menu,
  Popover,
  Radio,
  Select,
  Switch,
  Tag,
  Tooltip,
} from '@arco-design/web-react';
import { Clear, Download, Plug, Power, Robot, SettingTwo, Terminal, Usb } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { TERMINAL_BAUD_RATES, TERMINAL_NEWLINE_MODES, type TerminalNewlineMode } from '@/common/terminal/stream';
import type { TerminalConnection } from '@/common/types/terminal';
import { describeProfile } from '../terminalView';
import IconText from './IconText';
import type { TerminalViewPreferences } from '../useTerminalPreferences';

export default function SessionHeader({
  connection,
  baudRate,
  view,
  working,
  canGrant,
  onBaudChange,
  onViewChange,
  onClear,
  onExport,
  onDisconnect,
  onReconnect,
  onGrant,
  onResumeAi,
}: {
  connection: TerminalConnection;
  baudRate?: number;
  view: TerminalViewPreferences;
  working: boolean;
  canGrant: boolean;
  onBaudChange: (baudRate: number) => void;
  onViewChange: (patch: Partial<TerminalViewPreferences>) => void;
  onClear: () => void;
  onExport: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onGrant: (scope: 'connection' | 'profile') => void;
  onResumeAi: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`tools.terminal.${key}`);
  const open = connection.status === 'open';
  const serial = connection.profile.kind === 'serial';
  const baudOptions = (
    !baudRate || TERMINAL_BAUD_RATES.includes(baudRate) ? TERMINAL_BAUD_RATES : [baudRate, ...TERMINAL_BAUD_RATES]
  ).map((value) => ({ value, label: String(value) }));
  const profile =
    connection.profile.kind === 'serial' && baudRate ? { ...connection.profile, baudRate } : connection.profile;

  const settings = (
    <div className='w-264px flex flex-col gap-14px py-2px text-13px'>
      <div className='flex items-center justify-between gap-12px'>
        <span>{label('showTimestamps')}</span>
        <Switch size='small' checked={view.timestamps} onChange={(timestamps) => onViewChange({ timestamps })} />
      </div>
      {view.display === 'text' ? (
        <div className='flex items-center justify-between gap-12px'>
          <span>{label('newlineOut')}</span>
          <Select
            size='small'
            className='!w-150px'
            value={view.receiveNewlines}
            onChange={(receiveNewlines: TerminalNewlineMode) => onViewChange({ receiveNewlines })}
            options={TERMINAL_NEWLINE_MODES.map((value) => ({ value, label: label(`newline_${value}`) }))}
          />
        </div>
      ) : (
        <div className='flex flex-col gap-4px'>
          <div className='flex items-center justify-between gap-12px'>
            <span>{label('frameGap')}</span>
            <InputNumber
              size='small'
              className='!w-110px'
              min={0}
              max={5000}
              step={10}
              suffix='ms'
              value={view.frameGapMs}
              onChange={(value) => onViewChange({ frameGapMs: Math.max(0, Math.round(Number(value) || 0)) })}
            />
          </div>
          <span className='text-12px leading-18px text-t-tertiary'>{label('frameGapHint')}</span>
        </div>
      )}
    </div>
  );

  return (
    <header className='shrink-0 flex items-center gap-12px px-16px h-56px border-b border-[var(--border-base)]'>
      <span className='size-32px shrink-0 rd-8px bg-fill-2 flex-center text-t-secondary'>
        {serial ? (
          <Usb theme='outline' fill='currentColor' size='16' />
        ) : (
          <Terminal theme='outline' fill='currentColor' size='16' />
        )}
      </span>
      <div className='min-w-0'>
        <div className='flex items-center gap-8px'>
          <span className='truncate text-14px font-600 text-t-primary'>{connection.profile.name}</span>
          <Tag size='small' color={open ? 'green' : 'gray'} className='shrink-0'>
            {label(open ? 'open' : 'closed')}
          </Tag>
        </div>
        <div className='truncate text-12px text-t-tertiary'>
          {describeProfile(profile, label('shellDefault'))}
          {connection.error && <span className='text-danger'> · {connection.error}</span>}
        </div>
      </div>
      <div className='flex-1' />
      <div className='flex items-center gap-6px shrink-0'>
        {serial && open && (
          <Tooltip content={label('baudLive')} mini>
            <Select
              size='small'
              className='!w-104px'
              aria-label={label('baudLive')}
              value={baudRate}
              showSearch
              disabled={connection.owner !== 'manual' || working}
              onChange={(value) => onBaudChange(Number(value))}
              options={baudOptions}
            />
          </Tooltip>
        )}
        <Radio.Group
          type='button'
          size='small'
          value={view.display}
          onChange={(display) => onViewChange({ display })}
          options={[
            { value: 'text', label: label('encodingText') },
            { value: 'hex', label: label('hex') },
            { value: 'hexdump', label: label('hexdump') },
          ]}
        />
        <Popover trigger='click' position='br' title={label('displaySettings')} content={settings}>
          <Tooltip content={label('displaySettings')} mini>
            <Button
              size='small'
              type='text'
              aria-label={label('displaySettings')}
              icon={<SettingTwo theme='outline' fill='currentColor' size='15' />}
            />
          </Tooltip>
        </Popover>
        <Tooltip content={label('clear')} mini>
          <Button
            size='small'
            type='text'
            aria-label={label('clear')}
            icon={<Clear theme='outline' fill='currentColor' size='15' />}
            onClick={onClear}
          />
        </Tooltip>
        <Tooltip content={label('export')} mini>
          <Button
            size='small'
            type='text'
            aria-label={label('export')}
            icon={<Download theme='outline' fill='currentColor' size='15' />}
            onClick={onExport}
          />
        </Tooltip>
        {serial && open && connection.aiAccessBlocked && (
          <Button size='small' disabled={working} onClick={onResumeAi}>
            <IconText icon={<Robot theme='outline' fill='currentColor' size='14' />}>{label('resumeAi')}</IconText>
          </Button>
        )}
        {canGrant && (
          <Dropdown
            trigger='click'
            position='br'
            droplist={
              <Menu onClickMenuItem={(key) => onGrant(key as 'connection' | 'profile')}>
                <Menu.Item key='connection' disabled={!open}>
                  {label('grantConnection')}
                </Menu.Item>
                <Menu.Item key='profile'>{label('grantProfile')}</Menu.Item>
              </Menu>
            }
          >
            <Button size='small' loading={working}>
              <IconText icon={<Robot theme='outline' fill='currentColor' size='14' />}>{label('grantToAi')}</IconText>
            </Button>
          </Dropdown>
        )}
        {open ? (
          <Button size='small' onClick={onDisconnect}>
            <IconText icon={<Power theme='outline' fill='currentColor' size='14' />}>{label('disconnect')}</IconText>
          </Button>
        ) : (
          <Button size='small' type='primary' loading={working} onClick={onReconnect}>
            <IconText icon={<Plug theme='outline' fill='currentColor' size='14' />}>{label('reconnect')}</IconText>
          </Button>
        )}
      </div>
    </header>
  );
}
