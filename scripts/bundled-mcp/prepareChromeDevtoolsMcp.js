/**
 * Build-time preparation only. Installed applications never run this downloader.
 *
 * The in-app browser MCP runs the vendored chrome-devtools-mcp from
 * resources/bundled-mcp/chrome-devtools-mcp/build so it starts without the network.
 * That build is third-party output and stays out of Git (`build/` is ignored); this
 * script fetches the pinned npm tarball, checks its integrity, and installs the build.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { downloadArchive } = require('./downloadArchive.js');

const LABEL = 'Chrome DevTools MCP';
const OFFLINE_VARIABLE = 'AIONUI_CHROME_DEVTOOLS_MCP_TARBALL';

async function digest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

/** npm's `sha512-<base64>` integrity string. */
async function verifyIntegrity(file, integrity) {
  const [algorithm, expected] = integrity.split('-', 2);
  if (algorithm !== 'sha512' || !expected)
    throw new Error(`${LABEL} manifest has an unsupported integrity: ${integrity}`);
  const actual = await digest(file, 'sha512', 'base64');
  if (actual !== expected)
    throw new Error(`${LABEL} tarball integrity mismatch: ${file}; expected ${expected}, received ${actual}`);
}

async function verifySha256(file, expected) {
  const actual = await digest(file, 'sha256', 'hex');
  if (actual !== expected)
    throw new Error(`${LABEL} SHA256 mismatch: ${file}; expected ${expected}, received ${actual}`);
}

/** Windows' own bsdtar; the Git for Windows tar on PATH reads `C:` as a remote host. */
function tarExecutable(platform = process.platform, env = process.env) {
  return platform === 'win32' ? path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

async function verifyInstalled(bundleDir, manifest) {
  for (const file of [manifest.entry, manifest.bundle]) {
    const target = path.join(bundleDir, file.path);
    if (!fs.existsSync(target)) return false;
    await verifySha256(target, file.sha256);
  }
  return true;
}

async function prepareChromeDevtoolsMcp({
  projectRoot = path.resolve(__dirname, '../..'),
  env = process.env,
  allowDownload = true,
  download = downloadArchive,
} = {}) {
  const bundleDir = path.join(projectRoot, 'resources/bundled-mcp/chrome-devtools-mcp');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
  const localTarball = env[OFFLINE_VARIABLE];
  if (localTarball && !fs.existsSync(localTarball)) throw new Error(`${OFFLINE_VARIABLE} is missing: ${localTarball}`);
  if (!localTarball && (await verifyInstalled(bundleDir, manifest))) {
    console.log(`[chrome-devtools-mcp] Verified cached ${manifest.version} build.`);
    return { skipped: false, version: manifest.version, cached: true };
  }
  if (!localTarball && !allowDownload)
    throw new Error(
      `${LABEL} build is missing. Set ${OFFLINE_VARIABLE} to the pinned npm tarball and run preparation again.`
    );
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-chrome-devtools-mcp-'));
  try {
    const tarball = localTarball || path.join(stagingDir, 'package.tgz');
    if (!localTarball)
      await download(manifest.tarball.url, tarball, env, { label: LABEL, offlineVariable: OFFLINE_VARIABLE });
    await verifyIntegrity(tarball, manifest.tarball.integrity);
    const extracted = path.join(stagingDir, 'extracted');
    fs.mkdirSync(extracted);
    const extraction = spawnSync(tarExecutable(), ['-xzf', path.resolve(tarball), '-C', extracted], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (extraction.error || extraction.status !== 0)
      throw new Error(`${LABEL} tarball extraction failed: ${extraction.error?.message || extraction.stderr}`);
    const build = path.join(extracted, 'package', 'build');
    for (const file of [manifest.entry, manifest.bundle])
      await verifySha256(path.join(extracted, 'package', file.path), file.sha256);
    if (!fs.existsSync(path.join(build, 'src/third_party/THIRD_PARTY_NOTICES')))
      throw new Error(`${LABEL} tarball is missing its third-party notices.`);
    const target = path.join(bundleDir, 'build');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    fs.cpSync(build, target, { recursive: true });
    if (!(await verifyInstalled(bundleDir, manifest))) throw new Error(`${LABEL} build was not installed.`);
    console.log(`[chrome-devtools-mcp] Prepared ${manifest.version}; tarball integrity and entry SHA256 verified.`);
    return { skipped: false, version: manifest.version, cached: false };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (require.main === module) {
  prepareChromeDevtoolsMcp().catch((error) => {
    console.error(`[chrome-devtools-mcp] ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { prepareChromeDevtoolsMcp, tarExecutable };
