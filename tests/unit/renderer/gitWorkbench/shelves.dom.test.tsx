import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  shelfList: vi.fn(),
  shelfRead: vi.fn(),
  shelfApply: vi.fn(),
  shelfCreate: vi.fn(),
  shelfImport: vi.fn(),
  shelfRename: vi.fn(),
  shelfDelete: vi.fn(),
  shelfRestore: vi.fn(),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitStorage: Object.fromEntries(Object.entries(api).map(([key, invoke]) => [key, { invoke }])),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { patchFileName, Shelves } from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/Shelves';
import { deferred } from './fixtures';

const scope = { projectId: 'p', peId: 'r', relativePath: '' };
const text = (key: string) => `conversation.gitWorkbench.storage.${key}`;
const shelf = (overrides = {}) => ({
  id: 's',
  name: 'Saved edits',
  createdAt: 1,
  deleted: false,
  files: [{ path: 'src/a.ts', status: 'M', binary: false }],
  ...overrides,
});
const modal = () => within(document.querySelector('.arco-modal') as HTMLElement);
const confirm = () => modal().getByRole('button', { name: 'common.confirm' });
const openShelf = async (props: { paths?: string[] } = {}) => {
  render(<Shelves scope={scope} paths={props.paths ?? []} />);
  fireEvent.click(await screen.findByText('Saved edits'));
  await screen.findByRole('button', { name: text('exportPatch') });
};

beforeEach(() => {
  api.shelfList.mockResolvedValue([shelf()]);
  api.shelfRead.mockResolvedValue({ patch: 'diff --git a/src/a.ts b/src/a.ts' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('shelf panel', () => {
  it('explains an empty list', async () => {
    api.shelfList.mockResolvedValue([]);
    render(<Shelves scope={scope} paths={[]} />);

    expect(await screen.findByText(text('noShelves'))).toBeVisible();
  });

  it('shows what a shelf contains when it is opened', async () => {
    await openShelf();

    expect(screen.getByText(/M\s+src\/a\.ts/)).toBeVisible();
    expect(screen.getByText('diff --git a/src/a.ts b/src/a.ts')).toBeVisible();
  });

  it('keeps the list and details on screen while they reload', async () => {
    await openShelf();
    const reload = deferred<unknown>();
    api.shelfList.mockReturnValue(reload.promise);

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));

    await waitFor(() => expect(api.shelfList).toHaveBeenCalledTimes(3));
    expect(screen.getByText('Saved edits')).toBeVisible();
    expect(screen.getByRole('button', { name: text('exportPatch') })).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    reload.resolve([shelf()]);
  });

  it('explains why shelving is unavailable when nothing has changed', async () => {
    render(<Shelves scope={scope} paths={[]} />);
    const create = await screen.findByRole('button', { name: text('createShelf') });

    expect(create).toBeDisabled();
    fireEvent.mouseEnter(create.parentElement as HTMLElement);
    expect(await screen.findByText(text('noChangesToShelve'))).toBeVisible();
  });

  it('selects every changed file by default', async () => {
    render(<Shelves scope={scope} paths={['a.ts', 'b.ts']} />);
    fireEvent.click(await screen.findByRole('button', { name: text('createShelf') }));
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Both' } });
    fireEvent.click(confirm());

    await waitFor(() =>
      expect(api.shelfCreate).toHaveBeenCalledWith({
        scope,
        request: { name: 'Both', paths: ['a.ts', 'b.ts'], rollback: false },
      })
    );
  });

  it('needs a name and at least one file to create a shelf', async () => {
    render(<Shelves scope={scope} paths={['a.ts']} />);
    fireEvent.click(await screen.findByRole('button', { name: text('createShelf') }));

    expect(confirm()).toBeDisabled();
    expect(modal().getByRole('checkbox', { name: 'a.ts' })).toBeChecked();
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Named' } });
    expect(confirm()).toBeEnabled();
    fireEvent.click(modal().getByRole('checkbox', { name: 'a.ts' }));
    expect(confirm()).toBeDisabled();
  });

  it('passes the choice to revert the shelved files', async () => {
    render(<Shelves scope={scope} paths={['a.ts']} />);
    fireEvent.click(await screen.findByRole('button', { name: text('createShelf') }));
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Named' } });
    fireEvent.click(modal().getByRole('checkbox', { name: text('rollback') }));
    fireEvent.click(confirm());

    await waitFor(() =>
      expect(api.shelfCreate).toHaveBeenCalledWith({
        scope,
        request: { name: 'Named', paths: ['a.ts'], rollback: true },
      })
    );
  });

  it('keeps the dialog open with the error when creating fails', async () => {
    api.shelfCreate.mockRejectedValue(new Error('patch too large'));
    render(<Shelves scope={scope} paths={['a.ts']} />);
    fireEvent.click(await screen.findByRole('button', { name: text('createShelf') }));
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Named' } });
    fireEvent.click(confirm());

    expect(await modal().findByText('patch too large')).toBeVisible();
    expect(modal().getByLabelText(text('name'))).toHaveValue('Named');
    expect(screen.getAllByText('patch too large')).toHaveLength(1);
  });

  it('shows a failed shelf read on the panel', async () => {
    render(<Shelves scope={scope} paths={[]} />);
    api.shelfRead.mockRejectedValue(new Error('shelf is damaged'));
    fireEvent.click(await screen.findByText('Saved edits'));

    expect(await screen.findByText('shelf is damaged')).toBeVisible();
  });

  it('needs a name and a patch to import', async () => {
    render(<Shelves scope={scope} paths={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: text('importPatch') }));
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Imported' } });
    expect(confirm()).toBeDisabled();

    fireEvent.change(modal().getByLabelText(text('patch')), { target: { value: 'diff --git a/a b/a' } });
    fireEvent.click(confirm());

    await waitFor(() =>
      expect(api.shelfImport).toHaveBeenCalledWith({
        scope,
        request: { name: 'Imported', patch: 'diff --git a/a b/a' },
      })
    );
  });

  it('starts a rename from the current name', async () => {
    await openShelf();
    fireEvent.click(screen.getByRole('button', { name: text('rename') }));

    expect(screen.getByRole('dialog', { name: text('rename') })).toBeVisible();
    expect(modal().getByLabelText(text('name'))).toHaveValue('Saved edits');
    fireEvent.change(modal().getByLabelText(text('name')), { target: { value: 'Better name' } });
    fireEvent.click(confirm());

    await waitFor(() => expect(api.shelfRename).toHaveBeenCalledWith({ scope, id: 's', name: 'Better name' }));
  });

  it('warns that a first delete can be undone', async () => {
    await openShelf();
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));

    expect(modal().getByText(text('deleteShelf'))).toBeVisible();
    fireEvent.click(confirm());
    await waitFor(() => expect(api.shelfDelete).toHaveBeenCalledWith({ scope, id: 's', permanently: false }));
  });

  it('warns that deleting a deleted shelf is permanent, and offers to restore it', async () => {
    api.shelfList.mockResolvedValue([shelf({ deleted: true })]);
    render(<Shelves scope={scope} paths={[]} />);
    fireEvent.click(await screen.findByText(/Saved edits/));

    fireEvent.click(await screen.findByRole('button', { name: text('restoreShelf') }));
    await waitFor(() => expect(api.shelfRestore).toHaveBeenCalledWith({ scope, id: 's' }));

    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    expect(modal().getByText(text('deletePermanently'))).toBeVisible();
    fireEvent.click(confirm());
    await waitFor(() => expect(api.shelfDelete).toHaveBeenCalledWith({ scope, id: 's', permanently: true }));
  });

  it('stays permanent if the list is reloading when the delete is confirmed', async () => {
    api.shelfList.mockResolvedValue([shelf({ deleted: true })]);
    render(<Shelves scope={scope} paths={[]} />);
    fireEvent.click(await screen.findByText(/Saved edits/));
    fireEvent.click(await screen.findByRole('button', { name: 'common.delete' }));
    const reload = deferred<unknown>();
    api.shelfList.mockReturnValue(reload.promise);

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh', hidden: true }));
    await waitFor(() => expect(api.shelfList).toHaveBeenCalledTimes(3));
    fireEvent.click(confirm());

    await waitFor(() => expect(api.shelfDelete).toHaveBeenCalledWith({ scope, id: 's', permanently: true }));
    reload.resolve([]);
  });

  it('cannot apply a deleted shelf', async () => {
    api.shelfList.mockResolvedValue([shelf({ deleted: true })]);
    render(<Shelves scope={scope} paths={[]} />);
    fireEvent.click(await screen.findByText(/Saved edits/));

    await screen.findByRole('button', { name: text('restoreShelf') });
    expect(screen.queryByRole('button', { name: text('apply') })).toBeNull();
  });

  it('reports a successful apply', async () => {
    api.shelfApply.mockResolvedValue({ applied: true, conflicts: false });
    await openShelf();
    fireEvent.click(screen.getByRole('button', { name: text('apply') }));

    expect(await screen.findByText(text('applied'))).toBeVisible();
  });

  it('reports when a shelf only partly applied', async () => {
    api.shelfApply.mockResolvedValue({ applied: false, conflicts: true });
    await openShelf();
    fireEvent.click(screen.getByRole('button', { name: text('apply') }));

    expect(await screen.findByText(text('retained'))).toBeVisible();
  });

  it('prefers the reason Git gave for a failed apply', async () => {
    api.shelfApply.mockResolvedValue({ applied: false, conflicts: true, message: 'a.ts: patch does not apply' });
    await openShelf();
    fireEvent.click(screen.getByRole('button', { name: text('apply') }));

    expect(await screen.findByText('a.ts: patch does not apply')).toBeVisible();
  });

  it('exports the patch as a file named after the shelf', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:patch');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await openShelf();

    fireEvent.click(screen.getByRole('button', { name: text('exportPatch') }));

    expect(names).toEqual(['Saved edits.patch']);
    expect(await createObjectURL.mock.calls[0][0].text()).toBe('diff --git a/src/a.ts b/src/a.ts');
    click.mockRestore();
  });

  it.each([
    ['fix: a/b', 'fix_ a_b.patch'],
    ['C:\\temp\\x', 'C__temp_x.patch'],
    ['what?*<>|"', 'what______.patch'],
    ['line\nbreak', 'line_break.patch'],
    ['修复 登录', '修复 登录.patch'],
    ['   ', 'changes.patch'],
  ])('turns the shelf name %j into a safe file name', (name, expected) => {
    expect(patchFileName(name)).toBe(expected);
  });

  it('offers a retry when shelves cannot be read', async () => {
    api.shelfList.mockRejectedValue(new Error('store unavailable'));
    render(<Shelves scope={scope} paths={[]} />);

    expect(await screen.findByText('store unavailable')).toBeVisible();
    api.shelfList.mockResolvedValue([shelf()]);
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('Saved edits')).toBeVisible();
  });
});
