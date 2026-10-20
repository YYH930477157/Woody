import { describe, expect, it } from 'vitest';
import type { ITodoItem } from '@/common/types/todo/todoTypes';
import {
  buildSections,
  dayMarks,
  dueInfo,
  filterTodos,
  formatDue,
  groupOf,
  parseNotes,
  requesterCounts,
  subjectAsTitle,
  summaryOf,
  viewCounts,
} from '@/renderer/pages/todo/todoModel';

// Tue 2026-10-20 10:00 local time.
const NOW = new Date(2026, 9, 20, 10, 0).getTime();
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

let next = 0;
const todo = (patch: Partial<ITodoItem>): ITodoItem => ({
  id: `t${++next}`,
  title: `Todo ${next}`,
  status: 'pending',
  source: 'manual',
  created_at: at(1),
  updated_at: at(1),
  ...patch,
});

const t = (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key);

describe('todo grouping and views', () => {
  const overdue = todo({ title: 'overdue', due_at: at(18, 18), requester: 'Li' });
  const today = todo({ title: 'today', due_at: at(20, 17) });
  const waiting = todo({ title: 'waiting', status: 'waiting', due_at: at(23) });
  const later = todo({ title: 'later', due_at: at(26) });
  const unscheduled = todo({ title: 'unscheduled', due_at: null });
  const done = todo({ title: 'done', status: 'done', due_at: at(19), completed_at: at(19, 16), requester: 'Li' });
  const all = [later, done, unscheduled, waiting, today, overdue];

  it('lets status win over dates and treats missing deadlines as upcoming', () => {
    expect(all.map((item) => [item.title, groupOf(item, NOW)])).toEqual([
      ['later', 'upcoming'],
      ['done', 'done'],
      ['unscheduled', 'upcoming'],
      ['waiting', 'waiting'],
      ['today', 'today'],
      ['overdue', 'overdue'],
    ]);
  });

  it('counts each view the way the sidebar shows it', () => {
    expect(viewCounts(all, NOW)).toEqual({ all: 5, focus: 2, waiting: 1, upcoming: 2, done: 1 });
  });

  it('orders sections by urgency and items by deadline, unscheduled last', () => {
    const sections = buildSections(filterTodos(all, { view: 'all', day: null, requester: null, query: '' }, NOW), NOW);

    expect(sections.map((section) => [section.group, section.items.map((item) => item.title)])).toEqual([
      ['overdue', ['overdue']],
      ['today', ['today']],
      ['waiting', ['waiting']],
      ['upcoming', ['later', 'unscheduled']],
    ]);
  });

  it('shows every item due on a picked day, including finished ones', () => {
    const picked = filterTodos(all, { view: 'focus', day: at(19), requester: null, query: '' }, NOW);

    expect(picked.map((item) => item.title)).toEqual(['done']);
  });

  it('combines requester and keyword filters', () => {
    const items = [
      overdue,
      todo({ title: 'Review PR', requester: 'Zhang', notes: 'EEPROM writes' }),
      todo({ title: 'Other', requester: 'Zhang' }),
    ];

    expect(
      filterTodos(items, { view: 'all', day: null, requester: 'Zhang', query: 'eeprom' }, NOW).map((item) => item.title)
    ).toEqual(['Review PR']);
  });

  it('counts open items per requester and marks calendar days', () => {
    expect(requesterCounts(all)).toEqual([{ name: 'Li', count: 1 }]);
    const marks = dayMarks(all, NOW);
    expect([...(marks.get(at(18)) ?? [])]).toEqual(['focus']);
    expect([...(marks.get(at(23)) ?? [])]).toEqual(['waiting']);
    expect([...(marks.get(at(26)) ?? [])]).toEqual(['planned']);
    expect(marks.has(at(19))).toBe(false);
  });
});

describe('todo notes and deadlines', () => {
  it('splits email scan notes into goal, key points and the quoted sentence', () => {
    const notes = [
      '要做什么: 逐条回复客户反馈',
      '关键点:',
      '- 第 3 项需附测试视频',
      '2. 整改计划含时间节点',
      '原文关键句: "请于本周三前回复"',
    ].join('\n');

    expect(parseNotes(notes)).toEqual({
      goal: '逐条回复客户反馈',
      points: ['第 3 项需附测试视频', '整改计划含时间节点'],
      quote: '请于本周三前回复',
      extra: '',
    });
    expect(summaryOf(todo({ notes }))).toBe('逐条回复客户反馈');
  });

  it('keeps free-form notes as plain text', () => {
    expect(parseNotes('Call the lab\nthen update parameters')).toEqual({
      points: [],
      extra: 'Call the lab\nthen update parameters',
    });
  });

  it('labels deadlines relative to today and keeps a time of day when set', () => {
    const label = (due_at: number | null) => formatDue(dueInfo(todo({ due_at }), NOW), t, 'en-US');

    expect(label(at(18, 18))).toBe('todo.dueLabel.overdue:{"count":2}');
    expect(label(at(20, 17))).toBe('todo.dueLabel.today 17:00');
    expect(label(at(21))).toBe('todo.dueLabel.tomorrow');
    expect(label(at(23, 9, 30))).toBe('Fri 09:30');
    expect(label(at(30))).toBe('Oct 30');
    expect(label(null)).toBe('todo.dueNone');
  });

  it('drops reply and forward prefixes when an email subject becomes a title', () => {
    expect(subjectAsTitle('RE: FW: Virgo 06 sample feedback')).toBe('Virgo 06 sample feedback');
    expect(subjectAsTitle('回复：转发: 样机整改计划')).toBe('样机整改计划');
    expect(subjectAsTitle('Return policy update')).toBe('Return policy update');
  });
});
