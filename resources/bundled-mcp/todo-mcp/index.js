#!/usr/bin/env node
/**
 * aionui-todo MCP server — zero-dependency stdio MCP server for the AionUi todo list.
 *
 * Exposes todo CRUD tools plus an email-snapshot reader so agents (and the
 * scheduled email-scan job) can read and manage the user's todo list. Runs on
 * the managed node runtime spawned by aioncore; registration happens in
 * runBackendMigrations.ts (enabled, non-builtin → auto-attached to every new
 * conversation).
 *
 * Data contract: shares todo.json with the Electron main process. Both sides
 * implement the SAME write protocol — mkdir directory lock (stale after 10s,
 * forced break; acquire retries up to 3s in 50ms steps) plus tmp-file rename
 * for atomic replace. Keep the two implementations in sync when editing.
 *
 * Email snapshot: emails.json is written by the host's fetch-outlook.ps1. A
 * scheduled scan never passes through the host's scan button, so
 * email_snapshot_read reruns that script (AIONUI_TODO_EMAIL_SCRIPT) when the
 * snapshot is stale. Every returned email ends up in processed_message_ids,
 * via todo_create or email_mark_skipped, so later scans only see new mail.
 *
 * Protocol notes: stdio MCP uses newline-delimited JSON-RPC. stdout is the
 * protocol channel — all diagnostics go to stderr only.
 */

'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const PROTOCOL_VERSION = '2024-11-05';
const LOCK_STALE_MS = 10000;
const LOCK_ACQUIRE_TIMEOUT_MS = 3000;
const LOCK_RETRY_DELAY_MS = 50;
const SNAPSHOT_MAX_EMAILS = 15;
const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
const SNAPSHOT_REFRESH_TIMEOUT_MS = 120000;
// Message-IDs only need to outlive the snapshot window (a few days, ≤100 emails per fetch).
const PROCESSED_IDS_LIMIT = 2000;

const log = (message) => {
  process.stderr.write(`[aionui-todo] ${message}\n`);
};

const todoDir = (process.env.AIONUI_TODO_DIR || '').trim();
const dbPath = todoDir ? path.join(todoDir, 'todo.json') : null;
const snapshotPath = todoDir ? path.join(todoDir, 'emails.json') : null;
const emailScriptPath = (process.env.AIONUI_TODO_EMAIL_SCRIPT || '').trim();

if (!dbPath) {
  log('AIONUI_TODO_DIR is not set — todo tools will return an error until the Electron host publishes it.');
}

// ---------------------------------------------------------------------------
// Store — mirrors process/services/todo/todoStore.ts (see contract note above)
// ---------------------------------------------------------------------------

const emptyStore = () => ({
  version: 1,
  todos: [],
  processed_message_ids: [],
  last_scan_at: null,
  last_scan_status: null,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        /* retry loop handles it */
      }
      if (Date.now() > deadline) throw new Error(`todo store lock timeout: ${lockDir}`);
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
}

function releaseLock(lockDir) {
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

function readStoreUnlocked() {
  if (!dbPath) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.todos)) return emptyStore();
    return {
      version: 1,
      todos: parsed.todos,
      processed_message_ids: Array.isArray(parsed.processed_message_ids) ? parsed.processed_message_ids : [],
      last_scan_at: parsed.last_scan_at ?? null,
      last_scan_status: parsed.last_scan_status ?? null,
    };
  } catch {
    return emptyStore();
  }
}

async function withLock(mutate) {
  if (!dbPath) throw new Error('todo store unavailable: AIONUI_TODO_DIR not set');
  const lockDir = `${dbPath}.lock`;
  await acquireLock(lockDir);
  try {
    const store = readStoreUnlocked();
    const result = await mutate(store);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const tmpPath = `${dbPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store), 'utf8');
    fs.renameSync(tmpPath, dbPath);
    return result;
  } finally {
    releaseLock(lockDir);
  }
}

const readStore = () => readStoreUnlocked();

function rememberProcessed(store, messageId) {
  store.processed_message_ids.push(messageId);
  const overflow = store.processed_message_ids.length - PROCESSED_IDS_LIMIT;
  if (overflow > 0) store.processed_message_ids.splice(0, overflow);
}

function readSnapshot() {
  if (!snapshotPath) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
}

let refreshing = null;

/** Rerun the host's Outlook export when the snapshot is stale; resolves to a failure reason or undefined. */
function refreshSnapshotIfStale() {
  if (process.platform !== 'win32' || !snapshotPath || !emailScriptPath || !fs.existsSync(emailScriptPath)) {
    return Promise.resolve(undefined);
  }
  const current = readSnapshot();
  if (current && Date.now() - (Number(current.fetched_at) || 0) < SNAPSHOT_MAX_AGE_MS) {
    return Promise.resolve(undefined);
  }
  if (!refreshing) {
    refreshing = new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', emailScriptPath, '-OutFile', snapshotPath, '-Days', '3'],
        { timeout: SNAPSHOT_REFRESH_TIMEOUT_MS, windowsHide: true },
        (error) => resolve(error ? `outlook fetch failed: ${error.message}` : undefined)
      );
    })
      .then(async (failure) => {
        // The script reports Outlook problems inside the snapshot; mirror the host's scan status.
        const snapshot = readSnapshot();
        const reason = failure || (snapshot ? snapshot.error : 'snapshot unreadable');
        await withLock((store) => {
          store.last_scan_at = Date.now();
          store.last_scan_status = reason ? `snapshot-failed: ${reason}` : 'snapshot-ok';
        }).catch((error) => log(`failed to record scan status: ${error && error.message ? error.message : error}`));
        return failure;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const newId = () => `todo_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;

const normalizeDueAt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

// 与主进程 todoStore.sanitizeSubtasks 同规则:补 id、去空文本、限量。
const sanitizeSubtasks = (value) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
      text: String(entry.text ?? '')
        .trim()
        .slice(0, 300),
      done: Boolean(entry.done),
    }))
    .filter((entry) => entry.text)
    .slice(0, 30);
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolTodoList(params) {
  const { status, due_before, due_after, limit } = params || {};
  let todos = readStore().todos;
  if (status === 'pending' || status === 'waiting' || status === 'done')
    todos = todos.filter((todo) => todo.status === status);
  if (typeof due_before === 'number')
    todos = todos.filter((todo) => todo.due_at !== null && todo.due_at !== undefined && todo.due_at <= due_before);
  if (typeof due_after === 'number')
    todos = todos.filter((todo) => todo.due_at === null || todo.due_at === undefined || todo.due_at >= due_after);
  todos = [...todos].sort((a, b) => {
    const aDue = a.due_at ?? Number.POSITIVE_INFINITY;
    const bDue = b.due_at ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return (b.created_at || 0) - (a.created_at || 0);
  });
  const capped = typeof limit === 'number' && limit > 0 ? todos.slice(0, limit) : todos;
  const open = readStore().todos.filter((todo) => todo.status !== 'done').length;
  return `${capped.length} todo(s), ${open} open total\n${JSON.stringify(capped, null, 2)}`;
}

async function toolTodoCreate(params) {
  const title = String((params && params.title) || '').trim();
  if (!title) throw new Error('title is required');
  const emailRef =
    params && params.email_ref
      ? {
          message_id: String(params.email_ref.message_id || ''),
          subject: String(params.email_ref.subject || ''),
          from: String(params.email_ref.from || ''),
          received_at: Number(params.email_ref.received_at) || Date.now(),
        }
      : null;

  return withLock((store) => {
    // 邮件来源去重:同一封邮件无论派生几个任务,只在首个到达时登记
    // Message-ID,后续到达直接跳过——扫描 agent 重复执行也不会重复建。
    // Email-source dedup: the first arrival registers the Message-ID;
    // later arrivals are skipped so repeat scans never duplicate todos.
    if (emailRef && emailRef.message_id) {
      if (store.processed_message_ids.includes(emailRef.message_id)) {
        return { created: false, reason: 'duplicate', message_id: emailRef.message_id };
      }
      const alreadyReferenced = store.todos.some(
        (todo) => todo.email_ref && todo.email_ref.message_id === emailRef.message_id
      );
      if (alreadyReferenced) {
        if (!store.processed_message_ids.includes(emailRef.message_id)) rememberProcessed(store, emailRef.message_id);
        return { created: false, reason: 'duplicate', message_id: emailRef.message_id };
      }
    }
    const now = Date.now();
    const status = params && params.status === 'waiting' ? 'waiting' : 'pending';
    const item = {
      id: newId(),
      title,
      notes: String((params && params.notes) || '').trim() || undefined,
      due_at: normalizeDueAt(params && params.due_at),
      status,
      blocked_reason:
        status === 'waiting' ? String((params && params.blocked_reason) || '').trim() || undefined : undefined,
      requester: String((params && params.requester) || '').trim() || undefined,
      subtasks: sanitizeSubtasks(params && params.subtasks) || undefined,
      completed_at: null,
      source: emailRef ? 'email' : 'agent',
      email_ref: emailRef,
      created_at: now,
      updated_at: now,
    };
    store.todos.push(item);
    if (emailRef && emailRef.message_id) rememberProcessed(store, emailRef.message_id);
    return { created: true, todo: item };
  });
}

async function toolTodoUpdate(params) {
  if (!params || !params.id) throw new Error('id is required');
  return withLock((store) => {
    const item = store.todos.find((todo) => todo.id === params.id);
    if (!item) return { updated: false, reason: 'not found' };
    if (params.title !== undefined) {
      const title = String(params.title).trim();
      if (title) item.title = title;
    }
    if (params.notes !== undefined) item.notes = String(params.notes).trim() || undefined;
    if (params.due_at !== undefined) item.due_at = normalizeDueAt(params.due_at);
    if (params.requester !== undefined) item.requester = String(params.requester).trim() || undefined;
    if (params.subtasks !== undefined) item.subtasks = sanitizeSubtasks(params.subtasks) || undefined;
    // pending ↔ waiting 互转;从 done 重开也允许(清 completed_at)。
    // 置为 done 仍须经 todo_complete(要写完成时间戳)。
    if (params.status === 'waiting' || params.status === 'pending') {
      item.status = params.status;
      item.completed_at = null;
    }
    if (params.blocked_reason !== undefined) {
      item.blocked_reason = String(params.blocked_reason || '').trim() || undefined;
    }
    if (item.status !== 'waiting') item.blocked_reason = undefined;
    item.updated_at = Date.now();
    return { updated: true, todo: item };
  });
}

async function toolTodoComplete(params) {
  if (!params || !params.id) throw new Error('id is required');
  const done = params.done === undefined ? true : Boolean(params.done);
  return withLock((store) => {
    const item = store.todos.find((todo) => todo.id === params.id);
    if (!item) return { updated: false, reason: 'not found' };
    item.status = done ? 'done' : 'pending';
    item.completed_at = done ? Date.now() : null;
    if (!done) item.blocked_reason = undefined;
    item.updated_at = Date.now();
    return { updated: true, todo: item };
  });
}

async function toolTodoDelete(params) {
  if (!params || !params.id) throw new Error('id is required');
  return withLock((store) => {
    const before = store.todos.length;
    store.todos = store.todos.filter((todo) => todo.id !== params.id);
    return { deleted: store.todos.length < before };
  });
}

async function toolEmailSnapshotRead() {
  if (!snapshotPath) throw new Error('email snapshot unavailable: AIONUI_TODO_DIR not set');
  const refreshFailure = await refreshSnapshotIfStale();
  if (refreshFailure) return `Email source error: ${refreshFailure}`;
  const snapshot = readSnapshot();
  if (!snapshot) {
    return 'No email snapshot available yet. The host writes emails.json when a scan starts.';
  }
  if (snapshot.error) {
    return `Email source error: ${snapshot.error}`;
  }
  const processed = new Set(readStore().processed_message_ids);
  const fresh = (snapshot.emails || []).filter((email) => email.message_id && !processed.has(email.message_id));
  const capped = fresh.slice(0, SNAPSHOT_MAX_EMAILS);
  const remaining = fresh.length - capped.length;
  const next = remaining
    ? `${remaining} more unprocessed email(s) remain: handle every email in this batch with todo_create or email_mark_skipped, then call email_snapshot_read again.`
    : 'No more unprocessed emails after this batch.';
  return `${capped.length} unprocessed email(s) in this batch, ${(snapshot.emails || []).length} in snapshot, fetched_at=${snapshot.fetched_at}. ${next}\n${JSON.stringify(capped, null, 2)}`;
}

async function toolEmailMarkSkipped(params) {
  const ids = Array.isArray(params && params.message_ids)
    ? [...new Set(params.message_ids.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : [];
  if (!ids.length) throw new Error('message_ids is required');
  if (ids.length > 100) throw new Error('at most 100 message_ids per call');
  // Only ids from the current snapshot are accepted, so a mistyped id stays visible to the next scan.
  const known = new Set(((readSnapshot() || {}).emails || []).map((email) => email.message_id).filter(Boolean));
  return withLock((store) => {
    const processed = new Set(store.processed_message_ids);
    const result = { marked: 0, already_processed: 0, unknown: [] };
    for (const id of ids) {
      if (processed.has(id)) result.already_processed += 1;
      else if (!known.has(id)) result.unknown.push(id);
      else {
        rememberProcessed(store, id);
        processed.add(id);
        result.marked += 1;
      }
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// MCP plumbing (newline-delimited JSON-RPC over stdio)
// ---------------------------------------------------------------------------

const optionalString = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'todo_list',
    description:
      "List the user's todos. Filter by status ('pending'|'done') and due-date range (epoch ms). Use this before creating tasks to avoid duplicates and to find task ids.",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'waiting', 'done'],
          description: 'Filter by status; omit for all.',
        },
        due_before: { type: 'number', description: 'Epoch ms — only todos due at or before this time.' },
        due_after: { type: 'number', description: 'Epoch ms — only todos due at or after this time.' },
        limit: { type: 'number', description: 'Max items to return.' },
      },
    },
  },
  {
    name: 'todo_create',
    description:
      'Create a todo item. Pass email_ref when the task comes from an email so repeats stay deduplicated. due_at accepts epoch ms or an ISO 8601 string.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short imperative task title.' },
        notes: optionalString('Details, context or links.'),
        due_at: { description: 'Deadline: epoch ms or ISO 8601 string; omit when unknown.' },
        requester: {
          type: 'string',
          description:
            'Display name of the person asking for this task (prefer the Chinese name when the email has one).',
        },
        status: {
          type: 'string',
          enum: ['pending', 'waiting'],
          description: '"waiting" when the task is blocked on an external confirmation (client reply, lab data...).',
        },
        blocked_reason: { type: 'string', description: 'Why it waits, e.g. "待客户确认固件方案后再执行".' },
        subtasks: {
          type: 'array',
          description: 'Concrete execution steps (2-5, short imperative lines) when the email lists them.',
          items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
        email_ref: {
          type: 'object',
          description: 'Origin email for dedup/traceability.',
          properties: {
            message_id: { type: 'string' },
            subject: { type: 'string' },
            from: { type: 'string' },
            received_at: { type: 'number' },
          },
          required: ['message_id'],
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'todo_update',
    description: 'Update a todo (title / notes / due_at / requester / status / subtasks) by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        notes: { type: 'string' },
        due_at: { description: 'Epoch ms or ISO 8601 string; null clears.' },
        requester: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'waiting'] },
        blocked_reason: { type: 'string', description: 'Empty string clears.' },
        subtasks: {
          type: 'array',
          description: 'Replaces the whole step list.',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' }, done: { type: 'boolean' } },
            required: ['text'],
          },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_complete',
    description: 'Mark a todo done (or pending again with done=false) by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, done: { type: 'boolean', description: 'Defaults to true.' } },
      required: ['id'],
    },
  },
  {
    name: 'todo_delete',
    description: 'Delete a todo by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'email_snapshot_read',
    description:
      'Read unprocessed emails from the mailbox snapshot (refreshed automatically when older than 10 minutes). Call this first when scanning emails for tasks; each email carries message_id, subject, from, received_at and a body preview. Returns at most 15 per call: handle each one with todo_create (email_ref) or email_mark_skipped before calling again.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'email_mark_skipped',
    description:
      'Mark emails returned by email_snapshot_read as reviewed without creating a todo (not actionable), so later scans do not return them again. Pass message_id values verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'message_id values of the non-actionable emails (max 100 per call).',
        },
      },
      required: ['message_ids'],
    },
  },
];

const TOOL_HANDLERS = {
  todo_list: toolTodoList,
  todo_create: toolTodoCreate,
  todo_update: toolTodoUpdate,
  todo_complete: toolTodoComplete,
  todo_delete: toolTodoDelete,
  email_snapshot_read: toolEmailSnapshotRead,
  email_mark_skipped: toolEmailMarkSkipped,
};

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const handleRequest = async (message) => {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'aionui-todo', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
      return;
    }
    try {
      const result = await handler(params.arguments || {});
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `error: ${error && error.message ? error.message : String(error)}` }],
          isError: true,
        },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    log(`ignoring malformed stdin line: ${error && error.message ? error.message : error}`);
    return;
  }
  handleRequest(message).catch((error) => {
    log(`request handler failed: ${error && error.stack ? error.stack : error}`);
  });
});

rl.on('close', () => process.exit(0));
log(`started (db=${dbPath || 'unset'}, snapshot=${snapshotPath || 'unset'})`);
