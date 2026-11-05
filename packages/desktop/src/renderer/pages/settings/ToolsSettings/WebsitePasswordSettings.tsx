import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Popconfirm, Spin, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { DeleteFour, Edit, Refresh, Search, Star, Upload } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { websitePasswords } from '@/common/adapter/ipcBridge';
import type { WebsiteAccount, WebsitePasswordStatus } from '@/common/types/websitePasswords';
import { isElectronDesktop } from '@/renderer/utils/platform';
import SettingsPageWrapper from '../components/SettingsPageWrapper';

const errorKeys = {
  UNAVAILABLE: 'settings.websitePasswords.errors.UNAVAILABLE',
  CORRUPT: 'settings.websitePasswords.errors.CORRUPT',
  INVALID_CSV: 'settings.websitePasswords.errors.INVALID_CSV',
  TOO_LARGE: 'settings.websitePasswords.errors.TOO_LARGE',
  LIMIT: 'settings.websitePasswords.errors.LIMIT',
  IO: 'settings.websitePasswords.errors.IO',
  FORBIDDEN: 'settings.websitePasswords.errors.FORBIDDEN',
  CONFLICT: 'settings.websitePasswords.errors.CONFLICT',
} as const;

type ActionResult = {
  status: WebsitePasswordStatus;
  summary?: { added: number; updated: number; skipped: number };
};
type AccountAction = () => Promise<ActionResult | undefined>;

function DesktopWebsitePasswordSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WebsitePasswordStatus>();
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string>();
  const [summary, setSummary] = useState<ActionResult['summary']>();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<WebsiteAccount>();
  const [newPassword, setNewPassword] = useState('');
  const active = useRef(false);
  const working = useRef(false);
  const retry = useRef<AccountAction | undefined>(undefined);

  const run = useCallback(async (action: AccountAction, remember = true) => {
    if (working.current) return false;
    working.current = true;
    retry.current = remember ? action : undefined;
    setBusy(true);
    setErrorKey(undefined);
    try {
      const result = await action();
      if (active.current && result) {
        setStatus(result.status);
        if (result.summary) setSummary(result.summary);
      }
      return true;
    } catch (error) {
      if (active.current) {
        const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
        const code = message.match(/\bWEBSITE_PASSWORDS_([A-Z_]+)\b/)?.[1];
        setErrorKey(
          code && Object.hasOwn(errorKeys, code)
            ? errorKeys[code as keyof typeof errorKeys]
            : 'settings.websitePasswords.errors.generic'
        );
      }
      return false;
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }, []);

  const load = useCallback(async () => ({ status: await websitePasswords.list.invoke() }), []);

  useEffect(() => {
    active.current = true;
    void run(load);
    return () => {
      active.current = false;
    };
  }, [load, run]);

  const accounts = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (status?.accounts ?? []).filter((account) =>
      [account.name, account.origin, account.username].some((value) => value.toLocaleLowerCase().includes(search))
    );
  }, [query, status]);
  const disabled = busy || !status?.available;
  const closeEditor = (): void => {
    if (working.current) return;
    setEditing(undefined);
    setNewPassword('');
    setErrorKey(undefined);
  };
  const savePassword = async (): Promise<void> => {
    if (!editing || !newPassword) return;
    const saved = await run(
      async () => ({ status: await websitePasswords.updatePassword.invoke({ id: editing.id, password: newPassword }) }),
      false
    );
    if (saved) closeEditor();
  };

  const importAccounts = async (): Promise<ActionResult | undefined> => {
    const result = await websitePasswords.importChrome.invoke();
    if (result.cancelled) return;
    return {
      status: result.status,
      summary: { added: result.added, updated: result.updated, skipped: result.skipped },
    };
  };

  const retryButton = (
    <Button type='text' size='small' icon={<Refresh />} disabled={busy} onClick={() => void run(retry.current ?? load)}>
      {t('common.retry')}
    </Button>
  );

  return (
    <section className='py-8px' aria-busy={busy}>
      <div className='flex items-center justify-between flex-wrap gap-12px'>
        <h1 className='m-0 text-24px font-semibold text-t-primary'>{t('settings.websitePasswords.title')}</h1>
        <Button
          icon={<Upload />}
          disabled={disabled}
          loading={busy && Boolean(status)}
          onClick={() => void run(importAccounts)}
        >
          {t('settings.websitePasswords.importChrome')}
        </Button>
      </div>
      <div className='flex items-center justify-between gap-16px py-16px'>
        <span className='text-14px text-t-primary'>{t('settings.websitePasswords.automaticLogin')}</span>
        <Switch
          aria-label={t('settings.websitePasswords.automaticLogin')}
          checked={status?.enabled ?? false}
          disabled={disabled}
          onChange={(enabled) =>
            void run(async () => ({ status: await websitePasswords.setEnabled.invoke({ enabled }) }))
          }
        />
      </div>
      {/* Accepted risk: filled passwords sit in the page, where browser-controlling AI can run scripts. */}
      <Alert type='warning' className='mb-12px' content={t('settings.websitePasswords.agentRisk')} />
      {errorKey && !editing && <Alert type='error' className='mb-12px' content={t(errorKey)} action={retryButton} />}
      {status && !status.available && !errorKey && (
        <Alert
          type='warning'
          className='mb-12px'
          content={t('settings.websitePasswords.errors.UNAVAILABLE')}
          action={
            <Button type='text' size='small' icon={<Refresh />} disabled={busy} onClick={() => void run(load)}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {summary && (
        <div role='status' className='text-13px text-t-secondary mb-12px'>
          {t('settings.websitePasswords.importSummary', summary)}
        </div>
      )}
      {/* The exported file keeps every password in plain text after the import. */}
      {summary && <Alert type='warning' className='mb-12px' content={t('settings.websitePasswords.csvReminder')} />}
      <div className='flex items-center flex-wrap gap-12px'>
        <Input
          className='flex-1 min-w-160px'
          aria-label={t('settings.websitePasswords.search')}
          placeholder={t('settings.websitePasswords.search')}
          prefix={<Search />}
          allowClear
          disabled={!status}
          value={query}
          onChange={setQuery}
        />
        <span className='text-12px text-t-secondary whitespace-nowrap'>
          {t('settings.websitePasswords.accountCount', { count: status?.accounts.length ?? 0 })}
        </span>
      </div>
      {!status && busy && (
        <div className='flex justify-center py-20px'>
          <Spin tip={t('settings.websitePasswords.loading')} />
        </div>
      )}
      {status && accounts.length === 0 && (
        <div className='text-13px text-t-secondary py-20px'>
          {t(status.accounts.length ? 'settings.websitePasswords.noMatches' : 'settings.websitePasswords.empty')}
        </div>
      )}
      <ul className='list-none p-0 m-0 divide-y divide-border-2'>
        {accounts.map((account) => (
          <li key={account.id} className='flex items-center justify-between flex-wrap gap-12px py-16px'>
            <div className='min-w-0 flex-1 break-all'>
              <div className='flex items-center flex-wrap gap-8px text-14px text-t-primary'>
                <span>{account.name || account.origin}</span>
                {account.isDefault && <Tag size='small'>{t('settings.websitePasswords.defaultAccount')}</Tag>}
              </div>
              <div className='text-12px text-t-secondary mt-4px'>{account.origin}</div>
              <div className='text-13px text-t-primary mt-4px'>
                {account.username || t('settings.websitePasswords.noUsername')}
              </div>
            </div>
            <div className='flex items-center gap-8px shrink-0'>
              <Tooltip content={t('settings.websitePasswords.editPassword')}>
                <Button
                  type='text'
                  icon={<Edit />}
                  aria-label={t('settings.websitePasswords.editPassword')}
                  disabled={disabled}
                  onClick={() => {
                    setNewPassword('');
                    setErrorKey(undefined);
                    setEditing(account);
                  }}
                />
              </Tooltip>
              {!account.isDefault && (
                <Tooltip content={t('settings.websitePasswords.setDefault')}>
                  <Button
                    type='text'
                    icon={<Star />}
                    aria-label={t('settings.websitePasswords.setDefault')}
                    disabled={disabled}
                    onClick={() =>
                      void run(async () => ({ status: await websitePasswords.setDefault.invoke({ id: account.id }) }))
                    }
                  />
                </Tooltip>
              )}
              <Popconfirm
                title={t('settings.websitePasswords.deleteConfirm')}
                content={t('settings.websitePasswords.deleteAccount', {
                  site: account.origin,
                  username: account.username || t('settings.websitePasswords.noUsername'),
                })}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                disabled={disabled}
                okButtonProps={{ status: 'danger' }}
                onOk={() => run(async () => ({ status: await websitePasswords.remove.invoke({ id: account.id }) }))}
              >
                <Tooltip content={t('common.delete')}>
                  <Button
                    type='text'
                    status='danger'
                    icon={<DeleteFour />}
                    aria-label={t('common.delete')}
                    disabled={disabled}
                  />
                </Tooltip>
              </Popconfirm>
            </div>
          </li>
        ))}
      </ul>
      <Modal
        visible={Boolean(editing)}
        title={t('settings.websitePasswords.editPassword')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: !newPassword || disabled, loading: busy }}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        maskClosable={false}
        escToExit={!busy}
        unmountOnExit
        style={{ width: 'min(480px, calc(100vw - 32px))' }}
        onCancel={closeEditor}
        onOk={savePassword}
      >
        <div className='text-13px text-t-secondary break-all mb-12px'>
          <div>{editing?.origin}</div>
          <div>{editing?.username}</div>
        </div>
        {errorKey && <Alert type='error' className='mb-12px' content={t(errorKey)} />}
        <Input.Password
          aria-label={t('settings.websitePasswords.newPassword')}
          placeholder={t('settings.websitePasswords.newPassword')}
          autoComplete='new-password'
          value={newPassword}
          maxLength={65536}
          disabled={busy}
          onChange={setNewPassword}
        />
      </Modal>
    </section>
  );
}

export default function WebsitePasswordSettings() {
  return isElectronDesktop() ? (
    <SettingsPageWrapper>
      <DesktopWebsitePasswordSettings />
    </SettingsPageWrapper>
  ) : null;
}
