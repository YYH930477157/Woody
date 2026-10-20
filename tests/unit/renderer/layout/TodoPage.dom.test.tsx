import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TodoPage from '@/renderer/pages/todo';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  create: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.error } };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    todo: {
      list: { invoke: mocks.list },
      status: { invoke: mocks.status },
      create: { invoke: mocks.create },
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
