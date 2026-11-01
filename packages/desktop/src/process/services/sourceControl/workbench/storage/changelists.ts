import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChangelistChange, ChangelistMutation, ChangelistState } from '@/common/types/sourceControl/storageTypes';
import { idSchema, MAX_FILES, nameSchema, readJson, type StorageContext, validatePath, writeJson } from './core';

const stateSchema = z.object({
  lists: z
    .array(z.object({ id: idSchema, name: nameSchema, comment: z.string().max(4000).optional() }))
    .min(1)
    .max(200),
  activeId: idSchema,
  assignments: z.record(z.string(), idSchema),
});
const keySchema = z.string().min(1).max(32768);
const mutationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      name: nameSchema,
      comment: z.string().max(4000).optional(),
      makeActive: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('edit'), id: idSchema, name: nameSchema, comment: z.string().max(4000).optional() })
    .strict(),
  z.object({ kind: z.enum(['remove', 'activate']), id: idSchema }).strict(),
  z.object({ kind: z.literal('move'), id: idSchema, keys: z.array(keySchema).max(MAX_FILES) }).strict(),
]);

/**
 * Lists only group changes, so a damaged store must not take the changes panel down with it. The file is kept beside
 * the new one because the list names in it cannot be rebuilt. Failing to read the file at all still surfaces.
 */
async function setAsideDamagedStore(context: StorageContext, file: string): Promise<void> {
  const copy = path.join(context.dir, `changelists.damaged-${context.now()}.json`);
  await rename(file, copy);
  context.log(`Changelists could not be read and were reset; the old file is at ${copy}`);
}

export async function readChangelists(context: StorageContext): Promise<ChangelistState> {
  const initial: ChangelistState = {
    lists: [{ id: 'default', name: 'Changes' }],
    activeId: 'default',
    assignments: {},
  };
  const file = path.join(context.dir, 'changelists.json');
  let stored: unknown;
  try {
    stored = await readJson<unknown>(file, initial);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    await setAsideDamagedStore(context, file);
    return initial;
  }
  const value = stateSchema.safeParse(stored);
  if (value.success && value.data.lists.some((list) => list.id === value.data.activeId)) {
    return value.data as ChangelistState;
  }
  await setAsideDamagedStore(context, file);
  return initial;
}

export async function syncChangelists(context: StorageContext, changes: ChangelistChange[]): Promise<ChangelistState> {
  const parsed = z
    .array(z.object({ key: keySchema, path: z.string() }).strict())
    .max(MAX_FILES)
    .parse(changes);
  parsed.forEach((change) => validatePath(change.path));
  const state = await readChangelists(context);
  const keys = new Set(parsed.map((change) => change.key));
  if (keys.size !== parsed.length) throw new Error('Duplicate changelist keys');
  const assignments = new Map(Object.entries(state.assignments));
  for (const key of keys) {
    if (!state.lists.some((list) => list.id === assignments.get(key))) assignments.set(key, state.activeId);
  }
  for (const key of assignments.keys()) if (!keys.has(key)) assignments.delete(key);
  state.assignments = Object.fromEntries(assignments);
  await writeJson(path.join(context.dir, 'changelists.json'), state);
  return state;
}

export async function mutateChangelists(context: StorageContext, value: ChangelistMutation): Promise<ChangelistState> {
  const input = mutationSchema.parse(value);
  const state = await readChangelists(context);
  if (input.kind === 'create') {
    if (state.lists.length >= 200) throw new Error('Changelist limit exceeded');
    const list = { id: randomUUID(), name: input.name, comment: input.comment };
    state.lists.push(list);
    if (input.makeActive) state.activeId = list.id;
  } else {
    const list = state.lists.find((candidate) => candidate.id === input.id);
    if (!list) throw new Error('Unknown changelist');
    if (input.kind === 'edit') {
      list.name = input.name;
      list.comment = input.comment;
    }
    if (input.kind === 'activate') state.activeId = list.id;
    if (input.kind === 'remove') {
      if (state.lists.length === 1) throw new Error('Cannot remove the final changelist');
      state.lists = state.lists.filter((candidate) => candidate.id !== list.id);
      if (state.activeId === list.id) state.activeId = state.lists[0].id;
      state.assignments = Object.fromEntries(
        Object.entries(state.assignments).map(([key, assigned]) => [
          key,
          assigned === list.id ? state.activeId : assigned,
        ])
      );
    }
    if (input.kind === 'move') {
      const entries = new Map(Object.entries(state.assignments));
      for (const key of input.keys) {
        if (!entries.has(key)) throw new Error('Unknown change key; refresh before moving changes');
        entries.set(key, list.id);
      }
      state.assignments = Object.fromEntries(entries);
    }
  }
  await writeJson(path.join(context.dir, 'changelists.json'), state);
  return state;
}
