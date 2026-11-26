/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageThinking } from '@/common/chat/chatLib';
import {
  normalizeAcpToolCall,
  normalizeToolCall,
  normalizeToolGroup,
  type NormalizedToolCall,
  type ToolMessage,
} from '@/common/chat/normalizeToolCall';

/** One step inside a process group, in the order it happened. */
export type TurnActivity = { type: 'thinking'; message: IMessageThinking } | { type: 'tools'; messages: ToolMessage[] };

export type ToolCategory =
  | 'read'
  | 'readImage'
  | 'search'
  | 'write'
  | 'edit'
  | 'commands'
  | 'code'
  | 'webSearch'
  | 'webFetch'
  | 'subagents'
  | 'plan'
  | 'questions'
  | 'tools';

// Tool names differ across agents (aionrs `ExecCommand`, ACP titles, Gemini
// `run_shell_command`), so names are compared lowercase without `_` or `-`.
const NAME_CATEGORIES: Array<[ToolCategory, string[]]> = [
  ['readImage', ['readimage', 'viewimage']],
  ['read', ['read', 'readfile', 'readmanyfiles', 'view']],
  [
    'search',
    [
      'grep',
      'glob',
      'search',
      'searchfilecontent',
      'find',
      'ls',
      'listdirectory',
      'toolsearch',
      'searchcode',
      'searchgraph',
    ],
  ],
  ['write', ['write', 'writefile', 'createfile']],
  ['edit', ['edit', 'multiedit', 'applypatch', 'replace', 'strreplace', 'strreplaceeditor', 'notebookedit']],
  [
    'commands',
    ['bash', 'execcommand', 'runshellcommand', 'shell', 'powershell', 'pwsh', 'terminal', 'writestdin', 'killshell'],
  ],
  ['code', ['runcode']],
  ['webSearch', ['websearch', 'googlewebsearch']],
  ['webFetch', ['webfetch', 'fetch']],
  ['subagents', ['spawn', 'task', 'agent', 'subagent']],
  ['plan', ['todowrite', 'writetodos', 'updateplan', 'enterplanmode', 'exitplanmode']],
  ['questions', ['askuserquestion', 'requestuserinput']],
];

// ACP agents report a tool kind; their titles are free text such as "Read src/a.ts".
const ACP_KIND_CATEGORIES: Record<string, ToolCategory> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'commands',
  fetch: 'webFetch',
  switch_mode: 'plan',
};

/** Classify a tool by its recorded name. MCP tools (`mcp__server__tool`) keep only the tool part. */
export function categorizeToolName(name: string): ToolCategory {
  const bare = name.replace(/^mcp__.+?__/i, '');
  const key = bare.toLowerCase().replace(/[-_\s]/g, '');
  if (key.startsWith('terminal')) return 'commands';
  if (key.startsWith('subagent')) return 'subagents';
  return NAME_CATEGORIES.find(([, names]) => names.includes(key))?.[0] ?? 'tools';
}

type ToolCall = NormalizedToolCall & { category: ToolCategory };

/** Flatten tool messages into calls with a category each, in recorded order. */
export function collectToolCalls(messages: ToolMessage[]): ToolCall[] {
  return messages.flatMap((message): ToolCall[] => {
    if (message.type === 'tool_group') {
      return normalizeToolGroup(message).map((call) =>
        Object.assign(call, { category: categorizeToolName(call.name) })
      );
    }
    if (message.type === 'acp_tool_call') {
      const call = normalizeAcpToolCall(message);
      if (!call) return [];
      const kind = message.content.update.kind;
      return [{ ...call, category: ACP_KIND_CATEGORIES[kind] ?? categorizeToolName(call.name) }];
    }
    const call = normalizeToolCall(message);
    return call ? [{ ...call, category: categorizeToolName(call.name) }] : [];
  });
}

export type ActivitySummary = {
  /** Categories by call count, most first; ties keep their first appearance. */
  categories: ToolCategory[];
  toolCount: number;
  /** The latest tool still pending or running, which the running header names. */
  liveTool?: { category: ToolCategory; detail?: string };
  /** The thinking block still streaming, if any. */
  liveThinking?: IMessageThinking;
  thinkingCount: number;
  thinkingDuration: number;
};

/** Count what a process group did; repeated call ids count once. */
export function summarizeActivities(activities: TurnActivity[]): ActivitySummary {
  const counts = new Map<ToolCategory, number>();
  const seen = new Set<string>();
  let toolCount = 0;
  let liveTool: ActivitySummary['liveTool'];
  let liveThinking: IMessageThinking | undefined;
  let thinkingCount = 0;
  let thinkingDuration = 0;

  for (const activity of activities) {
    if (activity.type === 'thinking') {
      thinkingCount++;
      thinkingDuration += activity.message.content.duration ?? 0;
      if (activity.message.content.status !== 'done') liveThinking = activity.message;
      continue;
    }
    for (const call of collectToolCalls(activity.messages)) {
      if (call.key && seen.has(call.key)) continue;
      if (call.key) seen.add(call.key);
      toolCount++;
      counts.set(call.category, (counts.get(call.category) ?? 0) + 1);
      if (call.status === 'running' || call.status === 'pending') {
        const detail = call.description?.replace(/\s+/g, ' ').trim();
        liveTool = { category: call.category, detail: detail || undefined };
      }
    }
  }

  // Map keeps insertion order and the sort is stable, so ties stay in first-seen order.
  const categories = [...counts.entries()].toSorted((a, b) => b[1] - a[1]).map(([category]) => category);
  return { categories, toolCount, liveTool, liveThinking, thinkingCount, thinkingDuration };
}

/** Whole seconds as `12s`, `1m 5s` or `1h 2m`, with localized unit suffixes. */
export function formatDuration(ms: number, units: { hour: string; minute: string; second: string }): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return seconds + units.second;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + units.minute + ' ' + (seconds % 60) + units.second;
  return Math.floor(minutes / 60) + units.hour + ' ' + (minutes % 60) + units.minute;
}
