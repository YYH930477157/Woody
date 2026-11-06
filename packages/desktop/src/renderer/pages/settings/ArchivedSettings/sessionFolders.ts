/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionFilesRef, SessionFolderState } from '@/common/adapter/ipcBridge';
import { scopeToToken } from '@/common/adapter/sidebarMapper';
import type { TChatConversation } from '@/common/config/storage';
import type { SidebarItemsResponse, SidebarResponse, SidebarScope } from '@/common/types/sidebar';

const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

/** What a delete removes: single conversations, and whole archived projects. */
export type ArchivedDeletion = { conversationIds: string[]; projectIds: string[] };

export type SessionFolderDeps = {
  listActive: (params: {
    cursor?: string;
    limit: number;
  }) => Promise<{ items: TChatConversation[]; has_more: boolean }>;
  getArchived: (params: { archived: true; limit: number }) => Promise<SidebarResponse>;
  getArchivedItems: (params: {
    scope: string;
    cursor?: string;
    limit: number;
    archived: true;
  }) => Promise<SidebarItemsResponse>;
  inspect: (params: { dirs: string[] }) => Promise<SessionFolderState[]>;
};

/** The chat folder a conversation recorded at creation, if it has a well-formed one. */
export function readSessionFiles(conversation: TChatConversation): SessionFilesRef | undefined {
  const value = (conversation.extra as { session_files?: unknown } | undefined)?.session_files;
  if (!value || typeof value !== 'object') return undefined;
  const { dir, work_dir, output_dir } = value as Record<string, unknown>;
  if (typeof dir !== 'string' || !dir || typeof work_dir !== 'string' || typeof output_dir !== 'string') {
    return undefined;
  }
  return { dir, work_dir, output_dir };
}

/**
 * Folders that only the deleted conversations use. A fork copies its parent's `extra`, so a
 * folder any remaining conversation still points at is never offered. Paths are compared
 * without case, which can only ever withhold a folder, never offer a shared one.
 */
export function foldersOnlyUsedBy(deleting: TChatConversation[], keeping: TChatConversation[]): string[] {
  const kept = new Set(
    keeping.map((conversation) => readSessionFiles(conversation)?.dir.toLowerCase()).filter(Boolean)
  );
  const offered = new Map<string, string>();
  for (const conversation of deleting) {
    const dir = readSessionFiles(conversation)?.dir;
    if (dir && !kept.has(dir.toLowerCase())) offered.set(dir.toLowerCase(), dir);
  }
  return [...offered.values()];
}

async function loadActive(deps: SessionFolderDeps): Promise<TChatConversation[]> {
  const conversations: TChatConversation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await deps.listActive({ cursor, limit: PAGE_SIZE });
    conversations.push(...result.items);
    const last = result.items.at(-1);
    if (!result.has_more || !last) return conversations;
    cursor = last.id;
  }
  throw new Error('Too many conversations to check chat folders');
}

type ArchivedGroup = { scope: SidebarScope; conversations: TChatConversation[] };

/** Every archived conversation by group, or `null` when the archive cannot be read in full. */
async function loadArchived(deps: SessionFolderDeps): Promise<ArchivedGroup[] | null> {
  const first = await deps.getArchived({ archived: true, limit: PAGE_SIZE });
  if (first.has_more_groups) return null;
  const groups: ArchivedGroup[] = [];
  for (const group of first.groups) {
    const items = [...group.items];
    let hasMore = group.has_more;
    let cursor = group.next_cursor;
    for (let page = 0; hasMore && cursor; page += 1) {
      if (page >= MAX_PAGES) return null;
      const next = await deps.getArchivedItems({
        scope: scopeToToken(group.scope),
        cursor,
        limit: PAGE_SIZE,
        archived: true,
      });
      items.push(...next.items);
      hasMore = next.has_more;
      cursor = next.next_cursor;
    }
    if (hasMore) return null;
    const conversations = items.flatMap((item) => (item.type === 'conversation' ? [item.conversation] : []));
    groups.push({ scope: group.scope, conversations });
  }
  return groups;
}

/**
 * The chat folders a delete would leave unused that still exist on disk. Anything that
 * cannot be read in full yields no folders, so nothing is offered on a guess.
 */
export async function findSessionFolders(
  deletion: ArchivedDeletion,
  deps: SessionFolderDeps
): Promise<SessionFolderState[]> {
  const [active, archived] = await Promise.all([loadActive(deps), loadArchived(deps)]);
  if (!archived) return [];
  const ids = new Set(deletion.conversationIds);
  const projects = new Set(deletion.projectIds);
  const deleting: TChatConversation[] = [];
  const keeping: TChatConversation[] = [...active];
  for (const group of archived) {
    const wholeProject = group.scope.type === 'project' && projects.has(group.scope.project_id);
    for (const conversation of group.conversations) {
      (wholeProject || ids.has(conversation.id) ? deleting : keeping).push(conversation);
    }
  }
  const dirs = foldersOnlyUsedBy(deleting, keeping);
  return dirs.length > 0 ? deps.inspect({ dirs }) : [];
}
