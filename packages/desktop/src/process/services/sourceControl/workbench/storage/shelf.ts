import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  ShelfApplyInput,
  ShelfApplyResult,
  ShelfCreateInput,
  ShelfItem,
  ShelfPatchInput,
} from '@/common/types/sourceControl/storageTypes';
import {
  atomicWrite,
  boundedRead,
  idSchema,
  MAX_FILES,
  MAX_PATCH,
  nameSchema,
  pathsSchema,
  readJson,
  safeFile,
  type StorageContext,
  writeJson,
} from './core';
import { captureHistory, emptyStatus } from './history';
import { parsePatch, type PatchSection, selectSections } from './patch';

const shelfSchema = z.object({
  id: idSchema,
  name: nameSchema,
  createdAt: z.number(),
  deleted: z.boolean(),
  files: z
    .array(
      z.object({
        path: z.string(),
        oldPath: z.string().optional(),
        status: z.enum(['A', 'M', 'D', 'R']),
        binary: z.boolean(),
      })
    )
    .max(MAX_FILES),
});
const shelfPath = (context: StorageContext, id: string) =>
  path.join(context.dir, 'shelf', `${idSchema.parse(id)}.patch`);
const metadataPath = (context: StorageContext) => path.join(context.dir, 'shelf.json');

export async function listShelves(context: StorageContext): Promise<ShelfItem[]> {
  return z
    .array(shelfSchema)
    .max(2000)
    .parse(await readJson<unknown>(metadataPath(context), []))
    .toSorted((a: ShelfItem, b: ShelfItem): number => b.createdAt - a.createdAt) as ShelfItem[];
}

export async function readShelf(context: StorageContext, id: string): Promise<{ item: ShelfItem; patch: string }> {
  idSchema.parse(id);
  const item = (await listShelves(context)).find((candidate) => candidate.id === id);
  if (!item) throw new Error('Shelf not found');
  const patch = (await boundedRead(shelfPath(context, id), MAX_PATCH)).toString('utf8');
  const files = parsePatch(patch).map((section) => section.file);
  if (JSON.stringify(files) !== JSON.stringify(item.files))
    throw new Error('Shelf metadata does not match its durable patch');
  return { item, patch };
}

async function saveShelf(context: StorageContext, name: string, patch: string): Promise<ShelfItem> {
  const sections = parsePatch(patch);
  if (sections.length > MAX_FILES) throw new Error('Shelf file limit exceeded');
  const items = await listShelves(context);
  if (items.length >= 2000) throw new Error('Shelf limit exceeded');
  const item: ShelfItem = {
    id: randomUUID(),
    name: nameSchema.parse(name),
    createdAt: context.now(),
    deleted: false,
    files: sections.map((section) => section.file),
  };
  // The patch is flushed before metadata publishes it; rollback may start only after both writes finish.
  await atomicWrite(shelfPath(context, item.id), patch);
  await writeJson(metadataPath(context), [...items, item]);
  return item;
}

async function validateFiles(context: StorageContext, sections: PatchSection[]): Promise<void> {
  for (const section of sections) {
    await safeFile(context.root, section.file.path);
    if (section.file.oldPath) await safeFile(context.root, section.file.oldPath);
  }
}

export async function createShelf(context: StorageContext, input: ShelfCreateInput): Promise<ShelfItem> {
  const parsed = z
    .object({ name: nameSchema, paths: pathsSchema, rollback: z.boolean().optional() })
    .strict()
    .parse(input);
  for (const relative of parsed.paths) await safeFile(context.root, relative);
  const indexFile = path.join(context.dir, `shelf-index-${randomUUID()}`);
  let patch: string;
  try {
    const head = await context.git(context.root, ['rev-parse', '--verify', 'HEAD'], true);
    await context.git(context.root, head.code === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], false, {
      indexFile,
    });
    await context.git(context.root, ['add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], false, {
      indexFile,
      input: Buffer.from(`${parsed.paths.join('\0')}\0`),
    });
    patch = (
      await context.git(
        context.root,
        [
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          ...(head.code === 0 ? ['HEAD'] : []),
          '--',
          ...parsed.paths,
        ],
        false,
        { indexFile, maxBuffer: MAX_PATCH }
      )
    ).stdout;
  } finally {
    await rm(indexFile, { force: true });
    await rm(`${indexFile}.lock`, { force: true });
  }
  if (!patch) throw new Error('Selected files contain no changes to shelve');
  const sections = parsePatch(patch);
  if (sections.some((section) => !parsed.paths.includes(section.file.path)))
    throw new Error('Shelf selection expanded beyond the explicit files');
  await validateFiles(context, sections);
  const item = await saveShelf(context, parsed.name, patch);
  if (parsed.rollback) {
    try {
      await context.git(context.root, ['apply', '--reverse', '--check', '--whitespace=nowarn', '-'], false, {
        input: Buffer.from(patch),
      });
      await validateFiles(context, sections);
      // Worktree-only apply leaves the real index, including partial staging, byte-for-byte unchanged.
      await context.git(context.root, ['apply', '--reverse', '--whitespace=nowarn', '-'], false, {
        input: Buffer.from(patch),
      });
    } catch (error) {
      context.log(`[GitStorage] Shelf rollback failed; patch retained: ${item.id}`);
      throw new Error(`Shelf saved but rollback failed; recovery shelf: ${item.id}`, { cause: error });
    }
  }
  return item;
}

export async function updateShelf(
  context: StorageContext,
  id: string,
  change: { name?: string; deleted?: boolean; permanently?: boolean }
): Promise<void> {
  idSchema.parse(id);
  const items = await listShelves(context);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error('Shelf not found');
  if (change.permanently) {
    await writeJson(
      metadataPath(context),
      items.filter((candidate) => candidate.id !== id)
    );
    await rm(shelfPath(context, id), { force: true });
  } else {
    if (change.name !== undefined) item.name = nameSchema.parse(change.name);
    if (change.deleted !== undefined) item.deleted = change.deleted;
    await writeJson(metadataPath(context), items);
  }
}

export async function exportShelf(context: StorageContext, input: ShelfPatchInput): Promise<string> {
  const parsed = z.object({ id: idSchema, paths: pathsSchema.optional() }).strict().parse(input);
  const shelf = await readShelf(context, parsed.id);
  return selectSections(parsePatch(shelf.patch), parsed.paths)
    .map((section) => section.patch)
    .join('');
}

export async function importShelf(context: StorageContext, input: { name: string; patch: string }): Promise<ShelfItem> {
  const parsed = z
    .object({ name: nameSchema, patch: z.string().max(MAX_PATCH) })
    .strict()
    .parse(input);
  const sections = parsePatch(parsed.patch);
  await validateFiles(context, sections);
  await context.git(context.root, ['apply', '--numstat', '-z', '-'], false, { input: Buffer.from(parsed.patch) });
  return saveShelf(context, parsed.name, parsed.patch);
}

export async function applyShelf(context: StorageContext, input: ShelfApplyInput): Promise<ShelfApplyResult> {
  const parsed = z
    .object({ id: idSchema, paths: pathsSchema.optional(), removeApplied: z.boolean().optional() })
    .strict()
    .parse(input);
  const shelf = await readShelf(context, parsed.id);
  const sections = parsePatch(shelf.patch);
  const selected = selectSections(sections, parsed.paths);
  await validateFiles(context, selected);
  const patch = selected.map((section) => section.patch).join('');
  const checked = await context.git(context.root, ['apply', '--check', '--whitespace=nowarn', '-'], true, {
    input: Buffer.from(patch),
  });
  if (checked.code !== 0) return { applied: false, conflicts: true, message: checked.stderr.slice(0, 2000) };
  const paths = [
    ...new Set(
      selected.flatMap((section) => [section.file.path, ...(section.file.oldPath ? [section.file.oldPath] : [])])
    ),
  ];
  const [recovery] = await captureHistory(
    context,
    { paths, label: `Before applying shelf ${shelf.item.id}` },
    emptyStatus(),
    true,
    'recovery'
  );
  await validateFiles(context, selected);
  const applied = await context.git(context.root, ['apply', '--whitespace=nowarn', '-'], true, {
    input: Buffer.from(patch),
  });
  if (applied.code !== 0)
    return { applied: false, conflicts: true, message: applied.stderr.slice(0, 2000), recoveryId: recovery.id };
  if (parsed.removeApplied) {
    if (selected.length === sections.length) await updateShelf(context, parsed.id, { deleted: true });
    else {
      // Keep the original full patch as a recovery record; publish the unapplied remainder separately.
      const selectedPaths = new Set(selected.map((section) => section.file.path));
      const remaining = sections
        .filter((section) => !selectedPaths.has(section.file.path))
        .map((section) => section.patch)
        .join('');
      await saveShelf(context, shelf.item.name, remaining);
      await updateShelf(context, parsed.id, { deleted: true });
    }
  }
  return { applied: true, conflicts: false, recoveryId: recovery.id };
}
