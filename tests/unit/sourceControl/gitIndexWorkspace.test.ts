import { describe, expect, it } from 'vitest';

import { createTemporaryGitIndex } from '@/process/services/sourceControl/gitIndexWorkspace';

describe('temporary git index workspace', () => {
  it('creates a disposable index environment and removes it on cleanup', async () => {
    const workspace = await createTemporaryGitIndex('D:/repo');

    expect(workspace.env.GIT_INDEX_FILE).toContain('woody-git-index-');
    await workspace.cleanup();
    expect(workspace.cleaned).toBe(true);
  });
});
