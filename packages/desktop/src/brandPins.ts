/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MUST remain the FIRST import of the main entry (src/index.ts).
 *
 * The product is branded "Woody", but every stored byte (Chromium profile,
 * config, logs, backend DBs) lives under the historical %APPDATA%\AionUi
 * home. Module-scope code in modules imported after this one (config load,
 * electron-log setup) resolves paths exactly once, so the pin has to run
 * before any of them — import order within the bundled chunk guarantees
 * that when this file is imported first.
 */
import { app } from 'electron';
import path from 'node:path';

if (process.platform === 'win32') {
  app.setPath('userData', path.join(app.getPath('appData'), 'AionUi'));
}
