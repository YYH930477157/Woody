import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  servers: vi.fn(),
  skills: vi.fn(),
  importSkill: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    codebaseMemory: { session: { invoke: mocks.session } },
    fs: { listAvailableSkills: { invoke: mocks.skills }, importSkill: { invoke: mocks.importSkill } },
  },
}));
vi.mock('@/common/adapter/ipcBridge', () => ({ mcpService: { listServers: { invoke: mocks.servers } } }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: mocks.desktop }));
import { resolveCodebaseMemoryAccess } from '@/renderer/pages/team/WorkflowPresets/codebaseMemoryAccess';

describe('codebase memory for team members', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.desktop.mockReturnValue(true);
    mocks.session.mockResolvedValue({ enabled: true, skillPath: 'C:/res/SKILL.md', transport: {} });
    mocks.servers.mockResolvedValue([
      { id: 'other', name: 'woody-cmake', enabled: true },
      { id: 'cbm-row', name: 'woody-codebase-memory', enabled: true },
    ]);
    mocks.importSkill.mockResolvedValue({ skill_name: 'woody-codebase-memory' });
    mocks.skills.mockResolvedValue([]);
  });

  it('offers the shared catalog entry and the imported skill when the workspace has codebase memory', async () => {
    await expect(resolveCodebaseMemoryAccess('D:\\work\\project')).resolves.toEqual({
      mcpId: 'cbm-row',
      skill: 'woody-codebase-memory',
    });
    expect(mocks.session).toHaveBeenCalledWith({ repoPath: 'D:\\work\\project' });
    expect(mocks.importSkill).toHaveBeenCalledWith({ skill_path: 'C:/res/SKILL.md' });
  });

  it('offers nothing when the workspace has it switched off, or there is no workspace', async () => {
    mocks.session.mockResolvedValue({ enabled: false });
    await expect(resolveCodebaseMemoryAccess('D:\\work\\project')).resolves.toBeUndefined();
    await expect(resolveCodebaseMemoryAccess('')).resolves.toBeUndefined();
    expect(mocks.servers).not.toHaveBeenCalled();
  });

  it('offers nothing when the catalog entry is missing or disabled', async () => {
    mocks.servers.mockResolvedValue([{ id: 'cbm-row', name: 'woody-codebase-memory', enabled: false }]);
    await expect(resolveCodebaseMemoryAccess('D:\\work\\project')).resolves.toBeUndefined();
    expect(mocks.importSkill).not.toHaveBeenCalled();
  });

  it('never blocks team creation when codebase memory fails', async () => {
    mocks.session.mockRejectedValue(new Error('Bundled codebase-memory executable is unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveCodebaseMemoryAccess('D:\\work\\project')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is not offered outside the desktop app', async () => {
    mocks.desktop.mockReturnValue(false);
    await expect(resolveCodebaseMemoryAccess('D:\\work\\project')).resolves.toBeUndefined();
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
