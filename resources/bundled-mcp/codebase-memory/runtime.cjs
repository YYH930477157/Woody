// Shared by Electron and the dependency-free, project-bound stdio adapter.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const TOOL_SCHEMAS = new Map(require('./tools.json').map((tool) => [tool.name, tool.inputSchema]));
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
const C_FAMILY = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
const defaultModes = new Map();
/**
 * The mode a project starts with before it is saved. C and C++ lean on macros, and
 * only the full mode indexes them; on a 670-file firmware project full took 5.3 s
 * against 4.2 s for fast. Other projects start fast. Cached: the panel polls this.
 */
function defaultMode(root) {
  if (defaultModes.has(root)) return defaultModes.get(root);
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
  const mode = cFamily > 0 && cFamily >= other ? 'full' : 'fast';
  defaultModes.set(root, mode);
  return mode;
}
function readConfig(root) {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(configPath(root), 'utf8').replace(/^\uFEFF/, '')));
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
function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, filename);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return undefined;
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
  if (args.repo_path !== undefined && canonical(args.repo_path) !== project.root)
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
  let disposed = false;
  const projectFor = (repoPath) => identity(canonical(repoPath), path.resolve(options.cacheRoot));
  function available() {
    return fs.existsSync(options.binaryPath);
  }
  function current(project) {
    const config = readConfig(project.root);
    const saved = readJson(project.statusFile) || {};
    // An index built under another project name (the full-hash name before
    // shortening) answers no query under this one: report it as not indexed.
    if (saved.phase === 'succeeded' && saved.projectName !== project.name) {
      saved.phase = 'idle';
      delete saved.summary;
    }
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
  async function beginIndex(project, config, { bypassPrecheck = false } = {}) {
    const owner = acquireLock(project);
    const startedAt = Date.now();
    const previous = readJson(project.statusFile) || {};
    const state = {
      phase: 'running',
      log: '',
      launcher: powerShell ? 'powershell' : 'direct',
      // Proof from an earlier run that the indexer reads plaintext here outlives later runs.
      indexerReadsPlain: previous.indexerReadsPlain === true ? true : undefined,
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
      await fail(error);
      throw error;
    }
    const job = { operation, state, promise: undefined, startupError: operation.startupError };
    jobs.set(project.name, job);
    job.promise = operation.promise
      .then(async (result) => {
        if (await assertReadable(project)) state.indexerReadsPlain = true;
        return result;
      })
      .then(
        (result) => {
          state.phase = 'succeeded';
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
      readConfig(project.root);
      const next = validateConfig(config);
      atomicJson(configPath(project.root), next);
      if (!next.enabled) await api.cancel(repoPath);
      return api.get(repoPath);
    },
    /** bypassPrecheck: the user says the indexer is whitelisted although Woody reads ciphertext. */
    async start(repoPath, startOptions = {}) {
      const project = projectFor(repoPath);
      const config = readConfig(project.root);
      if (!config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
      let job;
      try {
        job = await beginIndex(project, config, { bypassPrecheck: startOptions?.bypassPrecheck === true });
      } catch (error) {
        // A refusal is a recorded outcome the panel explains, like any failed run.
        if (error?.precheck === true) return api.get(repoPath);
        throw error;
      }
      if (job.startupError) await job.promise;
      return api.get(repoPath);
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
      const config = readConfig(project.root);
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
            WOODY_CBM_REPO: project.root,
            WOODY_CBM_BINARY: options.binaryPath,
            WOODY_CBM_CACHE_ROOT: options.cacheRoot,
          },
        },
      };
    },
    async callTool(repoPath, tool, args) {
      const project = projectFor(repoPath);
      const config = readConfig(project.root);
      if (!config.enabled) throw new Error('Codebase memory is disabled for this project');
      const bound = boundArguments(project, tool, args, config);
      if (tool === 'index_repository') return (await beginIndex(project, config)).promise;
      return native(project, tool, bound).promise;
    },
    dispose() {
      disposed = true;
      for (const operation of processes) operation.cancel();
    },
  };
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
};
