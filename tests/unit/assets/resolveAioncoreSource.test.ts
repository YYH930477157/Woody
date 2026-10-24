import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveAioncoreRepo, resolveAioncoreVersion } = require('../../../scripts/resolveAioncoreVersion.js');
const { getDownloadUrl } = require('../../../packages/shared-scripts/src/prepare-aioncore');

const roots: string[] = [];

function projectWith(pins: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'aionui-aioncore-pin-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', ...pins }));
  return root;
}

afterEach(() => {
  delete process.env.AIONUI_BACKEND_REPO;
  delete process.env.AIONUI_BACKEND_VERSION;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('aioncore release source', () => {
  it('downloads the pinned version from the repository pinned beside it', () => {
    const root = projectWith({ aioncoreRepo: 'owner/AionCore', aioncoreVersion: 'v0.2.2-woody.1' });
    const repo = resolveAioncoreRepo(root);
    const tag = resolveAioncoreVersion(root);

    expect(getDownloadUrl(`aioncore-${tag}-x86_64-pc-windows-msvc.zip`, tag, repo)).toBe(
      'https://github.com/owner/AionCore/releases/download/v0.2.2-woody.1/aioncore-v0.2.2-woody.1-x86_64-pc-windows-msvc.zip'
    );
  });

  it('lets the environment override the pinned repository', () => {
    process.env.AIONUI_BACKEND_REPO = ' other/AionCore ';
    expect(resolveAioncoreRepo(projectWith({ aioncoreRepo: 'owner/AionCore' }))).toBe('other/AionCore');
  });

  it('falls back to upstream when no repository is pinned', () => {
    expect(resolveAioncoreRepo(projectWith({ aioncoreVersion: 'v0.2.2' }))).toBe('iOfficeAI/AionCore');
  });

  it('rejects a repository that is not owner/name', () => {
    expect(() => resolveAioncoreRepo(projectWith({ aioncoreRepo: 'https://github.com/owner/AionCore' }))).toThrow(
      /expected "owner\/name"/
    );
  });
});
