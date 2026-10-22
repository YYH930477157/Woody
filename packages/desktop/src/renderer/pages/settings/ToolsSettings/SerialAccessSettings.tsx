import React, { useEffect, useState } from 'react';
import { Alert, Radio } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TerminalSerialAccessMode } from '@/common/types/terminal';

export default function SerialAccessSettings() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TerminalSerialAccessMode>('ask');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void ipcBridge.terminal.serialAccessMode
      .invoke()
      .then((value) => {
        if (active) {
          setMode(value);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const save = async (value: TerminalSerialAccessMode) => {
    setSaving(true);
    setError(false);
    try {
      await ipcBridge.terminal.setSerialAccessMode.invoke({ mode: value });
      setMode(value);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className='px-12px md:px-32px py-20px border-b border-border-2'>
      <div className='flex items-center justify-between flex-wrap gap-12px'>
        <span className='text-14px text-t-primary'>{t('tools.terminal.accessTitle')}</span>
        <Radio.Group
          type='button'
          aria-label={t('tools.terminal.accessTitle')}
          value={mode}
          disabled={!loaded || saving}
          onChange={(value: TerminalSerialAccessMode) => void save(value)}
          options={[
            { value: 'ask', label: t('tools.terminal.accessAsk') },
            { value: 'auto', label: t('tools.terminal.accessAuto') },
          ]}
        />
      </div>
      <p className='mt-8px mb-0 text-12px text-t-secondary'>{t('tools.terminal.accessScope')}</p>
      {error && <Alert className='mt-12px' type='error' content={t('tools.terminal.accessSettingsError')} />}
    </section>
  );
}
