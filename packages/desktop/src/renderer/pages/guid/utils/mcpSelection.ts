/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMcpServer } from '@/common/config/storage';

/**
 * Woody: a new conversation starts with every enabled MCP server ticked, so the
 * agent gets the whole offline toolset without hand-picking boxes each time.
 *
 * Disabled servers stay unticked (the npx-backed chrome-devtools row, or image
 * generation before a model is configured): selecting them would only add
 * spawns that cannot start on an offline machine.
 */
export const defaultSelectedMcpServerIds = (servers: IMcpServer[]): string[] =>
  servers.filter((server) => server.enabled !== false).map((server) => server.id);

/** Toggle one server id in a selection list, preserving the existing order. */
export const toggleMcpServerId = (selectedIds: string[], serverId: string): string[] =>
  selectedIds.includes(serverId) ? selectedIds.filter((id) => id !== serverId) : [...selectedIds, serverId];
