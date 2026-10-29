import { beforeEach, describe, expect, it } from 'vitest';
import {
  hydrateSelectedWorkspace,
  selectWorkspace,
  getSelectedWorkspace,
} from '@/renderer/components/workspace/workspaceSelection';
const workspace = {
  project_id: 'p',
  name: 'Draft',
  workspace: { managed: true, dirty: true, config_path: null, default_pe_id: null },
  explorer: { workspace_pe_id: '', entries: [] },
};
describe('workspace selection persistence', () => {
  beforeEach(() => {
    selectWorkspace(null);
    localStorage.clear();
  });
  it('restores an unnamed draft using fresh backend detail', async () => {
    localStorage.setItem('woody.selectedWorkspace', 'p');
    await hydrateSelectedWorkspace(async () => workspace);
    expect(getSelectedWorkspace()).toEqual(workspace);
  });
  it('does not overwrite a newer choice with a late restore response', async () => {
    localStorage.setItem('woody.selectedWorkspace', 'p');
    let resolve!: (value: typeof workspace) => void;
    const pending = hydrateSelectedWorkspace(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    selectWorkspace({ ...workspace, project_id: 'new' });
    resolve(workspace);
    await pending;
    expect(getSelectedWorkspace()?.project_id).toBe('new');
  });
  it('keeps the saved identity available after a backend outage', async () => {
    localStorage.setItem('woody.selectedWorkspace', 'p');
    await expect(
      hydrateSelectedWorkspace(async () => {
        throw new Error('offline');
      })
    ).rejects.toThrow('offline');
    expect(localStorage.getItem('woody.selectedWorkspace')).toBe('p');
  });
});
