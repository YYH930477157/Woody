/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MUST remain the FIRST import of the main entry (src/index.ts).
 *
 * Migrate before any module can cache paths or open a database. Do not import
 * storage, logging, or the main-process i18n service here.
 */
import { app, dialog } from 'electron';
import fs from 'node:fs';
import { migrateUserData, prepareLegacyUserDataPath } from './process/startup/userDataMigration';
import { createMigrationProgressWindow } from './process/startup/userDataMigration/progressWindow';
import enUS from './renderer/services/i18n/locales/en-US/common.json';
import zhCN from './renderer/services/i18n/locales/zh-CN/common.json';
import zhTW from './renderer/services/i18n/locales/zh-TW/common.json';

type MigrationMessages = Pick<
  typeof enUS,
  'dataMigrationFailedTitle' | 'dataMigrationFailedBody' | 'dataMigrationProgressTitle' | 'dataMigrationProgressBody'
>;
const locales: Record<string, MigrationMessages> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

function systemMessages(): MigrationMessages {
  const language = app.getPreferredSystemLanguages()[0] || 'en-US';
  const locale = language.startsWith('zh') ? (/(TW|HK|Hant)/i.test(language) ? 'zh-TW' : 'zh-CN') : language;
  return locales[locale] || enUS;
}

// Reuse this result in index.ts; taking another lock after changing userData
// would change the identity used by older releases.
export let packagedInstanceLock: boolean | undefined;

if (app.isPackaged) {
  try {
    if (process.env.AIONUI_E2E_TEST === '1') {
      const testProfile = process.env.AIONUI_E2E_USER_DATA_DIR?.trim();
      if (!testProfile) throw new Error('E2E mode requires an explicit user data path.');
      fs.mkdirSync(testProfile, { recursive: true });
      app.setPath('userData', testProfile);
      app.setPath('sessionData', testProfile);
    } else {
      const appDataDir = app.getPath('appData');
      app.setPath('userData', prepareLegacyUserDataPath(appDataDir));
      packagedInstanceLock = app.requestSingleInstanceLock({
        deepLinkUrl: process.argv.find((arg) => arg.startsWith('aionui://')),
      });
      if (!packagedInstanceLock) {
        app.exit(0);
      } else {
        const messages = systemMessages();
        // The window appears only if the migration reports copy or hash work.
        const progress = createMigrationProgressWindow({
          title: messages.dataMigrationProgressTitle,
          body: messages.dataMigrationProgressBody,
        });
        try {
          const result = migrateUserData(appDataDir, { onProgress: progress.update });
          app.setPath('userData', result.userDataPath);
          app.setPath('sessionData', result.userDataPath);
        } finally {
          progress.close();
        }
      }
    }
  } catch (error) {
    // app.exit before ready does not stop the remaining module evaluation. A
    // missing lock makes index.ts quit without registering any startup work.
    packagedInstanceLock = false;
    const messages = systemMessages();
    console.error('[Woody] Data directory migration failed:', error);
    dialog.showErrorBox(messages.dataMigrationFailedTitle, `${messages.dataMigrationFailedBody}\n\n${String(error)}`);
    app.exit(1);
  }
}
