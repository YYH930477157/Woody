/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageThinking } from '@/common/chat/chatLib';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import { startsAgentTurn } from '@/renderer/utils/chat/turnCopy';
import type { TurnActivity } from './activity';

/** A run of adjacent thinking and tool steps inside one turn, shown in place of its first step. */
export type ProcessGroupItem = {
  type: 'turn_activity_summary';
  id: string;
  activities: TurnActivity[];
  sourceMessageIds: string[];
  created_at: number;
  /** Id of the message that opened the turn; absent when the loaded window starts mid-turn. */
  turnId?: string;
  /** No more steps can join: a reply, a file change or the next turn followed, or the turn ended. */
  closed: boolean;
};

/** The whole-turn row under the opening message: its status and duration, and the switch that folds its process. */
export type TurnProcessItem = {
  type: 'turn_process';
  id: string;
  turnId: string;
  /** When the opening message was sent; the clock starts here. */
  startedAt?: number;
  /** When the last step or reply of a finished turn started. */
  endedAt?: number;
  running: boolean;
  created_at: number;
};

type ToolSummaryInput = {
  type: 'tool_summary';
  id: string;
  messages: ToolMessage[];
  sourceMessageIds: string[];
  created_at: number;
};

/** The structural subset of a timeline item that grouping reads. */
type TimelineInput = { type: string; id: string; created_at?: number; position?: string; content?: unknown };

const isThinking = (item: TimelineInput): item is IMessageThinking & TimelineInput => item.type === 'thinking';
const isToolSummary = (item: TimelineInput): item is ToolSummaryInput => item.type === 'tool_summary';

/**
 * Items the reader takes as output, so steps after them start a new group:
 * a non-empty assistant reply, or a file change card. Prompts, statuses and
 * tips do not split a group; they stay visible on their own.
 */
const endsProcessGroup = (item: TimelineInput): boolean => {
  if (item.type === 'file_summary' || item.type === 'acp_tool_call') return true;
  if (item.type !== 'text' || item.position !== 'left') return false;
  const text = (item.content as { content?: unknown } | undefined)?.content;
  return typeof text === 'string' && text.trim().length > 0;
};

type Turn = { control?: TurnProcessItem; groups: ProcessGroupItem[]; lastAt?: number };

/**
 * Split each turn's thinking and tool steps into process groups and add a
 * turn row after every opening message that has any.
 *
 * - A turn opens at a user message, or in a team at a teammate's message.
 * - Adjacent steps form one group; a reply or a file change closes it, so
 *   later steps start the next group and every group keeps its place.
 * - While `processing`, the last turn runs and its trailing group stays open.
 */
export function groupTurnProcess<T extends TimelineInput>(
  items: T[],
  processing: boolean
): Array<T | ProcessGroupItem | TurnProcessItem> {
  const timeline: Array<T | ProcessGroupItem | TurnProcessItem> = [];
  const turns: Turn[] = [];
  let turn: Turn = { groups: [] };
  let group: ProcessGroupItem | undefined;

  const closeGroup = () => {
    if (group) group.closed = true;
    group = undefined;
  };
  const touch = (createdAt?: number) => {
    if (createdAt && (turn.lastAt === undefined || createdAt > turn.lastAt)) turn.lastAt = createdAt;
  };
  const openGroup = (firstId: string, createdAt: number): ProcessGroupItem => {
    if (group) return group;
    group = {
      type: 'turn_activity_summary',
      id: 'turn-activity-' + firstId,
      activities: [],
      sourceMessageIds: [],
      created_at: createdAt,
      turnId: turn.control?.turnId,
      closed: false,
    };
    turn.groups.push(group);
    timeline.push(group);
    return group;
  };

  for (const item of items) {
    if (startsAgentTurn(item)) {
      closeGroup();
      turns.push(turn);
      timeline.push(item);
      const control: TurnProcessItem = {
        type: 'turn_process',
        id: 'turn-process-' + item.id,
        turnId: item.id,
        startedAt: item.created_at || undefined,
        running: false,
        created_at: item.created_at ?? 0,
      };
      timeline.push(control);
      turn = { control, groups: [] };
      continue;
    }
    if (isThinking(item)) {
      const target = openGroup(item.id, item.created_at ?? 0);
      target.activities.push({ type: 'thinking', message: item });
      target.sourceMessageIds.push(item.id);
      touch(item.created_at);
      continue;
    }
    if (isToolSummary(item)) {
      const target = openGroup(item.sourceMessageIds[0] ?? item.id, item.created_at);
      target.activities.push({ type: 'tools', messages: item.messages });
      target.sourceMessageIds.push(...item.sourceMessageIds);
      touch(item.created_at);
      continue;
    }
    timeline.push(item);
    touch(item.created_at);
    if (endsProcessGroup(item)) closeGroup();
  }
  if (processing) {
    if (turn.control) turn.control.running = true;
  } else {
    closeGroup();
  }
  turns.push(turn);

  for (const { control, lastAt } of turns) {
    if (control && !control.running) control.endedAt = lastAt;
  }
  // A turn row is only worth showing when the turn has steps to fold.
  const unused = new Set(turns.filter((entry) => entry.control && !entry.groups.length).map((entry) => entry.control));
  return timeline.filter((item) => !unused.has(item as TurnProcessItem));
}
