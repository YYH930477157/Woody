import React, { useEffect, useState } from 'react';
import { Form, Input, InputNumber, Select, Space, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { TerminalProfile } from '@/common/types/terminal';

export function newTerminalProfile(kind: 'shell' | 'serial', cwd?: string): TerminalProfile {
  const base = { id: crypto.randomUUID(), name: '', kind };
  return kind === 'shell'
    ? { ...base, kind, cwd }
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

export default function TerminalConfig({
  profile,
  ports,
  onChange,
  onValidityChange,
}: {
  profile: TerminalProfile;
  ports: Array<{ path: string; manufacturer?: string }>;
  onChange: (profile: TerminalProfile) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`tools.terminal.${key}`);
  const serial = profile.kind === 'serial' ? profile : undefined;
  const [argsText, setArgsText] = useState(
    profile.kind === 'shell' && profile.args ? JSON.stringify(profile.args) : ''
  );
  const [argsInvalid, setArgsInvalid] = useState(false);
  useEffect(() => {
    setArgsText(profile.kind === 'shell' && profile.args ? JSON.stringify(profile.args) : '');
    setArgsInvalid(false);
    onValidityChange(true);
  }, [profile.id]);
  return (
    <Form layout='vertical' className='grid grid-cols-2 gap-x-12px'>
      <Form.Item label={label('name')}>
        <Input value={profile.name} onChange={(name) => onChange({ ...profile, name })} />
      </Form.Item>
      <Form.Item label={label('kind')}>
        <Select
          value={profile.kind}
          onChange={(kind: 'shell' | 'serial') => onChange(newTerminalProfile(kind))}
          options={[
            { value: 'shell', label: label('shell') },
            { value: 'serial', label: label('serial') },
          ]}
        />
      </Form.Item>
      {profile.kind === 'shell' ? (
        <>
          <Form.Item label={label('executable')}>
            <Input
              value={profile.executable || ''}
              placeholder={label('autoShell')}
              onChange={(executable) => onChange({ ...profile, executable: executable || undefined })}
            />
          </Form.Item>
          <Form.Item label={label('cwd')}>
            <Input value={profile.cwd || ''} onChange={(cwd) => onChange({ ...profile, cwd: cwd || undefined })} />
          </Form.Item>
          <Form.Item
            label={label('args')}
            className='col-span-2'
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
                  if (args === undefined || (Array.isArray(args) && args.every((item) => typeof item === 'string'))) {
                    onChange({ ...profile, args: args as string[] | undefined });
                    setArgsInvalid(false);
                    onValidityChange(true);
                  } else throw new Error('invalidArgs');
                } catch {
                  setArgsInvalid(true);
                  onValidityChange(false);
                }
              }}
            />
          </Form.Item>
        </>
      ) : (
        serial && (
          <>
            <Form.Item label={label('port')}>
              <Select
                showSearch
                allowCreate
                value={serial.path}
                onChange={(path) => onChange({ ...serial, path })}
                options={ports.map((port) => ({
                  value: port.path,
                  label: `${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ''}`,
                }))}
              />
            </Form.Item>
            <Form.Item label={label('baudRate')}>
              <InputNumber
                value={serial.baudRate}
                min={1}
                max={4000000}
                step={1}
                onChange={(baudRate) => onChange({ ...serial, baudRate: baudRate || 9600 })}
              />
              <Select
                size='mini'
                value={serial.baudRate}
                options={[300, 4800, 9600, 19200, 38400, 115200]}
                onChange={(baudRate) => onChange({ ...serial, baudRate })}
              />
            </Form.Item>
            <Form.Item label={label('dataBits')}>
              <Select
                value={serial.dataBits}
                options={[5, 6, 7, 8]}
                onChange={(dataBits) => onChange({ ...serial, dataBits })}
              />
            </Form.Item>
            <Form.Item label={label('parity')}>
              <Select
                value={serial.parity}
                options={(['none', 'even', 'odd', 'mark', 'space'] as const).map((value) => ({
                  value,
                  label: label(value),
                }))}
                onChange={(parity) => onChange({ ...serial, parity })}
              />
            </Form.Item>
            <Form.Item label={label('stopBits')}>
              <Select
                value={serial.stopBits}
                options={[1, 1.5, 2]}
                onChange={(stopBits) => onChange({ ...serial, stopBits })}
              />
            </Form.Item>
            <Form.Item label={label('flowControl')}>
              <Space>
                <Switch
                  checked={serial.rtscts}
                  onChange={(rtscts) => onChange({ ...serial, rtscts })}
                  checkedText='RTS/CTS'
                  uncheckedText='RTS/CTS'
                />
                <Switch
                  checked={serial.xon && serial.xoff}
                  onChange={(enabled) => onChange({ ...serial, xon: enabled, xoff: enabled })}
                  checkedText='XON/XOFF'
                  uncheckedText='XON/XOFF'
                />
              </Space>
            </Form.Item>
          </>
        )
      )}
    </Form>
  );
}
