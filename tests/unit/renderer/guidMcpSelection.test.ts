/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';
import { defaultSelectedMcpServerIds, toggleMcpServerId } from '@/renderer/pages/guid/utils/mcpSelection';

const server = (id: string, enabled: boolean, builtin = true) =>
  ({ id, name: id, enabled, builtin }) as unknown as IMcpServer;

describe('Guid MCP defaults', () => {
  it('ticks every enabled server for a new conversation', () => {
    const servers = [
      server('aionui-browser', true),
      server('aionui-todo', true, false),
      server('woody-terminal', true),
      server('woody-codebase-memory', true),
      server('woody-cmake', true),
    ];

    expect(defaultSelectedMcpServerIds(servers)).toEqual([
      'aionui-browser',
      'aionui-todo',
      'woody-terminal',
      'woody-codebase-memory',
      'woody-cmake',
    ]);
  });

  it('leaves disabled servers unticked so their spawns are not attempted', () => {
    const servers = [
      server('aionui-browser', true),
      server('chrome-devtools', false),
      server('aionui-image-generation', false),
    ];

    expect(defaultSelectedMcpServerIds(servers)).toEqual(['aionui-browser']);
  });

  it('treats a missing enabled flag as enabled', () => {
    const servers = [{ id: 'legacy', name: 'legacy', builtin: true } as unknown as IMcpServer];

    expect(defaultSelectedMcpServerIds(servers)).toEqual(['legacy']);
  });

  it('returns nothing when no servers are registered', () => {
    expect(defaultSelectedMcpServerIds([])).toEqual([]);
  });

  it('toggles one server off and back on while preserving order', () => {
    const initial = ['a', 'b', 'c'];

    const withoutB = toggleMcpServerId(initial, 'b');
    expect(withoutB).toEqual(['a', 'c']);

    expect(toggleMcpServerId(withoutB, 'b')).toEqual(['a', 'c', 'b']);
  });

  it('toggles a server on when nothing is selected', () => {
    expect(toggleMcpServerId([], 'a')).toEqual(['a']);
  });
});
