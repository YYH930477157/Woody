// Shared by Electron and the dependency-free, project-bound stdio adapter.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn, spawnSync } = require('node:child_process');
const TOOL_SCHEMAS = new Map(require('./tools.json').map((tool) => [tool.name, tool.inputSchema]));
const architecture = require('./lib/architecture.cjs');
const modules = require('./lib/modules.cjs');
const { C_FAMILY_EXTENSIONS, detectGit, prepareSourceOnlyOverlay } = require('./lib/sourceFilter.cjs');
const ARCHITECTURE_LABELS = require('./lib/architecture-labels.json');
const DEFAULT_CONFIG = { version: 1, enabled: false, mode: 'fast' };
const TOOLS = new Set([
  'index_repository',
  'index_status',
  'get_architecture',
  'search_graph',
  'trace_path',
  'get_code_snippet',
  'get_file_outline',
  'detect_changes',
  'search_code',
  'get_graph_schema',
  'check_index_coverage',
]);
const LOG_LIMIT = 16384;
const SAMPLE_FILES = 12;
const SAMPLE_BYTES = 64 * 1024;
const SAMPLE_NAMES = 40;
const SAMPLE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.py',
  '.rs',
  '.ts',
  '.tsx',
]);
const SAMPLE_SKIPPED = new Set(['build', 'dist', 'node_modules', 'out', 'target', 'third_party', 'vendor']);
const UNREADABLE_MESSAGE = 'The indexer received encrypted content, so the index contains no code from this folder';
const PRECHECK_MESSAGE =
  'This folder is encrypted for Woody: PowerShell 7 reads plaintext but Woody reads ciphertext, so the index was not started. The indexer (codebase-memory-mcp.exe) has to be on the encryption whitelist; once it is, use Index anyway in the Architecture panel.';
// Windows STATUS_ACCESS_VIOLATION surfaces as exit=-1073741819 through the daemon.
const WORKER_CRASH = /index worker ended with crash|exit=-?1073741819/i;
const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'];

// Encrypted disks give plain content only to listed programs, and PowerShell 7 is the
// one Woody can rely on. Both scripts are constant: paths and arguments stay environment data.
// ArgumentList is the only form that quotes JSON arguments correctly on every 7.x release.
const LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }
$start = [Diagnostics.ProcessStartInfo]::new($env:WOODY_CBM_EXECUTABLE)
foreach ($value in $env:WOODY_CBM_ARGUMENTS -split ',') {
  $start.ArgumentList.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)))
}
$start.UseShellExecute = $false
$start.WorkingDirectory = (Get-Location).ProviderPath
$process = [Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
`;
const SAMPLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required' }
foreach ($file in $env:WOODY_CBM_SAMPLES -split [char]10) {
  $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $buffer = [byte[]]::new(${SAMPLE_BYTES})
    $used = 0
    do {
      $count = $stream.Read($buffer, $used, $buffer.Length - $used)
      $used += $count
    } while ($count -gt 0 -and $used -lt $buffer.Length)
    [Console]::Out.WriteLine([Convert]::ToBase64String($buffer, 0, $used))
  } finally { $stream.Dispose() }
}
`;
const encodedScript = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Search absolute PATH entries only: the working directory is project content and never supplies a program. */
function findPowerShell(env = process.env) {
  if (process.platform !== 'win32') return undefined;
  const variable = (name) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const directories = (variable('PATH') || '').split(path.delimiter).filter((value) => value && path.isAbsolute(value));
  return [...directories, path.join(variable('ProgramFiles') || 'C:\\Program Files', 'PowerShell', '7')]
    .map((directory) => path.join(directory, 'pwsh.exe'))
    .find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
}
function sampleFiles(root) {
  const files = [];
  const pending = [root];
  for (let visited = 0; pending.length && files.length < SAMPLE_FILES && visited < 2000; visited++) {
    const directory = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SAMPLE_SKIPPED.has(entry.name.toLowerCase())) pending.push(child);
      } else if (entry.isFile() && SAMPLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (files.length < SAMPLE_FILES) files.push(child);
      }
    }
  }
  return files;
}
function readHead(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, SAMPLE_BYTES, 0));
  } finally {
    fs.closeSync(descriptor);
  }
}
function readThroughPowerShell(executable, files) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...POWERSHELL_FLAGS, encodedScript(SAMPLE_SCRIPT)],
      {
        env: { ...process.env, WOODY_CBM_SAMPLES: files.join('\n') },
        maxBuffer: (SAMPLE_BYTES * files.length * 4) / 3 + 1024,
        timeout: 20000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(
          stdout
            .split(/\r?\n/)
            .filter((line, index, lines) => index < lines.length - 1)
            .map((line) => Buffer.from(line, 'base64'))
        );
      }
    );
  });
}
/** One small file through PowerShell 7, synchronously: the configuration is read on every call. */
function readFileThroughPowerShellSync(executable, file) {
  const result = spawnSync(executable, [...POWERSHELL_FLAGS, encodedScript(SAMPLE_SCRIPT)], {
    env: { ...process.env, WOODY_CBM_SAMPLES: file },
    encoding: 'utf8',
    maxBuffer: SAMPLE_BYTES * 2,
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`PowerShell 7 could not read ${path.basename(file)}: ${(result.stderr || '').trim().slice(-300)}`);
  return Buffer.from(result.stdout.split(/\r?\n/)[0] || '', 'base64');
}
// ---------------------------------------------------------------------------
// Failure diagnostics
//
// An index that dies on an offline machine has to explain itself: the user's next
// step depends on whether the folder was unreadable, encrypted away from this
// process, or the launcher never started. Everything here is best-effort and must
// never throw — it runs on the failure path and is itself the last resort.
// ---------------------------------------------------------------------------
const DIAGNOSTICS_LIMIT = 32768;
const DIAGNOSTICS_SAMPLES = 5;
const DIAGNOSTICS_KEEP = 20;
// The indexer is the program that reads the code, so it is the one a whitelist has to name.
const DIAGNOSIS_ADVICE = {
  'encrypted-for-app':
    "PowerShell 7 reads plaintext from these files while Woody reads different, unreadable bytes: the folder encryption client only decrypts for whitelisted programs. Ask for the bundled indexer (codebase-memory-mcp.exe, path under 'binary' in this report) to be added to that client's whitelist, then use 'Index anyway' once in the Architecture panel, or index a folder that is not encrypted.",
  'encrypted-on-disk':
    "Every read that was probed returned ciphertext, PowerShell 7 included: the files are encrypted on disk. Ask for the bundled indexer (codebase-memory-mcp.exe, path under 'binary' in this report) to be added to the encryption client's whitelist, or index a folder that is not encrypted.",
  'permission-denied':
    'Part of the folder is not readable by this user account (access denied). Check NTFS permissions on the listed paths, then index again.',
  'missing-binary':
    'The bundled codebase-memory-mcp.exe is missing from resources/bundled-mcp/codebase-memory/bin. Reinstall Woody from a complete package.',
  'launcher-missing':
    'The launcher process could not be started (ENOENT). PowerShell 7 was not found and the direct fallback failed too.',
  timeout:
    'The indexer did not finish before the timeout. Large repositories need the "moderate" or "full" mode and more time; a locked file can also stall it.',
  'worker-crash':
    'The native index worker crashed (0xC0000005 access violation). If the folder is encrypted for this process, the worker was parsing ciphertext — fix the whitelist first (see encrypted-for-app). Otherwise attach the worker log tail from this report.',
  unknown:
    'No known cause matched. Attach the full report; it contains the native output and the samples that were readable.',
};

// Chinese projects often keep GBK sources. A runtime without the full ICU data has no
// GB18030 decoder; it then judges by UTF-8 alone.
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
/**
 * Text vs. ciphertext. Random bytes carry control characters in any ASCII-compatible
 * encoding and no decoder makes sense of them; text decodes cleanly as UTF-8, as GBK,
 * or as UTF-16 when it starts with a byte order mark.
 */
function looksLikeText(buffer) {
  if (!buffer || buffer.length === 0) return true;
  if (
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
  ) {
    const body = Buffer.from(buffer.subarray(2, buffer.length - (buffer.length % 2)));
    const text = (buffer[0] === 0xfe ? body.swap16() : body).toString('utf16le');
    return ratio(text, CONTROL) < 0.02 && ratio(text, REPLACEMENT) < 0.02;
  }
  const text = buffer.toString('utf8');
  if (ratio(text, CONTROL) >= 0.02) return false;
  return (
    ratio(text, REPLACEMENT) < 0.02 ||
    LEGACY_DECODERS.some((decoder) => ratio(decoder.decode(buffer), REPLACEMENT) < 0.02)
  );
}
/**
 * The fingerprint of an encryption client that whitelists PowerShell 7 but not Woody:
 * PowerShell reads text where this process reads different, unreadable bytes. Identical
 * bytes are never evidence, whatever they look like.
 */
function encryptedForThisProcess(probe) {
  return probe.shell.some((item, index) => {
    const direct = probe.direct[index];
    return item.ok && item.text && item.differs && Boolean(direct?.ok) && !direct.text;
  });
}
/** `attrib` reports E for EFS-encrypted files; it exists on every Windows install. */
function encryptionFlags(files) {
  if (process.platform !== 'win32' || files.length === 0) return Promise.resolve([]);
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');
  return Promise.all(
    files.map(
      (file) =>
        new Promise((resolve) => {
          execFile(executable, [file], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            if (error) return resolve(undefined);
            const line = String(stdout).split(/\r?\n/).find(Boolean) || '';
            const attributes = line.slice(0, Math.max(0, line.toLowerCase().lastIndexOf(file.toLowerCase())));
            resolve(attributes.toUpperCase().includes('E'));
          });
        })
    )
  );
}
function powerShellVersion(executable) {
  if (!executable) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : String(stdout).trim())
    );
  });
}
/** Bounded walk: counts what the indexer would see and records what it cannot open. */
function folderScan(root, limit = 5000) {
  const stats = { directories: 0, files: 0, unreadable: [], truncated: false };
  const pending = [root];
  while (pending.length > 0) {
    if (stats.directories + stats.files >= limit) {
      stats.truncated = true;
      break;
    }
    const directory = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (stats.unreadable.length < 10) stats.unreadable.push({ path: directory, code: error.code || error.message });
      continue;
    }
    stats.directories += 1;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SAMPLE_SKIPPED.has(entry.name.toLowerCase()))
          pending.push(path.join(directory, entry.name));
      } else if (entry.isFile()) stats.files += 1;
    }
  }
  return stats;
}
/**
 * Compare what this process reads with what PowerShell 7 reads. A difference is the
 * fingerprint of a folder encryption client that whitelists PowerShell but not us.
 */
async function readingProbe(root, powerShell, readShell) {
  const files = sampleFiles(root).slice(0, DIAGNOSTICS_SAMPLES);
  const probe = { files, direct: [], shell: [], shellError: undefined };
  const heads = [];
  for (const file of files) {
    try {
      const buffer = readHead(file);
      heads.push(buffer);
      probe.direct.push({ file, ok: true, text: looksLikeText(buffer) });
    } catch (error) {
      heads.push(undefined);
      probe.direct.push({ file, ok: false, text: true, error: error.code || error.message });
    }
  }
  if (!powerShell || files.length === 0) return probe;
  try {
    const buffers = await (readShell || readThroughPowerShell)(powerShell, files);
    buffers.forEach((buffer, index) => {
      probe.shell.push({
        file: files[index],
        ok: true,
        text: looksLikeText(buffer),
        differs: heads[index] !== undefined && !buffer.equals(heads[index]),
      });
    });
  } catch (error) {
    probe.shellError = error.message;
  }
  return probe;
}
/**
 * indexerReadsPlain: an earlier index proved the indexer is whitelisted, so what this
 * process reads says nothing about why the indexer failed this time.
 */
function classifyFailure({ binaryAvailable, error, probe, scan, output, indexerReadsPlain = false }) {
  if (!binaryAvailable) return 'missing-binary';
  if (error && error.code === 'ENOENT') return 'launcher-missing';
  if (error && /timed out/i.test(error.message || '')) return 'timeout';
  const cipherDirect = probe.direct.filter((item) => item.ok && !item.text).length;
  // Encryption outranks the crash: a worker chewing on ciphertext is the reason it died.
  if (!indexerReadsPlain && encryptedForThisProcess(probe)) return 'encrypted-for-app';
  if (!indexerReadsPlain && cipherDirect > 0) return 'encrypted-on-disk';
  if (WORKER_CRASH.test(String(output || ''))) return 'worker-crash';
  const denied = probe.direct.filter((item) => !item.ok && /EACCES|EPERM/i.test(String(item.error))).length;
  if (denied > 0 || scan.unreadable.length > 0) return 'permission-denied';
  return 'unknown';
}
/** The native daemon names the worker log it wants inspected; keep its tail in the report. */
function workerLogPath(output) {
  const match = /inspect log:\s*([^\r\n"]+)/i.exec(String(output || ''));
  return match ? match[1].trim() : undefined;
}
function readTail(file, limit = 8192) {
  try {
    const data = fs.readFileSync(file);
    return data.subarray(Math.max(0, data.length - limit)).toString('utf8');
  } catch {
    return undefined;
  }
}
function sampleLines(items, render) {
  return items.length > 0 ? items.map(render).join('\n') : '  (none)';
}
/** One report file per failure, newest DIAGNOSTICS_KEEP kept. Returns its path. */
function writeReport(project, text) {
  const directory = path.join(project.cache, 'diagnostics');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  const filename = path.join(directory, `${stamp}-${process.pid}.log`);
  fs.writeFileSync(filename, `${text}\n`, 'utf8');
  try {
    const reports = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.log'))
      .sort();
    for (const name of reports.slice(0, Math.max(0, reports.length - DIAGNOSTICS_KEEP)))
      fs.rmSync(path.join(directory, name), { force: true });
  } catch {
    /* Retention is cosmetic. */
  }
  return filename;
}
/** Names that look like calls: at least one of them is a symbol if the indexer saw this text. */
function symbolNames(contents) {
  const names = new Set();
  for (const content of contents)
    for (const [name] of content.toString('utf8').matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}(?=\s*\()/g))
      if (names.size < SAMPLE_NAMES) names.add(name);
  return [...names];
}

function canonical(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim() || !path.isAbsolute(repoPath))
    throw new Error('No bound project: select an absolute project folder first');
  const root = fs.realpathSync.native(repoPath);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project path must be a directory');
  return root;
}
/**
 * search_graph ranks code names with BM25, which has no tokens for Chinese or other words
 * that are not ASCII: such a query matched nothing, and the indexer then listed every node
 * in name order, which a model can mistake for an answer.
 */
const NON_ASCII_QUERY =
  'search_graph matches code names, so it cannot search for words that are not English. Find them in comments and strings with search_code({"pattern":"<words>"}), or call search_graph again with English words from the names, such as "uart receive timeout".';
const NON_ASCII_NOTE =
  'note: words that are not English were left out of the query, because search_graph matches code names. Find them in comments and strings with search_code.';
const worktreeNote = (project) =>
  `note: you work in the Git worktree ${project.worktreeRoot}, but this index describes the main checkout ${project.root}. Files you changed can differ from these results: read them in your workspace, and list them with detect_changes.`;
/** Git's output in `cwd`, with paths unquoted, or undefined when git fails or is missing. */
function gitOutput(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout : undefined;
}
const nulList = (text) => (text || '').split('\0').filter(Boolean);
const asciiWords = (query) =>
  query
    .replace(/[^\x00-\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** The text of an MCP error envelope printed on stdout, or undefined when there is none. */
function errorText(stdout) {
  try {
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!result || result.isError !== true) return undefined;
    const text = (result.content || [])
      .map((item) => item?.text || '')
      .join('\n')
      .trim();
    return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : undefined);
  } catch {
    return undefined;
  }
}
function validateConfig(config) {
  if (
    !config ||
    config.version !== 1 ||
    typeof config.enabled !== 'boolean' ||
    !['fast', 'moderate', 'full'].includes(config.mode)
  )
    throw new Error('Invalid codebase-memory configuration');
  return { version: 1, enabled: config.enabled, mode: config.mode };
}
const C_FAMILY = new Set(C_FAMILY_EXTENSIONS.map((extension) => `.${extension}`));
const cFamilyProjects = new Map();
/**
 * The mode a project starts with before it is saved. C and C++ lean on macros, and
 * only the full mode indexes them; on a 670-file firmware project full took 5.3 s
 * against 4.2 s for fast. Other projects start fast.
 */
function defaultMode(root) {
  return cFamilyProject(root) ? 'full' : 'fast';
}
/**
 * Whether most sampled code files are C or C++. Such a project indexes only its C and C++
 * sources and headers. Cached: the panel polls the default mode.
 */
function cFamilyProject(root) {
  if (cFamilyProjects.has(root)) return cFamilyProjects.get(root);
  let cFamily = 0;
  let other = 0;
  const pending = [root];
  for (let visited = 0; pending.length && visited < 400 && cFamily + other < 3000; visited++) {
    const directory = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SAMPLE_SKIPPED.has(entry.name.toLowerCase()))
          pending.push(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (C_FAMILY.has(extension)) cFamily++;
        else if (SAMPLE_EXTENSIONS.has(extension)) other++;
      }
    }
  }
  const result = cFamily > 0 && cFamily >= other;
  cFamilyProjects.set(root, result);
  return result;
}
/**
 * `throughPowerShell(filename)` returns the plain bytes when this process reads the file
 * as ciphertext: Woody may be on an encryption whitelist that the chat tools' node.exe is
 * not on, and a whitelisted program's files can be encrypted on disk.
 */
function readConfig(root, throughPowerShell) {
  try {
    const filename = configPath(root);
    let bytes = fs.readFileSync(filename);
    if (!looksLikeText(bytes)) {
      if (!throughPowerShell) throw new Error('the file is not readable as text, and PowerShell 7 was not found');
      bytes = throughPowerShell(filename);
      if (!bytes?.length || !looksLikeText(bytes))
        throw new Error('the file is not readable as text, and PowerShell 7 also reads it as ciphertext');
    }
    return validateConfig(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG, mode: defaultMode(root) };
    throw new Error(`Cannot read codebase-memory configuration: ${error.message}`);
  }
}
function configPath(root) {
  const filename = path.join(root, '.woody', 'codebase-memory.json');
  for (const candidate of [path.dirname(filename), filename]) {
    try {
      const relative = path.relative(root, fs.realpathSync.native(candidate));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Configuration points outside the project');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return filename;
}
function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function atomicJson(filename, value) {
  atomicWrite(filename, JSON.stringify(value, null, 2) + '\n');
}
function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Folder names the indexer skips by default where a project's own code can live (fast and
 * moderate skip more of them than full). Its list also holds hidden folders, dependency
 * stores and caches, which are never worth offering. The indexer still decides what it
 * skipped; these names only choose which of its skipped folders the panel offers back.
 */
const OFFERED_SKIPPED_NAMES = new Set([
  'obj',
  'tmp',
  'temp',
  'env',
  'dist',
  'target',
  'deploy',
  'deployed',
  'vendor',
  'vendored',
  'generated',
  'gen',
  'auto-generated',
  'fixtures',
  'testdata',
  'test_data',
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
]);
const SOURCE_EXTENSIONS = new Set([...C_FAMILY, ...SAMPLE_EXTENSIONS]);
const SKIPPED_FILE_CAP = 1000;
const SKIPPED_ENTRY_BUDGET = 20000;
const SKIPPED_LIMIT = 50;
const IGNORE_FILE = '.cbmignore';
/** Source files under a folder, counted by name (an encrypted disk still lists names). */
function countSources(directory, budget) {
  let files = 0;
  const pending = [directory];
  while (pending.length && files < SKIPPED_FILE_CAP && budget.entries > 0) {
    const current = pending.shift();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    budget.entries -= entries.length;
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files++;
    }
  }
  return Math.min(files, SKIPPED_FILE_CAP);
}
function ignorePath(root) {
  const filename = path.join(root, IGNORE_FILE);
  try {
    const relative = path.relative(root, fs.realpathSync.native(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`${IGNORE_FILE} points outside the project`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return filename;
}
function readIgnore(root) {
  try {
    return fs.readFileSync(ignorePath(root));
  } catch (error) {
    if (error.code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}
/** Folders a .cbmignore asks to index again, written as `!/folder/`, `!folder/` or without the slashes. */
function includedFolders(bytes) {
  const folders = new Set();
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = /^!\/?(.+?)\/?$/.exec(line.trim());
    if (match) folders.add(match[1]);
  }
  return folders;
}
/** Woody only appends to a .cbmignore it reads as text: not one encrypted for Woody, nor UTF-16. */
function ignoreWritable(bytes) {
  const utf16 =
    bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  return !utf16 && looksLikeText(bytes);
}
/**
 * Ask the indexer to index a folder it skips by name, with one `!/<folder>/` line. The line
 * is appended as bytes, so the rest of the file keeps its encoding and line endings.
 */
function addIncludeLine(root, folder) {
  const line = `!/${folder}/`;
  const yourself = `Add this line to ${IGNORE_FILE} in the project folder yourself: ${line}`;
  if (/[\r\n*?[\]\\]/.test(folder)) throw new Error(`Woody cannot write this folder name as a rule. ${yourself}`);
  const bytes = readIgnore(root);
  if (!ignoreWritable(bytes))
    throw new Error(`Woody cannot read ${IGNORE_FILE} as text; it may be encrypted for Woody. ${yourself}`);
  if (includedFolders(bytes).has(folder)) return;
  const text = bytes.toString('utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lead = !bytes.length
    ? `# Folders with source code that the indexer skips by name${eol}`
    : text.endsWith('\n')
      ? ''
      : eol;
  atomicWrite(ignorePath(root), Buffer.concat([bytes, Buffer.from(`${lead}${line}${eol}`)]));
}

const ARCHITECTURE_FILE = '.woody/architecture.md';
const EXPERTS_FILE = '.woody/experts.json';
const FEATURES_DIR = '.woody/features';
const FUNCTIONS_QUERY = 'MATCH (f:Function) RETURN f.name, f.file_path, f.start_line, f.end_line';
const FILES_QUERY = 'MATCH (f:File) RETURN f.file_path';
const VARIABLES_QUERY = 'MATCH (v:Variable) RETURN v.name, v.file_path';
const QUERY_PAGE = 10000;
const EXPERTS_MAX_BYTES = 64 * 1024;
/** The same rule as the team dialog's: lowercase ASCII words joined by "-". */
const EXPERT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COVERAGE_BATCH = 200;
/** A file Woody writes under .woody; it must stay inside the project even through links. */
function woodyPath(root, relative) {
  const filename = path.join(root, relative);
  for (const candidate of [path.dirname(filename), filename]) {
    try {
      const resolved = path.relative(root, fs.realpathSync.native(candidate));
      if (resolved.startsWith('..') || path.isAbsolute(resolved))
        throw new Error(`${relative} points outside the project`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return filename;
}
const architecturePath = (root) => woodyPath(root, ARCHITECTURE_FILE);
/**
 * The project's module experts, or undefined without a file. Read like the configuration:
 * directly, then through PowerShell 7 on machines that encrypt files for this process.
 * Entries the team dialog would refuse are left out instead of failing the whole list.
 */
function readExperts(root, throughPowerShell) {
  const filename = woodyPath(root, EXPERTS_FILE);
  let bytes;
  try {
    if (fs.statSync(filename).size > EXPERTS_MAX_BYTES) throw new Error('the file is larger than 64 KB');
    bytes = fs.readFileSync(filename);
    if (!looksLikeText(bytes)) {
      if (!throughPowerShell) throw new Error('the file is not readable as text, and PowerShell 7 was not found');
      bytes = throughPowerShell(filename);
      if (!bytes?.length || !looksLikeText(bytes))
        throw new Error('the file is not readable as text, and PowerShell 7 also reads it as ciphertext');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${EXPERTS_FILE}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`${EXPERTS_FILE} is not valid JSON: ${error.message}`);
  }
  const strings = (list) =>
    Array.isArray(list)
      ? list
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      : [];
  const experts = [];
  for (const item of Array.isArray(value?.experts) ? value.experts : []) {
    if (!item || typeof item.id !== 'string' || !EXPERT_ID.test(item.id) || item.id.length > 40) continue;
    if (experts.some((known) => known.id === item.id)) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id;
    experts.push({ id: item.id, name, paths: strings(item.paths).filter(Boolean) });
  }
  return { experts, shared: strings(value?.shared).filter(Boolean) };
}
/** A feature card as UTF-8 text, or undefined when there is none. */
function readCard(filename) {
  let bytes;
  try {
    bytes = fs.readFileSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const text = bytes.toString('utf8');
  if (!looksLikeText(bytes) || text.includes('�'))
    throw new Error(
      'Woody cannot read this feature card as UTF-8 text; it may be encrypted for Woody or saved in another encoding'
    );
  return text;
}
/** One hash for the contents of several project files, so a later change to any of them shows. */
function hashFiles(root, files) {
  const hash = crypto.createHash('sha1');
  for (const file of [...files].sort()) {
    hash.update(file).update('\0');
    try {
      hash.update(fs.readFileSync(path.join(root, file)));
    } catch {
      hash.update('missing');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
/** Cypher list of quoted strings. */
const cypherList = (list) => list.map((item) => `'${item.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',');
/**
 * The current file, or undefined when there is none. Woody only rewrites a file it reads as
 * UTF-8 text with its markers, so an encrypted or hand-written file is never replaced.
 */
function readArchitecture(filename) {
  let bytes;
  try {
    bytes = fs.readFileSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const text = bytes.toString('utf8');
  if (!looksLikeText(bytes) || text.includes('�'))
    throw new Error(
      `Woody cannot read ${ARCHITECTURE_FILE} as UTF-8 text; it may be encrypted for Woody or saved in another encoding`
    );
  if (!text.includes(architecture.MARK.start) || !text.includes(architecture.MARK.end))
    throw new Error(`${ARCHITECTURE_FILE} has no woody:generated markers; rename or delete it to generate a new one`);
  return text;
}
/** Project source as text, or null: ciphertext, unreadable or outside the project. */
function sourceReader(root) {
  return (file) => {
    if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return null;
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(root, file));
    } catch {
      return null;
    }
    if (!looksLikeText(bytes)) return null;
    const text = bytes.toString('utf8');
    if (!text.includes('�') || !LEGACY_DECODERS.length) return text.replace(/^﻿/, '');
    return LEGACY_DECODERS[0].decode(bytes);
  };
}
function localStamp(time = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
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
/**
 * The indexer prefixes every qualified name it returns with the project name, so a
 * 70-character hash took about 40% of each search or trace row the agent reads.
 * Folder name plus 8 hex characters is unique enough within one cache root.
 */
function projectName(root, hash) {
  const label = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return `${label || 'project'}-${hash.slice(0, 8)}`;
}
function identity(root, cacheRoot) {
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root;
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  // The cache directory keeps the original full-hash name: the saved status, its
  // indexerReadsPlain proof and the diagnostics stay where they were.
  const legacyName = `woody-${hash}`;
  const cache = path.join(cacheRoot, legacyName);
  return {
    root,
    name: projectName(root, hash),
    legacyName,
    cache,
    lock: path.join(cache, 'index.lock'),
    statusFile: path.join(cache, 'woody-status.json'),
  };
}
/** The index stored under the old full-hash name is unreachable once the new one exists. */
function removeLegacyIndex(project) {
  if (project.legacyName === project.name) return;
  for (const suffix of ['.db', '.db-wal', '.db-shm']) {
    try {
      fs.rmSync(path.join(project.cache, `${project.legacyName}${suffix}`), { force: true });
    } catch {
      // A daemon may still hold it open; the next successful index tries again.
    }
  }
}
function acquireLock(project) {
  fs.mkdirSync(project.cache, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(project.lock);
      const owner = { pid: process.pid, token: crypto.randomUUID() };
      try {
        atomicJson(path.join(project.lock, 'owner.json'), owner);
      } catch (error) {
        fs.rmSync(project.lock, { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recovery = `${project.lock}.recovery`;
      try {
        fs.mkdirSync(recovery);
      } catch {
        throw new Error('Index is already running for this project');
      }
      try {
        const previous = readJson(path.join(project.lock, 'owner.json'));
        // Missing/invalid owners and permission errors are never proof of death.
        if (!previous || !dead(previous.pid) || (previous.childPid && !dead(previous.childPid)))
          throw new Error('Index is already running for this project');
        const tombstone = `${project.lock}.${crypto.randomUUID()}.stale`;
        try {
          fs.renameSync(project.lock, tombstone);
          fs.rmSync(tombstone, { recursive: true });
        } catch (moveError) {
          if (moveError.code !== 'ENOENT') throw moveError;
        }
      } finally {
        fs.rmdirSync(recovery);
      }
    }
  }
  throw new Error('Index is already running for this project');
}
function releaseLock(project, owner) {
  if (readJson(path.join(project.lock, 'owner.json'))?.token === owner.token)
    fs.rmSync(project.lock, { recursive: true, force: true });
}
function safeRelative(root, value) {
  if (
    typeof value !== 'string' ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).includes('..')
  )
    throw new Error('Tool path must stay inside the bound project');
  let candidate = path.resolve(root, value);
  while (candidate !== root) {
    try {
      const relative = path.relative(root, fs.realpathSync.native(candidate));
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Tool path points outside the bound project');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      candidate = path.dirname(candidate);
    }
  }
}
function validateArgument(key, value, schema) {
  const validType =
    schema.type === 'integer'
      ? Number.isInteger(value)
      : schema.type === 'array'
        ? Array.isArray(value)
        : typeof value === schema.type;
  if (schema.type && !validType) throw new Error(`Invalid argument ${key}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid argument ${key}`);
  if (
    typeof value === 'number' &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new Error(`Argument out of range: ${key}`);
  if (typeof value === 'string' && schema.minLength && value.length < schema.minLength)
    throw new Error(`Argument too short: ${key}`);
  if (Array.isArray(value)) {
    if (schema.maxItems && value.length > schema.maxItems) throw new Error(`Too many values: ${key}`);
    if (schema.items) value.forEach((item) => validateArgument(key, item, schema.items));
  }
}
function boundArguments(project, name, supplied, config) {
  if (!TOOLS.has(name)) throw new Error(`Tool is not allowed: ${name}`);
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new Error('Tool arguments must be an object');
  const args = { ...supplied };
  if (args.project !== undefined && args.project !== project.name) throw new Error('Cannot query another project');
  if (
    args.repo_path !== undefined &&
    canonical(args.repo_path) !== project.root &&
    canonical(args.repo_path) !== project.worktreeRoot
  )
    throw new Error('Cannot index another project');
  for (const key of [
    'base_project',
    'target_project',
    'target_projects',
    'config_path',
    'persistence',
    'async',
    'status',
  ])
    if (args[key] !== undefined) throw new Error(`Argument is not allowed: ${key}`);
  for (const key of ['path', 'file_path', 'path_filter'])
    if (args[key] !== undefined) safeRelative(project.root, args[key]);
  for (const key of ['paths', 'scopes'])
    if (args[key] !== undefined) {
      if (!Array.isArray(args[key])) throw new Error(`${key} must be an array`);
      args[key].forEach((value) => safeRelative(project.root, value));
    }
  const schema = TOOL_SCHEMAS.get(name);
  const bindings = new Set(['project', 'repo_path', ...(name === 'index_repository' ? ['name', 'mode'] : [])]);
  for (const key of schema.required || [])
    if (args[key] === undefined) throw new Error(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (bindings.has(key)) continue;
    if (!schema.properties[key]) throw new Error(`Unknown argument: ${key}`);
    validateArgument(key, value, schema.properties[key]);
  }
  if (JSON.stringify(args).length > 65536) throw new Error('Tool arguments exceed 64 KiB');
  if (name === 'index_repository') {
    if (args.name !== undefined && args.name !== project.name) throw new Error('Cannot rename the bound project');
    if (args.mode !== undefined && args.mode !== config.mode)
      throw new Error('Index mode is controlled by project configuration');
    return { repo_path: project.root, name: project.name, mode: config.mode };
  }
  delete args.repo_path;
  return { ...args, project: project.name };
}

// Native tools can spawn git without Node's per-process child cleanup behavior.
// Target only this invocation's PID tree, never image names or unrelated jobs.
function terminateOwnedProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let killer;
    const fallback = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // If taskkill cannot run, still stop the owned parent and close inherited
      // pipes so cancellation settles with an explicit cleanup error.
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } catch {
        /* It may already have exited. */
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`Could not terminate the owned native process tree: ${error.message}`));
    };
    try {
      killer = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (error) {
      fallback(error);
      return;
    }
    timer = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        /* The helper may have just exited. */
      }
      fallback(new Error('taskkill timed out'));
    }, 5000);
    killer.once('error', fallback);
    killer.once('close', (code) => {
      if (settled) return;
      // The process can exit naturally while taskkill starts. Its native daemon
      // also shuts down when the last client disconnects.
      if (code !== 0 && !(code === 128 && (child.exitCode !== null || child.signalCode !== null))) {
        fallback(new Error(`taskkill exited ${code}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Create an isolated project runtime. binaryArgs supports executable wrappers; null powerShell runs directly. */
function createRuntime(options) {
  const jobs = new Map();
  const processes = new Set();
  const powerShell = options.powerShell === undefined ? findPowerShell() : options.powerShell;
  const plainReader =
    options.readConfigThroughPowerShell ||
    (powerShell ? (file) => readFileThroughPowerShellSync(powerShell, file) : undefined);
  // Starting PowerShell takes about a second; reuse a read until the file changes.
  const plainConfigs = new Map();
  const throughPowerShell = plainReader
    ? (file) => {
        const { mtimeMs, size } = fs.statSync(file);
        const cached = plainConfigs.get(file);
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.bytes;
        const bytes = plainReader(file);
        plainConfigs.set(file, { mtimeMs, size, bytes });
        return bytes;
      }
    : undefined;
  const readProjectConfig = (root) => readConfig(root, throughPowerShell);
  let disposed = false;
  function worktreeMainRoot(resolved) {
    let cursor = resolved;
    for (;;) {
      const dotGit = path.join(cursor, '.git');
      try {
        const stat = fs.lstatSync(dotGit);
        if (stat.isDirectory()) return undefined;
        if (stat.isFile()) {
          const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(dotGit, 'utf8'));
          if (!match) return undefined;
          const gitDir = path.resolve(cursor, match[1].trim());
          const commondirFile = path.join(gitDir, 'commondir');
          if (!fs.existsSync(commondirFile)) return undefined;
          const commonDir = path.resolve(gitDir, fs.readFileSync(commondirFile, 'utf8').trim());
          if (path.basename(commonDir).toLowerCase() !== '.git') return undefined;
          const mainTop = path.dirname(commonDir);
          const rel = path.relative(cursor, resolved);
          return canonical(rel ? path.join(mainTop, rel) : mainTop);
        }
      } catch {
        // Keep walking up until the filesystem root.
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return undefined;
      cursor = parent;
    }
  }
  const projectFor = (repoPath) => {
    const resolved = canonical(repoPath);
    if (!fs.existsSync(configPath(resolved))) {
      const origin = worktreeMainRoot(resolved);
      if (origin && fs.existsSync(configPath(origin)))
        return { ...identity(origin, path.resolve(options.cacheRoot)), worktreeRoot: resolved };
    }
    return identity(resolved, path.resolve(options.cacheRoot));
  };
  function available() {
    return fs.existsSync(options.binaryPath);
  }
  function current(project) {
    const config = readProjectConfig(project.root);
    const saved = readJson(project.statusFile) || {};
    // An index built under another project name (the full-hash name before
    // shortening) answers no query under this one: report it as not indexed.
    if (saved.phase === 'succeeded' && saved.projectName !== project.name) {
      saved.phase = 'idle';
      delete saved.summary;
      delete saved.skippedSources;
    }
    // The user deleted the architecture file: nothing to report about it any more.
    if (saved.architecture && !fs.existsSync(path.join(project.root, ARCHITECTURE_FILE))) delete saved.architecture;
    return { repoPath: project.root, config, available: available(), phase: 'idle', log: '', ...saved };
  }
  function persist(project, value) {
    const {
      phase,
      log,
      error,
      summary,
      reason,
      launcher,
      diagnostics,
      diagnosticsPath,
      conclusion,
      precheckRefused,
      indexerReadsPlain,
      skippedSources,
      architecture: architectureStatus,
      moduleCards,
      language,
      indexedAt,
    } = value;
    atomicJson(project.statusFile, {
      phase,
      log,
      error,
      summary,
      reason,
      launcher,
      diagnostics,
      diagnosticsPath,
      conclusion,
      precheckRefused,
      indexerReadsPlain,
      skippedSources,
      architecture: architectureStatus,
      moduleCards,
      language,
      indexedAt,
      projectName: project.name,
      updatedAt: Date.now(),
    });
  }
  /**
   * Collect what a support round-trip needs. Never throws: a diagnostic failure must
   * never replace the indexing failure it is describing.
   */
  async function diagnose(project, info) {
    const { readThroughPowerShell: readShell } = options;
    let binaryBytes;
    try {
      binaryBytes = fs.statSync(options.binaryPath).size;
    } catch {
      binaryBytes = undefined;
    }
    const version = await powerShellVersion(powerShell);
    const scan = folderScan(project.root);
    const probe = await readingProbe(project.root, powerShell, readShell);
    const flags = await encryptionFlags(probe.files);
    const output = `${info.message || ''}\n${info.stdoutTail || ''}\n${info.log || ''}`;
    const workerPath = workerLogPath(output);
    const workerTail = workerPath ? readTail(workerPath) : undefined;
    const daemonTail = readTail(path.join(project.cache, 'logs', 'cbm-daemon.log'));
    const conclusion = classifyFailure({
      binaryAvailable: binaryBytes !== undefined,
      indexerReadsPlain: info.indexerReadsPlain === true,
      error: info.error,
      probe,
      scan,
      output,
    });
    const text = [
      'Woody codebase-memory diagnostics',
      `generated: ${new Date().toISOString()}`,
      `conclusion: ${conclusion}`,
      `advice: ${DIAGNOSIS_ADVICE[conclusion]}`,
      '',
      '--- failure ---',
      `phase: ${info.phase}`,
      `duration_ms: ${info.durationMs}`,
      `exit_code: ${info.exitCode === undefined ? '(none)' : info.exitCode}`,
      `message: ${info.message || '(none)'}`,
      '',
      '--- environment ---',
      `platform: ${process.platform} ${process.arch} ${typeof os.release === 'function' ? os.release() : ''}`.trim(),
      `node: ${process.version}`,
      `electron: ${process.versions.electron || '(not electron)'}`,
      `launcher: ${info.launcher}`,
      `indexer_reads_plain: ${info.indexerReadsPlain ? 'proven by an earlier index' : 'not proven'}`,
      `power_shell: ${powerShell ? `${powerShell} (${version || 'version unknown'})` : 'not found'}`,
      `binary: ${options.binaryPath} (${binaryBytes === undefined ? 'MISSING' : `${binaryBytes} bytes`})`,
      `project: ${project.root}`,
      `cache: ${project.cache}`,
      `mode: ${info.mode}`,
      '',
      '--- folder ---',
      `directories: ${scan.directories}${scan.truncated ? ' (walk capped)' : ''}`,
      `files: ${scan.files}`,
      `unreadable_entries: ${scan.unreadable.length}`,
      sampleLines(scan.unreadable, (item) => `  ${item.code}: ${item.path}`),
      '',
      '--- encryption ---',
      `sampled_files: ${probe.files.length}`,
      `encrypted_attribute: ${flags.filter((flag) => flag === true).length} of ${flags.filter((flag) => flag !== undefined).length}`,
      sampleLines(
        probe.files.map((file, index) => ({ file, flag: flags[index] })),
        (item) => `  ${item.flag ? 'E' : '-'} ${item.file}`
      ),
      '',
      '--- reads (this process) ---',
      sampleLines(
        probe.direct,
        (item) => `  ${item.ok ? (item.text ? 'text' : 'CIPHERTEXT') : `error ${item.error}`}: ${item.file}`
      ),
      '',
      '--- reads (PowerShell 7) ---',
      probe.shell.length > 0
        ? sampleLines(
            probe.shell,
            (item) =>
              `  ${item.text ? 'text' : 'CIPHERTEXT'}${item.differs ? ' (differs from direct)' : ''}: ${item.file}`
          )
        : probe.shellError
          ? `  failed: ${probe.shellError}`
          : '  (not probed)',
      '',
      '--- native stderr (tail) ---',
      info.log || '(empty)',
      '',
      '--- native stdout (tail) ---',
      info.stdoutTail || '(empty)',
      '',
      '--- index worker log (tail) ---',
      workerTail || `  (not found: ${workerPath || 'native output named no log'})`,
      '',
      '--- daemon log (tail) ---',
      daemonTail || '  (not found)',
      '',
    ]
      .join('\n')
      .slice(0, DIAGNOSTICS_LIMIT);
    let reportPath;
    try {
      reportPath = writeReport(project, text);
    } catch (error) {
      reportPath = undefined;
      return { text: `${text}\n(report could not be written: ${error.message})\n`, path: undefined, conclusion };
    }
    return { text, path: reportPath, conclusion };
  }
  function native(project, tool, args, onLog, owner) {
    if (disposed) throw new Error('Codebase memory service is disposed');
    if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
    fs.mkdirSync(project.cache, { recursive: true });
    const cliArgs =
      tool === 'index_repository'
        ? ['cli', '--json', tool, '--repo-path', project.root, '--name', project.name, '--mode', args.mode]
        : ['cli', '--json', tool, JSON.stringify(args)];
    const nativeArgs = [...(options.binaryArgs || []), ...cliArgs];
    const launch = powerShell
      ? {
          command: powerShell,
          args: [...POWERSHELL_FLAGS, encodedScript(LAUNCH_SCRIPT)],
          env: {
            WOODY_CBM_EXECUTABLE: options.binaryPath,
            WOODY_CBM_ARGUMENTS: nativeArgs.map((value) => Buffer.from(value).toString('base64')).join(','),
          },
        }
      : { command: options.binaryPath, args: nativeArgs, env: {} };
    const child = spawn(launch.command, launch.args, {
      cwd: project.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CBM_CACHE_DIR: project.cache, CBM_RUNTIME_DIR: project.cache, ...launch.env },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const operation = { child, cancel: undefined, fail: undefined, promise: undefined };
    processes.add(operation);
    operation.promise = new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let failure;
      let termination;
      const stop = (message) => {
        if (termination) return;
        failure = new Error(message);
        termination = terminateOwnedProcess(child).catch((error) => {
          failure = new Error(`${failure.message}; ${error.message}`);
        });
      };
      operation.cancel = () => stop('Index cancelled');
      operation.fail = (error) => stop(error.message);
      const timer = setTimeout(
        () => stop('Native codebase-memory command timed out'),
        options.timeoutMs || 30 * 60 * 1000
      );
      const cancellation = owner
        ? setInterval(() => {
            if (readJson(path.join(project.lock, 'cancel.json'))?.token === owner.token) operation.cancel();
          }, 100)
        : undefined;
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 4 * 1024 * 1024) {
          stdout = '';
          stop('Native output exceeded the 4 MiB limit');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-LOG_LIMIT);
        if (onLog) onLog(stderr);
      });
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', async (code) => {
        clearTimeout(timer);
        clearInterval(cancellation);
        await termination;
        processes.delete(operation);
        if (failure) return reject(failure);
        // A query the indexer refuses ("function not found" with a hint) exits non-zero with
        // its answer on stdout, and only start-up warnings on stderr. The model needs the answer.
        const refusal = code !== 0 && tool !== 'index_repository' ? errorText(stdout) : undefined;
        if (refusal) return reject(new Error(refusal));
        if (code !== 0) {
          const exitError = new Error(`Native command exited ${code}: ${stderr}`);
          exitError.exitCode = code;
          exitError.stdoutTail = stdout.slice(-4096);
          return reject(exitError);
        }
        try {
          const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
          if (!result || typeof result !== 'object' || (!result.content && !result.structuredContent))
            throw new Error('Missing MCP result envelope');
          if (result.isError)
            throw new Error(
              (result.content || []).map((item) => item.text || '').join('\n') || 'Native command returned an error'
            );
          resolve(result);
        } catch (error) {
          reject(new Error(`Native response error: ${error.message}`));
        }
      });
    });
    if (owner && child.pid) {
      owner.childPid = child.pid;
      try {
        atomicJson(path.join(project.lock, 'owner.json'), owner);
      } catch (error) {
        operation.startupError = error;
        operation.fail(error);
      }
    }
    return operation;
  }
  /**
   * An indexer that only saw ciphertext still reports success, with nothing in the index.
   * Only a differing PowerShell view plus a graph without its symbols counts as proof.
   * Resolves true when the graph holds symbols that only PowerShell could read here:
   * proof that the indexer itself is allowed to see plaintext.
   */
  async function assertReadable(project) {
    if (!powerShell) return false;
    const files = sampleFiles(project.root);
    if (!files.length) return false;
    let plain;
    try {
      plain = await (options.readThroughPowerShell || readThroughPowerShell)(powerShell, files);
    } catch {
      return false;
    }
    if (plain.length !== files.length) return false;
    let differing;
    try {
      differing = plain.filter((content, index) => !content.equals(readHead(files[index])));
    } catch {
      return false;
    }
    const names = symbolNames(differing);
    if (!names.length) return false;
    let total;
    try {
      const result = await native(project, 'search_graph', {
        project: project.name,
        name_pattern: `^(${names.join('|')})$`,
        limit: 1,
        format: 'json',
      }).promise;
      total = JSON.parse(result.content[0].text).total;
    } catch {
      return false;
    }
    if (total === 0) throw Object.assign(new Error(UNREADABLE_MESSAGE), { reason: 'unreadable' });
    return typeof total === 'number' && total > 0;
  }
  /**
   * Ciphertext now, crash later: an indexer fed encrypted bytes produces nothing at best
   * and takes its worker down at worst. Probe a few files before spending minutes on it.
   *
   * The probe reads with this process (Woody.exe from the panel, node for MCP calls),
   * not with the indexer, so it cannot see whether the indexer itself is whitelisted.
   * Callers skip it once an index has proved that, or when the user asks to index anyway.
   */
  async function encryptedForProcess(project) {
    if (!powerShell) return false;
    try {
      return encryptedForThisProcess(await readingProbe(project.root, powerShell, options.readThroughPowerShell));
    } catch {
      // A failed probe must never block indexing: it is a hint, not a gate.
      return false;
    }
  }
  /**
   * Classify and report a failure, then publish it in one step: a status poll must never
   * see 'failed' without the reason, and the lock stays held until the caller persists.
   */
  async function recordFailure(project, state, error, startedAt, config) {
    let diagnosis;
    try {
      diagnosis = await diagnose(project, {
        phase: 'failed',
        message: error.message,
        error,
        exitCode: error.exitCode,
        log: state.log,
        stdoutTail: error.stdoutTail,
        durationMs: Date.now() - startedAt,
        launcher: state.launcher,
        mode: config.mode,
        // Only an index that saw ciphertext disproves the earlier proof.
        indexerReadsPlain: state.indexerReadsPlain === true && error.reason !== 'unreadable',
      });
      console.error(
        `[CodebaseMemory] index failed (${diagnosis.conclusion}) for ${project.root}; diagnostics: ${diagnosis.path || '(not written)'}`
      );
      // The agent (and any caller that only sees the message) gets the conclusion inline.
      error.message = `${error.message}\n\n[codebase-memory diagnosis: ${diagnosis.conclusion}] ${DIAGNOSIS_ADVICE[diagnosis.conclusion]}${
        diagnosis.path ? `\nreport: ${diagnosis.path}` : ''
      }`;
    } catch (diagnosisError) {
      diagnosis = { text: `Diagnostics could not be collected: ${diagnosisError.message}` };
    }
    Object.assign(state, {
      reason: error.reason,
      precheckRefused: error.precheck === true ? true : undefined,
      diagnostics: diagnosis.text,
      diagnosticsPath: diagnosis.path,
      conclusion: diagnosis.conclusion,
      error: error.message.slice(-LOG_LIMIT),
    });
    // The indexer itself read ciphertext: it is no longer (or never was) whitelisted here.
    if (error.reason === 'unreadable') state.indexerReadsPlain = undefined;
    state.phase = 'failed';
  }
  /**
   * Folders with source files that the indexer skipped by name, so the model cannot see them.
   * Coverage lists every skipped folder; the index summary stops after five. Never throws:
   * this only adds a hint to a finished index.
   */
  async function skippedSources(project, config) {
    try {
      const args = boundArguments(
        project,
        'check_index_coverage',
        { scopes: ['.'], scope_limit: 1000, format: 'json' },
        config
      );
      const result = await native(project, 'check_index_coverage', args).promise;
      const coverage = result.structuredContent || JSON.parse(result.content?.[0]?.text || '{}');
      const ignore = readIgnore(project.root);
      const manual = !ignoreWritable(ignore);
      const requested = manual ? new Set() : includedFolders(ignore);
      const budget = { entries: SKIPPED_ENTRY_BUDGET };
      const found = [];
      for (const entry of coverage.scopes?.[0]?.entries || []) {
        if (found.length >= SKIPPED_LIMIT) break;
        if (entry?.kind !== 'not_indexed_dir' || typeof entry.path !== 'string') continue;
        if (!OFFERED_SKIPPED_NAMES.has(entry.path.split('/').pop())) continue;
        const files = countSources(path.join(project.root, entry.path), budget);
        if (files === 0) continue;
        found.push({
          path: entry.path,
          files,
          ...(files >= SKIPPED_FILE_CAP ? { more: true } : {}),
          // Asked for and still skipped: .gitignore wins over .cbmignore.
          ...(requested.has(entry.path) ? { requested: true } : {}),
          ...(manual ? { manual: true } : {}),
        });
      }
      return found;
    } catch {
      return undefined;
    }
  }
  /**
   * Every row of a Cypher query, page by page. query_graph is not offered to the model;
   * Woody uses it to read the whole function list in one call instead of hundreds.
   */
  async function queryRows(project, query) {
    const rows = [];
    for (let offset = 0; ; ) {
      const result = await native(project, 'query_graph', {
        project: project.name,
        query,
        max_rows: QUERY_PAGE,
        offset,
        format: 'json',
        max_output_tokens: 1000000,
      }).promise;
      const page = result.structuredContent || JSON.parse(result.content?.[0]?.text || '{}');
      const batch = Array.isArray(page.rows) ? page.rows : [];
      for (const row of batch) rows.push(row);
      if (!page.has_more || !batch.length) return rows;
      offset += batch.length;
    }
  }
  /** Functions that call or reference each name, keyed `name|file`. */
  async function callersOf(project, names) {
    const safe = names.filter((name) => /^[A-Za-z_]\w*$/.test(name));
    const callers = new Map();
    if (!safe.length) return callers;
    const rows = await queryRows(
      project,
      `MATCH (a:Function)-[:CALLS|CALL_REFERENCE]->(b:Function) WHERE b.name IN [${safe.map((name) => `'${name}'`).join(',')}] RETURN b.name, b.file_path, a.name`
    );
    for (const [name, file, caller] of rows) {
      const key = `${name}|${file}`;
      if (!callers.has(key)) callers.set(key, []);
      callers.get(key).push(caller);
    }
    return callers;
  }
  /**
   * Write .woody/architecture.md from the index and the source. Keeps everything outside the
   * generated markers. `requested` is the panel's language; updates keep the file's own.
   */
  /** The index's functions and files, and the architecture analysis of the source. */
  async function analyzeProject(project) {
    const functions = await queryRows(project, FUNCTIONS_QUERY);
    // Files without functions, such as tables of parameters, can still hold tables.
    const sourceFiles = (await queryRows(project, FILES_QUERY)).map((row) => row[0]);
    const model = await architecture.analyze({
      functions,
      sourceFiles,
      readSource: sourceReader(project.root),
      callersOf: (names) => callersOf(project, names),
    });
    // An index started from a chat runs in a process that may not be on the encryption
    // whitelist; what it reads would replace good files with empty ones.
    const unreadable = model.gaps.unreadable.length;
    if (model.files > 0 && unreadable * 2 >= model.files)
      throw new Error(
        `This process reads ${unreadable} of ${model.files} source files as ciphertext; ${ARCHITECTURE_FILE} was left unchanged`
      );
    return { functions, sourceFiles, model };
  }
  /**
   * Write .woody/architecture.md, with the modules section. Keeps everything outside the
   * generated markers. `requested` is the panel's language; updates keep the file's own.
   */
  function writeArchitecture(project, config, requested, analysis, found, saved) {
    const filename = architecturePath(project.root);
    const existing = readArchitecture(filename);
    const wanted = requested && ARCHITECTURE_LABELS[requested] ? requested : architecture.languageOf(existing);
    const { language, text } = architecture.labelsFor(ARCHITECTURE_LABELS, wanted);
    const { model } = analysis;
    const suggestedShared = modules.suggestShared({
      model,
      experts: saved?.experts || [],
      shared: saved?.shared || [],
    });
    const generated = [
      architecture.render(model, text, { language, date: localStamp(), mode: config.mode }).trimEnd(),
      '',
      modules.renderModules(found, text, { suggestedShared }),
    ].join('\n');
    atomicWrite(filename, architecture.merge(existing, generated, text));
    return { generatedAt: Date.now(), tasks: model.tasks.length, tables: model.tables.length, language };
  }
  /** The detected modules as the panel shows them. */
  const moduleSummary = (found) =>
    found.map((item) => ({
      id: item.id,
      files: item.files,
      ...(item.split ? { split: item.split } : {}),
      tables: item.tables.map((entry) => entry.table),
      functions: item.tables.flatMap((entry) => entry.functions),
      experts: item.experts,
    }));
  /** Index coverage of some files: parse problems and whether each changed after the index. */
  async function coverageOf(project, config, files) {
    const coverage = new Map();
    try {
      for (let offset = 0; offset < files.length; offset += COVERAGE_BATCH) {
        const paths = files.slice(offset, offset + COVERAGE_BATCH);
        const args = boundArguments(project, 'check_index_coverage', { paths, format: 'json' }, config);
        const result = await native(project, 'check_index_coverage', args).promise;
        const value = result.structuredContent || JSON.parse(result.content?.[0]?.text || '{}');
        for (const item of value.paths || [])
          if (typeof item?.path === 'string')
            coverage.set(item.path, {
              status: item.status,
              freshness: item.freshness,
              ranges: (item.coverage || []).flatMap((entry) => entry.ranges || []),
            });
      }
    } catch {
      // Coverage only adds notes to the brief.
    }
    return coverage;
  }
  /**
   * Fallback for `detect_changes` when the workspace has no Git repository (or no HEAD commit):
   * compare the workspace against the last codebase-memory index and list affected callers.
   */
  async function detectIndexChanges(project, config, bound) {
    const indexedFiles = (await queryRows(project, FILES_QUERY))
      .map((row) => row[0])
      .filter((file) => typeof file === 'string' && /^[^<:/\\][^:]*$/.test(file))
      .sort();
    const coverage = await coverageOf(project, config, indexedFiles);
    const deleted = indexedFiles.filter(
      (file) => coverage.get(file)?.freshness === 'missing' || !fs.existsSync(path.join(project.root, file))
    );
    const deletedSet = new Set(deleted);
    const modified = indexedFiles.filter(
      (file) => !deletedSet.has(file) && coverage.get(file)?.freshness === 'metadata_changed'
    );
    const indexedSet = new Set(indexedFiles);
    const dirs = [...new Set(indexedFiles.map((file) => file.slice(0, Math.max(0, file.lastIndexOf('/')))))];
    const isCFamily = cFamilyProject(project.root);
    const cExt = new Set(C_FAMILY_EXTENSIONS.map((ext) => `.${ext}`));
    const added = [];
    for (const relDir of dirs) {
      const absDir = relDir ? path.join(project.root, relDir) : project.root;
      let entries = [];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (isCFamily ? !cExt.has(ext) : !SAMPLE_EXTENSIONS.has(ext)) continue;
        const relFile = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (!indexedSet.has(relFile)) added.push(relFile);
      }
    }
    added.sort();
    const touched = [...modified, ...deleted];
    const impacted = [];
    if (bound.scope !== 'files') impacted.push(...(await externalCallers(project, touched)));
    const payload = {
      source: 'index_freshness_fallback',
      note: 'No Git repository (or HEAD commit) found; changes are compared against the last codebase-memory index.',
      modified,
      deleted,
      added,
      ...(bound.scope !== 'files' ? { impacted } : {}),
    };
    return changesReply(payload, bound, 'No indexed file has changed since the last index.', [
      ['modified', 'Modified since index'],
      ['deleted', 'Deleted since index'],
      ['added', 'Added in indexed folders'],
    ]);
  }
  /** Functions outside `files` that call into them, from the index; empty when the graph cannot say. */
  async function externalCallers(project, files) {
    if (!files.length) return [];
    const list = cypherList(files);
    try {
      const rows = await queryRows(
        project,
        `MATCH (a:Function)-[:CALLS|CALL_REFERENCE]->(b:Function) WHERE b.file_path IN [${list}] AND NOT a.file_path IN [${list}] RETURN DISTINCT b.name, b.file_path, a.name, a.file_path LIMIT 100`
      );
      return rows.map(([callee, calleeFile, caller, callerFile]) => ({ callee, calleeFile, caller, callerFile }));
    } catch {
      // Impact edges are optional when only file-level changes are known.
      return [];
    }
  }
  /** The reply of a Woody-made `detect_changes`: JSON, or the note, each listed group and the callers. */
  function changesReply(payload, bound, nothing, groups) {
    if (bound.format === 'json')
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    const lines = [payload.note];
    const impacted = payload.impacted || [];
    if (groups.every(([key]) => !payload[key].length)) {
      lines.push(nothing);
    } else {
      for (const [key, label] of groups)
        if (payload[key].length) lines.push(`${label} (${payload[key].length}): ${payload[key].join(', ')}`);
      if (impacted.length)
        lines.push(
          `External callers of changed files (${impacted.length}):`,
          ...impacted
            .slice(0, 30)
            .map((item) => `- ${item.caller} (${item.callerFile}) -> ${item.callee} (${item.calleeFile})`)
        );
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  /**
   * `detect_changes` for a linked Git worktree that shares the main checkout's index: what the
   * worktree changed against the main checkout's HEAD (commits on its branch, edits and new
   * files), the indexed files the main checkout edited without committing (the index shows
   * those edits, the worktree does not), and the callers of the worktree's changed files in
   * the shared index.
   * `since` or `base_branch` replace the main checkout's HEAD as the base.
   */
  async function detectWorktreeChanges(project, bound) {
    const worktree = project.worktreeRoot;
    const ref = (value) => (typeof value === 'string' && value && !value.startsWith('-') ? value : undefined);
    const mergeBase = ref(bound.base_branch)
      ? gitOutput(worktree, ['merge-base', bound.base_branch, 'HEAD'])?.trim()
      : undefined;
    const requested = ref(bound.since) || mergeBase;
    const base = requested || gitOutput(project.root, ['rev-parse', 'HEAD'])?.trim();
    if (!base) throw new Error(`Git cannot read the main checkout ${project.root} to compare this worktree with`);
    const diff = gitOutput(worktree, ['diff', '--name-status', '-z', '--no-renames', '--relative', base, '--']);
    if (diff === undefined) throw new Error(`git diff against ${base} failed in ${worktree}`);
    const modified = [];
    const deleted = [];
    const added = [];
    const fields = nulList(diff);
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index];
      const file = fields[index + 1];
      if (status.startsWith('A')) added.push(file);
      else if (status.startsWith('D')) deleted.push(file);
      else modified.push(file);
    }
    for (const file of nulList(gitOutput(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])))
      if (!added.includes(file)) added.push(file);
    const listed = new Set([...modified, ...deleted, ...added]);
    // Only files the index holds can show the main checkout's version instead of the worktree's.
    const indexedList = readJson(indexedFilesPath(project));
    const indexed = Array.isArray(indexedList) ? new Set(indexedList) : undefined;
    const mainEdited = requested
      ? []
      : nulList(gitOutput(project.root, ['diff', '--name-only', '-z', '--relative', 'HEAD', '--'])).filter(
          (file) => !listed.has(file) && (!indexed || indexed.has(file))
        );
    const against = requested ? base : `the main checkout's HEAD (${base.slice(0, 12)})`;
    const payload = {
      source: 'worktree_diff',
      note: `You work in the Git worktree ${worktree}; the index describes the main checkout ${project.root}. Changes are your worktree against ${against}.`,
      base,
      modified: modified.sort(),
      deleted: deleted.sort(),
      added: added.sort(),
      mainEdited: mainEdited.sort(),
    };
    // The callers of what this worktree changed; the main checkout's own edits are not its work.
    if (bound.scope !== 'files')
      payload.impacted = await externalCallers(project, [...payload.modified, ...payload.deleted]);
    return changesReply(payload, bound, 'Your worktree has no changes against that base.', [
      ['modified', 'Modified in your worktree'],
      ['deleted', 'Deleted in your worktree'],
      ['added', 'Added in your worktree'],
      ['mainEdited', 'Edited in the main checkout only, so the index shows its version'],
    ]);
  }
  /** Files of the last index, kept for the drift pre-check, which must not start the indexer. */
  const indexedFilesPath = (project) => path.join(project.cache, 'woody-indexed-files.json');
  const indexedFileList = ({ sourceFiles, functions }) =>
    [...new Set([...sourceFiles, ...functions.map((row) => row[1])])]
      .filter((file) => typeof file === 'string' && /^[^<:/\\][^:]*$/.test(file))
      .sort();
  const samePaths = (record, expert) =>
    Array.isArray(record?.paths) && record.paths.join('\n') === expert.paths.join('\n');
  /**
   * A card reviewed under an older files hash (before the drift signature, or with an older
   * format of it) whose files have not changed since: carry the review over to the new hash,
   * so an upgrade alone does not send every expert back to learning.
   */
  function carryReview(before, plainHash, filesHash) {
    if (!before?.reviewedFilesHash || modules.isCurrentDriftSignature(before.driftSig)) return before;
    const reviewedUnder = before.driftSig === undefined ? plainHash : sha1(`${plainHash}\n${before.driftSig}`);
    return before.reviewedFilesHash === reviewedUnder ? { ...before, reviewedFilesHash: filesHash } : before;
  }
  /**
   * The generated part of each expert's feature card in .woody/features, and the card state
   * for the team dialog. `only` limits the work to some experts; the others keep their record.
   * An expert whose card cannot be written gets an error in its record; the others go on.
   */
  async function writeModuleCards(project, config, analysis, found, saved, language, previous, only) {
    const result = { generatedAt: Date.now(), language, experts: {} };
    if (!saved?.experts.length) return result;
    const { functions, sourceFiles, model } = analysis;
    const { text } = architecture.labelsFor(ARCHITECTURE_LABELS, language);
    const variables = await queryRows(project, VARIABLES_QUERY);
    const source = modules.sourceCache(sourceReader(project.root));
    const indexed = [...new Set([...sourceFiles, ...functions.map((row) => row[1])])].filter(
      (file) => typeof file === 'string' && /^[^<:/\\][^:]*$/.test(file)
    );
    const ownedBy = new Map();
    for (const expert of saved.experts)
      if (!only || only.includes(expert.id))
        ownedBy.set(
          expert.id,
          indexed.filter((file) => modules.ownerOf(file, saved.experts, saved.shared) === expert.id).sort()
        );
    // One pass for every expert: the calls that touch any of their files, and their coverage.
    const allOwned = [...new Set([...ownedBy.values()].flat())];
    const list = cypherList(allOwned);
    const edges = 'MATCH (a:Function)-[:CALLS|CALL_REFERENCE]->(b:Function)';
    const fields = 'RETURN a.name, a.file_path, a.start_line, b.name, b.file_path';
    let allCalls = [];
    try {
      if (allOwned.length)
        allCalls = [
          ...(await queryRows(project, `${edges} WHERE b.file_path IN [${list}] ${fields}`)),
          ...(await queryRows(project, `${edges} WHERE a.file_path IN [${list}] ${fields}`)),
        ];
    } catch (error) {
      // Without the calls every brief would claim the module has no callers.
      return { ...previous, generatedAt: result.generatedAt, language, error: error.message };
    }
    const coverage = await coverageOf(project, config, allOwned);
    for (const expert of saved.experts) {
      const before = previous?.experts?.[expert.id];
      if (!ownedBy.has(expert.id)) {
        if (before) result.experts[expert.id] = before;
        continue;
      }
      try {
        const owned = ownedBy.get(expert.id);
        const mine = new Set(owned);
        const calls = allCalls.filter((row) => mine.has(row[1]) || mine.has(row[4]));
        const data = modules.collect({
          expert,
          experts: saved.experts,
          shared: saved.shared,
          model,
          functions,
          files: sourceFiles,
          calls,
          variables,
          coverage,
          source,
          modules: found,
        });
        const filename = woodyPath(project.root, `${FEATURES_DIR}/${expert.id}.md`);
        const existing = readCard(filename);
        const generated = modules.renderBrief(data, text, { date: localStamp(), mode: config.mode });
        const next = modules.mergeCard(existing, generated, expert, text, language);
        if (next !== existing) atomicWrite(filename, next);
        const own = modules.ownPart(next, expert);
        const driftSig = modules.driftSignature(data);
        const plainHash = hashFiles(project.root, owned);
        const filesHash = sha1(`${plainHash}\n${driftSig}`);
        const { state, record } = modules.cardState(carryReview(before, plainHash, filesHash), {
          filesHash,
          ownHash: sha1(own),
          hasOwn: own.length > 0,
        });
        result.experts[expert.id] = {
          ...record,
          driftSig,
          state,
          paths: expert.paths,
          owned,
          generatedAt: Date.now(),
          digest: modules.digest(data),
        };
      } catch (error) {
        const keep = samePaths(before, expert) ? before : undefined;
        result.experts[expert.id] = { ...(keep || {}), paths: expert.paths, state: 'error', error: error.message };
      }
    }
    return result;
  }
  /**
   * Architecture file, modules and expert cards from the current index. `language` is the
   * panel's, when it asked; otherwise each file keeps its own. Throws when the source cannot
   * be read (nothing is written then) and when the architecture file was asked for and could
   * not be written; card failures stay in their records.
   */
  async function writeProjectFiles(project, config, options = {}) {
    const { language, previous = {}, only, strict = false } = options;
    const analysis = await analyzeProject(project);
    try {
      atomicJson(indexedFilesPath(project), indexedFileList(analysis));
    } catch {
      // Without the list the drift pre-check counts edited files outside modules as added.
    }
    let saved;
    let expertsError;
    try {
      saved = readExperts(project.root, throughPowerShell);
    } catch (error) {
      expertsError = error.message;
    }
    const found = modules.classify({
      model: analysis.model,
      functions: analysis.functions,
      files: analysis.sourceFiles,
      experts: saved?.experts || [],
      shared: saved?.shared || [],
    });
    let architectureStatus;
    try {
      architectureStatus = writeArchitecture(project, config, language, analysis, found, saved);
    } catch (error) {
      if (strict) throw error;
      architectureStatus = { ...previous.architecture, error: error.message };
    }
    architectureStatus.modules = moduleSummary(found);
    // Cards follow the architecture file's language; without one, the panel's.
    const cardLanguage = architecture.labelsFor(
      ARCHITECTURE_LABELS,
      architectureStatus.language || language || previous.moduleCards?.language
    ).language;
    const cards = await writeModuleCards(
      project,
      config,
      analysis,
      found,
      saved,
      cardLanguage,
      previous.moduleCards,
      only
    );
    if (expertsError) cards.error = expertsError;
    return { architecture: architectureStatus, moduleCards: cards };
  }
  /** After an index: write or update the files. Never throws; a failure is kept in the status. */
  async function refreshProjectFiles(project, config, state) {
    try {
      const exists = fs.existsSync(path.join(project.root, ARCHITECTURE_FILE));
      // The map describes C and C++ firmware; other projects get it only when they ask.
      if (!exists && !fs.existsSync(path.join(project.root, EXPERTS_FILE)) && !cFamilyProject(project.root)) return;
      const result = await writeProjectFiles(project, config, {
        // A new file takes the language of the panel that started the index.
        language: exists ? undefined : state.language,
        previous: { architecture: state.architecture, moduleCards: state.moduleCards },
      });
      state.architecture = result.architecture;
      state.moduleCards = result.moduleCards;
    } catch (error) {
      state.architecture = { ...state.architecture, error: error.message };
    }
  }
  async function beginIndex(project, config, { bypassPrecheck = false, language } = {}) {
    const owner = acquireLock(project);
    const startedAt = Date.now();
    const previous = readJson(project.statusFile) || {};
    const state = {
      phase: 'running',
      log: '',
      launcher: powerShell ? 'powershell' : 'direct',
      // Proof from an earlier run that the indexer reads plaintext here outlives later runs.
      indexerReadsPlain: previous.indexerReadsPlain === true ? true : undefined,
      architecture: previous.architecture,
      moduleCards: previous.moduleCards,
      indexedAt: previous.indexedAt,
      // The panel's language, for files the first index creates.
      language: typeof language === 'string' && ARCHITECTURE_LABELS[language] ? language : previous.language,
    };
    const fail = async (error) => {
      await recordFailure(project, state, error, startedAt, config);
      try {
        persist(project, state);
      } finally {
        releaseLock(project, owner);
      }
    };
    try {
      persist(project, state);
      if (!bypassPrecheck && !state.indexerReadsPlain && (await encryptedForProcess(project)))
        throw Object.assign(new Error(PRECHECK_MESSAGE), { reason: 'unreadable', precheck: true });
    } catch (error) {
      await fail(error);
      throw error;
    }
    let overlay;
    try {
      overlay = prepareSourceOnlyOverlay(
        project.root,
        { indexLock: project.lock, indexToken: owner.token },
        { cFamily: cFamilyProject(project.root), mode: config.mode }
      );
      state.indexFilter = {
        gitTrackedOnly: overlay.gitTrackedOnly,
        cSourcesOnly: overlay.cSourcesOnly,
        files: overlay.files,
        restored: false,
      };
    } catch (error) {
      await fail(error);
      throw error;
    }
    let operation;
    try {
      operation = native(
        project,
        'index_repository',
        { mode: config.mode },
        (log) => {
          state.log = log;
        },
        owner
      );
    } catch (error) {
      const cleanup = overlay.cleanup();
      state.indexFilter.restored = cleanup.restored;
      if (!cleanup.restored) error.message = `${error.message}; ${cleanup.conflict}`;
      await fail(error);
      throw error;
    }
    const indexed = operation.promise.then(
      (result) => {
        const cleanup = overlay.cleanup();
        state.indexFilter.restored = cleanup.restored;
        if (!cleanup.restored) throw new Error(`Source-only index filter cleanup failed: ${cleanup.conflict}`);
        return result;
      },
      (error) => {
        const cleanup = overlay.cleanup();
        state.indexFilter.restored = cleanup.restored;
        if (!cleanup.restored) error.message = `${error.message}; ${cleanup.conflict}`;
        throw error;
      }
    );
    const job = { operation, state, promise: undefined, startupError: operation.startupError };
    jobs.set(project.name, job);
    job.promise = indexed
      .then(async (result) => {
        if (await assertReadable(project)) state.indexerReadsPlain = true;
        state.skippedSources = await skippedSources(project, config);
        await refreshProjectFiles(project, config, state);
        return result;
      })
      .then(
        (result) => {
          state.phase = 'succeeded';
          // When the indexer started reading: a file saved while it ran may be missing from
          // the index, so the drift pre-check must count it.
          state.indexedAt = startedAt;
          state.summary = JSON.stringify(result.structuredContent || result.content).slice(0, LOG_LIMIT);
          removeLegacyIndex(project);
          return result;
        },
        async (error) => {
          if (error.message === 'Index cancelled') {
            state.phase = 'cancelled';
            state.error = error.message.slice(-LOG_LIMIT);
          } else {
            await recordFailure(project, state, error, startedAt, config);
          }
          throw error;
        }
      )
      .finally(() => {
        try {
          persist(project, state);
        } finally {
          try {
            releaseLock(project, owner);
          } finally {
            jobs.delete(project.name);
          }
        }
      });
    // GUI jobs finish after start() returns. Keep their rejection observed.
    job.promise.catch(() => {});
    return job;
  }
  /**
   * Fast filesystem pre-check against the last completed index: counts source files that were
   * deleted, modified after `indexedAt`, or added into module/expert directories without spawning
   * the native indexer.
   */
  function computeIndexDrift(project, status, saved, latestModules, current) {
    if (status.phase !== 'succeeded') return undefined;
    const baseline = status.indexedAt ?? status.architecture?.generatedAt ?? status.updatedAt ?? 0;
    const experts = saved?.experts || [];
    const knownFiles = new Set(
      [
        ...(latestModules || []).flatMap((item) => item.files || []),
        ...Object.values(current || {}).flatMap((record) => record?.owned || []),
      ].filter((file) => typeof file === 'string' && file && !/^[<:/\\]/.test(file))
    );
    const indexedList = readJson(indexedFilesPath(project));
    const indexed = new Set(Array.isArray(indexedList) ? indexedList.filter((file) => typeof file === 'string') : []);
    let added = 0;
    let deleted = 0;
    let modified = 0;
    for (const file of knownFiles) {
      try {
        const stat = fs.statSync(path.join(project.root, file));
        if (baseline > 0 && Math.floor(stat.mtimeMs) > baseline) modified++;
      } catch (error) {
        if (error.code === 'ENOENT') deleted++;
      }
    }
    const dirSet = new Set();
    for (const file of knownFiles) {
      dirSet.add(file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
    }
    for (const expert of experts) {
      for (const raw of expert.paths || []) {
        const prefix = raw.includes('*') ? raw.slice(0, raw.indexOf('*')) : raw;
        const relDir = prefix.endsWith('/')
          ? prefix.replace(/\/+$/, '')
          : prefix.includes('/')
            ? prefix.slice(0, prefix.lastIndexOf('/'))
            : '';
        if (!relDir.includes('..') && !path.isAbsolute(relDir) && !/^[A-Za-z]:/.test(relDir)) dirSet.add(relDir);
      }
    }
    const extensions = cFamilyProject(project.root) ? C_FAMILY : SOURCE_EXTENSIONS;
    const seenCandidates = new Set();
    for (const relDir of dirSet) {
      if (relDir && relDir.split('/').some((seg) => architecture.FOREIGN_SEGMENTS.has(seg.toLowerCase()))) continue;
      const absDir = relDir ? path.join(project.root, relDir) : project.root;
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
        const relFile = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (knownFiles.has(relFile) || seenCandidates.has(relFile)) continue;
        if (relFile.split('/').some((seg) => architecture.FOREIGN_SEGMENTS.has(seg.toLowerCase()))) continue;
        seenCandidates.add(relFile);
        try {
          const stat = fs.statSync(path.join(project.root, relFile));
          // An indexed file outside every module was edited, not added.
          if (indexed.has(relFile)) {
            if (baseline > 0 && Math.floor(stat.mtimeMs) > baseline) modified++;
            continue;
          }
          const stamp = Math.floor(Math.max(stat.mtimeMs, stat.birthtimeMs || 0));
          if (baseline > 0 && stamp > baseline) added++;
        } catch {
          continue;
        }
      }
    }
    // Indexed files outside every module that are gone from the scanned folders.
    for (const file of indexed) {
      if (knownFiles.has(file) || !extensions.has(path.extname(file).toLowerCase())) continue;
      if (!dirSet.has(file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')) continue;
      if (file.split('/').some((seg) => architecture.FOREIGN_SEGMENTS.has(seg.toLowerCase()))) continue;
      if (!fs.existsSync(path.join(project.root, file))) deleted++;
    }
    if (!knownFiles.size && !dirSet.size && baseline > 0) {
      for (const full of sampleFiles(project.root)) {
        try {
          if (Math.floor(fs.statSync(full).mtimeMs) > baseline) modified++;
        } catch {
          // Best-effort pre-check only.
        }
      }
    }
    return added + deleted + modified > 0 ? { added, deleted, modified } : undefined;
  }
  const api = {
    async get(repoPath) {
      const project = projectFor(repoPath);
      const status = current(project);
      const job = jobs.get(project.name);
      if (job) return { ...status, ...job.state };
      if (status.phase === 'running') {
        const owner = readJson(path.join(project.lock, 'owner.json'));
        if (!owner || (dead(owner.pid) && (!owner.childPid || dead(owner.childPid))))
          return { ...status, phase: 'failed', error: 'Previous index process stopped before completion' };
      }
      return status;
    },
    async save(repoPath, config) {
      const project = projectFor(repoPath);
      readProjectConfig(project.root);
      const next = validateConfig(config);
      atomicJson(configPath(project.root), next);
      if (!next.enabled) await api.cancel(repoPath);
      return api.get(repoPath);
    },
    /** bypassPrecheck: the user says the indexer is whitelisted although Woody reads ciphertext. */
    async start(repoPath, startOptions = {}) {
      const project = projectFor(repoPath);
      const config = readProjectConfig(project.root);
      if (!config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
      let job;
      try {
        job = await beginIndex(project, config, {
          bypassPrecheck: startOptions?.bypassPrecheck === true,
          language: startOptions?.language,
        });
      } catch (error) {
        // A refusal is a recorded outcome the panel explains, like any failed run.
        if (error?.precheck === true) return api.get(repoPath);
        throw error;
      }
      if (job.startupError) await job.promise;
      return api.get(repoPath);
    },
    /** Index a folder the last index skipped by name: add it to .cbmignore, then index again. */
    async include(repoPath, folder) {
      const project = projectFor(repoPath);
      const status = await api.get(repoPath);
      if (!status.config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (status.phase === 'running') throw new Error('An index is already running for this project');
      if (typeof folder !== 'string' || !status.skippedSources?.some((item) => item.path === folder))
        throw new Error('Only a folder the last index skipped can be added');
      safeRelative(project.root, folder);
      addIncludeLine(project.root, folder);
      return api.start(repoPath);
    },
    /**
     * Write .woody/architecture.md now, in `language` (the panel's). Holds the index lock so
     * an index cannot rebuild the graph underneath it.
     */
    async architecture(repoPath, architectureOptions = {}) {
      const project = projectFor(repoPath);
      const status = await api.get(repoPath);
      if (!status.config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
      if (status.phase === 'running') throw new Error('An index is already running for this project');
      if (status.phase !== 'succeeded')
        throw new Error('Index the project successfully before generating the architecture file');
      const owner = acquireLock(project);
      try {
        const language = typeof architectureOptions.language === 'string' ? architectureOptions.language : undefined;
        let result;
        try {
          result = await writeProjectFiles(project, status.config, {
            language,
            previous: { architecture: status.architecture, moduleCards: status.moduleCards },
            strict: true,
          });
        } catch (error) {
          persist(project, {
            ...(readJson(project.statusFile) || {}),
            architecture: { ...status.architecture, error: error.message },
          });
          throw error;
        }
        persist(project, { ...(readJson(project.statusFile) || {}), ...result });
      } finally {
        releaseLock(project, owner);
      }
      return api.get(repoPath);
    },
    /**
     * The module experts' feature cards: the state of each (`nobrief` before Woody wrote its
     * brief, `missing` before the expert wrote anything, `stale` when the module's files
     * changed after the expert's last update, `ready`, or `error`) and the brief's digest.
     * `refresh` regenerates the briefs of `ids` (all experts when omitted) from the index,
     * and of every expert whose brief is missing or whose paths changed.
     */
    async moduleCards(repoPath, cardOptions = {}) {
      const project = projectFor(repoPath);
      const status = await api.get(repoPath);
      if (!status.config.enabled) throw new Error('Codebase memory is disabled for this project');
      const saved = readExperts(project.root, throughPowerShell);
      const experts = saved?.experts || [];
      const records = status.moduleCards?.experts || {};
      const hasBrief = (expert) => {
        try {
          const text = readCard(woodyPath(project.root, `${FEATURES_DIR}/${expert.id}.md`));
          return text !== undefined && text.includes(architecture.MARK.start);
        } catch {
          return false;
        }
      };
      const wanted = Array.isArray(cardOptions.ids) ? cardOptions.ids : experts.map((expert) => expert.id);
      const outdated = experts
        .filter(
          (expert) => !records[expert.id]?.generatedAt || !samePaths(records[expert.id], expert) || !hasBrief(expert)
        )
        .map((expert) => expert.id);
      const regenerate = cardOptions.refresh === true ? [...new Set([...wanted, ...outdated])] : [];
      let cards = status.moduleCards || {};
      let latestModules = status.architecture?.modules || [];
      let latestStatus = status;
      if (regenerate.length) {
        if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
        if (status.phase === 'running') throw new Error('An index is already running for this project');
        if (status.phase !== 'succeeded')
          throw new Error('Index the project successfully before writing feature cards');
        const owner = acquireLock(project);
        try {
          const language = typeof cardOptions.language === 'string' ? cardOptions.language : undefined;
          const result = await writeProjectFiles(project, status.config, {
            language: fs.existsSync(path.join(project.root, ARCHITECTURE_FILE)) ? undefined : language,
            previous: { architecture: status.architecture, moduleCards: status.moduleCards },
            only: regenerate,
          });
          persist(project, { ...(readJson(project.statusFile) || {}), ...result });
          cards = result.moduleCards;
          latestModules = result.architecture?.modules || latestModules;
          latestStatus = await api.get(repoPath);
        } finally {
          releaseLock(project, owner);
        }
      }
      // For experts not regenerated above, check whether their card was written or their files changed.
      const regenerated = new Set(regenerate);
      const next = { ...cards, experts: { ...(cards.experts || {}) } };
      let changed = false;
      for (const expert of experts) {
        if (regenerated.has(expert.id)) continue;
        const record = next.experts[expert.id];
        if (!record?.generatedAt || !samePaths(record, expert) || record.state === 'error') continue;
        try {
          const text = readCard(woodyPath(project.root, `${FEATURES_DIR}/${expert.id}.md`));
          const own = modules.ownPart(text, expert);
          const filesHash =
            record.driftSig !== undefined
              ? sha1(`${hashFiles(project.root, record.owned || [])}\n${record.driftSig}`)
              : hashFiles(project.root, record.owned || []);
          const { state, record: updated } = modules.cardState(record, {
            filesHash,
            ownHash: sha1(own),
            hasOwn: own.length > 0,
          });
          if (state !== record.state || updated.reviewedFilesHash !== record.reviewedFilesHash) changed = true;
          next.experts[expert.id] = { ...record, ...updated, state };
        } catch (error) {
          next.experts[expert.id] = { ...record, state: 'error', error: error.message };
          changed = true;
        }
      }
      if (changed && status.phase !== 'running')
        persist(project, { ...(readJson(project.statusFile) || {}), moduleCards: next });
      cards = next;
      const current = cards.experts || {};
      const indexDrift = computeIndexDrift(project, latestStatus, saved, latestModules, current);
      return {
        modules: latestModules,
        error: cards.error,
        indexPhase: latestStatus.phase,
        ...(latestStatus.phase === 'failed' && latestStatus.error ? { indexError: latestStatus.error } : {}),
        ...(latestStatus.phase === 'failed' && latestStatus.precheckRefused === true
          ? { indexPrecheckRefused: true }
          : {}),
        ...(indexDrift ? { indexDrift } : {}),
        experts: experts.map((expert) => {
          const record = current[expert.id];
          const matched = samePaths(record, expert);
          const fresh = Boolean(record?.generatedAt && matched);
          const failed = record?.state === 'error' && matched;
          return {
            id: expert.id,
            card: `${FEATURES_DIR}/${expert.id}.md`,
            state: fresh || failed ? record.state : 'nobrief',
            ...((fresh || failed) && record.error ? { error: record.error } : {}),
            ...(fresh ? { generatedAt: record.generatedAt, digest: record.digest } : {}),
          };
        }),
      };
    },
    async cancel(repoPath) {
      const project = projectFor(repoPath);
      const job = jobs.get(project.name);
      if (job) {
        job.operation.cancel();
        try {
          await job.promise;
        } catch {
          /* State includes cancellation. */
        }
      } else {
        const owner = readJson(path.join(project.lock, 'owner.json'));
        if (owner && !dead(owner.pid)) {
          // Never recreate a lock directory if its owner finished after our read.
          try {
            fs.writeFileSync(path.join(project.lock, 'cancel.json'), JSON.stringify({ token: owner.token }));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          for (let i = 0; i < 100 && readJson(path.join(project.lock, 'owner.json'))?.token === owner.token; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      return api.get(repoPath);
    },
    async session(repoPath) {
      const project = projectFor(repoPath);
      const config = readProjectConfig(project.root);
      if (!config.enabled) return { enabled: false };
      if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
      return {
        enabled: true,
        skillPath: options.skillPath,
        transport: {
          type: 'stdio',
          command: 'node',
          args: [options.adapterPath],
          env: {
            // The folder itself: a worktree maps to the main index again and keeps its own diff.
            WOODY_CBM_REPO: project.worktreeRoot || project.root,
            WOODY_CBM_BINARY: options.binaryPath,
            WOODY_CBM_CACHE_ROOT: options.cacheRoot,
          },
        },
      };
    },
    async callTool(repoPath, tool, args) {
      const project = projectFor(repoPath);
      const config = readProjectConfig(project.root);
      if (!config.enabled) throw new Error('Codebase memory is disabled for this project');
      const bound = boundArguments(project, tool, args, config);
      if (!project.worktreeRoot) return callBound(project, config, tool, bound);
      if (tool === 'detect_changes') return detectWorktreeChanges(project, bound);
      // The shared index is the main checkout's: say so wherever positions or text may differ.
      const result = await callBound(project, config, tool, bound);
      return result && typeof result === 'object' && !result.isError
        ? { ...result, content: [{ type: 'text', text: worktreeNote(project) }, ...(result.content || [])] }
        : result;
    },
    dispose() {
      disposed = true;
      for (const operation of processes) operation.cancel();
    },
  };
  async function callBound(project, config, tool, bound) {
    if (tool === 'index_repository') return (await beginIndex(project, config)).promise;
    if (tool === 'detect_changes') {
      if (!detectGit(project.root)) return detectIndexChanges(project, config, bound);
      try {
        return await native(project, tool, bound).promise;
      } catch (error) {
        if (/git revision|not a git repository|ambiguous argument 'HEAD'/i.test(error.message))
          return detectIndexChanges(project, config, bound);
        throw error;
      }
    }
    if (tool === 'search_graph' && typeof bound.query === 'string' && /[^\x00-\x7f]/.test(bound.query)) {
      const query = asciiWords(bound.query);
      if (!/[A-Za-z0-9_]{2,}/.test(query)) return { isError: true, content: [{ type: 'text', text: NON_ASCII_QUERY }] };
      const result = await native(project, tool, { ...bound, query }).promise;
      return { ...result, content: [{ type: 'text', text: NON_ASCII_NOTE }, ...(result.content || [])] };
    }
    return native(project, tool, bound).promise;
  }
  return api;
}
module.exports = {
  createRuntime,
  canonical,
  findPowerShell,
  readConfig,
  validateConfig,
  identity,
  terminateOwnedProcess,
  TOOLS,
  // Exposed for the failure-diagnostics tests; not part of the runtime API.
  classifyFailure,
  readingProbe,
  looksLikeText,
  encryptedForThisProcess,
  readFileThroughPowerShellSync,
};
