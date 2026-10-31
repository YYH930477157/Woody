import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: {
      createWorkspace: { invoke: api.create },
      get: { invoke: api.get },
      updateWorkspace: { invoke: api.update },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Message: { error: vi.fn() },
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => null,
}));
vi.mock('@/renderer/components/workspace/WorkspaceManager/lifecycle', () => ({
  confirmWorkspaceLeave: async () => true,
  confirmRootEditors: async () => true,
  saveWorkspaceConfiguration: vi.fn(),
  publishWorkspaceDetail: vi.fn(),
  closeRootEditors: vi.fn(),
}));
import { Message } from '@arco-design/web-react';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import WorkspaceManager from '@/renderer/components/workspace/WorkspaceManager';
import { selectWorkspace, getSelectedWorkspace } from '@/renderer/components/workspace/workspaceSelection';
afterEach(() => {
  cleanup();
  selectWorkspace(null);
  vi.clearAllMocks();
});
describe('workspace manager', () => {
  it('creates an independent empty workspace before a chat exists', async () => {
    const workspace = {
      project_id: 'new',
      name: 'New workspace',
      workspace: { managed: true, dirty: true, config_path: null, default_pe_id: null },
      explorer: { workspace_pe_id: '', entries: [] },
    };
    api.create.mockResolvedValue(workspace);
    const onWorkspaceChange = vi.fn();
    render(<WorkspaceManager onWorkspaceChange={onWorkspaceChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.managedWorkspace.manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.managedWorkspace.new' }));
    await waitFor(() => expect(onWorkspaceChange).toHaveBeenCalledWith(workspace));
    expect(getSelectedWorkspace()?.project_id).toBe('new');
  });
  it('preserves selection when workspace creation fails', async () => {
    api.create.mockRejectedValue(new Error('unavailable'));
    render(<WorkspaceManager />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.managedWorkspace.manage' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.managedWorkspace.new' }));
    await waitFor(() => expect(api.create).toHaveBeenCalled());
    expect(getSelectedWorkspace()).toBeNull();
  });
  const managedWorkspace = (name = 'Old name') => ({
    project_id: 'w',
    name,
    workspace: { managed: true, dirty: true, config_path: null, default_pe_id: 'a' },
    explorer: {
      workspace_pe_id: '',
      entries: [
        { pe_id: 'a', display_name: null, display_path: '/a' },
        { pe_id: 'b', display_name: null, display_path: '/b' },
      ],
    },
  });
  const openManager = async () => {
    selectWorkspace(managedWorkspace() as never);
    api.get.mockResolvedValue(managedWorkspace());
    render(<WorkspaceManager />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.managedWorkspace.manage' }));
    return (await screen.findByLabelText('conversation.managedWorkspace.name')) as HTMLInputElement;
  };
  it('applies an edit and the click that blurred it, in order, without losing the edit', async () => {
    const input = await openManager();
    api.update.mockResolvedValue(managedWorkspace('New name'));

    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.blur(input);
    const moveDown = screen.getAllByRole('button', { name: /moveDown|down/i })[0];
    expect(moveDown).toBeEnabled();
    fireEvent.click(moveDown);

    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
    expect(api.update.mock.calls[0][0].name).toBe('New name');
    expect(api.update.mock.calls[1][0].name).toBe('New name');
    expect(api.update.mock.calls[1][0].roots.map((root: { pe_id: string }) => root.pe_id)).toEqual(['b', 'a']);
  });
  it('blames the build only for a missing route, not a missing resource', async () => {
    const input = await openManager();
    api.update.mockRejectedValueOnce(
      new BackendHttpError({ method: 'PUT', path: '/x', status: 404, body: { code: 'project_not_found' } })
    );
    fireEvent.change(input, { target: { value: 'First edit' } });
    fireEvent.blur(input);
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('conversation.managedWorkspace.failed'));

    api.update.mockRejectedValueOnce(
      new BackendHttpError({ method: 'PUT', path: '/x', status: 404, body: 'Not found' })
    );
    fireEvent.change(input, { target: { value: 'Second edit' } });
    fireEvent.blur(input);
    await waitFor(() => expect(Message.error).toHaveBeenCalledWith('conversation.managedWorkspace.unsupported'));
  });
});
