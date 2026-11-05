import { app, BrowserWindow, dialog, safeStorage, session, webContents } from 'electron';
import type { BrowserWindow as NativeWindow } from 'electron';
import path from 'node:path';
import { getNativeBridgeSender } from '@/common/adapter/main';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { onConfirmedQuit } from '@process/startup/quitCleanup';
import { BrowserPasswordController } from './controller';
import { WebsitePasswordStore } from './store';
import { BrowserPasswordUpdates, type ConfirmPasswordUpdate } from './updates';

let applicationWindow: NativeWindow | undefined;
let runtime: { store: WebsitePasswordStore; controller: BrowserPasswordController } | undefined;

const configureBrowserPreload = (
  _event: Electron.Event,
  preferences: Electron.WebPreferences,
  params: Record<string, string>
): void => {
  if (params.partition !== BROWSER_SESSION_PARTITION) return;
  preferences.preload = path.join(__dirname, '../preload/websitePasswordPreload.js');
  preferences.contextIsolation = true;
  preferences.nodeIntegration = false;
  preferences.sandbox = true;
};

export function setWebsitePasswordWindow(window: NativeWindow): void {
  applicationWindow?.webContents.removeListener('will-attach-webview', configureBrowserPreload);
  applicationWindow = window;
  window.webContents.on('will-attach-webview', configureBrowserPreload);
}

const confirmUpdate: ConfirmPasswordUpdate = async (account, signal) => {
  const window = applicationWindow;
  if (!window || window.isDestroyed() || signal.aborted) return false;
  const { default: i18n, i18nReady } = await import('@process/services/i18n');
  await i18nReady;
  if (window !== applicationWindow || window.isDestroyed() || signal.aborted) return false;
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: i18n.t('settings.websitePasswords.updatePromptTitle'),
    message: i18n.t('settings.websitePasswords.updatePrompt'),
    detail: i18n.t('settings.websitePasswords.updatePromptDetails', {
      site: account.origin,
      username: account.username,
    }),
    buttons: [i18n.t('common.cancel'), i18n.t('settings.websitePasswords.updateSavedPassword')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  });
  return !signal.aborted && result.response === 1;
};

const updateFailed = (): void => {
  void (async () => {
    const window = applicationWindow;
    if (!window || window.isDestroyed()) return;
    const { default: i18n, i18nReady } = await import('@process/services/i18n');
    await i18nReady;
    if (window !== applicationWindow || window.isDestroyed()) return;
    await dialog.showMessageBox(window, {
      type: 'error',
      title: i18n.t('settings.websitePasswords.title'),
      message: i18n.t('settings.websitePasswords.errors.IO'),
    });
  })().catch(() => {});
};
/** Derive authorization from Electron IPC ownership, never renderer-supplied IDs. */
export function requireWebsitePasswordWindow(): NativeWindow {
  const sender = getNativeBridgeSender();
  if (
    !applicationWindow ||
    applicationWindow.isDestroyed() ||
    !sender ||
    sender.isDestroyed() ||
    sender !== applicationWindow.webContents ||
    sender.getType() !== 'window' ||
    BrowserWindow.fromWebContents(sender) !== applicationWindow
  ) {
    throw new Error('WEBSITE_PASSWORDS_FORBIDDEN');
  }
  return applicationWindow;
}

export function getWebsitePasswordRuntime() {
  if (!runtime) {
    const store = new WebsitePasswordStore(path.join(app.getPath('userData'), 'passwords', 'vault.bin'), {
      isAvailable: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    });
    const updates = new BrowserPasswordUpdates(store, confirmUpdate, updateFailed);
    runtime = { store, controller: new BrowserPasswordController(store, updates) };
  }
  return runtime;
}

/** Attach only the reported active webview owned by the trusted application window. */
export function attachWebsitePasswordTarget(id: number, active = true): void {
  const window = requireWebsitePasswordWindow();
  const target = Number.isSafeInteger(id) ? webContents.fromId(id) : undefined;
  if (
    !target ||
    target.isDestroyed() ||
    target.getType() !== 'webview' ||
    target.session !== session.fromPartition(BROWSER_SESSION_PARTITION) ||
    target.hostWebContents !== window.webContents
  ) {
    throw new Error('WEBSITE_PASSWORDS_FORBIDDEN');
  }
  if (active) getWebsitePasswordRuntime().controller.attach(target);
  else runtime?.controller.detach(id);
}

export function disposeWebsitePasswords(): void {
  runtime?.controller.dispose();
  runtime = undefined;
  applicationWindow?.webContents.removeListener('will-attach-webview', configureBrowserPreload);
  applicationWindow = undefined;
}

onConfirmedQuit(async () => {
  disposeWebsitePasswords();
});
