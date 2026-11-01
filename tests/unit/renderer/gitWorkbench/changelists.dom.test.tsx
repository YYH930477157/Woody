import React, { useImperativeHandle } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ read: vi.fn(), sync: vi.fn(), mutate: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    gitStorage: {
      changelistRead: { invoke: api.read },
      changelistSync: { invoke: api.sync },
      changelistMutate: { invoke: api.mutate },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { Changelists, useChangelists } from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/Changelists';
import { deferred } from './fixtures';

const scope = { projectId: 'p', peId: 'e', relativePath: '' };
const text = (key: string) => `conversation.gitWorkbench.storage.${key}`;
const two = {
  activeId: 'default',
  lists: [
    { id: 'default', name: 'Changes' },
    { id: 'later', name: 'Later' },
  ],
  assignments: { a: 'later' },
};
const one = { ...two, lists: [two.lists[0]], assignments: {} };

type Handle = {
  setFilter: (filter: string) => void;
  filter: () => string;
  includes: (key: string) => boolean;
};
type HarnessProps = { selectedKeys?: string[]; disabled?: boolean; changed?: string };
const Harness = React.forwardRef<Handle, HarnessProps>(function Harness(
  { selectedKeys = [], disabled = false, changed = 'a' },
  ref
) {
  const controller = useChangelists(scope, [{ key: changed, path: changed }]);
  useImperativeHandle(ref, () => ({
    setFilter: controller.setFilter,
    filter: () => controller.filter,
    includes: controller.includes,
  }));
  return <Changelists controller={controller} selectedKeys={selectedKeys} disabled={disabled} />;
});

const open = async (state: unknown = two, props: HarnessProps = {}) => {
  api.sync.mockResolvedValue(state);
  api.mutate.mockResolvedValue(state);
  const ref = React.createRef<Handle>();
  const view = render(<Harness ref={ref} {...props} />);
  await screen.findByRole('button', { name: text('newList') });
  return { ref, rerender: (next: HarnessProps) => view.rerender(<Harness ref={ref} {...next} />) };
};
const dialog = () => document.querySelector('.arco-modal') as HTMLElement;
const nameInput = () => screen.getByLabelText(text('name'));
const confirm = () => screen.getByRole('button', { name: 'common.confirm' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => api.read.mockResolvedValue(two));

describe('changelist panel', () => {
  it('asks for a name before creating a list', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));

    expect(confirm()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: 'Next' } });
    expect(confirm()).toBeEnabled();
  });

  it('creates the list and closes the dialog', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));
    fireEvent.change(nameInput(), { target: { value: 'Next' } });
    fireEvent.click(confirm());

    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ scope, request: { kind: 'create', name: 'Next' } }));
    await waitFor(() => expect(dialog()?.closest('.arco-modal-wrapper')).toHaveStyle({ display: 'none' }));
  });

  it('keeps the dialog and the typed name when saving fails', async () => {
    await open();
    api.mutate.mockRejectedValue(new Error('disk full'));
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));
    fireEvent.change(nameInput(), { target: { value: 'Next' } });
    fireEvent.click(confirm());

    expect(await within(dialog()).findByText('disk full')).toBeVisible();
    expect(nameInput()).toHaveValue('Next');
    expect(screen.getAllByText('disk full')).toHaveLength(1);
  });

  it('titles the dialog after what it does', async () => {
    const { ref } = await open();
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));
    expect(screen.getByRole('dialog', { name: text('newList') })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    act(() => ref.current?.setFilter('later'));
    fireEvent.click(await screen.findByRole('button', { name: text('rename') }));
    expect(screen.getByRole('dialog', { name: text('rename') })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: text('removeList') }));
    expect(screen.getByRole('dialog', { name: text('removeList') })).toBeVisible();
  });

  it('renames the default list from the name people see', async () => {
    const { ref } = await open();
    act(() => ref.current?.setFilter('default'));
    fireEvent.click(await screen.findByRole('button', { name: text('rename') }));

    expect(nameInput()).toHaveValue(text('defaultList'));
  });

  it('says what happens to the changes of a removed list', async () => {
    const { ref } = await open();
    act(() => ref.current?.setFilter('later'));
    fireEvent.click(await screen.findByRole('button', { name: text('removeList') }));

    expect(within(dialog()).getByText(text('removeListWarning'))).toBeVisible();
  });

  it('shows every change when the filtered list is removed elsewhere', async () => {
    const { ref, rerender } = await open();
    act(() => ref.current?.setFilter('later'));
    await screen.findByRole('button', { name: text('removeList') });
    api.sync.mockResolvedValue(one);

    rerender({ changed: 'b' });

    await waitFor(() => expect(ref.current?.filter()).toBe('all'));
    expect(ref.current?.includes('b')).toBe(true);
    expect(screen.queryByRole('button', { name: text('removeList') })).toBeNull();
  });

  it('stays usable while a status change resyncs in the background', async () => {
    const { rerender } = await open();
    const sync = deferred<unknown>();
    api.sync.mockReturnValue(sync.promise);
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));
    fireEvent.change(nameInput(), { target: { value: 'Next' } });

    rerender({ changed: 'b' });

    await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: text('newList') })).toBeEnabled();
    expect(confirm()).toBeEnabled();
    sync.resolve(two);
  });

  it('starts a new list with an empty name, not the last one typed', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));
    fireEvent.change(nameInput(), { target: { value: 'Abandoned' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: text('newList') }));

    expect(nameInput()).toHaveValue('');
  });

  it('offers rename and remove only while a list is selected', async () => {
    const { ref } = await open();
    expect(screen.queryByRole('button', { name: text('rename') })).toBeNull();

    act(() => ref.current?.setFilter('later'));

    expect(await screen.findByRole('button', { name: text('rename') })).toBeEnabled();
    expect(screen.getByRole('button', { name: text('removeList') })).toBeEnabled();
  });

  it('starts a rename from the current name', async () => {
    const { ref } = await open();
    act(() => ref.current?.setFilter('later'));
    fireEvent.click(await screen.findByRole('button', { name: text('rename') }));

    expect(nameInput()).toHaveValue('Later');
    fireEvent.change(nameInput(), { target: { value: 'Soon' } });
    fireEvent.click(confirm());

    await waitFor(() =>
      expect(api.mutate).toHaveBeenCalledWith({ scope, request: { kind: 'edit', id: 'later', name: 'Soon' } })
    );
  });

  it('will not remove the only list', async () => {
    const { ref } = await open(one);
    act(() => ref.current?.setFilter('default'));

    expect(await screen.findByRole('button', { name: text('removeList') })).toBeDisabled();
  });

  it('confirms removal, then shows every change again', async () => {
    const { ref } = await open();
    act(() => ref.current?.setFilter('later'));
    fireEvent.click(await screen.findByRole('button', { name: text('removeList') }));
    fireEvent.click(confirm());

    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ scope, request: { kind: 'remove', id: 'later' } }));
    await waitFor(() => expect(screen.queryByRole('button', { name: text('removeList') })).toBeNull());
  });

  it('cancelling removal changes nothing', async () => {
    const { ref } = await open();
    act(() => ref.current?.setFilter('later'));
    fireEvent.click(await screen.findByRole('button', { name: text('removeList') }));
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

    expect(api.mutate).not.toHaveBeenCalled();
  });

  it('turns off every control while the panel is busy', async () => {
    await open(two, { disabled: true });

    expect(screen.getByRole('button', { name: text('newList') })).toBeDisabled();
  });

  it('shows why the lists could not be read, and recovers on retry', async () => {
    api.sync.mockRejectedValue(new Error('store unavailable'));
    render(<Harness />);

    expect(await screen.findByText('store unavailable')).toBeVisible();
    api.sync.mockResolvedValue(two);
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByRole('button', { name: text('newList') })).toBeEnabled();
  });
});
