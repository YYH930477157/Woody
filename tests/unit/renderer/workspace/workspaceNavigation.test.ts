import { describe, expect, it, vi } from 'vitest';
import { canLeaveWorkspaceForRoute } from '@/renderer/components/workspace/WorkspaceManager/navigation';
describe('workspace navigation', () => {
  it('keeps same-workspace chat navigation free of prompts', async () => {
    const confirm = vi.fn();
    expect(await canLeaveWorkspaceForRoute('p', '/conversation/new', 'other', async () => 'p', confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('preserves the current route when a different workspace switch is cancelled', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await canLeaveWorkspaceForRoute('p', '/conversation/new', null, async () => 'q', confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith('p');
  });
  it('prompts when leaving for a route without a workspace', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await canLeaveWorkspaceForRoute('p', '/settings/model', 'p', async () => null, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith('p');
  });
  it('uses the selected workspace for the new-chat route', async () => {
    const confirm = vi.fn();
    expect(await canLeaveWorkspaceForRoute('p', '/guid', 'p', async () => null, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('does not leave if destination workspace resolution fails', async () => {
    const confirm = vi.fn();
    await expect(
      canLeaveWorkspaceForRoute(
        'p',
        '/conversation/new',
        null,
        async () => {
          throw new Error('offline');
        },
        confirm
      )
    ).rejects.toThrow('offline');
    expect(confirm).not.toHaveBeenCalled();
  });
});
