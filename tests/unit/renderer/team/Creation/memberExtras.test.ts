import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  codebase: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock('@/common', () => ({ ipcBridge: { sessionFiles: { prepare: { invoke: mocks.prepare } } } }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: mocks.desktop }));
vi.mock('@/renderer/pages/team/WorkflowPresets/codebaseMemoryAccess', () => ({
  resolveCodebaseMemoryAccess: mocks.codebase,
}));
import { prepareTeamMemberExtras } from '@/renderer/pages/team/WorkflowPresets/memberExtras';

const names = { root: '会话文件', work: '过程', output: '成品', untitled: '未命名' };
const folder = {
  dir: 'D:\\work\\project\\.woody\\会话文件\\2026-11-25_电表团队',
  work_dir: 'D:\\work\\project\\.woody\\会话文件\\2026-11-25_电表团队\\过程',
  output_dir: 'D:\\work\\project\\.woody\\会话文件\\2026-11-25_电表团队\\成品',
};
const params = { workspace: 'D:\\work\\project', teamName: '电表团队', names, withCodebaseMemory: true };

describe('extras every member of a new team gets', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.desktop.mockReturnValue(true);
    mocks.prepare.mockResolvedValue(folder);
    mocks.codebase.mockResolvedValue({ mcpId: 'cbm-row', skill: 'woody-codebase-memory' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives members picked by hand the codebase memory tools and the team one folder named after it', async () => {
    await expect(prepareTeamMemberExtras(params)).resolves.toEqual({
      skills: ['woody-codebase-memory'],
      mcp_server_ids: ['cbm-row'],
      session_files: folder,
    });
    expect(mocks.prepare).toHaveBeenCalledWith({ workspace: 'D:\\work\\project', title: '电表团队', names });
    expect(mocks.codebase).toHaveBeenCalledWith('D:\\work\\project');
  });

  it('leaves the codebase memory tools to template roles, which carry them already', async () => {
    await expect(prepareTeamMemberExtras({ ...params, withCodebaseMemory: false })).resolves.toEqual({
      session_files: folder,
    });
    expect(mocks.codebase).not.toHaveBeenCalled();
  });

  it('sends nothing without a chosen folder or outside the desktop app', async () => {
    await expect(prepareTeamMemberExtras({ ...params, workspace: '' })).resolves.toBeUndefined();
    mocks.desktop.mockReturnValue(false);
    await expect(prepareTeamMemberExtras(params)).resolves.toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('keeps the tools when the folder fails, and sends nothing when both are missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.prepare.mockRejectedValue(new Error('folder is read-only'));
    await expect(prepareTeamMemberExtras(params)).resolves.toEqual({
      skills: ['woody-codebase-memory'],
      mcp_server_ids: ['cbm-row'],
    });
    expect(warn).toHaveBeenCalled();
    mocks.codebase.mockResolvedValue(undefined);
    mocks.prepare.mockResolvedValue(null);
    await expect(prepareTeamMemberExtras(params)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('does not wait for a slow folder', async () => {
    vi.useFakeTimers();
    mocks.prepare.mockReturnValue(new Promise(() => {}));
    const pending = prepareTeamMemberExtras(params);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending).resolves.toEqual({ skills: ['woody-codebase-memory'], mcp_server_ids: ['cbm-row'] });
  });
});
