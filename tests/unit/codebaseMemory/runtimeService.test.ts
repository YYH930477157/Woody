import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createCodebaseMemoryService } from '@/process/services/codebaseMemory/service';

it('loads the shared runtime beside the packaged adapter and returns managed Node transport', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-service-'));
  const service = createCodebaseMemoryService({
    binaryPath: process.execPath,
    adapterPath: path.resolve('resources/bundled-mcp/codebase-memory/index.cjs'),
    cacheRoot: path.join(repo, 'cache'),
    skillPath: 'bundled-skill',
  });
  try {
    await service.save(repo, { version: 1, enabled: true, mode: 'fast' });
    expect(await service.session(repo)).toMatchObject({
      enabled: true,
      skillPath: 'bundled-skill',
      transport: { command: 'node', env: { WOODY_CBM_REPO: fs.realpathSync.native(repo) } },
    });
  } finally {
    service.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
