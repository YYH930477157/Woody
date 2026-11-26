/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const locales = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US');
const namespaces: Record<string, unknown> = {
  common: JSON.parse(readFileSync(path.join(locales, 'common.json'), 'utf8')),
  conversation: JSON.parse(readFileSync(path.join(locales, 'conversation.json'), 'utf8')),
};

/**
 * A `t` that reads the shipped en-US `common` and `conversation` strings and
 * fills `{{name}}` placeholders, so tests assert what an English reader sees.
 * Other keys fall back to `defaultValue`, then to the key itself.
 */
export function enT(key: string, options?: Record<string, unknown> & { defaultValue?: string }): string {
  const [namespace, ...parts] = key.split('.');
  let value: unknown = namespaces[namespace];
  for (const part of parts) {
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  }
  const text = typeof value === 'string' ? value : (options?.defaultValue ?? key);
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
}
