import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryDistillResult,
  MemoryEntry,
  MemoryInput,
  MemoryProject,
  MemoryRecall,
  MemorySettings,
} from '@/common/types/memory';
import { distillPrompt, parseDistilled } from './distill';
import { HiddenTurnError, startHiddenTurn, type HiddenTurn, type Request } from './hiddenTurn';
import { memoryDirectory } from './paths';
import { rank, recallBlock, selectRecall } from './search';
import { INDEX_FILE, listMemories, removeMemory, saveMemory } from './store';

export type MemoryServiceOptions = {
  request: Request;
  /** The platform config folder aionrs uses (Electron's `appData`). */
  appData: string;
  /** Woody's own JSON state: settings and which conversations were distilled. */
  statePath: string;
  trash: (target: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** A conversation is distilled once it has been quiet this long. */
  idleMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
};

type State = {
  version: 1;
  /** Conversations last changed before Woody first ran this are never distilled on their own. */
  baseline: number;
  settings: MemorySettings;
  conversations: Record<string, { distilledAt: number }>;
};

type ConversationRow = {
  id: string;
  type?: string;
  source?: string | null;
  modified_at?: number;
  extra?: Record<string, unknown>;
};

const DEFAULT_SETTINGS: MemorySettings = { autoDistill: true, autoRecall: true };

/** Only the user's own aionrs chats in a workspace: not channels, cron jobs or team members. */
function workspaceOf(row: ConversationRow): string | undefined {
  if (row.type !== 'aionrs') return undefined;
  if (row.source && row.source !== 'aionui') return undefined;
  const extra = row.extra ?? {};
  if (extra.cron_job_id || extra.cronJobId || extra.team_id || extra.teamId) return undefined;
  return typeof extra.workspace === 'string' && extra.workspace.trim() ? extra.workspace : undefined;
}

export function createMemoryService(options: MemoryServiceOptions) {
  const {
    request,
    appData,
    statePath,
    trash,
    env = process.env,
    now = () => Date.now(),
    wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    idleMs = 5 * 60_000,
    intervalMs = 60_000,
    timeoutMs = 10 * 60_000,
  } = options;
  let state: State | undefined;
  const running = new Map<string, HiddenTurn>();
  const given = new Map<string, Set<string>>();
  const workspaces = new Map<string, string | null>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function saveState(): Promise<void> {
    if (!state) return;
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, statePath);
  }
  async function loadState(): Promise<State> {
    if (state) return state;
    try {
      const saved = JSON.parse(await fs.readFile(statePath, 'utf8')) as Partial<State>;
      state = {
        version: 1,
        baseline: typeof saved.baseline === 'number' ? saved.baseline : now(),
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        conversations: saved.conversations ?? {},
      };
    } catch {
      // First run: everything that happened before now is left alone.
      state = { version: 1, baseline: now(), settings: { ...DEFAULT_SETTINGS }, conversations: {} };
      await saveState();
    }
    return state;
  }

  const directoryFor = (workspace: string) => memoryDirectory(workspace, appData, env);

  async function conversationWorkspace(conversationId: string): Promise<string | undefined> {
    if (workspaces.has(conversationId)) return workspaces.get(conversationId) ?? undefined;
    const row = await request<ConversationRow>('GET', `/api/conversations/${encodeURIComponent(conversationId)}`);
    const workspace = workspaceOf(row);
    workspaces.set(conversationId, workspace ?? null);
    return workspace;
  }

  async function list(workspace: string): Promise<MemoryProject> {
    const directory = directoryFor(workspace);
    return { workspace, directory, entries: await listMemories(directory) };
  }

  async function search(workspace: string, query: string): Promise<MemoryEntry[]> {
    const entries = await listMemories(directoryFor(workspace));
    return query.trim() ? rank(entries, query).map((item) => item.entry) : entries;
  }

  const save = (workspace: string, input: MemoryInput) => saveMemory(directoryFor(workspace), input);
  const remove = (workspace: string, file: string) => removeMemory(directoryFor(workspace), file, trash);

  async function distill(conversationId: string): Promise<MemoryDistillResult> {
    const current = await loadState();
    if (running.has(conversationId)) throw new Error('Memories are already being distilled from this conversation');
    const workspace = await conversationWorkspace(conversationId);
    if (!workspace) throw new Error('Only aionrs conversations with a workspace keep memories');
    const directory = directoryFor(workspace);
    const entries = await listMemories(directory);
    const index = await fs.readFile(path.join(directory, INDEX_FILE), 'utf8').catch(() => '');
    const turn = startHiddenTurn(request, conversationId, distillPrompt(index), { wait, timeoutMs, now });
    running.set(conversationId, turn);
    try {
      const answer = await turn.answer;
      const memories = parseDistilled(answer, new Set(entries.map((entry) => entry.file)));
      const result: MemoryDistillResult = { added: 0, updated: 0 };
      for (const item of memories) {
        const { action, slug, ...input } = item;
        // One at a time: every save rewrites MEMORY.md.
        // eslint-disable-next-line no-await-in-loop
        await saveMemory(directory, input, slug);
        result[action === 'add' ? 'added' : 'updated']++;
      }
      return result;
    } finally {
      running.delete(conversationId);
      // The hidden turn itself changed the conversation; only later activity counts as new.
      const row = await request<ConversationRow>(
        'GET',
        `/api/conversations/${encodeURIComponent(conversationId)}`
      ).catch((): undefined => undefined);
      current.conversations[conversationId] = { distilledAt: row?.modified_at ?? now() };
      await saveState().catch((): void => {});
    }
  }

  async function recall(conversationId: string, text: string): Promise<MemoryRecall> {
    // The user is writing: a distill running in this conversation gives way.
    const turn = running.get(conversationId);
    if (turn) await turn.cancel();
    const current = await loadState();
    if (!current.settings.autoRecall || !text.trim()) return { block: '', names: [] };
    try {
      const workspace = await conversationWorkspace(conversationId);
      if (!workspace) return { block: '', names: [] };
      const seen = given.get(conversationId) ?? new Set<string>();
      const chosen = selectRecall(await listMemories(directoryFor(workspace)), text, seen);
      for (const entry of chosen) seen.add(entry.file);
      given.set(conversationId, seen);
      return { block: recallBlock(chosen), names: chosen.map((entry) => entry.name) };
    } catch {
      // Memory is a help, never a reason a message cannot be sent.
      return { block: '', names: [] };
    }
  }

  /** One scheduler step: distill the most recent conversation that has gone quiet. */
  async function tick(): Promise<void> {
    if (ticking || running.size) return;
    ticking = true;
    try {
      const current = await loadState();
      if (!current.settings.autoDistill) return;
      const page = await request<{ items?: ConversationRow[] }>('GET', '/api/conversations?limit=30');
      const candidate = (page.items ?? []).find((row) => {
        const modified = row.modified_at ?? 0;
        return (
          workspaceOf(row) !== undefined &&
          modified >= current.baseline &&
          now() - modified >= idleMs &&
          modified > (current.conversations[row.id]?.distilledAt ?? 0)
        );
      });
      if (!candidate) return;
      workspaces.set(candidate.id, workspaceOf(candidate) ?? null);
      await distill(candidate.id).catch((error: unknown) => {
        // A busy conversation is tried again on a later tick; any other failure waits
        // for new activity, so a model that cannot answer in JSON is not asked every minute.
        if (error instanceof HiddenTurnError && (error.reason === 'busy' || error.reason === 'cancelled')) {
          delete current.conversations[candidate.id];
          void saveState().catch((): void => {});
        }
      });
    } catch {
      // The backend may be restarting; the next tick tries again.
    } finally {
      ticking = false;
    }
  }

  return {
    list,
    search,
    save,
    remove,
    distill,
    recall,
    tick,
    directoryFor,
    workspaceOf: conversationWorkspace,
    async getSettings(): Promise<MemorySettings> {
      return { ...(await loadState()).settings };
    },
    async setSettings(settings: MemorySettings): Promise<MemorySettings> {
      const current = await loadState();
      current.settings = { autoDistill: settings.autoDistill === true, autoRecall: settings.autoRecall === true };
      await saveState();
      return { ...current.settings };
    },
    start(): void {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async dispose(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.all([...running.values()].map((turn) => turn.cancel()));
    },
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
