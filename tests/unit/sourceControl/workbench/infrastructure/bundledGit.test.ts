import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGitRuntime } from '@process/services/sourceControl/workbench/executor/runtime';

describe('bundled Git fallback', () => {
  it('resolves the verified Git for Windows runtime when no system candidate is usable', async () => {
    const runtime = await resolveGitRuntime({
      systemCandidates: [],
      bundledExecutable: path.resolve('resources/third-party/git/cmd/git.exe'),
    });

    expect(runtime).toMatchObject({
      source: 'bundled',
      version: { major: 2, minor: 56, patch: 0 },
      capabilities: { updateRefs: true, memoryHistoryEdit: true },
    });
  });
});
