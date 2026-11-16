import React, { useEffect, useState } from 'react';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Key } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { websitePasswords } from '@/common/adapter/ipcBridge';
import type { SavedLoginPageStatus } from '@/common/types/websitePasswords';

/** Outcomes that are not a failure worth pointing at. */
const QUIET_REASONS = new Set(['noLoginForm', 'alreadyTried']);
const REASON_KEYS: Record<string, string> = {
  noLoginForm: 'settings.websitePasswords.page.reasons.noLoginForm',
  otherOrigin: 'settings.websitePasswords.page.reasons.otherOrigin',
  filledByUser: 'settings.websitePasswords.page.reasons.filledByUser',
  multiplePasswords: 'settings.websitePasswords.page.reasons.multiplePasswords',
  registration: 'settings.websitePasswords.page.reasons.registration',
  verification: 'settings.websitePasswords.page.reasons.verification',
  noButton: 'settings.websitePasswords.page.reasons.noButton',
  ambiguousButton: 'settings.websitePasswords.page.reasons.ambiguousButton',
  unsafeDestination: 'settings.websitePasswords.page.reasons.unsafeDestination',
  alreadyTried: 'settings.websitePasswords.page.reasons.alreadyTried',
};

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
};

/**
 * Shown in the in-app browser's address bar when the open site has a saved account:
 * how the automatic login went, and a button that logs in now. It never shows the account.
 */
const SavedLoginButton: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SavedLoginPageStatus>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    websitePasswords.pageStatus
      .invoke()
      .then((next) => {
        if (alive) setStatus(next);
      })
      .catch((): void => {});
    const off = websitePasswords.pageStatusChanged.on((next) => setStatus(next));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const site = originOf(url);
  if (!status || status.account !== 'saved' || !site || status.site !== site) return null;
  const reasonText = (reason?: string): string => t(REASON_KEYS[reason ?? ''] ?? REASON_KEYS.noLoginForm);
  const failed = status.result === 'skipped' && !!status.reason && !QUIET_REASONS.has(status.reason);
  const tip =
    status.result === 'password-submitted'
      ? t('settings.websitePasswords.page.submitted')
      : status.result === 'username-submitted'
        ? t('settings.websitePasswords.page.usernameSubmitted')
        : failed
          ? t('settings.websitePasswords.page.failed', { reason: reasonText(status.reason) })
          : t('settings.websitePasswords.page.saved');

  const login = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await websitePasswords.loginNow.invoke();
      setStatus(next);
      if (next.result === 'password-submitted') Message.success(t('settings.websitePasswords.page.submitted'));
      else if (next.result === 'username-submitted')
        Message.success(t('settings.websitePasswords.page.usernameSubmitted'));
      else if (next.account === 'disabled') Message.warning(t('settings.websitePasswords.page.disabled'));
      else if (next.account === 'unavailable') Message.warning(t('settings.websitePasswords.errors.UNAVAILABLE'));
      else if (next.account !== 'saved') Message.warning(t('settings.websitePasswords.page.noAccount'));
      else Message.warning(t('settings.websitePasswords.page.failed', { reason: reasonText(next.reason) }));
    } catch {
      Message.error(t('settings.websitePasswords.errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip content={tip} position='br'>
      <Button
        size='small'
        data-testid='saved-login-button'
        aria-label={t('settings.websitePasswords.page.loginNow')}
        status={failed ? 'warning' : 'default'}
        loading={busy}
        icon={<Key theme='outline' size={14} />}
        onClick={() => void login()}
      />
    </Tooltip>
  );
};

export default SavedLoginButton;
