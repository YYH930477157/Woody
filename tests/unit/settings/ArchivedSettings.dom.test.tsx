/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const {
  getMock,
  itemsMock,
  listActiveMock,
  inspectMock,
  trashMock,
  deleteItemMock,
  deleteProjectMock,
  confirmMock,
  warningMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  itemsMock: vi.fn(),
  listActiveMock: vi.fn(),
  inspectMock: vi.fn(),
  trashMock: vi.fn(),
  deleteItemMock: vi.fn(),
  deleteProjectMock: vi.fn(),
  confirmMock: vi.fn(),
  warningMock: vi.fn(),
}));

// Real Arco components; only the imperative dialog and toasts are replaced, since
// `Modal.confirm` renders through its own root that jsdom tests cannot reach.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...actual,
    Modal: { confirm: (config: unknown) => confirmMock(config) },
    Message: { success: vi.fn(), error: vi.fn(), warning: (text: string) => warningMock(text) },
  };
});

// The component reads `ipcBridge` from `@/common`: the sidebar surface, plus the
// active list and chat-folder channels the delete dialog consults.
vi.mock('@/common', () => ({
  ipcBridge: {
    sidebar: {
      get: { invoke: getMock },
      items: { invoke: itemsMock },
      unarchive: { invoke: vi.fn(() => Promise.resolve()) },
      deleteArchivedItem: { invoke: deleteItemMock },
      deleteArchivedProject: { invoke: deleteProjectMock },
    },
    database: { getUserConversations: { invoke: listActiveMock } },
    sessionFiles: { inspect: { invoke: inspectMock }, trash: { invoke: trashMock } },
  },
}));

// Keep the real `scopeToToken` — the token grammar it produces is exactly what
// the paging assertions verify. Only i18n / logos / passthrough shells are mocked.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'count' in opts ? `${key}:${String(opts.count)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}) }));

vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

vi.mock('@/renderer/pages/conversation/utils/conversationAssistantIdentity', () => ({
  resolveConversationLeadingMark: () => ({ kind: 'assistant_fallback' as const }),
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/pages/settings/components/SettingsPageHeader', () => ({
  default: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{actions}</div>
    </div>
  ),
}));

import ArchivedSettings from '@/renderer/pages/settings/ArchivedSettings';

type Conv = { id: string; name: string; created_at: number; extra?: Record<string, unknown> };

const conv = (
  id: string,
  name: string,
  extra?: Record<string, unknown>
): { type: 'conversation'; conversation: Conv } => ({
  type: 'conversation',
  conversation: { id, name, created_at: 1_700_000_000_000, extra },
});

/** A project group with the given items / paging signals. */
const projectGroup = (
  projectId: string,
  name: string,
  items: ReturnType<typeof conv>[],
  hasMore: boolean,
  nextCursor?: string
) => ({
  scope: { type: 'project' as const, project_id: projectId, name },
  items,
  has_more: hasMore,
  next_cursor: nextCursor,
});

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ArchivedSettings />
    </SWRConfig>
  );

describe('ArchivedSettings paging', () => {
  beforeEach(() => {
    getMock.mockReset();
    itemsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('requests the first screen with an explicit page-size limit and the archived flag', async () => {
    getMock.mockResolvedValue({
      groups: [projectGroup('P1', 'Alpha', [conv('c1', 'Chat One')], false)],
      has_more_groups: false,
    });

    renderPage();

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(getMock).toHaveBeenCalledWith({ archived: true, limit: 5 });
    // A fully-loaded group (has_more false) shows no "load more" affordance.
    await screen.findByText('Chat One');
    expect(screen.queryByText('settings.archived.loadMore')).toBeNull();
  });

  it('renders a load-more button only for a group with more archived items', async () => {
    getMock.mockResolvedValue({
      groups: [projectGroup('P1', 'Alpha', [conv('c1', 'Chat One')], true, 'cursor-1')],
      has_more_groups: false,
    });

    renderPage();

    await screen.findByText('Chat One');
    expect(screen.getByText('settings.archived.loadMore')).toBeTruthy();
  });

  it('pages the group via sidebar.items with the derived scope token, appends the window, and clears the button when drained', async () => {
    getMock.mockResolvedValue({
      groups: [projectGroup('P1', 'Alpha', [conv('c1', 'Chat One')], true, 'cursor-1')],
      has_more_groups: false,
    });
    itemsMock.mockResolvedValue({ items: [conv('c2', 'Chat Two')], has_more: false, next_cursor: undefined });

    renderPage();

    fireEvent.click(await screen.findByText('settings.archived.loadMore'));

    await screen.findByText('Chat Two');
    expect(itemsMock).toHaveBeenCalledWith({ scope: 'project:P1', cursor: 'cursor-1', limit: 10, archived: true });
    // Both the first-screen and appended rows are present…
    expect(screen.getByText('Chat One')).toBeTruthy();
    // …and with the group drained, the button is gone.
    await waitFor(() => expect(screen.queryByText('settings.archived.loadMore')).toBeNull());
  });

  it('keeps paging when the appended window still reports more', async () => {
    getMock.mockResolvedValue({
      groups: [projectGroup('P1', 'Alpha', [conv('c1', 'Chat One')], true, 'cursor-1')],
      has_more_groups: false,
    });
    itemsMock.mockResolvedValue({ items: [conv('c2', 'Chat Two')], has_more: true, next_cursor: 'cursor-2' });

    renderPage();

    fireEvent.click(await screen.findByText('settings.archived.loadMore'));

    await screen.findByText('Chat Two');
    // Still more to page: the next click carries the advanced cursor.
    fireEvent.click(screen.getByText('settings.archived.loadMore'));
    await waitFor(() =>
      expect(itemsMock).toHaveBeenLastCalledWith({ scope: 'project:P1', cursor: 'cursor-2', limit: 10, archived: true })
    );
  });
});

type ConfirmConfig = { title: React.ReactNode; content: React.ReactNode; okText: string; onOk: () => Promise<void> };

const folder = (name: string) => ({
  dir: `D:\\repo\\.woody\\chat-files\\${name}`,
  work_dir: `D:\\repo\\.woody\\chat-files\\${name}\\work`,
  output_dir: `D:\\repo\\.woody\\chat-files\\${name}\\output`,
});
const chatsGroup = (items: ReturnType<typeof conv>[]) => ({
  scope: { type: 'chats' as const },
  items,
  has_more: false,
});

describe('ArchivedSettings delete and chat folders', () => {
  const fixFolder = folder('2026-11-06_fix');
  let dialog: ConfirmConfig | undefined;

  beforeEach(() => {
    for (const mock of [
      getMock,
      itemsMock,
      listActiveMock,
      inspectMock,
      trashMock,
      deleteItemMock,
      deleteProjectMock,
      confirmMock,
      warningMock,
    ]) {
      mock.mockReset();
    }
    dialog = undefined;
    // Stand-in for the dialog: show its content in the page and keep its callbacks.
    confirmMock.mockImplementation((config: ConfirmConfig) => {
      dialog = config;
      render(
        <div data-testid='confirm'>
          <div>{config.title}</div>
          <div>{config.content}</div>
        </div>
      );
    });
    listActiveMock.mockResolvedValue({ items: [], total: 0, has_more: false });
    inspectMock.mockImplementation(async ({ dirs }: { dirs: string[] }) => dirs.map((dir) => ({ dir, files: 3 })));
    trashMock.mockImplementation(async ({ dirs }: { dirs: string[] }) => ({ trashed: dirs, failed: [] }));
    deleteItemMock.mockResolvedValue(undefined);
    deleteProjectMock.mockResolvedValue({ teams_deleted: 0, conversations_deleted: 2 });
  });

  afterEach(() => {
    cleanup();
  });

  const archiveWith = (...items: ReturnType<typeof conv>[]) =>
    getMock.mockResolvedValue({ groups: [chatsGroup(items)], has_more_groups: false });

  const openSingleDelete = async () => {
    renderPage();
    await screen.findByText('Chat One');
    fireEvent.click(document.querySelector('.arco-btn-status-danger') as Element);
    await screen.findByTestId('confirm');
  };
  const tick = () => fireEvent.click(screen.getByText(/^settings\.archived\.trashSessionFolders:/));
  const confirm = () => act(() => (dialog as ConfirmConfig).onOk());

  it('offers to move the chat folder to the trash, and does so only after the chat is deleted', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));

    await openSingleDelete();
    expect(screen.getByText('settings.archived.trashSessionFolders:1')).toBeTruthy();
    expect(screen.getByText(/D:\\repo\\\.woody\\chat-files\\2026-11-06_fix/)).toBeTruthy();
    expect(screen.getByText(/settings\.archived\.sessionFolderFiles:3/)).toBeTruthy();
    tick();
    await confirm();

    expect(deleteItemMock).toHaveBeenCalledWith({ item_type: 'conversation', item_id: 'c1' });
    expect(trashMock).toHaveBeenCalledWith({ dirs: [fixFolder.dir] });
    expect(deleteItemMock.mock.invocationCallOrder[0]).toBeLessThan(trashMock.mock.invocationCallOrder[0]);
    expect(warningMock).not.toHaveBeenCalled();
  });

  it('keeps the folder when the box is left unticked', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));

    await openSingleDelete();
    await confirm();

    expect(deleteItemMock).toHaveBeenCalled();
    expect(trashMock).not.toHaveBeenCalled();
  });

  it('keeps the folder when the delete fails, even with the box ticked', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    deleteItemMock.mockRejectedValue(new Error('backend down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await openSingleDelete();
    tick();
    await confirm();

    expect(deleteItemMock).toHaveBeenCalled();
    expect(trashMock).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not offer a folder a remaining chat still uses, such as a fork', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    listActiveMock.mockResolvedValue({
      items: [
        { id: 'fork', name: 'Fork', extra: { session_files: { ...fixFolder, dir: fixFolder.dir.toUpperCase() } } },
      ],
      total: 1,
      has_more: false,
    });

    await openSingleDelete();

    expect(inspectMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/^settings\.archived\.trashSessionFolders:/)).toBeNull();
  });

  it('reads every page of the active list before deciding', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    listActiveMock
      .mockResolvedValueOnce({ items: [{ id: 'a1', name: 'A1', extra: {} }], total: 2, has_more: true })
      .mockResolvedValueOnce({
        items: [{ id: 'a2', name: 'A2', extra: { session_files: fixFolder } }],
        total: 2,
        has_more: false,
      });

    await openSingleDelete();

    expect(listActiveMock).toHaveBeenLastCalledWith({ cursor: 'a1', limit: 100 });
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it('shows the plain dialog when the folder is already gone', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    inspectMock.mockResolvedValue([]);

    await openSingleDelete();

    expect(inspectMock).toHaveBeenCalledWith({ dirs: [fixFolder.dir] });
    expect(screen.queryByText(/^settings\.archived\.trashSessionFolders:/)).toBeNull();
  });

  it('shows the plain dialog when the lookup fails', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    listActiveMock.mockRejectedValue(new Error('backend down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await openSingleDelete();

    expect(screen.queryByText(/^settings\.archived\.trashSessionFolders:/)).toBeNull();
    error.mockRestore();
  });

  it('offers nothing when the archive is too large to read in full', async () => {
    getMock.mockResolvedValue({
      groups: [chatsGroup([conv('c1', 'Chat One', { session_files: fixFolder })])],
      has_more_groups: true,
    });

    await openSingleDelete();

    expect(inspectMock).not.toHaveBeenCalled();
  });

  it('counts the not-yet-loaded rows of a project that is deleted whole', async () => {
    const pagedFolder = folder('2026-11-06_paged');
    getMock.mockResolvedValue({
      groups: [projectGroup('P1', 'Alpha', [conv('c1', 'Chat One', { session_files: fixFolder })], true, 'cursor-1')],
      has_more_groups: false,
    });
    itemsMock.mockResolvedValue({ items: [conv('c2', 'Chat Two', { session_files: pagedFolder })], has_more: false });

    renderPage();
    await screen.findByText('Chat One');
    fireEvent.click(screen.getByText('settings.archived.multiSelect'));
    fireEvent.click(screen.getByText('settings.archived.selectAll'));
    fireEvent.click(screen.getByText('settings.archived.deleteSelected'));
    await screen.findByTestId('confirm');
    expect(itemsMock).toHaveBeenCalledWith({ scope: 'project:P1', cursor: 'cursor-1', limit: 100, archived: true });
    expect(screen.getByText('settings.archived.trashSessionFolders:2')).toBeTruthy();
    tick();
    await confirm();

    expect(deleteProjectMock).toHaveBeenCalledWith({ project_id: 'P1' });
    expect(trashMock).toHaveBeenCalledWith({ dirs: [fixFolder.dir, pagedFolder.dir] });
  });

  it('warns when the trash refuses a folder', async () => {
    archiveWith(conv('c1', 'Chat One', { session_files: fixFolder }));
    trashMock.mockResolvedValue({ trashed: [], failed: [fixFolder.dir] });

    await openSingleDelete();
    tick();
    await confirm();

    expect(warningMock).toHaveBeenCalledWith('settings.archived.trashSessionFoldersFailed:1');
  });
});
