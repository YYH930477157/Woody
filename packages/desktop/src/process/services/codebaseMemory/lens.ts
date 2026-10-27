import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

export type LensProject = { root: string; name: string; cache: string };
type LensOptions = {
  binaryPath: string;
  binaryArgs?: string[];
  openExternal(url: string): Promise<void>;
  validateProject?: (project: LensProject) => Promise<void>;
  terminateProcess(child: ChildProcessWithoutNullStreams): Promise<void>;
  timeoutMs?: number;
};
type Instance = {
  cancelled: boolean;
  children: Set<ChildProcessWithoutNullStreams>;
  url?: string;
  opening?: Promise<void>;
  stopping?: Promise<void>;
  error?: Error;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** Use direct loopback HTTP, independent of the workstation's proxy settings. */
function readLocal(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy(new Error('Lens readiness response is too large'));
      });
      response.on('error', reject);
      response.on('end', () =>
        response.statusCode === 200 ? resolve(body) : reject(new Error(`Lens returned HTTP ${response.statusCode}`))
      );
    });
    request.setTimeout(10000, () => request.destroy(new Error('Lens readiness request timed out')));
    request.on('error', reject);
  });
}

async function releaseClient(child: ChildProcessWithoutNullStreams, force: LensOptions['terminateProcess']) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // EOF releases the daemon client reference. Other queries may still own the daemon.
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.removeListener('exit', done);
      resolve();
    };
    const timer = setTimeout(done, 1000);
    child.once('exit', done);
    child.stdin.on('error', () => {
      /* The process may exit before stdin closes. */
    });
    child.stdin.end();
  });
  if (child.exitCode === null && child.signalCode === null) await force(child);
}

/** Own project-scoped Lens process trees; never expose a renderer-supplied URL. */
export function createLensManager(options: LensOptions) {
  const instances = new Map<string, Instance>();
  const terminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
  let disposed = false;
  const check = (entry: Instance) => {
    if (disposed || entry.cancelled) throw new Error('Lens startup cancelled: service stopped or disposed');
    if (entry.error) throw entry.error;
  };
  async function terminate(entry: Instance) {
    await Promise.all(
      [...entry.children].map((child) => {
        let pending = terminations.get(child);
        if (!pending) {
          pending = releaseClient(child, options.terminateProcess).catch((error: unknown) => {
            terminations.delete(child);
            throw error;
          });
          terminations.set(child, pending);
        }
        return pending;
      })
    );
  }
  function launch(entry: Instance, project: LensProject, args: string[], server: boolean) {
    check(entry);
    const child = spawn(options.binaryPath, [...(options.binaryArgs ?? []), ...args], {
      cwd: project.root,
      windowsHide: true,
      stdio: 'pipe',
      env: { ...process.env, CBM_CACHE_DIR: project.cache, CBM_RUNTIME_DIR: project.cache },
    });
    entry.children.add(child);
    let diagnostic = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-4096);
    });
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', (error) => {
        entry.error ??= error;
        reject(error);
      });
      child.once('close', (code) => {
        entry.children.delete(child);
        if (server || code !== 0) {
          const error = new Error(`CBM Lens process exited ${code}: ${diagnostic}`);
          entry.error ??= error;
          reject(error);
        } else resolve();
      });
    });
    // A retained stdio parent supervises the native HTTP daemon. Keep stdin open.
    if (server) void completion.catch(() => {});
    return completion;
  }
  async function start(entry: Instance, project: LensProject) {
    fs.mkdirSync(project.cache, { recursive: true });
    const port = await freePort();
    check(entry);
    // Persist the chosen port BEFORE stdio starts its daemon, avoiding the default 9749 listener.
    await launch(entry, project, ['config', 'set', 'ui_port', String(port)], false);
    check(entry);
    void launch(entry, project, ['--ui=true', `--port=${port}`], true);
    const base = `http://127.0.0.1:${port}`;
    const query = `project=${encodeURIComponent(project.name)}`;
    const deadline = Date.now() + (options.timeoutMs ?? 30000);
    // Readiness probes must be sequential so cancellation cannot open a stale browser tab.
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      check(entry);
      try {
        const html = await readLocal(base + '/');
        const info: unknown = JSON.parse(await readLocal(`${base}/api/repo-info?${query}`));
        if (
          html.includes('<title>CBM Lens') &&
          typeof info === 'object' &&
          info !== null &&
          'root_path' in info &&
          typeof info.root_path === 'string' &&
          fs.realpathSync.native(info.root_path) === project.root
        ) {
          check(entry);
          entry.url = `${base}/?${query}`;
          return;
        }
      } catch {
        // The listener and project store can become ready at different times.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    /* eslint-enable no-await-in-loop */
    throw new Error('CBM Lens did not become ready for this project before the startup timeout');
  }
  const api = {
    async open(project: LensProject): Promise<void> {
      if (disposed) throw new Error('Lens service is disposed');
      let entry = instances.get(project.name);
      if (entry?.stopping) {
        await entry.stopping;
        return api.open(project);
      }
      if (entry?.opening) return entry.opening;
      if (entry?.error || entry?.cancelled) {
        await api.stop(project.name);
        return api.open(project);
      }
      if (!entry) {
        entry = { cancelled: false, children: new Set() };
        instances.set(project.name, entry);
      }
      const current = entry;
      current.opening = (async () => {
        const timer = setTimeout(() => {
          current.error = new Error('CBM Lens startup timed out');
          void terminate(current).catch((error: unknown) => {
            current.error = error instanceof Error ? error : new Error(String(error));
          });
        }, options.timeoutMs ?? 30000);
        try {
          await options.validateProject?.(project);
          check(current);
          if (!current.url) await start(current, project);
          await options.validateProject?.(project);
          check(current);
          clearTimeout(timer);
          await options.openExternal(current.url!);
        } catch (error) {
          current.cancelled = true;
          try {
            await terminate(current);
          } catch (cleanupError) {
            throw new Error(`${String(error)}; Lens cleanup failed: ${String(cleanupError)}`, { cause: cleanupError });
          }
          if (instances.get(project.name) === current) instances.delete(project.name);
          throw error;
        } finally {
          clearTimeout(timer);
          current.opening = undefined;
        }
      })();
      return current.opening;
    },
    async stop(name: string): Promise<void> {
      const entry = instances.get(name);
      if (!entry) return;
      if (entry.stopping) return entry.stopping;
      entry.cancelled = true;
      entry.stopping = (async () => {
        try {
          await terminate(entry);
          await entry.opening?.catch(() => {});
          if (instances.get(name) === entry) instances.delete(name);
        } finally {
          entry.stopping = undefined;
        }
      })();
      return entry.stopping;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...instances.keys()].map((name) => api.stop(name)));
    },
  };
  return api;
}
