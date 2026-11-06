/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { shell } from 'electron';
import { sessionFiles } from '@/common/adapter/ipcBridge';
import { createSessionFilesService } from './sessionFiles';

/** Serve the per-chat folder channels. Every handler resolves; none throws to the caller. */
export function initSessionFilesBridge(): void {
  const service = createSessionFilesService({ now: () => new Date(), trash: (dir) => shell.trashItem(dir) });
  sessionFiles.prepare.provider((request) => service.prepare(request));
  sessionFiles.inspect.provider(({ dirs }) => service.inspect(dirs));
  sessionFiles.trash.provider(({ dirs }) => service.trash(dirs));
}
