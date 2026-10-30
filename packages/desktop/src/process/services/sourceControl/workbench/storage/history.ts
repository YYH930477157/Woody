import { randomUUID } from 'node:crypto';
import { opendir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  HistoryCaptureInput,
  HistoryContent,
  HistoryEvent,
  HistoryQuery,
  HistoryReadInput,
  HistoryRestoreInput,
  HistoryRestoreResult,
} from '@/common/types/sourceControl/storageTypes';
import {
  atomicWrite,
  boundedRead,
  currentFile,
  digest,
  idSchema,
  MAX_CAPTURE,
  MAX_FILE,
  MAX_FILES,
  nameSchema,
  pathsSchema,
  readJson,
  safeFile,
  type StorageContext,
  validatePath,
  writeJson,
} from './core';

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const eventSchema = z.object({
  id: idSchema,
  createdAt: z.number(),
  kind: z.enum(['save', 'external', 'label', 'recovery', 'restore']),
  label: z.string().max(500).optional(),
  files: z
    .array(z.object({ path: z.string(), before: hashSchema.nullable().optional(), after: hashSchema.nullable() }))
    .max(MAX_FILES),
});
const eventsSchema = z.array(eventSchema).max(20000);
export type CaptureStatus = { limited: boolean; errors: string[]; fileCount: number };
export const emptyStatus = (): CaptureStatus => ({ limited: false, errors: [], fileCount: 0 });
const report = (context: StorageContext, status: CaptureStatus, message: string) => {
  const bounded = message.slice(0, 500);
  if (status.errors.length < 20) status.errors.push(bounded);
  context.log(`[GitStorage] ${bounded}`);
};

export async function historyEvents(context: StorageContext): Promise<HistoryEvent[]> {
  return eventsSchema.parse(await readJson<unknown>(path.join(context.dir, 'history.json'), [])) as HistoryEvent[];
}

async function saveEvents(context: StorageContext, events: HistoryEvent[]): Promise<void> {
  // Recovery entries remain until the user's recovery window expires, like other history.
  const retained = events.filter((event) => event.createdAt >= context.now() - 5 * 86400_000);
  if (retained.length > 20000) throw new Error('Local history event limit reached');
  await writeJson(path.join(context.dir, 'history.json'), retained);
  const used = new Set(
    retained.flatMap((event) =>
      event.files.flatMap((file) => [file.before, file.after].filter((hash): hash is string => !!hash))
    )
  );
  const content = path.join(context.dir, 'content');
  const entries = await readdir(content).catch((error: unknown): Promise<string[]> | string[] => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries)
    if (/^[0-9a-f]{64}$/.test(entry) && !used.has(entry)) await rm(path.join(content, entry), { force: true });
}

async function putBlob(context: StorageContext, bytes: Buffer | null): Promise<string | null> {
  if (bytes === null) return null;
  const hash = digest(bytes);
  await atomicWrite(path.join(context.dir, 'content', hash), bytes);
  return hash;
}

async function readBlob(context: StorageContext, hash: string | null): Promise<Buffer | null> {
  if (hash === null) return null;
  hashSchema.parse(hash);
  const bytes = await boundedRead(path.join(context.dir, 'content', hash), MAX_FILE);
  if (digest(bytes) !== hash) throw new Error('Local history content failed integrity validation');
  return bytes;
}

function content(bytes: Buffer | null): HistoryContent {
  return bytes === null
    ? { exists: false, fingerprint: 'missing', size: 0 }
    : { exists: true, fingerprint: digest(bytes), contentBase64: bytes.toString('base64'), size: bytes.length };
}

/** Bounded directory walk, independent of Git and resilient to inaccessible subdirectories. */
export async function enumerateFiles(context: StorageContext, status: CaptureStatus): Promise<string[]> {
  const files: string[] = [];
  const queue = [''];
  let visited = 0;
  while (queue.length && !status.limited) {
    const relative = queue.shift()!;
    try {
      const directory = relative ? await safeFile(context.root, relative) : context.root;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++visited > MAX_FILES) {
          status.limited = true;
          break;
        }
        if (entry.name.toLowerCase() === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        try {
          validatePath(child);
        } catch {
          continue;
        }
        // Never recursively record the application's own store if the registered project is its parent.
        const absolute = path.join(context.root, child);
        if (context.dir === absolute || context.dir.startsWith(`${absolute}${path.sep}`)) continue;
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile()) files.push(child);
      }
    } catch (error) {
      report(context, status, `Unable to enumerate ${relative || '.'}: ${String(error)}`);
    }
  }
  if (status.limited) report(context, status, `Local history enumeration reached the ${MAX_FILES} entry limit`);
  return files;
}

/** Capture readable files; only ENOENT creates a deleted state. No error is silently mapped to empty bytes. */
export async function captureHistory(
  context: StorageContext,
  input: HistoryCaptureInput = {},
  status = emptyStatus(),
  force = false,
  kind?: HistoryEvent['kind']
): Promise<HistoryEvent[]> {
  const parsed = z
    .object({
      paths: pathsSchema.optional(),
      label: nameSchema.optional(),
      kind: z.enum(['save', 'external', 'label']).optional(),
    })
    .strict()
    .parse(input);
  const events = await historyEvents(context);
  const latest = new Map<string, string | null>();
  for (const event of events) for (const file of event.files) latest.set(file.path, file.after);
  const enumerated = parsed.paths ?? (await enumerateFiles(context, status));
  const selected = parsed.paths ?? [...new Set([...enumerated, ...latest.keys()])].slice(0, MAX_FILES);
  const files: HistoryEvent['files'] = [];
  let total = 0;
  for (const relative of selected) {
    try {
      const bytes = await currentFile(context, relative);
      total += bytes?.length ?? 0;
      if (total > MAX_CAPTURE) {
        status.limited = true;
        report(context, status, 'Local history capture reached its byte limit');
        break;
      }
      status.fileCount++;
      const after = bytes === null ? null : digest(bytes);
      const snapshot = force || parsed.kind === 'label';
      if (!snapshot && latest.get(relative) === after) continue;
      if (!snapshot && after === null && !latest.has(relative)) continue;
      await putBlob(context, bytes);
      files.push({ path: relative, before: latest.get(relative), after });
    } catch (error) {
      if (force) throw error;
      report(context, status, `Unable to record ${relative}: ${String(error)}`);
    }
  }
  if (!files.length && !parsed.label) {
    await saveEvents(context, events);
    return [];
  }
  if (force && files.length !== selected.length)
    throw new Error('Cannot capture complete recovery within storage limits');
  const event: HistoryEvent = {
    id: randomUUID(),
    createdAt: context.now(),
    kind: kind ?? parsed.kind ?? 'save',
    ...(parsed.label ? { label: parsed.label } : {}),
    files,
  };
  await saveEvents(context, [...events, event]);
  return [event];
}

export async function listHistory(context: StorageContext, query: HistoryQuery = {}): Promise<HistoryEvent[]> {
  const parsed = z
    .object({ path: z.string().optional(), limit: z.number().int().min(1).max(500).optional() })
    .strict()
    .parse(query);
  if (parsed.path) validatePath(parsed.path);
  const events = await historyEvents(context);
  return events
    .filter(
      (event) =>
        event.createdAt >= context.now() - 5 * 86400_000 &&
        (!parsed.path ||
          event.files.some((file) => file.path === parsed.path || file.path.startsWith(`${parsed.path}/`)))
    )
    .toReversed()
    .slice(0, parsed.limit ?? 200);
}

async function selectedEvent(context: StorageContext, id: string): Promise<HistoryEvent> {
  idSchema.parse(id);
  const event = (await historyEvents(context)).find((candidate) => candidate.id === id);
  if (!event) throw new Error('Local history event not found');
  return event;
}

export async function readHistory(context: StorageContext, input: HistoryReadInput): Promise<HistoryContent> {
  validatePath(input.path);
  const event = await selectedEvent(context, input.id);
  const file = event.files.find((candidate) => candidate.path === input.path);
  if (!file) throw new Error('File was not recorded in this history event');
  return content(await readBlob(context, file.after));
}

export async function compareHistory(context: StorageContext, input: HistoryReadInput) {
  return { before: await readHistory(context, input), current: content(await currentFile(context, input.path)) };
}

export async function restoreHistory(
  context: StorageContext,
  input: HistoryRestoreInput
): Promise<HistoryRestoreResult> {
  const parsed = z
    .object({
      id: idSchema,
      paths: pathsSchema.optional(),
      expected: z.record(z.string(), z.union([hashSchema, z.literal('missing')])),
    })
    .strict()
    .parse(input);
  if (Object.keys(parsed.expected).length > MAX_FILES) throw new Error('Restore payload exceeds file limit');
  const event = await selectedEvent(context, parsed.id);
  const selected = parsed.paths ?? event.files.map((file) => file.path);
  if (!selected.length) throw new Error('History event has no file content');
  const desired = new Map<string, Buffer | null>();
  let total = 0;
  for (const relative of selected) {
    validatePath(relative);
    const file = event.files.find((candidate) => candidate.path === relative);
    if (!file) throw new Error('Selected file was not recorded in this history event');
    const current = content(await currentFile(context, relative));
    if (parsed.expected[relative] !== current.fingerprint)
      throw new Error('File changed since the restore preview; compare again');
    const bytes = await readBlob(context, file.after);
    total += bytes?.length ?? 0;
    if (total > MAX_CAPTURE) throw new Error('Restore content exceeds byte limit');
    desired.set(relative, bytes);
  }
  const [recovery] = await captureHistory(
    context,
    { paths: selected, label: `Before restore ${event.id}` },
    emptyStatus(),
    true,
    'recovery'
  );
  try {
    for (const [relative, bytes] of desired) {
      // Recheck immediately before each mutation, including changes by external editors.
      if (content(await currentFile(context, relative)).fingerprint !== parsed.expected[relative])
        throw new Error('File changed during restore');
      await context.writeFile(context, relative, bytes);
    }
    await captureHistory(context, { paths: selected }, emptyStatus(), true, 'restore');
  } catch (error) {
    context.log(`[GitStorage] Restore failed; recovery retained: ${recovery.id}`);
    throw new Error(`Restore failed; recovery retained: ${recovery.id}`, { cause: error });
  }
  return { restored: selected, recoveryId: recovery.id };
}
