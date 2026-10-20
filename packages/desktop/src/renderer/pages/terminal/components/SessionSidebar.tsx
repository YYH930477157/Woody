import React from 'react';
import { Button, Dropdown, Menu, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Close, Delete, Edit, Plus, Power, Robot, Terminal, Usb } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import type { TerminalConnection, TerminalProfile } from '@/common/types/terminal';
import { describeProfile } from '../terminalView';
import IconText from './IconText';

type Kind = TerminalProfile['kind'];

function KindIcon({ kind, status }: { kind: Kind; status?: TerminalConnection['status'] }) {
  return (
    <span className='relative size-28px shrink-0 rd-8px bg-fill-2 flex-center text-t-secondary'>
      {kind === 'serial' ? (
        <Usb theme='outline' fill='currentColor' size='15' />
      ) : (
        <Terminal theme='outline' fill='currentColor' size='15' />
      )}
      {status && (
        <span
          aria-hidden
          className={classNames(
            'absolute -right-2px -bottom-2px size-10px rd-full border-[2px] border-[var(--bg-1)]',
            status === 'open' ? 'bg-success' : 'bg-6'
          )}
        />
      )}
    </span>
  );
}

function SectionTitle({ text, count }: { text: string; count?: number }) {
  return (
    <div className='flex items-center gap-6px px-8px pt-14px pb-6px text-12px font-500 text-t-tertiary'>
      {text}
      {count !== undefined && <span className='text-11px'>{count}</span>}
    </div>
  );
}

function Row({
  active,
  muted,
  onClick,
  children,
  actions,
  ariaLabel,
}: {
  active?: boolean;
  muted?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  actions: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <div
      role='button'
      tabIndex={0}
      aria-label={ariaLabel}
      aria-current={active ? 'true' : undefined}
      className={classNames(
        'group relative flex items-center gap-10px px-8px py-7px rd-8px cursor-pointer transition-colors outline-none',
        active ? 'bg-fill-3' : 'hover:bg-fill-2 focus-visible:bg-fill-2',
        muted && 'opacity-65'
      )}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {children}
      <div
        className='absolute right-6px top-1/2 -translate-y-1/2 hidden group-hover:flex group-focus-within:flex items-center gap-2px'
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
      </div>
    </div>
  );
}

export default function SessionSidebar({
  title,
  profiles,
  connections,
  selectedId,
  onSelect,
  onOpenProfile,
  onNewProfile,
  onEditProfile,
  onDeleteProfile,
  onDisconnect,
  onDismiss,
}: {
  title?: string;
  profiles: TerminalProfile[];
  connections: TerminalConnection[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onOpenProfile: (profile: TerminalProfile) => void;
  onNewProfile: (kind: Kind) => void;
  onEditProfile: (profile: TerminalProfile) => void;
  onDeleteProfile: (profile: TerminalProfile) => void;
  onDisconnect: (connection: TerminalConnection) => void;
  onDismiss: (connection: TerminalConnection) => void;
}) {
  const { t } = useTranslation();
  const label = (key: string, options?: Record<string, unknown>) => t(`tools.terminal.${key}`, options);
  const shellFallback = label('shellDefault');
  const openProfileIds = new Set(
    connections.filter((connection) => connection.status === 'open').map((connection) => connection.profile.id)
  );

  return (
    <aside className='w-252px shrink-0 min-h-0 flex flex-col border-r border-[var(--border-base)] bg-1'>
      <div className='shrink-0 flex items-center justify-between gap-8px px-16px h-56px'>
        <span className='text-15px font-600 text-t-primary truncate'>{title}</span>
        <Dropdown
          trigger='click'
          position='br'
          droplist={
            <Menu onClickMenuItem={(key) => onNewProfile(key as Kind)}>
              <Menu.Item key='serial'>
                <span className='inline-flex items-center gap-8px'>
                  <Usb theme='outline' fill='currentColor' size='14' />
                  {label('newSerial')}
                </span>
              </Menu.Item>
              <Menu.Item key='shell'>
                <span className='inline-flex items-center gap-8px'>
                  <Terminal theme='outline' fill='currentColor' size='14' />
                  {label('newShell')}
                </span>
              </Menu.Item>
            </Menu>
          }
        >
          <Button size='small' type='primary'>
            <IconText icon={<Plus theme='outline' fill='currentColor' size='14' />}>{label('newConnection')}</IconText>
          </Button>
        </Dropdown>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto px-8px pb-12px'>
        {connections.length > 0 && (
          <>
            <SectionTitle text={label('sessions')} count={connections.length} />
            <div className='flex flex-col gap-2px'>
              {connections.map((connection) => {
                const open = connection.status === 'open';
                return (
                  <Row
                    key={connection.id}
                    ariaLabel={connection.profile.name}
                    active={connection.id === selectedId}
                    muted={!open}
                    onClick={() => onSelect(connection.id)}
                    actions={
                      <Tooltip content={open ? label('disconnect') : label('dismiss')} mini>
                        <Button
                          size='mini'
                          type='text'
                          aria-label={open ? label('disconnect') : label('dismiss')}
                          icon={
                            open ? (
                              <Power theme='outline' fill='currentColor' size='13' />
                            ) : (
                              <Close theme='outline' fill='currentColor' size='13' />
                            )
                          }
                          onClick={() => (open ? onDisconnect(connection) : onDismiss(connection))}
                        />
                      </Tooltip>
                    }
                  >
                    <KindIcon kind={connection.profile.kind} status={connection.status} />
                    <div className='min-w-0 flex-1 pr-24px'>
                      <div className='flex items-center gap-6px'>
                        <span className='truncate text-13px font-500 text-t-primary'>{connection.profile.name}</span>
                        {connection.owner === 'ai' && (
                          <Tooltip content={label('ai')} mini>
                            <Robot theme='outline' fill='currentColor' size='13' className='shrink-0 text-primary' />
                          </Tooltip>
                        )}
                      </div>
                      <div className='truncate text-12px text-t-tertiary'>
                        {open ? describeProfile(connection.profile, shellFallback) : label('closed')}
                      </div>
                    </div>
                  </Row>
                );
              })}
            </div>
          </>
        )}
        <SectionTitle text={label('profiles')} count={profiles.length || undefined} />
        {profiles.length === 0 ? (
          <div className='px-8px py-6px text-12px leading-18px text-t-tertiary'>{label('noProfiles')}</div>
        ) : (
          <div className='flex flex-col gap-2px'>
            {profiles.map((profile) => (
              <Row
                key={profile.id}
                ariaLabel={profile.name}
                onClick={() => onOpenProfile(profile)}
                actions={
                  <>
                    <Tooltip content={t('common.edit')} mini>
                      <Button
                        size='mini'
                        type='text'
                        aria-label={t('common.edit')}
                        icon={<Edit theme='outline' fill='currentColor' size='13' />}
                        onClick={() => onEditProfile(profile)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={label('deleteConfirm', { name: profile.name })}
                      onOk={() => onDeleteProfile(profile)}
                      position='br'
                    >
                      <Button
                        size='mini'
                        type='text'
                        aria-label={t('common.delete')}
                        icon={<Delete theme='outline' fill='currentColor' size='13' />}
                      />
                    </Popconfirm>
                  </>
                }
              >
                <KindIcon kind={profile.kind} />
                <div className='min-w-0 flex-1 pr-52px'>
                  <div className='flex items-center gap-6px'>
                    <span className='truncate text-13px font-500 text-t-primary'>{profile.name}</span>
                    {openProfileIds.has(profile.id) && (
                      <span aria-hidden className='size-6px shrink-0 rd-full bg-success' />
                    )}
                  </div>
                  <div className='truncate text-12px text-t-tertiary'>{describeProfile(profile, shellFallback)}</div>
                </div>
              </Row>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
