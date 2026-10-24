import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const {
  ensurePreparedAioncore,
  isPreparedAioncoreCurrent,
} = require('../../../packages/shared-scripts/src/prepare-aioncore');

const roots: string[] = [];
const pin = { platform: 'win32', arch: 'x64', version: 'v0.2.2-woody.1', repo: 'owner/AionCore' };

function writeFile(filePath: string, contents: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

/** A prepared bundle as prepareAioncore leaves it, identified by its manifest. */
function projectWithBundle(manifest?: Record<string, unknown>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'aionui-aioncore-stale-'));
  roots.push(projectRoot);
  if (manifest) {
    const bundle = join(projectRoot, 'resources', 'bundled-aioncore', 'win32-x64');
    writeFile(join(bundle, 'aioncore.exe'), 'previous binary');
    writeFile(join(bundle, 'managed-resources', 'manifest.json'), '{}');
    writeFile(join(bundle, 'manifest.json'), JSON.stringify({ platform: 'win32', arch: 'x64', ...manifest }));
  }
  return projectRoot;
}

afterEach(() => {
  delete process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR;
  delete process.env.AIONUI_BACKEND_RUN_ID;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepare-aioncore development refresh', () => {
  it('treats a bundle prepared from the pinned repository and tag as current', () => {
    const projectRoot = projectWithBundle({ repo: 'owner/AionCore', version: 'v0.2.2-woody.1' });

    expect(isPreparedAioncoreCurrent({ projectRoot, ...pin })).toBe(true);
    expect(isPreparedAioncoreCurrent({ projectRoot, ...pin, version: '0.2.2-woody.1' })).toBe(true);
    expect(ensurePreparedAioncore({ projectRoot, ...pin })).toMatchObject({ prepared: false });
  });

  it.each([
    ['another tag', { repo: 'owner/AionCore', version: 'v0.2.2' }],
    ['another repository', { repo: 'iOfficeAI/AionCore', version: 'v0.2.2-woody.1' }],
    ['a manifest written before repositories were recorded', { version: 'v0.2.2-woody.1' }],
  ])('treats a bundle from %s as stale', (_label, manifest) => {
    expect(isPreparedAioncoreCurrent({ projectRoot: projectWithBundle(manifest), ...pin })).toBe(false);
  });

  it('treats a missing or incomplete bundle as stale', () => {
    expect(isPreparedAioncoreCurrent({ projectRoot: projectWithBundle(), ...pin })).toBe(false);

    const projectRoot = projectWithBundle({ repo: 'owner/AionCore', version: 'v0.2.2-woody.1' });
    rmSync(join(projectRoot, 'resources', 'bundled-aioncore', 'win32-x64', 'aioncore.exe'));
    expect(isPreparedAioncoreCurrent({ projectRoot, ...pin })).toBe(false);
  });

  it('restores the previous bundle when the refresh fails', () => {
    const projectRoot = projectWithBundle({ repo: 'owner/AionCore', version: 'v0.2.2' });
    // An incomplete local bundle makes prepareAioncore fail before any download.
    const localBundle = join(projectRoot, 'incomplete-bundle');
    mkdirSync(join(localBundle, 'managed-resources'), { recursive: true });
    writeFileSync(join(localBundle, 'aioncore.exe'), '');
    process.env.AIONUI_BACKEND_LOCAL_BUNDLE_DIR = localBundle;

    expect(() => ensurePreparedAioncore({ projectRoot, ...pin })).toThrow(/managed-resources\/manifest\.json/);

    const bundle = join(projectRoot, 'resources', 'bundled-aioncore', 'win32-x64');
    expect(readFileSync(join(bundle, 'aioncore.exe'), 'utf8')).toBe('previous binary');
    expect(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).version).toBe('v0.2.2');
    expect(existsSync(join(projectRoot, 'resources', 'bundled-aioncore-previous', 'win32-x64'))).toBe(false);
  });
});
