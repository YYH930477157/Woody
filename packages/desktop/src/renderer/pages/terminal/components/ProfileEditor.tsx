import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Form, Input, Modal, Radio, Select, Tooltip } from '@arco-design/web-react';
import { Refresh, Terminal, Usb } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { TERMINAL_BAUD_RATES } from '@/common/terminal/stream';
import type { TerminalProfile } from '@/common/types/terminal';

type SerialPortInfo = { path: string; manufacturer?: string; friendlyName?: string };

export function newTerminalProfile(kind: 'shell' | 'serial', cwd?: string): TerminalProfile {
  const base = { id: crypto.randomUUID(), name: '', kind };
  return kind === 'shell'
    ? { ...base, kind, ...(cwd ? { cwd } : {}) }
    : {
        ...base,
        kind,
        path: '',
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        rtscts: false,
        xon: false,
        xoff: false,
      };
}

/** Name used when the user leaves the field empty, e.g. "COM3 · 115200". */
export function defaultProfileName(profile: TerminalProfile, shellFallback: string): string {
  if (profile.kind === 'serial') return profile.path ? `${profile.path} · ${profile.baudRate}` : '';
  return profile.executable?.split(/[\\/]/).pop() || shellFallback;
}

export default function ProfileEditor({
  profile,
  isNew,
  onCancel,
  onSave,
}: {
  profile?: TerminalProfile;
  isNew: boolean;
  onCancel: () => void;
  onSave: (profile: TerminalProfile, connect: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`tools.terminal.${key}`);
  const [draft, setDraft] = useState<TerminalProfile | undefined>(profile);
  const [argsText, setArgsText] = useState('');
  const [argsInvalid, setArgsInvalid] = useState(false);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [loadingPorts, setLoadingPorts] = useState(false);
  const [saving, setSaving] = useState<'save' | 'connect'>();

  const refreshPorts = useCallback(async () => {
    setLoadingPorts(true);
    try {
      const found: SerialPortInfo[] = await ipcBridge.terminal.ports.invoke();
      setPorts(found);
      // A new serial profile starts on the first detected port instead of an empty field.
      setDraft((current) =>
        current?.kind === 'serial' && !current.path && found[0] ? { ...current, path: found[0].path } : current
      );
    } catch {
      setPorts([]);
    } finally {
      setLoadingPorts(false);
    }
  }, []);

  useEffect(() => {
    setDraft(profile);
    setArgsText(profile?.kind === 'shell' && profile.args ? JSON.stringify(profile.args) : '');
    setArgsInvalid(false);
    if (profile?.kind === 'serial') void refreshPorts();
  }, [profile, refreshPorts]);

  if (!draft) return null;
  const serial = draft.kind === 'serial' ? draft : undefined;
  const shellFallback = label('shellDefault');
  const valid = !argsInvalid && (!serial || Boolean(serial.path.trim()));

  const switchKind = (kind: 'shell' | 'serial') => {
    if (kind === draft.kind) return;
    setDraft({ ...newTerminalProfile(kind, draft.kind === 'shell' ? draft.cwd : undefined), id: draft.id });
    setArgsText('');
    setArgsInvalid(false);
    if (kind === 'serial') void refreshPorts();
  };

  const save = async (connect: boolean) => {
    if (!valid) return;
    setSaving(connect ? 'connect' : 'save');
    try {
      await onSave({ ...draft, name: draft.name.trim() || defaultProfileName(draft, shellFallback) }, connect);
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <Modal
      title={isNew ? label('newProfile') : label('profileConfig')}
      visible={Boolean(profile)}
      onCancel={onCancel}
      style={{ width: 560 }}
      unmountOnExit
      footer={
        <div className='flex justify-end gap-8px'>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button disabled={!valid} loading={saving === 'save'} onClick={() => void save(false)}>
            {t('common.save')}
          </Button>
          <Button type='primary' disabled={!valid} loading={saving === 'connect'} onClick={() => void save(true)}>
            {label('saveAndConnect')}
          </Button>
        </div>
      }
    >
      <Form layout='vertical' className='grid grid-cols-6 gap-x-12px'>
        <Form.Item label={label('kind')} className='col-span-6'>
          <Radio.Group type='button' value={draft.kind} onChange={switchKind}>
            <Radio value='serial'>
              <span className='inline-flex items-center gap-6px'>
                <Usb theme='outline' fill='currentColor' size='14' />
                {label('serial')}
              </span>
            </Radio>
            <Radio value='shell'>
              <span className='inline-flex items-center gap-6px'>
                <Terminal theme='outline' fill='currentColor' size='14' />
                {label('shell')}
              </span>
            </Radio>
          </Radio.Group>
        </Form.Item>
        {serial ? (
          <>
            <Form.Item label={label('port')} className='col-span-4' required>
              <div className='flex gap-8px'>
                <Select
                  showSearch
                  allowCreate
                  value={serial.path || undefined}
                  placeholder={label('portPlaceholder')}
                  loading={loadingPorts}
                  notFoundContent={<span className='text-12px text-t-tertiary'>{label('noPorts')}</span>}
                  onChange={(path: string) => setDraft({ ...serial, path: path ?? '' })}
                  renderFormat={(_option, value) => String(value)}
                >
                  {ports.map((port) => (
                    <Select.Option key={port.path} value={port.path}>
                      <span className='font-mono'>{port.path}</span>
                      {(port.friendlyName || port.manufacturer) && (
                        <span className='ml-8px text-12px text-t-tertiary'>
                          {port.friendlyName || port.manufacturer}
                        </span>
                      )}
                    </Select.Option>
                  ))}
                </Select>
                <Tooltip content={label('refreshPorts')}>
                  <Button
                    icon={<Refresh theme='outline' fill='currentColor' size='14' />}
                    aria-label={label('refreshPorts')}
                    loading={loadingPorts}
                    onClick={() => void refreshPorts()}
                  />
                </Tooltip>
              </div>
            </Form.Item>
            <Form.Item label={label('baudRate')} className='col-span-2'>
              <Select
                showSearch
                allowCreate
                value={serial.baudRate}
                options={TERMINAL_BAUD_RATES.map((value) => ({ value, label: String(value) }))}
                onChange={(value: number | string) => {
                  const baudRate = Number(value);
                  if (Number.isInteger(baudRate) && baudRate > 0 && baudRate <= 12_000_000) {
                    setDraft({ ...serial, baudRate });
                  }
                }}
              />
            </Form.Item>
            <Form.Item label={label('dataBits')} className='col-span-2'>
              <Select
                value={serial.dataBits}
                options={[5, 6, 7, 8]}
                onChange={(dataBits) => setDraft({ ...serial, dataBits })}
              />
            </Form.Item>
            <Form.Item label={label('parity')} className='col-span-2'>
              <Select
                value={serial.parity}
                options={(['none', 'even', 'odd', 'mark', 'space'] as const).map((value) => ({
                  value,
                  label: label(value),
                }))}
                onChange={(parity) => setDraft({ ...serial, parity })}
              />
            </Form.Item>
            <Form.Item label={label('stopBits')} className='col-span-2'>
              <Select
                value={serial.stopBits}
                options={[1, 1.5, 2]}
                onChange={(stopBits) => setDraft({ ...serial, stopBits })}
              />
            </Form.Item>
            <Form.Item label={label('flowControl')} className='col-span-6'>
              <div className='flex items-center gap-16px'>
                <Checkbox checked={serial.rtscts} onChange={(rtscts) => setDraft({ ...serial, rtscts })}>
                  RTS/CTS
                </Checkbox>
                <Checkbox
                  checked={serial.xon && serial.xoff}
                  onChange={(enabled) => setDraft({ ...serial, xon: enabled, xoff: enabled })}
                >
                  XON/XOFF
                </Checkbox>
              </div>
            </Form.Item>
          </>
        ) : (
          draft.kind === 'shell' && (
            <>
              <Form.Item label={label('executable')} className='col-span-3'>
                <Input
                  value={draft.executable || ''}
                  placeholder={label('autoShell')}
                  onChange={(executable) => setDraft({ ...draft, executable: executable || undefined })}
                />
              </Form.Item>
              <Form.Item label={label('cwd')} className='col-span-3'>
                <Input value={draft.cwd || ''} onChange={(cwd) => setDraft({ ...draft, cwd: cwd || undefined })} />
              </Form.Item>
              <Form.Item
                label={label('args')}
                className='col-span-6'
                validateStatus={argsInvalid ? 'error' : undefined}
                help={argsInvalid ? label('invalidArgs') : undefined}
              >
                <Input
                  value={argsText}
                  placeholder={label('argsHint')}
                  onChange={(text) => {
                    setArgsText(text);
                    try {
                      const args: unknown = text ? JSON.parse(text) : undefined;
                      if (
                        args !== undefined &&
                        !(Array.isArray(args) && args.every((item) => typeof item === 'string'))
                      )
                        throw new Error('invalidArgs');
                      setDraft({ ...draft, args: args as string[] | undefined });
                      setArgsInvalid(false);
                    } catch {
                      setArgsInvalid(true);
                    }
                  }}
                />
              </Form.Item>
            </>
          )
        )}
        <Form.Item label={label('name')} className='col-span-6'>
          <Input
            value={draft.name}
            placeholder={defaultProfileName(draft, shellFallback) || label('namePlaceholder')}
            onChange={(name) => setDraft({ ...draft, name })}
          />
        </Form.Item>
      </Form>
      <div className='text-12px leading-18px text-t-tertiary'>{label('defaultsHint')}</div>
    </Modal>
  );
}
