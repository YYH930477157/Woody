/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import dayjs from 'dayjs';
import type { ITodoItem } from '@/common/types/todo/todoTypes';

export type TodoView = 'all' | 'focus' | 'waiting' | 'upcoming' | 'done';
export type TodoGroup = 'overdue' | 'today' | 'waiting' | 'upcoming' | 'done';
export type TodoFilters = { view: TodoView; day: number | null; requester: string | null; query: string };

export const GROUP_ORDER: TodoGroup[] = ['overdue', 'today', 'waiting', 'upcoming', 'done'];
const DAY_MS = 24 * 60 * 60 * 1000;

export const startOfDay = (value: number): number => dayjs(value).startOf('day').valueOf();

const hasDue = (item: ITodoItem): item is ITodoItem & { due_at: number } =>
  item.due_at !== null && item.due_at !== undefined;

/** Done and waiting win over dates; open items fall into overdue, today, or upcoming (incl. unscheduled). */
export function groupOf(item: ITodoItem, now = Date.now()): TodoGroup {
  if (item.status === 'done') return 'done';
  if (item.status === 'waiting') return 'waiting';
  if (!hasDue(item)) return 'upcoming';
  const today = startOfDay(now);
  if (item.due_at < today) return 'overdue';
  if (startOfDay(item.due_at) === today) return 'today';
  return 'upcoming';
}

export function matchesView(item: ITodoItem, view: TodoView, now = Date.now()): boolean {
  const group = groupOf(item, now);
  if (view === 'all') return group !== 'done';
  if (view === 'focus') return group === 'overdue' || group === 'today';
  return group === view;
}

export function requesterOf(item: ITodoItem): string | null {
  const name = item.requester || item.email_ref?.from || '';
  return name.trim() || null;
}

const SUBJECT_PREFIX = /^\s*(re|fw|fwd|回复|回覆|答复|转发|轉寄|轉發)\s*[:：]\s*/i;

/** An email subject without its reply / forward prefixes, as a starting title for a todo. */
export function subjectAsTitle(subject: string): string {
  let text = subject.trim();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(SUBJECT_PREFIX, '');
  }
  return text;
}

const NOTE_LABEL = /^(要做什么|关键点|原文关键句|要求人|截止)[:：]/;

/** One-line summary: the "要做什么" line written by the email scan, else the first plain line or the subject. */
export function summaryOf(item: ITodoItem): string {
  if (item.notes) {
    const goal = item.notes.match(/^要做什么[:：]\s*(.+)$/m)?.[1]?.trim();
    if (goal) return goal;
    const first = item.notes
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !NOTE_LABEL.test(line));
    if (first) return first;
  }
  return item.email_ref?.subject || '';
}

export type ParsedNotes = { goal?: string; points: string[]; quote?: string; extra: string };

/**
 * The email scan writes notes as "要做什么 / 关键点 / 原文关键句" sections. Split them so the detail
 * view can lay them out; anything else stays as free text.
 */
export function parseNotes(notes = ''): ParsedNotes {
  const parsed: ParsedNotes = { points: [], extra: '' };
  const extra: string[] = [];
  let inPoints = false;
  for (const raw of notes.split('\n')) {
    const line = raw.trim();
    const goal = line.match(/^要做什么[:：]\s*(.*)$/);
    const points = line.match(/^关键点[:：]\s*(.*)$/);
    const quote = line.match(/^原文关键句[:：]\s*(.*)$/);
    if (goal) {
      parsed.goal = goal[1].trim() || undefined;
      inPoints = false;
    } else if (points) {
      inPoints = true;
      if (points[1].trim()) parsed.points.push(points[1].trim());
    } else if (quote) {
      parsed.quote = quote[1].trim().replace(/^["“「]|["”」]$/g, '') || undefined;
      inPoints = false;
    } else if (inPoints && /^([-•·*]|\d+[.、)])\s*/.test(line)) {
      parsed.points.push(line.replace(/^([-•·*]|\d+[.、)])\s*/, ''));
    } else if (line) {
      inPoints = false;
      extra.push(raw);
    }
  }
  parsed.extra = extra.join('\n').trim();
  return parsed;
}

export type DueInfo =
  | { kind: 'none' }
  | {
      kind: 'overdue' | 'today' | 'tomorrow' | 'week' | 'later';
      at: number;
      /** Calendar days from today; negative when overdue. */
      days: number;
      /** Set when the deadline carries a time of day. */
      time?: string;
    };

export function dueInfo(item: ITodoItem, now = Date.now()): DueInfo {
  if (!hasDue(item)) return { kind: 'none' };
  const days = Math.round((startOfDay(item.due_at) - startOfDay(now)) / DAY_MS);
  const due = dayjs(item.due_at);
  const time = due.hour() || due.minute() ? due.format('HH:mm') : undefined;
  const kind = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : days < 7 ? 'week' : 'later';
  return { kind, at: item.due_at, days, ...(time ? { time } : {}) };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Short deadline label: "2 days overdue", "Today 17:00", "Fri", "Oct 26". */
export function formatDue(info: DueInfo, t: Translate, locale: string): string {
  if (info.kind === 'none') return t('todo.dueNone');
  const withTime = (label: string) => (info.time ? `${label} ${info.time}` : label);
  if (info.kind === 'overdue') return t('todo.dueLabel.overdue', { count: -info.days });
  if (info.kind === 'today') return withTime(t('todo.dueLabel.today'));
  if (info.kind === 'tomorrow') return withTime(t('todo.dueLabel.tomorrow'));
  const date = new Date(info.at);
  if (info.kind === 'week') return withTime(new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date));
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/** Full date for the detail view, e.g. "2026年10月18日 星期日 17:00". */
export function formatFullDate(at: number, locale: string, withTime = false): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(at));
}

export function filterTodos(todos: ITodoItem[], filters: TodoFilters, now = Date.now()): ITodoItem[] {
  const query = filters.query.trim().toLowerCase();
  return todos.filter((item) => {
    // A picked day shows that day's items from every open view; "done" keeps its own scope.
    if (filters.day === null || filters.view === 'done') {
      if (!matchesView(item, filters.view, now)) return false;
    } else if (!hasDue(item) || startOfDay(item.due_at) !== filters.day) return false;
    if (filters.requester && requesterOf(item) !== filters.requester) return false;
    if (query) {
      const haystack = [item.title, item.notes, requesterOf(item), item.email_ref?.subject, item.email_ref?.from]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const byDue = (a: ITodoItem, b: ITodoItem) =>
  (a.due_at ?? Number.POSITIVE_INFINITY) - (b.due_at ?? Number.POSITIVE_INFINITY) || b.created_at - a.created_at;

export function buildSections(items: ITodoItem[], now = Date.now()): Array<{ group: TodoGroup; items: ITodoItem[] }> {
  return GROUP_ORDER.map((group) => {
    const members = items.filter((item) => groupOf(item, now) === group);
    members.sort(group === 'done' ? (a, b) => (b.completed_at || 0) - (a.completed_at || 0) : byDue);
    return { group, items: members };
  }).filter((section) => section.items.length > 0);
}

export function viewCounts(todos: ITodoItem[], now = Date.now()): Record<TodoView, number> {
  const counts: Record<TodoView, number> = { all: 0, focus: 0, waiting: 0, upcoming: 0, done: 0 };
  for (const item of todos) {
    for (const view of Object.keys(counts) as TodoView[]) if (matchesView(item, view, now)) counts[view] += 1;
  }
  return counts;
}

export function requesterCounts(todos: ITodoItem[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of todos) {
    if (item.status === 'done') continue;
    const name = requesterOf(item);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).toSorted((a, b) => b.count - a.count);
}

export type DayMark = 'focus' | 'waiting' | 'planned';

/** Calendar dots for open items: red for overdue/today, amber for waiting, blue for planned. */
export function dayMarks(todos: ITodoItem[], now = Date.now()): Map<number, Set<DayMark>> {
  const marks = new Map<number, Set<DayMark>>();
  for (const item of todos) {
    if (item.status === 'done' || !hasDue(item)) continue;
    const day = startOfDay(item.due_at);
    const group = groupOf(item, now);
    const mark: DayMark = group === 'waiting' ? 'waiting' : group === 'upcoming' ? 'planned' : 'focus';
    if (!marks.has(day)) marks.set(day, new Set());
    marks.get(day)!.add(mark);
  }
  return marks;
}

export function subtaskProgress(item: ITodoItem): { done: number; total: number } | null {
  const total = item.subtasks?.length ?? 0;
  if (!total) return null;
  return { done: item.subtasks!.filter((step) => step.done).length, total };
}
