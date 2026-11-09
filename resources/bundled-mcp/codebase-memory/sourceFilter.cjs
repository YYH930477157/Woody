'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

function isUtf16(bytes) {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

function readTextFile(filename) {
  try {
    const bytes = fs.readFileSync(filename);
    if (isUtf16(bytes)) throw new Error(`${filename} is UTF-16`);
    const text = bytes.toString('utf8');
    if (text.includes('\uFFFD')) throw new Error(`${filename} is not readable as UTF-8 text`);
    return { exists: true, bytes, text };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: Buffer.alloc(0), text: '' };
    throw error;
  }
}

function removeMarkerBlocks(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && line.startsWith(MARKER_START)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (line.startsWith(MARKER_END)) skipping = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join(lineEnding(text));
}

function lineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function appendBlock(text, block, eol) {
  const separator = text.length === 0 || text.endsWith('\n') ? '' : eol;
  return `${text}${separator}${block.replace(/\n/g, eol)}${eol}`;
}

function markerBlock(token, rules) {
  return [MARKER_START, `# token: ${token}`, ...rules, MARKER_END].join('\n');
}

function createLayer(filename, block, token) {
  const original = readTextFile(filename);
  const eol = lineEnding(original.text);
  const base = removeMarkerBlocks(original.text);
  const nextText = appendBlock(base, block, eol);
  const expected = Buffer.from(nextText, 'utf8');
  const restore = Buffer.from(base, 'utf8');
  fs.writeFileSync(filename, expected);
  return {
    filename,
    expected,
    restore,
    originallyExists: original.exists,
    token,
  };
}

function restoreLayer(layer) {
  let current;
  try {
    current = fs.readFileSync(layer.filename);
  } catch (error) {
    if (error.code === 'ENOENT' && !layer.originallyExists) return { restored: true };
    return { restored: false, conflict: `${layer.filename}: ${error.message}` };
  }
  if (!current.equals(layer.expected)) return { restored: false, conflict: `${layer.filename} changed while indexing` };
  try {
    if (layer.originallyExists) fs.writeFileSync(layer.filename, layer.restore);
    else fs.unlinkSync(layer.filename);
    return { restored: true };
  } catch (error) {
    return { restored: false, conflict: `${layer.filename}: ${error.message}` };
  }
}

function prepareSourceOnlyOverlay(root) {
  const git = detectGit(root);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const layers = [];
  try {
    if (git) layers.push(createLayer(git.infoExclude, markerBlock(token, ['*']), token));
    layers.push(createLayer(path.join(root, '.cbmignore'), markerBlock(token, SOURCE_ONLY_RULES), token));
  } catch (error) {
    for (const layer of layers.reverse()) restoreLayer(layer);
    throw new Error(`Cannot establish source-only index filter: ${error.message}`);
  }

  return {
    gitTrackedOnly: Boolean(git),
    files: layers.map((layer) => layer.filename),
    cleanup() {
      const conflicts = [];
      for (const layer of [...layers].reverse()) {
        const result = restoreLayer(layer);
        if (!result.restored && result.conflict) conflicts.push(result.conflict);
      }
      return conflicts.length ? { restored: false, conflict: conflicts.join('; ') } : { restored: true };
    },
  };
}

module.exports = {
  MARKER_END,
  MARKER_START,
  SOURCE_ONLY_RULES,
  detectGit,
  prepareSourceOnlyOverlay,
};
