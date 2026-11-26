/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  groupTurnProcess,
  type ProcessGroupItem,
  type TurnProcessItem,
} from '@/renderer/pages/conversation/Messages/components/TurnProcess/grouping';

type Item = { type: string; id: string; created_at?: number; position?: string; content?: unknown };

const user = (id: string, created_at: number): Item => ({
  id,
  type: 'text',
  position: 'right',
  content: { content: id },
  created_at,
});
const teammate = (id: string, created_at: number): Item => ({
  id,
  type: 'text',
  position: 'left',
  content: { content: id, teammateMessage: true },
  created_at,
});
const reply = (id: string, created_at: number, text = id): Item => ({
  id,
  type: 'text',
  position: 'left',
  content: { content: text },
  created_at,
});
const thinking = (id: string, created_at: number, status: 'thinking' | 'done' = 'done'): Item => ({
  id,
  type: 'thinking',
  position: 'left',
  content: { content: id, status },
  created_at,
});
const tools = (id: string, created_at: number): Item & { messages: unknown[]; sourceMessageIds: string[] } => ({
  type: 'tool_summary',
  id: 'tool-summary-' + id,
  messages: [{ id, type: 'tool_call', content: { call_id: id, name: 'Read', status: 'completed' } }],
  sourceMessageIds: [id],
  created_at,
});
const other = (id: string, type: string, created_at: number): Item => ({ id, type, position: 'center', created_at });

const shape = (timeline: ReturnType<typeof groupTurnProcess<Item>>) =>
  timeline.map((item) =>
    item.type === 'turn_activity_summary'
      ? `G[${(item as ProcessGroupItem).sourceMessageIds.join(',')}]${(item as ProcessGroupItem).closed ? '' : '*'}`
      : item.type === 'turn_process'
        ? `T(${(item as TurnProcessItem).turnId})`
        : item.id
  );

describe('groupTurnProcess', () => {
  it('starts a new group after each reply so steps keep their place', () => {
    const timeline = groupTurnProcess(
      [user('u1', 1), thinking('th1', 2), tools('r1', 3), reply('progress', 4), tools('r2', 5), reply('answer', 6)],
      false
    );
    expect(shape(timeline)).toEqual(['u1', 'T(u1)', 'G[th1,r1]', 'progress', 'G[r2]', 'answer']);
  });

  it('keeps prompts, statuses and tips out of the group without splitting it', () => {
    const timeline = groupTurnProcess(
      [
        user('u1', 1),
        thinking('th1', 2),
        other('perm', 'permission', 3),
        tools('r1', 4),
        other('status', 'agent_status', 5),
        other('tip', 'tips', 6),
        thinking('th2', 7),
      ],
      false
    );
    expect(shape(timeline)).toEqual(['u1', 'T(u1)', 'G[th1,r1,th2]', 'perm', 'status', 'tip']);
  });

  it('treats a file change card and an empty streaming text as they read', () => {
    const timeline = groupTurnProcess(
      [
        user('u1', 1),
        tools('r1', 2),
        other('diff', 'file_summary', 3),
        tools('r2', 4),
        reply('empty', 5, '  '),
        tools('r3', 6),
      ],
      false
    );
    // A file change ends the group; an empty text does not.
    expect(shape(timeline)).toEqual(['u1', 'T(u1)', 'G[r1]', 'diff', 'G[r2,r3]', 'empty']);
  });

  it('opens a turn at each teammate message and runs the last one while processing', () => {
    const timeline = groupTurnProcess(
      [
        teammate('lead1', 1),
        thinking('th1', 2),
        reply('done', 3),
        teammate('lead2', 4),
        thinking('th2', 5, 'thinking'),
      ],
      true
    );
    expect(shape(timeline)).toEqual(['lead1', 'T(lead1)', 'G[th1]', 'done', 'lead2', 'T(lead2)', 'G[th2]*']);
    const rows = timeline.filter((item): item is TurnProcessItem => item.type === 'turn_process');
    expect(rows.map((row) => row.running)).toEqual([false, true]);
  });

  it('closes the trailing group of a running turn once a reply follows it', () => {
    const timeline = groupTurnProcess([user('u1', 1), thinking('th1', 2), reply('streaming', 3)], true);
    expect(shape(timeline)).toEqual(['u1', 'T(u1)', 'G[th1]', 'streaming']);
  });

  it('measures a finished turn from its opening message to its last item', () => {
    const timeline = groupTurnProcess([user('u1', 1000), thinking('th1', 2000), reply('answer', 74000)], false);
    const row = timeline.find((item): item is TurnProcessItem => item.type === 'turn_process');
    expect(row).toMatchObject({ startedAt: 1000, endedAt: 74000, running: false });
  });

  it('adds no turn row to a turn without steps, nor to steps before the first opening message', () => {
    const timeline = groupTurnProcess([thinking('th0', 1), reply('old', 2), user('u1', 3), reply('plain', 4)], false);
    expect(shape(timeline)).toEqual(['G[th0]', 'old', 'u1', 'plain']);
    expect((timeline[0] as ProcessGroupItem).turnId).toBeUndefined();
  });
});
