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
 * Ownership: the scan must only create the user's own todos. The snapshot
 * names the mailbox owner and each mail's To/CC, so email_snapshot_read
 * states the user's role in every mail (to / cc / not_listed / sender / self),
 * splits the newest message from the quoted history, flags machine-sent mail
 * and points at an existing todo of the same thread. Skipped mail is logged
 * with its reason (skipped_emails) so the user can review and restore it;
 * the user's corrections (scan_feedback) are shown to later scans.
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
// Keep in sync with todoStore.ts.
const SKIPPED_EMAILS_LIMIT = 300;
const SCAN_FEEDBACK_LIMIT = 30;
const SCAN_FEEDBACK_SHOWN = 10;
const LATEST_MESSAGE_MAX_CHARS = 1800;
const QUOTED_HISTORY_MAX_CHARS = 500;
const RECIPIENTS_SHOWN = 6;
const SKIP_REASONS = ['not_mine', 'fyi', 'automated', 'tracked', 'other'];

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
  skipped_emails: [],
  scan_feedback: [],
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
      skipped_emails: Array.isArray(parsed.skipped_emails) ? parsed.skipped_emails : [],
      scan_feedback: Array.isArray(parsed.scan_feedback) ? parsed.scan_feedback : [],
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

function rememberSkipped(store, entry) {
  store.skipped_emails = store.skipped_emails.filter((current) => current.message_id !== entry.message_id);
  store.skipped_emails.push(entry);
  const overflow = store.skipped_emails.length - SKIPPED_EMAILS_LIMIT;
  if (overflow > 0) store.skipped_emails.splice(0, overflow);
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

const clean = (value, max) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

// ---------------------------------------------------------------------------
// Email analysis — whom a mail is for and what is new in it
// ---------------------------------------------------------------------------

const normalizeKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/** The mailbox owner's names and addresses; empty for exports that predate them. */
function mailboxIdentity(snapshot) {
  const mailbox = (snapshot && snapshot.mailbox) || {};
  const collect = (values) => new Set((Array.isArray(values) ? values : []).map(normalizeKey).filter(Boolean));
  return { names: collect(mailbox.names), addresses: collect(mailbox.addresses) };
}

const isMe = (me, person) =>
  Boolean(person) &&
  Boolean(
    (person.address && me.addresses.has(normalizeKey(person.address))) ||
    (person.name && me.names.has(normalizeKey(person.name)))
  );

const peopleOf = (value) =>
  Array.isArray(value) ? value.filter((person) => person && (person.name || person.address)) : [];

/**
 * The user's place in a mail: self (a note to themselves), sender, to, cc,
 * not_listed (reached through a distribution list or BCC), or unknown when
 * the export has no mailbox or recipient data.
 */
function myRole(email, me) {
  if (!me.names.size && !me.addresses.size) return 'unknown';
  if (!Array.isArray(email.to) && !Array.isArray(email.cc)) return 'unknown';
  const to = peopleOf(email.to);
  const cc = peopleOf(email.cc);
  if (isMe(me, { name: email.from_name, address: email.from_address })) {
    const onlyMe = to.length > 0 && cc.length === 0 && to.every((person) => isMe(me, person));
    return onlyMe ? 'self' : 'sender';
  }
  if (to.some((person) => isMe(me, person))) return 'to';
  if (cc.some((person) => isMe(me, person))) return 'cc';
  return 'not_listed';
}

/** "Me (me), Zhang San, +12 more", with the user listed first. */
function describePeople(value, me) {
  const people = peopleOf(value).sort((a, b) => Number(isMe(me, b)) - Number(isMe(me, a)));
  if (!people.length) return undefined;
  const shown = people
    .slice(0, RECIPIENTS_SHOWN)
    .map((person) => `${person.name || person.address}${isMe(me, person) ? ' (me)' : ''}`);
  const hidden = people.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')}, +${hidden} more` : shown.join(', ');
}

// Where the quoted thread starts in a plain-text reply or forward (Outlook, Gmail, Foxmail; en/zh).
const QUOTE_MARKERS = [
  /^[ \t]*-{2,}[ \t]*(Original Message|Forwarded message|原始邮件|邮件原件|原始郵件|轉寄郵件|转发邮件)[ \t]*-{2,}/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  /^[ \t]*(From|发件人|發件人|寄件者)[ \t]*[:：][^\n]*\n[ \t]*(Sent|Date|发送时间|發送時間|日期|时间|時間|寄件日期)[ \t]*[:：]/im,
  /^[ \t]*On [^\n]{4,200}wrote:[ \t]*$/im,
  /^[ \t]*在[^\n]{4,200}写道[:：][ \t]*$/m,
  /^[ \t]*>[^\n]*\n[ \t]*>/m,
];

const clip = (text, max) => {
  const tidy = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy.length > max ? `${tidy.slice(0, max)}…` : tidy;
};

/** Split a mail body into the newest message and the quoted thread below it. */
function splitQuoted(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  let cut = -1;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && (cut === -1 || match.index < cut)) cut = match.index;
  }
  if (cut === -1) return { latest: clip(text, LATEST_MESSAGE_MAX_CHARS), quoted: '' };
  return {
    latest: clip(text.slice(0, cut), LATEST_MESSAGE_MAX_CHARS),
    quoted: clip(text.slice(cut), QUOTED_HISTORY_MAX_CHARS),
  };
}

const AUTOMATED_SENDER =
  /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|bounces?)([._+-]|@)/i;

/** Mailing-list or machine-sent mail, judged by its headers or sender address. */
function isAutomated(email) {
  const headers = Array.isArray(email.list_headers) ? email.list_headers.map(String) : [];
  const listed = headers.some(
    (line) =>
      /^list-(id|unsubscribe)\s*:/i.test(line) ||
      /^precedence\s*:\s*(bulk|list|junk)/i.test(line) ||
      (/^auto-submitted\s*:/i.test(line) && !/^auto-submitted\s*:\s*no\b/i.test(line))
  );
  return listed || AUTOMATED_SENDER.test(String(email.from_address || ''));
}

const SUBJECT_PREFIX = /^\s*(re|fw|fwd|aw|wg|tr|rv|sv|回复|回覆|答复|转发|轉寄|轉發)\s*[:：]\s*/i;

/** Subject without reply / forward prefixes; matches a thread when one side has no thread id. */
function threadSubject(subject) {
  let text = String(subject || '').trim();
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(SUBJECT_PREFIX, '').trim();
  }
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/** The todo already made from this mail's thread, open ones first. */
function findThreadTodo(todos, email) {
  const subject = threadSubject(email.subject);
  const matches = todos.filter((todo) => {
    const ref = todo.email_ref;
    if (!ref) return false;
    if (email.thread_id && ref.thread_id) return ref.thread_id === email.thread_id;
    return subject.length >= 4 && threadSubject(ref.subject) === subject;
  });
  matches.sort(
    (a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (b.updated_at || 0) - (a.updated_at || 0)
  );
  const todo = matches[0];
  return todo ? { id: todo.id, title: todo.title, status: todo.status, due_at: todo.due_at ?? null } : undefined;
}

/** Local wall-clock time, so relative deadlines ("明天下班前") resolve against the right day. */
function formatLocal(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (value) => String(value).padStart(2, '0');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${weekday}`;
}

/** Mail of one thread stays together, in the order the thread first appears. */
function groupByThread(emails) {
  const rank = new Map();
  const keyed = emails.map((email, index) => {
    const key = email.thread_id ? `t:${email.thread_id}` : `i:${index}`;
    if (!rank.has(key)) rank.set(key, rank.size);
    return { email, index, rank: rank.get(key) };
  });
  keyed.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return keyed.map((entry) => entry.email);
}

function presentEmail(email, me, todos) {
  const { latest, quoted } = splitQuoted(email.body_preview);
  return {
    message_id: email.message_id,
    subject: email.subject,
    from_name: email.from_name,
    from_address: email.from_address,
    received_at: email.received_at,
    received_local: formatLocal(email.received_at),
    my_role: myRole(email, me),
    to: describePeople(email.to, me),
    cc: describePeople(email.cc, me),
    automated: isAutomated(email) || undefined,
    importance: email.importance || undefined,
    flagged: email.flagged || undefined,
    thread_id: email.thread_id || undefined,
    thread_todo: findThreadTodo(todos, email),
    latest_message: latest,
    quoted_history: quoted || undefined,
  };
}

function describeMailbox(snapshot) {
  const mailbox = (snapshot && snapshot.mailbox) || {};
  const names = (Array.isArray(mailbox.names) ? mailbox.names : []).filter(Boolean);
  const addresses = (Array.isArray(mailbox.addresses) ? mailbox.addresses : []).filter(
    (address) => /@/.test(address) && !/^\/o=/i.test(address)
  );
  if (!names.length && !addresses.length) {
    return 'Mailbox owner ("me"): unknown — this export has no recipient data (my_role=unknown); judge ownership from the mail text.';
  }
  return `Mailbox owner ("me"): ${[...names, ...addresses].join(', ')}`;
}

function describeFeedback(feedback) {
  return feedback
    .slice(-SCAN_FEEDBACK_SHOWN)
    .reverse()
    .map((entry) => {
      const mail = `"${entry.subject}" from ${entry.from || 'unknown sender'}`;
      return entry.verdict === 'not_mine'
        ? `- NOT the user's todo: ${mail}${entry.owner ? ` (it is ${entry.owner}'s)` : ''}`
        : `- IS the user's todo (an earlier scan skipped it): ${mail}`;
    });
}

const findSnapshotEmail = (messageId) =>
  ((readSnapshot() || {}).emails || []).find((email) => email && email.message_id === messageId);

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
  const ref = params && params.email_ref;
  // The snapshot fills what the agent left out, including the thread id it never sees as required.
  const source = ref && ref.message_id ? findSnapshotEmail(String(ref.message_id)) : undefined;
  const threadId = String((ref && ref.thread_id) || (source && source.thread_id) || '');
  const emailRef = ref
    ? {
        message_id: String(ref.message_id || ''),
        subject: String(ref.subject || (source && source.subject) || ''),
        from: String(ref.from || (source && (source.from_name || source.from_address)) || ''),
        received_at: Number(ref.received_at) || (source && Number(source.received_at)) || Date.now(),
        ...(threadId ? { thread_id: threadId } : {}),
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
  const store = readStore();
  const processed = new Set(store.processed_message_ids);
  const fresh = (snapshot.emails || []).filter((email) => email.message_id && !processed.has(email.message_id));
  const capped = fresh.slice(0, SNAPSHOT_MAX_EMAILS);
  const remaining = fresh.length - capped.length;
  const next = remaining
    ? `${remaining} more unprocessed email(s) remain: handle every email in this batch with todo_create or email_mark_skipped, then call email_snapshot_read again.`
    : 'No more unprocessed emails after this batch.';
  const me = mailboxIdentity(snapshot);
  const batch = groupByThread(capped).map((email) => presentEmail(email, me, store.todos));
  const lines = [
    describeMailbox(snapshot),
    `${capped.length} unprocessed email(s) in this batch, ${(snapshot.emails || []).length} in snapshot, fetched_at=${snapshot.fetched_at}. ${next}`,
  ];
  const corrections = describeFeedback(store.scan_feedback);
  if (corrections.length) {
    lines.push('Corrections the user made to earlier scans — decide similar emails the same way:', ...corrections);
  }
  return `${lines.join('\n')}\n${JSON.stringify(batch, null, 2)}`;
}

async function toolEmailMarkSkipped(params) {
  const decisions = new Map();
  const add = (rawId, reason, owner, note) => {
    const id = String(rawId ?? '').trim();
    if (!id || decisions.has(id)) return;
    decisions.set(id, {
      reason: SKIP_REASONS.includes(reason) ? reason : 'other',
      owner: clean(owner, 60),
      note: clean(note, 200),
    });
  };
  for (const entry of Array.isArray(params && params.emails) ? params.emails : []) {
    if (entry && typeof entry === 'object') add(entry.message_id, entry.reason, entry.owner, entry.note);
  }
  // Older skill versions pass bare ids.
  for (const id of Array.isArray(params && params.message_ids) ? params.message_ids : []) add(id, 'other');
  if (!decisions.size) throw new Error('emails is required');
  if (decisions.size > 100) throw new Error('at most 100 emails per call');
  // Only ids from the current snapshot are accepted, so a mistyped id stays visible to the next scan.
  const known = new Map(
    ((readSnapshot() || {}).emails || []).filter((email) => email && email.message_id).map((e) => [e.message_id, e])
  );
  return withLock((store) => {
    const processed = new Set(store.processed_message_ids);
    const result = { marked: 0, already_processed: 0, unknown: [] };
    const now = Date.now();
    for (const [id, decision] of decisions) {
      const email = known.get(id);
      if (processed.has(id)) result.already_processed += 1;
      else if (!email) result.unknown.push(id);
      else {
        rememberProcessed(store, id);
        processed.add(id);
        rememberSkipped(store, {
          message_id: id,
          subject: String(email.subject || ''),
          from: String(email.from_name || email.from_address || ''),
          received_at: Number(email.received_at) || now,
          ...(email.thread_id ? { thread_id: String(email.thread_id) } : {}),
          reason: decision.reason,
          ...(decision.owner ? { owner: decision.owner } : {}),
          ...(decision.note ? { note: decision.note } : {}),
          by: 'scan',
          at: now,
        });
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
      "List the user's todos. Filter by status ('pending'|'waiting'|'done') and due-date range (epoch ms). Use this before creating tasks to avoid duplicates and to find task ids.",
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
          description:
            'Origin email for dedup/traceability. Missing subject, sender, time and thread are filled from the snapshot.',
          properties: {
            message_id: { type: 'string' },
            subject: { type: 'string' },
            from: { type: 'string' },
            received_at: { type: 'number' },
            thread_id: { type: 'string' },
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
      "Read unprocessed emails from the mailbox snapshot (refreshed automatically when older than 10 minutes). Call this first when scanning emails for tasks. The header names the mailbox owner (the user) and lists the user's corrections of earlier scans; each email carries message_id, subject, sender, received_local, my_role (the user's place in the mail: to / cc / not_listed / sender / self / unknown), to / cc, automated, flagged, thread_todo (an existing todo of the same thread), latest_message (the new text) and quoted_history (older mail in the thread). Returns at most 15 per call: handle each one with todo_create (email_ref) or email_mark_skipped before calling again.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'email_mark_skipped',
    description:
      'Record emails returned by email_snapshot_read that need no new todo for the user, each with a reason, so later scans skip them and the user can review the decision. Pass message_id values verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        emails: {
          type: 'array',
          description: 'One entry per email (max 100 per call).',
          items: {
            type: 'object',
            properties: {
              message_id: { type: 'string' },
              reason: {
                type: 'string',
                enum: SKIP_REASONS,
                description:
                  "not_mine: the ask is someone else's; fyi: for information, nothing to do; automated: newsletter, notification or report; tracked: the thread already has a todo; other.",
              },
              owner: { type: 'string', description: 'For not_mine: whose task it is, e.g. "张三".' },
              note: { type: 'string', description: 'One short line on why, in the email language.' },
            },
            required: ['message_id', 'reason'],
          },
        },
      },
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
