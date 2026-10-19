/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';

type AssistantNameSource = Pick<Assistant, 'id' | 'name' | 'name_i18n'>;

/** Present the legacy builtin engine name using the application's brand. */
export function resolveAgentDisplayName(name: string): string {
  return name === 'Aion CLI' ? 'Woody' : name;
}

export function resolveAssistantName(
  assistant: AssistantNameSource | null | undefined,
  localeKey: string,
  fallback = 'Assistant'
): string {
  if (!assistant) {
    return fallback;
  }

  const localizedName = assistant.name_i18n?.[localeKey] || assistant.name_i18n?.['en-US'];
  const name = localizedName?.trim() || assistant.name?.trim() || assistant.id || fallback;
  return resolveAgentDisplayName(name);
}
