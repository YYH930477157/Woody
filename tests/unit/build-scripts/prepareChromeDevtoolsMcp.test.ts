import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { prepareChromeDevtoolsMcp, tarExecutable } =
  require('../../../scripts/bundled-mcp/prepareChromeDevtoolsMcp.js') as {
    prepareChromeDevtoolsMcp: (options: Record<string, unknown>) => Promise<{ cached: boolean; version: string }>;
    tarExecutable: () => string;
  };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
let root: string;
let tarball: string;
let integrity: string;

/** A tarball shaped like the npm package, with its manifest in a temporary project. */
function fixture({ notices = true } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'woody-cdm-tarball-'));
  const files: Record<string, string> = {
    'package/build/src/index.js': 'export {};\n',
    'package/build/src/third_party/index.js': '// bundled\n',
    ...(notices ? { 'package/build/src/third_party/THIRD_PARTY_NOTICES': 'notices\n' } : {}),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    writeFileSync(path.join(work, name), text);
  }
  tarball = path.join(root, 'package.tgz');
  const packed = spawnSync(tarExecutable(), ['-czf', tarball, '-C', work, 'package'], { encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr);
  rmSync(work, { recursive: true, force: true });
  integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  const bundleDir = path.join(root, 'resources/bundled-mcp/chrome-devtools-mcp');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      version: '0.16.0',
      tarball: { url: 'https://registry.example/package.tgz', integrity },
      entry: { path: 'build/src/index.js', sha256: sha256('export {};\n') },
      bundle: { path: 'build/src/third_party/index.js', sha256: sha256('// bundled\n') },
    })
  );
  return bundleDir;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'woody-cdm-project-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('chrome-devtools-mcp build preparation', () => {
  it('installs a verified local tarball, then reuses the verified build', async () => {
    const bundleDir = fixture();
    const env = { AIONUI_CHROME_DEVTOOLS_MCP_TARBALL: tarball };
    expect(await prepareChromeDevtoolsMcp({ projectRoot: root, env })).toMatchObject({ cached: false });
    expect(readFileSync(path.join(bundleDir, 'build/src/index.js'), 'utf8')).toBe('export {};\n');
    const download = vi.fn();
    expect(await prepareChromeDevtoolsMcp({ projectRoot: root, env: {}, download })).toMatchObject({ cached: true });
    expect(download).not.toHaveBeenCalled();
  });

  it('downloads the pinned tarball when nothing is installed', async () => {
    fixture();
    const download = vi.fn(async (_url: string, destination: string) => {
      writeFileSync(destination, readFileSync(tarball));
    });
    await prepareChromeDevtoolsMcp({ projectRoot: root, env: {}, download });
    expect(download).toHaveBeenCalledWith(
      'https://registry.example/package.tgz',
      expect.any(String),
      {},
      {
        label: 'Chrome DevTools MCP',
        offlineVariable: 'AIONUI_CHROME_DEVTOOLS_MCP_TARBALL',
      }
    );
  });

  it('rejects a tarball that does not match the pinned integrity and keeps the old build', async () => {
    const bundleDir = fixture();
    mkdirSync(path.join(bundleDir, 'build'), { recursive: true });
    writeFileSync(path.join(bundleDir, 'build/old.js'), 'old');
    writeFileSync(tarball, 'tampered');
    await expect(
      prepareChromeDevtoolsMcp({ projectRoot: root, env: { AIONUI_CHROME_DEVTOOLS_MCP_TARBALL: tarball } })
    ).rejects.toThrow('integrity mismatch');
    expect(existsSync(path.join(bundleDir, 'build/old.js'))).toBe(true);
  });

  it('requires the third-party notices and an offline tarball when downloads are off', async () => {
    fixture({ notices: false });
    await expect(
      prepareChromeDevtoolsMcp({ projectRoot: root, env: { AIONUI_CHROME_DEVTOOLS_MCP_TARBALL: tarball } })
    ).rejects.toThrow('third-party notices');
    await expect(prepareChromeDevtoolsMcp({ projectRoot: root, env: {}, allowDownload: false })).rejects.toThrow(
      'AIONUI_CHROME_DEVTOOLS_MCP_TARBALL'
    );
  });

  it('pins the same version the launcher falls back to and the vendored package declares', () => {
    const manifest = JSON.parse(readFileSync('resources/bundled-mcp/chrome-devtools-mcp/manifest.json', 'utf8'));
    const vendored = JSON.parse(readFileSync('resources/bundled-mcp/chrome-devtools-mcp/package.json', 'utf8'));
    const launcher = readFileSync('packages/desktop/src/process/resources/builtinMcp/browserServer.ts', 'utf8');
    expect(vendored.version).toBe(manifest.version);
    expect(launcher).toContain(`const CHROME_DEVTOOLS_MCP_VERSION = '${manifest.version}'`);
    expect(manifest.tarball.url).toContain(`chrome-devtools-mcp-${manifest.version}.tgz`);
  });
});
