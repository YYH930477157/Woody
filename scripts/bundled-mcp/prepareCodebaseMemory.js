/** Build-time preparation only. Installed applications never run this downloader. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { downloadArchive } = require('./downloadArchive.js');
const manifest = require('../../resources/bundled-mcp/codebase-memory/manifest.json');

async function verifyHash(file, expected) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expected)
    throw new Error(`Codebase Memory SHA256 mismatch: ${file}; expected ${expected}, received ${actual}`);
}

/** Resolve the packaged target, which may differ from the host running this script. */
function resolveBuildTarget(args, architectures, hostPlatform = process.platform) {
  const platform =
    args.includes('--win') || args.includes('--all')
      ? 'win32'
      : args.includes('--mac')
        ? 'darwin'
        : args.includes('--linux')
          ? 'linux'
          : hostPlatform;
  return { platform, arch: architectures.includes('x64') ? 'x64' : architectures[0] || process.arch };
}

/** Prepare a pinned Windows x64 executable and the upstream redistribution notices. */
async function prepareCodebaseMemory({
  projectRoot = path.resolve(__dirname, '../..'),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  allowDownload = true,
} = {}) {
  if (platform !== 'win32' || arch !== 'x64') {
    console.log(`[codebase-memory] Skipping ${platform}-${arch}: this feature is available only on win32-x64.`);
    return { skipped: true, reason: 'unsupported-platform' };
  }
  const bundleDir = path.join(projectRoot, 'resources/bundled-mcp/codebase-memory');
  const binaryPath = path.join(bundleDir, manifest.binary.path);
  const notices = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
  const localArchive = env.AIONUI_CODEBASE_MEMORY_ARCHIVE;
  if (localArchive && !fs.existsSync(localArchive)) {
    throw new Error(`AIONUI_CODEBASE_MEMORY_ARCHIVE is missing: ${localArchive}`);
  }
  if (localArchive) await verifyHash(localArchive, manifest.archive.sha256);
  if (!localArchive && fs.existsSync(binaryPath)) {
    await verifyHash(binaryPath, manifest.binary.sha256);
    if (notices.every((name) => fs.existsSync(path.join(bundleDir, name)))) {
      console.log(`[codebase-memory] Verified cached ${manifest.version} win32-x64 bundle.`);
      return { skipped: false, binaryPath, version: manifest.version };
    }
  }
  if (!localArchive && !allowDownload) {
    throw new Error(
      'Codebase Memory bundle is missing or incomplete. Set AIONUI_CODEBASE_MEMORY_ARCHIVE to the pinned release ZIP and run preparation again.'
    );
  }
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-codebase-memory-'));
  try {
    const archive = localArchive || path.join(stagingDir, 'release.zip');
    if (!localArchive) {
      await downloadArchive(manifest.archive.url, archive, env);
      await verifyHash(archive, manifest.archive.sha256);
    }
    const extracted = path.join(stagingDir, 'extracted');
    fs.mkdirSync(extracted);
    const extraction =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Expand-Archive -LiteralPath $env:WOODY_CBM_ARCHIVE -DestinationPath $env:WOODY_CBM_EXTRACT -Force -ErrorAction Stop',
            ],
            {
              env: { ...process.env, WOODY_CBM_ARCHIVE: path.resolve(archive), WOODY_CBM_EXTRACT: extracted },
              encoding: 'utf8',
              windowsHide: true,
            }
          )
        : spawnSync('unzip', ['-q', path.resolve(archive), '-d', extracted], { encoding: 'utf8' });
    if (extraction.error || extraction.status !== 0)
      throw new Error(`Codebase Memory archive extraction failed: ${extraction.error?.message || extraction.stderr}`);
    const extractedBinary = path.join(extracted, 'codebase-memory-mcp.exe');
    if (!fs.existsSync(extractedBinary)) throw new Error('Codebase Memory archive is missing codebase-memory-mcp.exe.');
    await verifyHash(extractedBinary, manifest.binary.sha256);
    for (const name of notices) {
      if (!fs.existsSync(path.join(extracted, name)))
        throw new Error(`Codebase Memory archive is missing required notice: ${name}`);
    }
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.copyFileSync(extractedBinary, binaryPath);
    for (const name of notices) fs.copyFileSync(path.join(extracted, name), path.join(bundleDir, name));
    console.log(`[codebase-memory] Prepared ${manifest.version} win32-x64; archive and executable SHA256 verified.`);
    return { skipped: false, binaryPath, version: manifest.version };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (require.main === module) {
  prepareCodebaseMemory({ platform: process.argv[2], arch: process.argv[3] }).catch((error) => {
    console.error(`[codebase-memory] ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { prepareCodebaseMemory, resolveBuildTarget };
