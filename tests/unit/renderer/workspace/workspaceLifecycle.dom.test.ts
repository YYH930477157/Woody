import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  discardWorkspace: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  savePath: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    project: {
      getWorkspace: { invoke: api.getWorkspace },
      saveWorkspace: { invoke: api.saveWorkspace },
      discardWorkspace: { invoke: api.discardWorkspace },
      get: { invoke: api.get },
      updateWorkspace: { invoke: api.update },
    },
    dialog: { saveWorkspaceFile: { invoke: api.savePath } },
  },
}));
vi.mock('@arco-design/web-react', () => ({
  Button: 'button',
  Modal: { confirm: api.confirm },
  Message: { error: vi.fn() },
}));
vi.mock('@/renderer/services/i18n', () => ({ default: { t: (key: string) => key } }));
import {
  addWorkspaceRoot,
  confirmWorkspaceLeave,
  confirmRootEditors,
  registerWorkspaceDiscardGuard,
  saveWorkspaceConfiguration,
  publishWorkspaceDetail,
} from '@/renderer/components/workspace/WorkspaceManager/lifecycle';
import type { ProjectDetailDto } from '@/common/types/project';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import type { PreviewContextValue } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import useSWR, { mutate } from 'swr';
import { act, cleanup, renderHook } from '@testing-library/react';
describe('workspace configuration lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  it('makes the first added directory the default using its backend identity', async () => {
    const empty: ProjectDetailDto = {
      project_id: 'p',
      name: 'Draft',
      workspace: { managed: true, dirty: true, default_pe_id: null, config_path: null },
      explorer: { workspace_pe_id: '', entries: [] },
    };
    const added: ProjectDetailDto = {
      ...empty,
      explorer: {
        workspace_pe_id: 'new',
        entries: [
          { pe_id: 'new', role: 'workspace', display_path: 'C:/app', order_index: 0, runtime_status: 'available' },
        ],
      },
    };
    api.update
      .mockResolvedValueOnce(added)
      .mockResolvedValueOnce({ ...added, workspace: { ...added.workspace!, default_pe_id: 'new' } });
    const result = await addWorkspaceRoot(empty, 'file:///C:/app');
    expect(result.workspace?.default_pe_id).toBe('new');
    expect(api.update).toHaveBeenLastCalledWith(expect.objectContaining({ default_pe_id: 'new' }));
  });
  it('leaves a clean workspace without asking for a decision', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: false });
    expect(await confirmWorkspaceLeave('p')).toBe(true);
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it('does not save when the file picker is cancelled', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true, config_path: null });
    api.savePath.mockResolvedValue(null);
    expect(await saveWorkspaceConfiguration('p')).toBe(false);
    expect(api.saveWorkspace).not.toHaveBeenCalled();
  });
  it('preserves the draft when leaving is cancelled', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true });
    api.confirm.mockImplementation((options) => {
      options.onCancel();
      return { close: vi.fn() };
    });
    expect(await confirmWorkspaceLeave('p')).toBe(false);
    expect(api.discardWorkspace).not.toHaveBeenCalled();
  });
  it('blocks leaving when workspace state cannot be read', async () => {
    api.getWorkspace.mockRejectedValue(new Error('offline'));
    expect(await confirmWorkspaceLeave('p')).toBe(false);
  });
  it('allows legacy projects when the backend has no workspace endpoint', async () => {
    api.getWorkspace.mockRejectedValue(
      new BackendHttpError({ method: 'GET', path: '/api/projects/old/workspace', status: 404, body: 'Not found' })
    );
    api.get.mockResolvedValue({
      project_id: 'old',
      name: 'Legacy',
      explorer: { workspace_pe_id: 'root', entries: [] },
    });
    expect(await confirmWorkspaceLeave('old')).toBe(true);
  });
  it('prevents root changes when an edited file fails to save', async () => {
    api.confirm.mockImplementation((options) => {
      queueMicrotask(() => options.footer.props.children[2].props.onClick());
      return { close: vi.fn() };
    });
    const closeTab = vi.fn();
    const preview = {
      tabs: [{ id: 'edit', isDirty: true, metadata: { fileRef: { kind: 'project', pe_id: 'a', relative_path: 'x' } } }],
      saveContent: vi.fn().mockResolvedValue(false),
      closeTab,
    } as unknown as PreviewContextValue;
    expect(await confirmRootEditors(preview, ['a'])).toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });
  it('keeps edited buffers after a discard decision until the server accepts the mutation', async () => {
    api.confirm.mockImplementation((options) => {
      queueMicrotask(() => options.footer.props.children[1].props.onClick());
      return { close: vi.fn() };
    });
    const closeTab = vi.fn();
    const preview = {
      tabs: [{ id: 'edit', isDirty: true, metadata: { fileRef: { kind: 'project', pe_id: 'a', relative_path: 'x' } } }],
      closeTab,
    } as unknown as PreviewContextValue;
    expect(await confirmRootEditors(preview, ['a'])).toBe(true);
    expect(closeTab).not.toHaveBeenCalled();
  });
  it('keeps the draft when the editor guard cancels configuration discard', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true });
    api.confirm.mockImplementation((options) => {
      queueMicrotask(() => options.footer.props.children[1].props.onClick());
      return { close: vi.fn() };
    });
    const dispose = registerWorkspaceDiscardGuard(async () => false);
    try {
      expect(await confirmWorkspaceLeave('p')).toBe(false);
      expect(api.discardWorkspace).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
  it('shares one prompt between concurrent navigation and quit checks', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true });
    api.confirm.mockImplementation((options) => {
      queueMicrotask(() => options.onCancel());
      return { close: vi.fn() };
    });
    expect(await Promise.all([confirmWorkspaceLeave('p'), confirmWorkspaceLeave('p')])).toEqual([false, false]);
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });
  it('keeps editor buffers when the backend rejects configuration discard', async () => {
    api.getWorkspace.mockResolvedValue({ managed: true, dirty: true });
    api.confirm.mockImplementation((options) => {
      queueMicrotask(() => options.footer.props.children[1].props.onClick());
      return { close: vi.fn() };
    });
    api.discardWorkspace.mockRejectedValue(new Error('project_workspace_busy'));
    const closeEditors = vi.fn();
    const dispose = registerWorkspaceDiscardGuard(async () => true, closeEditors);
    try {
      expect(await confirmWorkspaceLeave('p')).toBe(false);
      expect(closeEditors).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
  it('publishes reopened or restored metadata over an existing SWR snapshot', async () => {
    const detail: ProjectDetailDto = {
      project_id: 'cache-test',
      name: 'Restored',
      explorer: { workspace_pe_id: 'new', entries: [] },
    };
    const { result } = renderHook(() => useSWR<ProjectDetailDto>('explorer-project/cache-test', null).data);
    await act(async () => {
      await mutate('explorer-project/cache-test', { ...detail, name: 'Old draft' }, false);
    });
    expect(result.current?.name).toBe('Old draft');
    await act(async () => {
      await publishWorkspaceDetail(detail);
    });
    expect(result.current?.name).toBe('Restored');
    cleanup();
  });
});
