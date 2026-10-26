// Shared by Electron and the dependency-free, project-bound stdio adapter.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
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
      if (code !== 0) {
        fallback(new Error(`taskkill exited ${code}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Create an isolated project runtime. binaryArgs supports executable wrappers. */
function createRuntime(options) {
  const jobs = new Map();
  const processes = new Set();
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
    const { phase, log, error, summary } = value;
    atomicJson(project.statusFile, { phase, log, error, summary, updatedAt: Date.now() });
  }
  function native(project, tool, args, onLog, owner) {
    if (disposed) throw new Error('Codebase memory service is disposed');
    if (!available()) throw new Error('Bundled codebase-memory executable is unavailable');
    fs.mkdirSync(project.cache, { recursive: true });
    const cliArgs =
      tool === 'index_repository'
        ? ['cli', '--json', tool, '--repo-path', project.root, '--name', project.name, '--mode', args.mode]
        : ['cli', '--json', tool, JSON.stringify(args)];
    const child = spawn(options.binaryPath, [...(options.binaryArgs || []), ...cliArgs], {
      cwd: project.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CBM_CACHE_DIR: project.cache, CBM_NO_DAEMON: '1' },
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
  function beginIndex(project, config) {
    const owner = acquireLock(project);
    const state = { phase: 'running', log: '' };
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
      .then(
        (result) => {
          state.phase = 'succeeded';
          state.summary = JSON.stringify(result.structuredContent || result.content).slice(0, LOG_LIMIT);
          return result;
        },
        (error) => {
          state.phase = error.message === 'Index cancelled' ? 'cancelled' : 'failed';
          state.error = error.message.slice(-LOG_LIMIT);
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
module.exports = { createRuntime, canonical, readConfig, validateConfig, identity, TOOLS };
