import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/renderer/pages/todo';
import type { ITodoItem, TodoSkippedEmail } from '@/common/types/todo/todoTypes';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  skippedEmails: vi.fn(),
  restoreEmail: vi.fn(),
  dismissEmail: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.error, success: mocks.success } };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    todo: {
      list: { invoke: mocks.list },
      status: { invoke: mocks.status },
      create: { invoke: mocks.create },
      update: { invoke: mocks.update },
      skippedEmails: { invoke: mocks.skippedEmails },
      restoreEmail: { invoke: mocks.restoreEmail },
      dismissEmail: { invoke: mocks.dismissEmail },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

beforeEach(() => {
  // jsdom has no matchMedia; Arco's Form grid subscribes to it.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
  mocks.status.mockResolvedValue(null);
  mocks.create.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.skippedEmails.mockResolvedValue([]);
  mocks.restoreEmail.mockResolvedValue(null);
  mocks.dismissEmail.mockResolvedValue(true);
});

async function openEditor() {
  render(<TodoPage />);
  await screen.findByText('todo.empty');
  fireEvent.click(screen.getByRole('button', { name: 'todo.new' }));
  const title = screen.getByPlaceholderText('todo.titlePlaceholder');
  fireEvent.change(title, { target: { value: 'Reply' } });
  return title;
}

describe('Todo editor saving', () => {
  it.each([
    [undefined, undefined],
    ['todo.editor.statusActive', 'pending'],
    ['todo.editor.statusWaiting', 'waiting'],
  ])('only reopens a finished todo when status is explicitly selected: %s', async (label, status) => {
    mocks.list.mockResolvedValue([
      {
        id: 'finished',
        title: 'Finished item',
        status: 'done',
        source: 'manual',
        created_at: 1,
        updated_at: 1,
        completed_at: 2,
      },
    ]);
    render(<TodoPage />);
    fireEvent.click(await screen.findByText('todo.tab.done'));
    await screen.findByText('Finished item');
    fireEvent.click(screen.getByRole('button', { name: 'todo.edit' }));
    fireEvent.change(await screen.findByDisplayValue('Finished item'), { target: { value: 'Edited item' } });
    if (label) fireEvent.click(screen.getByText(label));
    fireEvent.click(screen.getByRole('button', { name: 'todo.save' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'finished', title: 'Edited item', status })
    );
    expect(mocks.update.mock.calls[0][0]).not.toHaveProperty('completed_at');
  });

  it('ignores repeated Enter presses while a create request is pending', async () => {
    let finishSave!: () => void;
    mocks.create.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSave = resolve;
      })
    );
    const title = await openEditor();

    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 });
    fireEvent.click(screen.getByRole('button', { name: 'todo.save' }));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => finishSave());
    await waitFor(() => expect(screen.queryByPlaceholderText('todo.titlePlaceholder')).toBeNull());
  });

  it('allows retry after a failed create request', async () => {
    mocks.create.mockRejectedValueOnce(new Error('backend unavailable')).mockResolvedValueOnce(undefined);
    const title = await openEditor();

    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'todo.save' })).not.toHaveClass('arco-btn-loading'));
    fireEvent.keyDown(title, { key: 'Enter', keyCode: 13 });

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.error).toHaveBeenCalledWith('todo.opFailed');
  });
});

describe('Email scan corrections', () => {
  const skipped: TodoSkippedEmail = {
    message_id: 'm1',
    subject: 'Weekly report summary',
    from: 'Wang',
    received_at: 1_700_000_000_000,
    reason: 'not_mine',
    owner: 'Zhang',
    note: 'Wang asked Zhang',
    by: 'scan',
    at: 1,
  };

  it('turns a filtered email into a todo', async () => {
    mocks.skippedEmails.mockResolvedValue([skipped]);
    mocks.restoreEmail.mockResolvedValue({ id: 'todo-1', title: 'Weekly report summary' });
    render(<TodoPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'todo.skipped.title' }));
    expect(await screen.findByText('Weekly report summary')).toBeInTheDocument();
    expect(screen.getByText('todo.skipped.reason.not_mine')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'todo.skipped.restore' }));

    expect(await screen.findByDisplayValue('Weekly report summary')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Wang')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'todo.save' }));

    await waitFor(() =>
      expect(mocks.restoreEmail).toHaveBeenCalledWith(
        expect.objectContaining({ message_id: 'm1', title: 'Weekly report summary', requester: 'Wang' })
      )
    );
    expect(mocks.success).toHaveBeenCalledWith('todo.skipped.restored');
  });

  it('removes an email todo the user marks as not theirs', async () => {
    const item: ITodoItem = {
      id: 'todo-7',
      title: 'Summarize the weekly report',
      status: 'pending',
      source: 'email',
      email_ref: { message_id: 'm7', subject: 'Weekly report', from: 'Wang', received_at: 1_700_000_000_000 },
      created_at: 1,
      updated_at: 1,
    };
    mocks.list.mockResolvedValue([item]);
    render(<TodoPage />);

    fireEvent.click(await screen.findByText('Summarize the weekly report'));
    fireEvent.click(await screen.findByRole('button', { name: 'todo.skipped.notMine' }));

    await waitFor(() => expect(mocks.dismissEmail).toHaveBeenCalledWith({ id: 'todo-7' }));
    expect(mocks.success).toHaveBeenCalledWith('todo.skipped.dismissed');
  });
});
