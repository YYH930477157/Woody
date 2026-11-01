// Shared by Electron and the dependency-free, project-bound stdio adapter.
'use strict';
const fs = require('node:fs');
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
function readConfig(root) {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(configPath(root), 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG };
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
function identity(root, cacheRoot) {
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root;
  const name = `woody-${crypto.createHash('sha256').update(normalized).digest('hex')}`;
  const cache = path.join(cacheRoot, name);
  return { root, name, cache, lock: path.join(cache, 'index.lock'), statusFile: path.join(cache, 'woody-status.json') };
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
    return { repoPath: project.root, config, available: available(), phase: 'idle', log: '', ...saved };
  }
  function persist(project, value) {
    const { phase, log, error, summary, reason, launcher } = value;
    atomicJson(project.statusFile, { phase, log, error, summary, reason, launcher, updatedAt: Date.now() });
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
        if (code !== 0) return reject(new Error(`Native command exited ${code}: ${stderr}`));
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
   */
  async function assertReadable(project) {
    if (!powerShell) return;
    const files = sampleFiles(project.root);
    if (!files.length) return;
    let plain;
    try {
      plain = await (options.readThroughPowerShell || readThroughPowerShell)(powerShell, files);
    } catch {
      return;
    }
    if (plain.length !== files.length) return;
    const names = symbolNames(plain.filter((content, index) => !content.equals(readHead(files[index]))));
    if (!names.length) return;
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
      return;
    }
    if (total === 0) throw Object.assign(new Error(UNREADABLE_MESSAGE), { reason: 'unreadable' });
  }
  function beginIndex(project, config) {
    const owner = acquireLock(project);
    const state = { phase: 'running', log: '', launcher: powerShell ? 'powershell' : 'direct' };
    let operation;
    try {
      persist(project, state);
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
      releaseLock(project, owner);
      throw error;
    }
    const job = { operation, state, promise: undefined, startupError: operation.startupError };
    jobs.set(project.name, job);
    job.promise = operation.promise
      .then(async (result) => {
        await assertReadable(project);
        return result;
      })
      .then(
        (result) => {
          state.phase = 'succeeded';
          state.summary = JSON.stringify(result.structuredContent || result.content).slice(0, LOG_LIMIT);
          return result;
        },
        (error) => {
          state.phase = error.message === 'Index cancelled' ? 'cancelled' : 'failed';
          state.error = error.message.slice(-LOG_LIMIT);
          state.reason = error.reason;
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
    async start(repoPath) {
      const project = projectFor(repoPath);
      const config = readConfig(project.root);
      if (!config.enabled) throw new Error('Codebase memory is disabled for this project');
      if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
      const job = beginIndex(project, config);
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
      if (tool === 'index_repository') return beginIndex(project, config).promise;
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
};
