import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryService } from '@process/services/memory/service';
import { memoryDirectory } from '@process/services/memory/paths';

type Row = { id: string; type: string; source?: string; modified_at: number; extra: Record<string, unknown> };
type Message = { id: string; msg_id: string; position: string; type: string; hidden: boolean; content: unknown };

// Polling observes state transitions and must remain sequential.
/* eslint-disable no-await-in-loop */
let root: string;
let clock: number;
const MINUTE = 60_000;

/** A small AionCore: conversations, hidden turns that finish after a few polls, cancel. */
function backend(answer: () => string) {
  const rows = new Map<string, Row>();
  const messages = new Map<string, Message[]>();
  const turns = new Map<string, { turnId: string; polls: number; cancelled: boolean }>();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let pollsPerTurn = 2;
  const request = async <T>(method: string, requestPath: string, body?: unknown): Promise<T> => {
    calls.push({ method, path: requestPath, body });
    const [route, query = ''] = requestPath.split('?');
    if (method === 'GET' && route === '/api/conversations')
      return { items: [...rows.values()].toSorted((a, b) => b.modified_at - a.modified_at) } as T;
    const match = /^\/api\/conversations\/([^/]+)(\/messages|\/cancel)?$/.exec(route);
    if (!match) throw new Error(`Unexpected ${method} ${requestPath}`);
    const id = decodeURIComponent(match[1]);
    const row = rows.get(id);
    if (!row) throw new Error('404');
    const turn = turns.get(id);
    if (!match[2] && method === 'GET') {
      if (turn && !turn.cancelled && turn.polls > 0 && --turn.polls === 0) {
        const list = messages.get(id) ?? [];
        list.push({
          id: `a${list.length}`,
          msg_id: `a${list.length}`,
          position: 'left',
          type: 'text',
          hidden: false,
          content: { content: answer() },
        });
        messages.set(id, list);
        row.modified_at = clock;
      }
      const processing = Boolean(turn && !turn.cancelled && turn.polls > 0);
      return {
        ...row,
        runtime: {
          is_processing: processing,
          can_send_message: !processing,
          turn_id: processing ? turn?.turnId : null,
        },
      } as T;
    }
    if (match[2] === '/messages' && method === 'POST') {
      const list = messages.get(id) ?? [];
      const msgId = `h${list.length}`;
      list.push({
        id: msgId,
        msg_id: msgId,
        position: 'right',
        type: 'text',
        hidden: (body as { hidden?: boolean }).hidden === true,
        content: { content: (body as { content: string }).content },
      });
      messages.set(id, list);
      turns.set(id, { turnId: `t-${msgId}`, polls: pollsPerTurn, cancelled: false });
      return { turn_id: `t-${msgId}`, msg_id: msgId } as T;
    }
    if (match[2] === '/messages' && method === 'GET') {
      const anchor = new URLSearchParams(query).get('anchor_message_id');
      const list = messages.get(id) ?? [];
      const start = list.findIndex((message) => message.msg_id === anchor);
      return { items: start < 0 ? [] : list.slice(start), newest_cursor: null, has_more_after: false } as T;
    }
    if (match[2] === '/cancel') {
      if (turn) turn.cancelled = true;
      return {} as T;
    }
    throw new Error(`Unexpected ${method} ${requestPath}`);
  };
  return {
    request,
    calls,
    rows,
    hiddenSends: () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages')),
    slowTurns: (polls: number) => {
      pollsPerTurn = polls;
    },
  };
}

const workspace = 'E:\\firmware';
function service(api: ReturnType<typeof backend>, overrides: Partial<Parameters<typeof createMemoryService>[0]> = {}) {
  return createMemoryService({
    request: api.request,
    appData: path.join(root, 'appdata'),
    statePath: path.join(root, 'state', 'memory.json'),
    trash: async (target) => fs.rmSync(target),
    env: {},
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    ...overrides,
  });
}
const directory = () => memoryDirectory(workspace, path.join(root, 'appdata'), {});
const aionrs = (id: string, modified: number, extra: Record<string, unknown> = {}): Row => ({
  id,
  type: 'aionrs',
  modified_at: modified,
  extra: { workspace, ...extra },
});
const ANSWER = JSON.stringify({
  memories: [
    {
      action: 'add',
      file: 'alarm-threshold',
      type: 'project',
      name: '报警阈值',
      description: '过流阈值存在 EEPROM',
      body: 'AlarmPara 在 parameter.c 有默认值。',
    },
  ],
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-memory-service-'));
  clock = 10_000_000;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('distilling memories when a conversation goes quiet', () => {
  it('waits five quiet minutes, distills once, and leaves older and foreign conversations alone', async () => {
    const api = backend(() => ANSWER);
    const memory = service(api);
    await memory.getSettings(); // first run: everything before now is left alone
    api.rows.set('old', aionrs('old', clock - 10 * MINUTE));
    api.rows.set('chat', aionrs('chat', clock + 1000));
    api.rows.set('telegram', { ...aionrs('telegram', clock + 1000), source: 'telegram' });
    api.rows.set('acp', { ...aionrs('acp', clock + 1000), type: 'acp' });
    api.rows.set('cron', aionrs('cron', clock + 1000, { cron_job_id: 'job' }));

    clock += 2 * MINUTE;
    await memory.tick();
    expect(api.hiddenSends()).toHaveLength(0);

    clock += 4 * MINUTE;
    await memory.tick();
    const sends = api.hiddenSends();
    expect(sends.map((call) => call.path)).toEqual(['/api/conversations/chat/messages']);
    expect(sends[0].body).toMatchObject({ hidden: true });
    expect((sends[0].body as { content: string }).content).toContain('Existing memories (MEMORY.md):\n(none yet)');
    expect(fs.readFileSync(path.join(directory(), 'MEMORY.md'), 'utf8')).toBe(
      '- [报警阈值](alarm-threshold.md) — 过流阈值存在 EEPROM\n'
    );

    // The hidden turn changed the conversation; that alone is no new activity.
    clock += 10 * MINUTE;
    await memory.tick();
    expect(api.hiddenSends()).toHaveLength(1);
    // New activity, then quiet again: distilled again, now with the index in the prompt.
    api.rows.get('chat')!.modified_at = clock;
    clock += 6 * MINUTE;
    await memory.tick();
    expect(api.hiddenSends()).toHaveLength(2);
    expect((api.hiddenSends()[1].body as { content: string }).content).toContain('- [报警阈值](alarm-threshold.md)');
  });

  it('writes nothing from an answer that is not JSON, and does not ask again until there is news', async () => {
    const api = backend(() => 'Sorry, nothing to add.');
    const memory = service(api);
    await memory.getSettings();
    api.rows.set('chat', aionrs('chat', clock + 1000));
    clock += 6 * MINUTE;
    await memory.tick();
    await memory.tick();
    expect(api.hiddenSends()).toHaveLength(1);
    expect(fs.existsSync(directory())).toBe(false);
    await expect(memory.distill('chat')).rejects.toThrow(/not JSON/);
  });

  it('can be switched off, and the switch survives a restart', async () => {
    const api = backend(() => ANSWER);
    const memory = service(api);
    expect(await memory.setSettings({ autoDistill: false, autoRecall: true })).toEqual({
      autoDistill: false,
      autoRecall: true,
    });
    api.rows.set('chat', aionrs('chat', clock + 1000));
    clock += 6 * MINUTE;
    await memory.tick();
    expect(api.hiddenSends()).toHaveLength(0);
    expect(await service(api).getSettings()).toEqual({ autoDistill: false, autoRecall: true });
  });
});

describe('recalling memories before a message is sent', () => {
  it('adds related memories once per conversation, and nothing for other agents or when switched off', async () => {
    const api = backend(() => ANSWER);
    const memory = service(api);
    api.rows.set('chat', aionrs('chat', clock));
    api.rows.set('acp', { ...aionrs('acp', clock), type: 'acp' });
    await memory.save(workspace, {
      name: '报警阈值',
      description: '过流阈值存在 EEPROM',
      type: 'project',
      body: 'AlarmPara 在 parameter.c。',
    });

    const first = await memory.recall('chat', '过流报警阈值要改成多少？');
    expect(first.names).toEqual(['报警阈值']);
    expect(first.block).toContain('AlarmPara 在 parameter.c。');
    expect((await memory.recall('chat', '过流报警阈值再改一次')).block).toBe('');
    expect((await memory.recall('acp', '过流报警阈值')).block).toBe('');

    await memory.setSettings({ autoDistill: true, autoRecall: false });
    expect((await service(api).recall('chat', '过流报警阈值')).block).toBe('');
  });

  it('stops a distill running in the conversation before the user message goes out', async () => {
    const api = backend(() => ANSWER);
    api.slowTurns(1000);
    // Polls yield to the event loop here, so the user's message can arrive mid-turn.
    const memory = service(api, {
      wait: async (ms) => {
        clock += ms;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    api.rows.set('chat', aionrs('chat', clock));
    const distilling = memory.distill('chat');
    // Let the hidden message go out.
    for (let attempt = 0; attempt < 20 && !api.hiddenSends().length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(api.hiddenSends()).toHaveLength(1);
    await memory.recall('chat', '新问题');
    expect(api.calls.some((call) => call.method === 'POST' && call.path === '/api/conversations/chat/cancel')).toBe(
      true
    );
    await expect(distilling).rejects.toThrow(/cancelled|busy/);
    expect(fs.existsSync(directory())).toBe(false);
  });
});
