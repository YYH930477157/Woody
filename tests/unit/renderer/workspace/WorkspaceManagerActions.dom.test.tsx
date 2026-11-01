import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  discard: vi.fn(),
  getWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  showOpen: vi.fn(),
  selectFile: vi.fn(),
  saveFile: vi.fn(),
  preview: null as unknown,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: {
      get: { invoke: api.get },
      updateWorkspace: { invoke: api.update },
      createWorkspace: { invoke: api.create },
      openWorkspace: { invoke: api.open },
      discardWorkspace: { invoke: api.discard },
      getWorkspace: { invoke: api.getWorkspace },
      saveWorkspace: { invoke: api.saveWorkspace },
    },
    dialog: {
      showOpen: { invoke: api.showOpen },
      selectWorkspaceFile: { invoke: api.selectFile },
      saveWorkspaceFile: { invoke: api.saveFile },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/services/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Message: { error: vi.fn() },
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => api.preview,
}));

// The renderer entry loads this too; without it Modal.confirm has no way to mount under React 19.
import '@arco-design/web-react/lib/_util/react-19-adapter';
import { Message, Modal } from '@arco-design/web-react';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import type { WorkspaceUpdate } from '@/common/types/project';
import WorkspaceManager from '@/renderer/components/workspace/WorkspaceManager';
import { getSelectedWorkspace, selectWorkspace } from '@/renderer/components/workspace/workspaceSelection';
import { deferred } from '../gitWorkbench/fixtures';

const label = (key: string) => `conversation.managedWorkspace.${key}`;
const root = (pe_id: string, overrides = {}) => ({
  pe_id,
  display_name: null,
  display_path: `/${pe_id}`,
  runtime_status: 'available',
  ...overrides,
});
const workspace = (overrides = {}, state = {}) => ({
  project_id: 'w',
  name: 'Work',
  workspace: { managed: true, dirty: true, config_path: '/w.json', default_pe_id: 'a', ...state },
  explorer: { workspace_pe_id: '', entries: [root('a'), root('b')] },
  ...overrides,
});
/** What the backend answers: the submitted draft, with an identity for any new root. */
const applied = ({ name, roots, default_pe_id }: WorkspaceUpdate) =>
  workspace(
    {
      name,
      explorer: {
        workspace_pe_id: '',
        entries: roots.map((item, index) =>
          root(item.pe_id ?? `new${index}`, {
            display_name: item.display_name ?? null,
            display_path: decodeURI(item.uri.replace('file://', '')),
          })
        ),
      },
    },
    { default_pe_id }
  );

const manage = async (detail: object = workspace()) => {
  selectWorkspace(detail as never);
  api.get.mockResolvedValue(detail);
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <WorkspaceManager />
    </SWRConfig>
  );
  fireEvent.click(screen.getByRole('button', { name: label('manage') }));
  await screen.findByText(label('roots'));
};
const button = (name: string) => screen.getByRole('button', { name });
const lastUpdate = () => api.update.mock.calls.at(-1)?.[0];
const prompt = () => within(screen.getAllByRole('dialog').at(-1) as HTMLElement);

beforeEach(() => {
  api.preview = null;
  api.update.mockImplementation(async (body) => applied(body));
  api.getWorkspace.mockResolvedValue({ managed: true, dirty: false, config_path: '/w.json' });
});
afterEach(async () => {
  Modal.destroyAll();
  cleanup();
  await waitFor(() => expect(document.querySelector('.arco-modal')).toBeNull());
  selectWorkspace(null);
  vi.clearAllMocks();
});

describe('workspace manager edits', () => {
  it('adds a folder without undoing an alias that is still saving', async () => {
    await manage();
    const saving = deferred<void>();
    api.update.mockImplementationOnce(async (body) => {
      await saving.promise;
      return applied(body);
    });
    api.showOpen.mockResolvedValue(['/c']);
    const alias = screen.getAllByLabelText(label('alias'))[0];
    fireEvent.change(alias, { target: { value: 'Front end' } });
    fireEvent.blur(alias);

    fireEvent.click(button('conversation.explorer.addFolder'));
    saving.resolve();

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(lastUpdate().roots[0].display_name).toBe('Front end');
    expect(lastUpdate().roots.map((item: { uri: string }) => item.uri)).toEqual([
      'file:///a',
      'file:///b',
      'file:///c',
    ]);
  });

  it('changes nothing when the folder picker is cancelled', async () => {
    await manage();
    api.showOpen.mockResolvedValue([]);

    fireEvent.click(button('conversation.explorer.addFolder'));

    await waitFor(() => expect(api.showOpen).toHaveBeenCalled());
    expect(api.update).not.toHaveBeenCalled();
  });

  it('puts the name back when it is cleared', async () => {
    await manage();
    const name = screen.getByLabelText(label('name'));

    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.blur(name);

    expect(name).toHaveValue('Work');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('trims a new name and ignores an unchanged one', async () => {
    await manage();
    const name = screen.getByLabelText(label('name'));

    fireEvent.change(name, { target: { value: ' Work ' } });
    fireEvent.blur(name);
    expect(api.update).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: ' Renamed ' } });
    fireEvent.blur(name);
    await waitFor(() => expect(lastUpdate()?.name).toBe('Renamed'));
  });

  it('clears an alias instead of storing an empty one', async () => {
    await manage(workspace({ explorer: { workspace_pe_id: '', entries: [root('a', { display_name: 'Old' })] } }));
    const alias = screen.getByLabelText(label('alias'));

    fireEvent.change(alias, { target: { value: '  ' } });
    fireEvent.blur(alias);

    await waitFor(() => expect(api.update).toHaveBeenCalled());
    expect(lastUpdate().roots[0].display_name).toBeUndefined();
  });

  it('keeps folders from moving past either end', async () => {
    await manage();
    const up = screen.getAllByRole('button', { name: label('moveUp') });
    const down = screen.getAllByRole('button', { name: label('moveDown') });

    expect(up[0]).toBeDisabled();
    expect(down[1]).toBeDisabled();
    fireEvent.click(up[1]);

    await waitFor(() => expect(lastUpdate()?.roots.map((item: { pe_id: string }) => item.pe_id)).toEqual(['b', 'a']));
  });

  it('clears the default when its folder is removed', async () => {
    await manage();

    fireEvent.click(screen.getAllByRole('button', { name: 'conversation.explorer.removeFolder' })[0]);

    await waitFor(() => expect(lastUpdate()).toMatchObject({ default_pe_id: null, roots: [{ pe_id: 'b' }] }));
  });

  it('marks a missing folder and will not offer it as the default', async () => {
    await manage(
      workspace({ explorer: { workspace_pe_id: '', entries: [root('a'), root('b', { runtime_status: 'missing' })] } })
    );

    expect(screen.getByText(label('unavailable'))).toBeVisible();
    fireEvent.click(screen.getByLabelText(label('defaultRoot')).querySelector('.arco-select-view') as HTMLElement);
    expect((await screen.findByRole('option', { name: '/b' })).className).toContain('disabled');
  });

  it('lets a missing folder be pointed somewhere else', async () => {
    await manage();
    api.showOpen.mockResolvedValue(['/moved']);

    fireEvent.click(screen.getAllByRole('button', { name: label('relocate') })[1]);

    await waitFor(() => expect(lastUpdate()?.roots[1]).toMatchObject({ pe_id: 'b', uri: 'file:///moved' }));
  });

  it('encodes unusual folder names so they survive the round trip', async () => {
    await manage();
    api.showOpen.mockResolvedValue(['C:\\Users\\me\\工程 #1']);

    fireEvent.click(button('conversation.explorer.addFolder'));

    await waitFor(() => expect(lastUpdate()?.roots[2].uri).toBe('file:///C:/Users/me/%E5%B7%A5%E7%A8%8B%20%231'));
  });

  it('stars the name while changes are unsaved', async () => {
    await manage();

    expect(button(label('manage'))).toHaveTextContent('Work *');
  });

  it('points to the first step when nothing is managed yet', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <WorkspaceManager />
      </SWRConfig>
    );
    fireEvent.click(button(label('manage')));

    expect(await screen.findByText(label('startHint'))).toBeVisible();
    expect(screen.queryByRole('button', { name: label('saveAs') })).toBeNull();
  });
});

describe('workspace manager failures', () => {
  it.each([
    [{ status: 409, body: { code: 'project_workspace_busy' } }, label('busy')],
    [{ status: 409, body: { code: 'project_explorer_duplicate' } }, 'conversation.explorer.attachDuplicate'],
    [{ status: 409, body: { code: 'project_explorer_overlap' } }, 'conversation.explorer.attachOverlap'],
    [{ status: 405, body: '' }, label('unsupported')],
    [{ status: 500, body: { code: 'internal' } }, label('failed')],
  ])('explains %j', async (response, message) => {
    await manage();
    api.showOpen.mockResolvedValue(['/c']);
    api.update.mockRejectedValue(new BackendHttpError({ method: 'PUT', path: '/x', ...response }));

    fireEvent.click(button('conversation.explorer.addFolder'));

    await waitFor(() => expect(Message.error).toHaveBeenCalledWith(message));
    expect(button('conversation.explorer.addFolder')).toBeEnabled();
  });

  it('carries on with the next edit after one fails', async () => {
    await manage();
    api.update.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getAllByRole('button', { name: label('moveUp') })[1]);
    await waitFor(() => expect(Message.error).toHaveBeenCalledOnce());

    fireEvent.click(screen.getAllByRole('button', { name: label('moveDown') })[0]);

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
  });

  it('keeps the selected workspace when opening another one fails', async () => {
    await manage();
    api.selectFile.mockResolvedValue('/other.json');
    api.open.mockRejectedValue(new Error('invalid workspace configuration'));

    fireEvent.click(button(label('open')));

    await waitFor(() => expect(Message.error).toHaveBeenCalledWith(label('failed')));
    expect(getSelectedWorkspace()?.project_id).toBe('w');
  });
});

describe('discarding workspace changes', () => {
  const dirtyEditor = () => {
    api.preview = {
      tabs: [{ id: 't', isDirty: true, metadata: { fileRef: { kind: 'project', pe_id: 'a' } } }],
      saveContent: vi.fn(async () => true),
      closeTab: vi.fn(),
    };
    return api.preview as { saveContent: () => Promise<boolean>; closeTab: (id: string) => void };
  };

  it('asks first, because a never-saved workspace would lose its folders', async () => {
    await manage(workspace({}, { config_path: null }));

    fireEvent.click(button(label('discard')));

    expect(await screen.findByText(label('discardConfirm'))).toBeVisible();
    expect(api.discard).not.toHaveBeenCalled();
  });

  it('keeps everything when the confirmation is cancelled', async () => {
    await manage();
    fireEvent.click(button(label('discard')));
    await screen.findByText(label('discardConfirm'));

    fireEvent.click(prompt().getByRole('button', { name: 'common.cancel' }));

    await waitFor(() => expect(screen.queryByText(label('discardConfirm'))).toBeNull());
    expect(api.discard).not.toHaveBeenCalled();
    expect(button(label('discard'))).toBeEnabled();
  });

  it('restores the saved workspace once confirmed', async () => {
    await manage();
    api.discard.mockResolvedValue(workspace({ name: 'Saved' }, { dirty: false }));
    fireEvent.click(button(label('discard')));
    await screen.findByText(label('discardConfirm'));

    fireEvent.click(prompt().getByRole('button', { name: 'common.confirm' }));

    await waitFor(() => expect(getSelectedWorkspace()?.name).toBe('Saved'));
    expect(await screen.findByLabelText(label('name'))).toHaveValue('Saved');
    expect(button(label('discard'))).toBeDisabled();
  });

  it('then protects edited files, and closes them only after the discard worked', async () => {
    const preview = dirtyEditor();
    await manage();
    api.discard.mockResolvedValue(workspace({}, { dirty: false }));
    fireEvent.click(button(label('discard')));
    await screen.findByText(label('discardConfirm'));
    fireEvent.click(prompt().getByRole('button', { name: 'common.confirm' }));
    await screen.findByText(label('unsavedEditors'));

    fireEvent.click(prompt().getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(api.discard).toHaveBeenCalled());
    expect(preview.saveContent).toHaveBeenCalledWith('t');
    await waitFor(() => expect(preview.closeTab).toHaveBeenCalledWith('t'));
  });

  it('keeps edited files open when the discard fails', async () => {
    const preview = dirtyEditor();
    await manage();
    api.discard.mockRejectedValue(new Error('busy'));
    fireEvent.click(button(label('discard')));
    await screen.findByText(label('discardConfirm'));
    fireEvent.click(prompt().getByRole('button', { name: 'common.confirm' }));
    await screen.findByText(label('unsavedEditors'));

    fireEvent.click(prompt().getByRole('button', { name: label('discard') }));

    await waitFor(() => expect(Message.error).toHaveBeenCalled());
    expect(preview.closeTab).not.toHaveBeenCalled();
  });

  it('cannot discard when nothing changed', async () => {
    await manage(workspace({}, { dirty: false }));

    expect(button(label('discard'))).toBeDisabled();
  });
});

describe('leaving a workspace', () => {
  it('stays when the user cancels leaving unsaved changes', async () => {
    await manage();
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true, config_path: '/w.json' });

    fireEvent.click(button(label('new')));
    await screen.findByText(label('unsavedConfiguration'));
    fireEvent.click(prompt().getByRole('button', { name: 'common.cancel' }));

    await waitFor(() => expect(api.getWorkspace).toHaveBeenCalled());
    expect(api.create).not.toHaveBeenCalled();
    expect(getSelectedWorkspace()?.project_id).toBe('w');
  });

  it('asks before replacing the selected workspace from a saved file', async () => {
    await manage();
    api.selectFile.mockResolvedValue(null);

    fireEvent.click(button(label('open')));

    await waitFor(() => expect(api.selectFile).toHaveBeenCalled());
    expect(api.getWorkspace).not.toHaveBeenCalled();
  });

  it('reopening the current file closes its editors, as their folders may have changed', async () => {
    api.preview = {
      tabs: [{ id: 't', metadata: { fileRef: { kind: 'project', pe_id: 'a' } } }],
      saveContent: vi.fn(),
      closeTab: vi.fn(),
    };
    await manage();
    api.selectFile.mockResolvedValue('/w.json');
    api.open.mockResolvedValue(workspace());

    fireEvent.click(button(label('open')));

    await waitFor(() => expect((api.preview as { closeTab: () => void }).closeTab).toHaveBeenCalledWith('t'));
  });
});
