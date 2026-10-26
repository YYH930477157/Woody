import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { prepareCodebaseMemory, resolveBuildTarget } = require('../../../scripts/bundled-mcp/prepareCodebaseMemory.js');
const roots: string[] = [];
function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'woody-cbm-bundle-test-'));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('pinned offline codebase memory bundle', () => {
  it('rejects a missing explicitly supplied archive without downloading', async () => {
    const root = fixtureRoot();
    await expect(
      prepareCodebaseMemory({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        env: { AIONUI_CODEBASE_MEMORY_ARCHIVE: path.join(root, 'missing.zip') },
      })
    ).rejects.toThrow(/AIONUI_CODEBASE_MEMORY_ARCHIVE.*missing/i);
  });

  it('rejects an archive whose contents do not match the pinned checksum', async () => {
    const root = fixtureRoot();
    const archive = path.join(root, 'wrong.zip');
    writeFileSync(archive, 'not the pinned upstream archive');
    await expect(
      prepareCodebaseMemory({
        projectRoot: root,
        platform: 'win32',
        arch: 'x64',
        env: { AIONUI_CODEBASE_MEMORY_ARCHIVE: archive },
      })
    ).rejects.toThrow(/SHA256 mismatch/);
  });

  it('rejects a missing bundle when downloads are disabled', async () => {
    await expect(
      prepareCodebaseMemory({
        projectRoot: fixtureRoot(),
        platform: 'win32',
        arch: 'x64',
        env: {},
        allowDownload: false,
      })
    ).rejects.toThrow(/AIONUI_CODEBASE_MEMORY_ARCHIVE/);
  });

  it('does not trust an existing executable with the wrong digest', async () => {
    const root = fixtureRoot();
    const target = path.join(root, 'resources/bundled-mcp/codebase-memory/bin/win32-x64');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'codebase-memory-mcp.exe'), 'corrupted executable');
    await expect(
      prepareCodebaseMemory({ projectRoot: root, platform: 'win32', arch: 'x64', env: {}, allowDownload: false })
    ).rejects.toThrow(/SHA256 mismatch/);
  });

  it.each([
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'arm64'],
  ])('explicitly skips unsupported target %s/%s without downloading', async (platform, arch) => {
    await expect(prepareCodebaseMemory({ projectRoot: fixtureRoot(), platform, arch, env: {} })).resolves.toMatchObject(
      { skipped: true, reason: 'unsupported-platform' }
    );
  });
});

describe('build target routing', () => {
  it('uses the requested target platform instead of the build host', () => {
    expect(resolveBuildTarget(['--win'], ['x64'], 'linux')).toEqual({ platform: 'win32', arch: 'x64' });
  });
  it('prepares the Windows x64 asset when a multi-target build includes it', () => {
    expect(resolveBuildTarget(['--all'], ['x64'], 'win32')).toEqual({ platform: 'win32', arch: 'x64' });
    expect(resolveBuildTarget(['--win'], ['arm64', 'x64'], 'win32')).toEqual({ platform: 'win32', arch: 'x64' });
  });
});
