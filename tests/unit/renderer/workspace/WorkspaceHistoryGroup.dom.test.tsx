import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutate } from 'swr';
import type { ProjectDetailDto } from '@/common/types/project';
const api = vi.hoisted(() => ({ get: vi.fn(), confirm: vi.fn(), navigate: vi.fn(), current: vi.fn(), error: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { project: { get: { invoke: api.get } } } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => api.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/explorer/currentProjectStore', () => ({ getCurrentProject: api.current }));
vi.mock('@/renderer/components/workspace/WorkspaceManager/lifecycle', () => ({
  confirmWorkspaceLeave: api.confirm,
  publishWorkspaceDetail: async (detail: ProjectDetailDto) =>
    mutate(`explorer-project/${detail.project_id}`, detail, false),
}));
vi.mock('@arco-design/web-react', async (original) => ({
  ...(await original<typeof import('@arco-design/web-react')>()),
  Message: { error: api.error },
}));
import WorkspaceHistoryGroup from '@/renderer/pages/conversation/GroupedHistory/WorkspaceHistoryGroup';
import { getSelectedWorkspace, selectWorkspace } from '@/renderer/components/workspace/workspaceSelection';

const detail = (id: string, name = id): ProjectDetailDto => ({
  project_id: id,
  name,
  workspace: { managed: true, config_path: null, dirty: false, default_pe_id: null },
  explorer: { workspace_pe_id: '', entries: [] },
});
const mount = (projectId?: string) =>
  render(
    <WorkspaceHistoryGroup
      group={{
        workspace: projectId ? `project:${projectId}` : '/legacy',
        project_id: projectId,
        display_name: 'fallback',
        conversations: [],
      }}
      expanded={false}
      onToggle={vi.fn()}
      collapsed={false}
      isMobile={true}
      onArchive={vi.fn()}
    />
  );
beforeEach(() => {
  api.get.mockImplementation(async ({ project_id }) => detail(project_id, 'Workspace name'));
  api.confirm.mockResolvedValue(true);
  api.current.mockReturnValue(null);
});
afterEach(async () => {
  cleanup();
  selectWorkspace(null);
  await mutate((key) => typeof key === 'string' && key.startsWith('explorer-project/'), undefined, false);
  vi.resetAllMocks();
});
describe('managed history group', () => {
  it('subscribes to project name updates in the shared explorer cache', async () => {
    mount('names');
    expect(await screen.findByText('Workspace name')).toBeTruthy();
    await act(async () => {
      await mutate('explorer-project/names', detail('names', 'Renamed workspace'), false);
    });
    expect(screen.getByText('Renamed workspace')).toBeTruthy();
  });
  it('selects the clicked workspace before navigating to a new chat', async () => {
    selectWorkspace(detail('previous'));
    mount('target');
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.newConversationInProject' }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith('/guid'));
    expect(getSelectedWorkspace()?.project_id).toBe('target');
    expect(api.confirm).toHaveBeenCalledWith('previous');
  });
  it('keeps selection and route when leaving the active project is cancelled', async () => {
    selectWorkspace(detail('previous'));
    api.current.mockReturnValue('active');
    api.confirm.mockResolvedValue(false);
    mount('cancelled');
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.newConversationInProject' }));
    await waitFor(() => expect(api.confirm).toHaveBeenCalledWith('active'));
    expect(api.navigate).not.toHaveBeenCalled();
    expect(getSelectedWorkspace()?.project_id).toBe('previous');
  });
  it('preserves selection when the target project cannot be loaded', async () => {
    selectWorkspace(detail('previous'));
    api.get.mockRejectedValue(new Error('offline'));
    mount('missing');
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.newConversationInProject' }));
    await waitFor(() => expect(api.error).toHaveBeenCalled());
    expect(api.navigate).not.toHaveBeenCalled();
    expect(getSelectedWorkspace()?.project_id).toBe('previous');
  });
  it('preserves legacy directory navigation and clears the managed binding', async () => {
    selectWorkspace(detail('previous'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.newConversationInProject' }));
    await waitFor(() => expect(api.navigate).toHaveBeenCalledWith('/guid', { state: { workspace: '/legacy' } }));
    expect(getSelectedWorkspace()).toBeNull();
  });
});
