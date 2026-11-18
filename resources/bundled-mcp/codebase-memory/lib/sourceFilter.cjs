'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MARKER_START = '# BEGIN WOODY-CBM-SOURCE-ONLY';
const MARKER_END = '# END WOODY-CBM-SOURCE-ONLY';

const SOURCE_ONLY_RULES = [
  '**/test/',
  '**/tests/',
  '**/__tests__/',
  '**/fixtures/',
  '**/testdata/',
  '**/test_data/',
  '**/e2e/',
  '**/integration/',
  '**/build/',
  '**/dist/',
  '**/obj/',
  '**/tmp/',
  '**/temp/',
  '**/out/',
  '**/target/',
  '**/generated/',
  '**/gen/',
  '**/scripts/',
  '**/tools/',
  '**/vendor/',
  '**/vendored/',
  '**/third_party/',
  '**/thirdparty/',
  '**/*_test.*',
  '**/test_*.*',
  '**/*.test.*',
  '**/*.spec.*',
  '**/conftest.py',
];

// A C or C++ project indexes only its sources and headers. Build scripts, CMake, Makefiles,
// assembly and config files otherwise fill searches and the graph; the indexer also picks up
// extensionless files and `#!` scripts, so only an allow list keeps them out.
const C_FAMILY_EXTENSIONS = ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'];
// Folders codebase-memory-mcp v0.12.1 skips by name, from its binary. The allow list has to
// re-include every folder (`!*/`), which also overrides these, so they are listed again.
const INDEXER_SKIPPED_ALWAYS = [
  '.git',
  'node_modules',
  '.worktrees',
  '.claude-worktrees',
  'storage/framework/views',
  '.hg',
  '.svn',
  '.idea',
  '.vs',
  '.vscode',
  '.eclipse',
  '.claude',
  'Antigravity',
  '.cache',
  '.eggs',
  '.env',
  '.mypy_cache',
  '.nox',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  '__pycache__',
  'env',
  'htmlcov',
  'site-packages',
  'venv',
  '.npm',
  '.nyc_output',
  '.pnpm-store',
  '.yarn',
  'bower_components',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.docusaurus',
  '.expo',
  'dist',
  'obj',
  'Pods',
  'target',
  'temp',
  'tmp',
  '.terraform',
  '.serverless',
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  '.cargo',
  '.stack-work',
  '.dart_tool',
  'zig-cache',
  'zig-out',
  '.metals',
  '.bloop',
  '.bsp',
  '.ccls-cache',
  '.clangd',
  'elm-stuff',
  '_opam',
  '.cpcache',
  '.shadow-cljs',
  '.vercel',
  '.netlify',
  'deploy',
  'deployed',
  '.codebase-memory',
  '.qdrant_code_embeddings',
  '.tmp',
];
// Skipped by name in the fast and moderate modes only.
const INDEXER_SKIPPED_FILTERED = [
  'vendor',
  'vendored',
  'generated',
  'gen',
  'auto-generated',
  'fixtures',
  'testdata',
  'test_data',
  '__tests__',
  '__mocks__',
  '__snapshots__',
  '__fixtures__',
  '__test__',
  'docs',
  'doc',
  'documentation',
  'examples',
  'example',
  'samples',
  'sample',
  'assets',
  'static',
  'public',
  'media',
  'third_party',
  'thirdparty',
  '3rdparty',
  'external',
  'migrations',
  'seeds',
  'e2e',
  'integration',
  'locale',
  'locales',
  'i18n',
  'l10n',
  'scripts',
  'tools',
  'hack',
  'bin',
  'build',
  'out',
];

// Skipped folder names a C or C++ project indexes after all. An `obj` folder there can hold
// sources (protocol objects, for one); a build's `obj` holds object files, which the allow
// list keeps out anyway.
const C_FAMILY_INDEXED = new Set(['obj']);

/** Rules that keep only C and C++ sources and headers, with the indexer's folder skips for `mode`. */
function cFamilyRules(mode) {
  const skipped = (
    mode === 'full' ? INDEXER_SKIPPED_ALWAYS : [...INDEXER_SKIPPED_ALWAYS, ...INDEXER_SKIPPED_FILTERED]
  ).filter((name) => !C_FAMILY_INDEXED.has(name));
  return [
    '*',
    '!*/',
    ...C_FAMILY_EXTENSIONS.map((extension) => `!*.${extension}`),
    ...skipped.map((name) => `**/${name}/`),
  ];
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function detectGit(root) {
  const topLevel = runGit(root, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return null;
  const infoExclude = runGit(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!infoExclude) return null;
  return {
    topLevel: path.resolve(topLevel),
    infoExclude: path.resolve(path.isAbsolute(infoExclude) ? infoExclude : path.join(root, infoExclude)),
  };
}

const LEGACY_DECODERS = ['gb18030'].flatMap((label) => {
  try {
    return [new TextDecoder(label)];
  } catch {
    return [];
  }
});
const ratio = (text, pattern) => (text.length ? (text.match(pattern) || []).length / text.length : 0);
const REPLACEMENT = /\uFFFD/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function isUtf16(bytes) {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) return true;
  const text = buffer.toString('utf8');
  if (ratio(text, CONTROL) >= 0.02) return false;
  return (
    ratio(text, REPLACEMENT) < 0.02 ||
    LEGACY_DECODERS.some((decoder) => ratio(decoder.decode(buffer), REPLACEMENT) < 0.02)
  );
}

function readTextFile(filename) {
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`${filename} must not be a symbolic link`);
    const bytes = fs.readFileSync(filename);
    if (isUtf16(bytes)) throw new Error(`${filename} is UTF-16`);
    if (bytes.includes(0) || !looksLikeText(bytes)) return { exists: true, bytes, writable: false };
    return { exists: true, bytes, writable: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0), writable: true };
    throw error;
  }
}

function removeMarkerBlocks(bytes) {
  // latin1 is a reversible byte mapping, not an encoding conversion. Only our
  // complete ASCII marker blocks are removed; GBK comments and EOLs stay intact.
  const text = bytes.toString('latin1');
  const clean = text.replace(
    /^# BEGIN WOODY-CBM-SOURCE-ONLY\r?\n# token: [^\r\n]+\r?\n[\s\S]*?^# END WOODY-CBM-SOURCE-ONLY(?:\r?\n|$)/gm,
    ''
  );
  if (clean.includes(MARKER_START))
    throw new Error('Incomplete source-only filter marker; restore the ignore file first');
  return Buffer.from(clean, 'latin1');
}

function markerBlock(token, rules) {
  return [MARKER_START, `# token: ${token}`, ...rules, MARKER_END].join('\n');
}

function createLayer(filename, block, prepend) {
  const original = readTextFile(filename);
  if (!original.writable) return null;
  const restore = removeMarkerBlocks(original.bytes);
  const eol = restore.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const marker = Buffer.from(`${block.replace(/\n/g, eol)}${eol}`, 'ascii');
  // Default exclusions precede user rules so explicit includes remain effective.
  // Keep a UTF-8 BOM at the start where the native parser expects it.
  const bomLength = restore.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const expected = prepend
    ? Buffer.concat([restore.subarray(0, bomLength), marker, restore.subarray(bomLength)])
    : Buffer.concat([restore, restore.length && restore.at(-1) !== 10 ? Buffer.from(eol) : Buffer.alloc(0), marker]);
  return {
    filename,
    expected,
    restore,
    originallyExists: original.exists,
  };
}

function restoreLayer(layer) {
  let current;
  try {
    if (fs.lstatSync(layer.filename).isSymbolicLink())
      return { restored: false, conflict: `${layer.filename} is now a symbolic link` };
    current = fs.readFileSync(layer.filename);
  } catch (error) {
    if (error.code === 'ENOENT' && !layer.originallyExists) return { restored: true };
    return { restored: false, conflict: `${layer.filename}: ${error.message}` };
  }
  if (current.equals(layer.restore)) return { restored: true };
  if (!current.equals(layer.expected)) return { restored: false, conflict: `${layer.filename} changed while indexing` };
  try {
    if (layer.originallyExists) fs.writeFileSync(layer.filename, layer.restore);
    else fs.unlinkSync(layer.filename);
    return { restored: true };
  } catch (error) {
    return { restored: false, conflict: `${layer.filename}: ${error.message}` };
  }
}

function readOwner(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

function dead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function ownerStopped(owner) {
  if (!owner || !dead(owner.pid)) return false;
  // The index process can outlive the adapter. The project lock records its
  // PID (the launcher when using PowerShell); keep its active filter intact.
  if (!owner.indexLock) return true;
  const indexOwner = readOwner(path.join(owner.indexLock, 'owner.json'));
  if (!indexOwner || typeof indexOwner.token !== 'string') return false;
  return indexOwner.token !== owner.indexToken || !indexOwner.childPid || dead(indexOwner.childPid);
}

function serializedLayer(layer) {
  return { ...layer, expected: layer.expected.toString('base64'), restore: layer.restore.toString('base64') };
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(left) === normalize(right);
}

function restoreSavedLayers(owner, filename) {
  // The journal can be inside an untrusted project. Validate every target
  // before restoring any bytes, including shared worktrees' project filters.
  const allowed = (layer) => {
    if (!layer || typeof layer.filename !== 'string' || !path.isAbsolute(layer.filename)) return false;
    if (
      typeof layer.expected !== 'string' ||
      typeof layer.restore !== 'string' ||
      typeof layer.originallyExists !== 'boolean'
    )
      return false;
    if (samePath(layer.filename, filename)) return true;
    if (path.basename(filename) === '.cbmignore' || path.basename(layer.filename) !== '.cbmignore') return false;
    const git = detectGit(path.dirname(layer.filename));
    return git && samePath(git.infoExclude, filename);
  };
  if (!Array.isArray(owner.layers) || owner.layers.length > 2 || !owner.layers.every(allowed))
    throw new Error('Invalid source-only recovery target');
  for (const saved of [...owner.layers].reverse()) {
    const result = restoreLayer({
      ...saved,
      expected: Buffer.from(saved.expected, 'base64'),
      restore: Buffer.from(saved.restore, 'base64'),
    });
    if (!result.restored) throw new Error(`Cannot recover source-only index filter: ${result.conflict}`);
  }
}

function retireFilterLock(directory) {
  // Rename before deleting the journal, so interruption cannot leave a lock
  // with no owner. Cleanup touches only known files in this retired directory.
  const retired = `${directory}.${crypto.randomUUID()}.stale`;
  fs.renameSync(directory, retired);
  try {
    for (const name of fs.readdirSync(retired)) {
      if (name === 'owner.json' || /^[0-9a-f-]{36}\.tmp$/.test(name)) fs.unlinkSync(path.join(retired, name));
    }
    fs.rmdirSync(retired);
  } catch (error) {
    console.warn(`[CodebaseMemory] Retired filter journal remains at ${retired}: ${error.message}`);
  }
}

function acquireFilterLock(filename, indexOwner) {
  const directory = `${filename}.woody-source-lock`;
  const ownerFile = path.join(directory, 'owner.json');
  const recovery = `${directory}.recovery`;
  const busy = () => new Error('An index is already running for this Git repository or project');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        fs.mkdirSync(recovery);
      } catch {
        throw busy();
      }
      try {
        const previous = readOwner(ownerFile);
        if (!ownerStopped(previous)) throw busy();
        restoreSavedLayers(previous, filename);
        retireFilterLock(directory);
      } finally {
        fs.rmdirSync(recovery);
      }
      continue;
    }
    const owner = { pid: process.pid, token: crypto.randomUUID(), ...indexOwner, layers: [] };
    const save = (layers) => {
      owner.layers = layers.map(serializedLayer);
      const temp = path.join(directory, `${owner.token}.tmp`);
      fs.writeFileSync(temp, JSON.stringify(owner));
      fs.renameSync(temp, ownerFile);
    };
    const release = () => {
      if (readOwner(ownerFile)?.token !== owner.token) return;
      retireFilterLock(directory);
    };
    try {
      save([]);
    } catch (error) {
      fs.rmSync(path.join(directory, `${owner.token}.tmp`), { force: true });
      fs.rmdirSync(directory);
      throw error;
    }
    return { save, release };
  }
  throw busy();
}

/**
 * Install the temporary index filters. `options.cFamily` restricts the index to C and C++
 * sources and headers; `options.mode` is the index mode, whose folder skips that rule keeps.
 */
function prepareSourceOnlyOverlay(root, indexOwner = {}, options = {}) {
  const git = detectGit(root);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const lock = acquireFilterLock(git ? git.infoExclude : path.join(root, '.cbmignore'), indexOwner);
  const layers = [];
  const install = (filename, rules, prepend) => {
    const layer = createLayer(filename, markerBlock(token, rules), prepend);
    if (!layer) return;
    layers.push(layer);
    // Journal original bytes before mutating either file for crash recovery.
    lock.save(layers);
    fs.writeFileSync(filename, layer.expected);
  };
  try {
    if (git) install(git.infoExclude, ['*'], false);
    // Prepended: the user's own lines come after and can still include a folder or a file type.
    const rules = options.cFamily
      ? [
          ...cFamilyRules(options.mode),
          ...SOURCE_ONLY_RULES.filter((rule) => !C_FAMILY_INDEXED.has(rule.replace(/^\*\*\/|\/$/g, ''))),
        ]
      : SOURCE_ONLY_RULES;
    install(path.join(root, '.cbmignore'), rules, true);
  } catch (error) {
    for (const layer of [...layers].reverse()) restoreLayer(layer);
    lock.release();
    throw new Error(`Cannot establish source-only index filter: ${error.message}`);
  }

  return {
    gitTrackedOnly: Boolean(git),
    cSourcesOnly: Boolean(options.cFamily),
    files: layers.map((layer) => layer.filename),
    cleanup() {
      const conflicts = [];
      for (const layer of [...layers].reverse()) {
        const result = restoreLayer(layer);
        if (!result.restored && result.conflict) conflicts.push(result.conflict);
      }
      lock.release();
      return conflicts.length ? { restored: false, conflict: conflicts.join('; ') } : { restored: true };
    },
  };
}

module.exports = {
  C_FAMILY_EXTENSIONS,
  MARKER_END,
  MARKER_START,
  SOURCE_ONLY_RULES,
  cFamilyRules,
  detectGit,
  prepareSourceOnlyOverlay,
};
