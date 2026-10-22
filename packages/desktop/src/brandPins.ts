/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MUST remain the FIRST import of the main entry (src/index.ts).
 *
 * The product is branded "Woody", and every stored byte (Chromium profile,
 * config, logs, backend DBs) lives under the WoodyUi app-data directory on
 * every packaged platform. Data under the historical AionUi directory is not
 * migrated. Module-scope code in modules imported after this one (config load,
 * electron-log setup) resolves paths exactly once, so the pin has to run
 * before any of them.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// False only when startup must stop; otherwise index.ts takes the single-instance lock itself.
export let packagedInstanceLock: boolean | undefined;

if (app.isPackaged) {
  if (process.env.AIONUI_E2E_TEST === '1') {
    const testProfile = process.env.AIONUI_E2E_USER_DATA_DIR?.trim();
    if (testProfile) {
      fs.mkdirSync(testProfile, { recursive: true });
      app.setPath('userData', testProfile);
      app.setPath('sessionData', testProfile);
    } else {
      // app.exit before ready does not stop the remaining module evaluation. A
      // missing lock makes index.ts quit before E2E work touches the real profile.
      packagedInstanceLock = false;
      console.error('[Woody] E2E mode requires an explicit user data path.');
      app.exit(1);
    }
  } else {
    const userData = path.join(app.getPath('appData'), 'WoodyUi');
    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
  }
}
