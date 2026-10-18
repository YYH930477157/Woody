/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TodoScanSession } from '@/common/types/todo/todoTypes';

export type CronConversationApi = {
  id?: unknown;
  name?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  status?: unknown;
};

export const mapTodoScanSession = (
  conversation: CronConversationApi,
  fallbackName: string,
  now = Date.now()
): TodoScanSession | null => {
  if (typeof conversation.id !== 'string' || !conversation.id) return null;
  return {
    id: conversation.id,
    name: typeof conversation.name === 'string' && conversation.name ? conversation.name : fallbackName,
    created_at: typeof conversation.created_at === 'number' ? conversation.created_at : now,
    updated_at: typeof conversation.updated_at === 'number' ? conversation.updated_at : now,
    status: typeof conversation.status === 'string' ? conversation.status : undefined,
  };
};
