import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  selectProvider: vi.fn(),
  saveProvider: vi.fn(),
  openProvider: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save },
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { provider: mocks.openProvider },
      selectWorkspaceFile: { provider: mocks.selectProvider },
      saveWorkspaceFile: { provider: mocks.saveProvider },
    },
  },
}));
import { initDialogBridge } from '@/process/bridge/dialogBridge';

describe('workspace file dialogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initDialogBridge();
  });
  it('returns null when opening a workspace is cancelled', async () => {
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(mocks.selectProvider).toHaveBeenCalled();
    expect(await mocks.selectProvider.mock.calls[0][0]()).toBeNull();
  });
  it('returns the chosen configuration save path', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'D:\\项目\\组合.woody-workspace' });
    expect(mocks.saveProvider).toHaveBeenCalled();
    expect(await mocks.saveProvider.mock.calls[0][0]({ defaultPath: '组合.woody-workspace' })).toBe(
      'D:\\项目\\组合.woody-workspace'
    );
  });
});
