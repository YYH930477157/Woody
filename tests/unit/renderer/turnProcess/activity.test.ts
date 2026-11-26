/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, IMessageToolGroup } from '@/common/chat/chatLib';
import {
  categorizeToolName,
  formatDuration,
  summarizeActivities,
} from '@/renderer/pages/conversation/Messages/components/TurnProcess/activity';

const group = (calls: Array<{ id: string; name: string; status?: string; description?: string }>): IMessageToolGroup =>
  ({
    id: 'group-' + calls.map((call) => call.id).join('-'),
    conversation_id: 'c1',
    type: 'tool_group',
    content: calls.map((call) => ({
      call_id: call.id,
      name: call.name,
      description: call.description ?? '',
      status: call.status ?? 'Success',
      renderOutputAsMarkdown: false,
    })),
  }) as unknown as IMessageToolGroup;

const acp = (id: string, kind: string, status = 'completed'): IMessageAcpToolCall =>
  ({
    id,
    conversation_id: 'c1',
    type: 'acp_tool_call',
    content: { update: { sessionUpdate: 'tool_call', tool_call_id: id, title: 'Run something', kind, status } },
  }) as unknown as IMessageAcpToolCall;

describe('categorizeToolName', () => {
  it.each([
    ['Read', 'read'],
    ['ViewImage', 'readImage'],
    ['Grep', 'search'],
    ['mcp__codebase-memory__search_graph', 'search'],
    ['Edit', 'edit'],
    ['ExecCommand', 'commands'],
    ['run_shell_command', 'commands'],
    ['terminal_open', 'commands'],
    ['Spawn', 'subagents'],
    ['subagent_codex', 'subagents'],
    ['TodoWrite', 'plan'],
    ['AskUserQuestion', 'questions'],
    ['mcp__woody-cmake__cmake_start', 'tools'],
  ])('%s is %s', (name, category) => {
    expect(categorizeToolName(name)).toBe(category);
  });
});

describe('summarizeActivities', () => {
  it('ranks categories by count, keeps first-seen order on ties, and counts a call id once', () => {
    const summary = summarizeActivities([
      {
        type: 'tools',
        messages: [
          group([
            { id: 'a', name: 'ExecCommand' },
            { id: 'b', name: 'Read' },
          ]),
        ],
      },
      {
        type: 'tools',
        messages: [
          group([
            { id: 'c', name: 'Read' },
            { id: 'b', name: 'Read' },
          ]),
        ],
      },
      { type: 'tools', messages: [acp('d', 'execute'), acp('e', 'search')] },
    ]);
    expect(summary.categories).toEqual(['commands', 'read', 'search']);
    expect(summary.toolCount).toBe(5);
  });

  it('names the latest unfinished tool with its detail', () => {
    const summary = summarizeActivities([
      {
        type: 'tools',
        messages: [
          group([
            { id: 'a', name: 'Read', status: 'Executing', description: 'src/a.c' },
            { id: 'b', name: 'ExecCommand', status: 'Executing', description: 'cmake  --build\nbuild' },
          ]),
        ],
      },
    ]);
    expect(summary.liveTool).toEqual({ category: 'commands', detail: 'cmake --build build' });
  });

  it('has no live tool once every call has settled', () => {
    const summary = summarizeActivities([{ type: 'tools', messages: [group([{ id: 'a', name: 'Read' }])] }]);
    expect(summary.liveTool).toBeUndefined();
  });
});

describe('formatDuration', () => {
  const units = { hour: 'h', minute: 'm', second: 's' };
  it.each([
    [999, '0s'],
    [12_000, '12s'],
    [72_000, '1m 12s'],
    [3_780_000, '1h 3m'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatDuration(ms, units)).toBe(text);
  });
});
