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
});
