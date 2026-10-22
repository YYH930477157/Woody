import { BrowserWindow, dialog } from 'electron';
import type { SerialAccessConfirmation } from './serialAccess';

/** Native confirmation stays available even when no conversation terminal panel is open. */
export const confirmSerialAccess: SerialAccessConfirmation = async (profile, signal) => {
  const { default: i18n, i18nReady } = await import('@process/services/i18n');
  await i18nReady;
  if (signal.aborted) return false;
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: i18n.t('tools.terminal.accessTitle'),
    message: i18n.t('tools.terminal.accessPrompt'),
    detail: i18n.t('tools.terminal.accessDetails', {
      name: profile.name,
      port: profile.path,
      baud: profile.baudRate,
      dataBits: profile.dataBits,
      parity: profile.parity,
      stopBits: profile.stopBits,
    }),
    buttons: [i18n.t('tools.terminal.accessDeny'), i18n.t('tools.terminal.accessAllow')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((item) => item.isVisible());
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return !signal.aborted && result.response === 1;
};
