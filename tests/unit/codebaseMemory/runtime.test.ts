import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = path.resolve('resources/bundled-mcp/codebase-memory/runtime.cjs');
let root: string;
let repo: string;
const disposables: Array<{ dispose(): void }> = [];
function runtime(extra = {}) {
  const { createRuntime } = require(runtimePath);
  const value = createRuntime({
    binaryPath: process.execPath,
    binaryArgs: [path.join(root, 'fixture.cjs')],
    cacheRoot: path.join(root, 'cache'),
    adapterPath: path.resolve('resources/bundled-mcp/codebase-memory/index.cjs'),
    skillPath: '/skill',
    ...extra,
  });
  disposables.push(value);
  return value;
}
const config = { version: 1, enabled: true, mode: 'fast' };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-cbm-test-'));
  repo = path.join(root, '中文 project');
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(root, 'fixture.cjs'),
    `const fs=require('node:fs'); const path=require('node:path'); const marker=path.join(process.cwd(),'behavior'); const b=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):''; if(b==='hang')setInterval(()=>{},1000); else if(b==='invalid')console.log('oops'); else if(b==='exit'){console.error('fixture error');process.exit(3)} else if(b==='error')console.log(JSON.stringify({isError:true,content:[{type:'text',text:'native refused'}]})); else { console.error('index diagnostic');console.log(JSON.stringify({isError:false,structuredContent:{nodes:13,args:process.argv.slice(2),cache:process.env.CBM_CACHE_DIR}})); }`
  );
});
afterEach(() => {
  for (const value of disposables.splice(0)) value.dispose();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
// Polling observes state transitions and must remain sequential.
/* eslint-disable no-await-in-loop */
async function finished(service: ReturnType<typeof runtime>) {
  let result = await service.get(repo);
  for (let i = 0; i < 100 && result.phase === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await service.get(repo);
  }
  return result;
}
describe('project runtime', () => {
  it('defaults disabled without creating project configuration', async () => {
    const result = await runtime().get(repo);
    expect(result.config).toEqual({ version: 1, enabled: false, mode: 'fast' });
    expect(fs.existsSync(path.join(repo, '.woody'))).toBe(false);
  });
  it('accepts BOM and refuses to overwrite invalid configuration', async () => {
    const service = runtime();
    await service.save(repo, config);
    const filename = path.join(repo, '.woody/codebase-memory.json');
    fs.writeFileSync(filename, '\uFEFF' + JSON.stringify(config));
    expect((await service.get(repo)).config.enabled).toBe(true);
    fs.writeFileSync(filename, '{broken');
    await expect(service.get(repo)).rejects.toThrow(/config/i);
    await expect(service.save(repo, config)).rejects.toThrow(/config/i);
    expect(fs.readFileSync(filename, 'utf8')).toBe('{broken');
  });
  it('blocks disabled tools and session attachment', async () => {
    const service = runtime();
    expect(await service.session(repo)).toEqual({ enabled: false });
    await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/disabled/);
  });
  it('indexes asynchronously and captures structured output', async () => {
    const service = runtime();
    await service.save(repo, config);
    expect((await service.start(repo)).phase).toBe('running');
    const result = await finished(service);
    expect(result.phase).toBe('succeeded');
    expect(result.summary).toContain('13');
  });
  it.each(['invalid', 'exit', 'error'])('surfaces native %s failures', async (behavior) => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), behavior);
    await service.start(repo);
    expect((await finished(service)).phase).toBe('failed');
  });
  it('times out hung native work', async () => {
    const service = runtime({ timeoutMs: 100 });
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    await service.start(repo);
    expect((await finished(service)).error).toMatch(/timed out/);
  });
  it('serializes index requests between independent runtimes and cancels cleanly', async () => {
    const first = runtime();
    const second = runtime();
    await first.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    await first.start(repo);
    await expect(second.callTool(repo, 'index_repository', {})).rejects.toThrow(/already running/);
    expect((await first.cancel(repo)).phase).toBe('cancelled');
    fs.unlinkSync(path.join(repo, 'behavior'));
    await second.start(repo);
    expect((await finished(second)).phase).toBe('succeeded');
  });
  it('isolates same-basename projects and rejects cross-project arguments', async () => {
    const service = runtime();
    const other = path.join(root, 'other', path.basename(repo));
    fs.mkdirSync(other, { recursive: true });
    await service.save(repo, config);
    await service.save(other, config);
    const first = await service.callTool(repo, 'search_graph', { query: 'hello' });
    const second = await service.callTool(other, 'search_graph', {});
    expect(first.structuredContent.cache).not.toBe(second.structuredContent.cache);
    await expect(service.callTool(repo, 'search_graph', { project: 'other' })).rejects.toThrow(/project/);
    await expect(service.callTool(repo, 'get_file_outline', { file_path: '../secret' })).rejects.toThrow(/path/);
  });
  it('refuses unbound calls and destructive tool names', async () => {
    const service = runtime();
    await service.save(repo, config);
    await expect(service.callTool('', 'search_graph', {})).rejects.toThrow(/bound project/);
    await expect(service.callTool(repo, 'delete_project', {})).rejects.toThrow(/not allowed/);
  });
  it('rejects configuration directories linked outside the project', async () => {
    const service = runtime();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, '.woody'), 'junction');
    await expect(service.save(repo, config)).rejects.toThrow(/outside/);
    expect(fs.existsSync(path.join(outside, 'codebase-memory.json'))).toBe(false);
  });
  it('allows another runtime to cancel an MCP-owned index', async () => {
    const first = runtime();
    const second = runtime();
    await first.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    await first.start(repo);
    expect((await second.cancel(repo)).phase).toBe('cancelled');
  });
  it('validates schema types and rejects unknown tool arguments', async () => {
    const service = runtime();
    await service.save(repo, config);
    await expect(service.callTool(repo, 'trace_path', { function_name: 42 })).rejects.toThrow(/function_name/);
    await expect(service.callTool(repo, 'get_file_outline', {})).rejects.toThrow(/file_path/);
    await expect(service.callTool(repo, 'search_graph', { dangerous_override: '/elsewhere' })).rejects.toThrow(
      /dangerous_override/
    );
  });
  it('rejects tool paths through a junction outside the project', async () => {
    const service = runtime();
    await service.save(repo, config);
    const outside = path.join(root, 'external');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.c'), 'secret');
    fs.symlinkSync(outside, path.join(repo, 'linked'), 'junction');
    await expect(service.callTool(repo, 'get_file_outline', { file_path: 'linked/secret.c' })).rejects.toThrow(/path/);
  });
  it('cleans up running work on disposal', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    await service.start(repo);
    service.dispose();
    expect((await finished(service)).phase).toBe('cancelled');
  });
  it('recovers a lock only after its owner is verified dead', async () => {
    const service = runtime();
    await service.save(repo, config);
    const { identity } = require(runtimePath);
    const project = identity(fs.realpathSync.native(repo), path.join(root, 'cache'));
    const exited = spawnSync(process.execPath, ['-e', '']);
    fs.mkdirSync(project.lock, { recursive: true });
    fs.writeFileSync(path.join(project.lock, 'owner.json'), JSON.stringify({ pid: exited.pid, token: 'stale' }));
    await service.start(repo);
    expect((await finished(service)).phase).toBe('succeeded');
  });
  it('does not steal a lock with an unverifiable owner', async () => {
    const service = runtime();
    await service.save(repo, config);
    const { identity } = require(runtimePath);
    const project = identity(fs.realpathSync.native(repo), path.join(root, 'cache'));
    fs.mkdirSync(project.lock, { recursive: true });
    await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/already running/);
  });
  it('does not recreate a lock if its owner finishes during a cancellation request', async () => {
    const service = runtime();
    await service.save(repo, config);
    const { identity } = require(runtimePath);
    const project = identity(fs.realpathSync.native(repo), path.join(root, 'cache'));
    const ownerFile = path.join(project.lock, 'owner.json');
    fs.mkdirSync(project.lock, { recursive: true });
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token: 'finishing' }));
    const originalRead = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const value = originalRead(...args);
      if (args[0] === ownerFile) fs.rmSync(project.lock, { recursive: true, force: true });
      return value;
    }) as typeof fs.readFileSync);
    try {
      await service.cancel(repo);
      expect(fs.existsSync(project.lock)).toBe(false);
    } finally {
      read.mockRestore();
    }
  });
  it('bounds diagnostics and rejects excessively large native results', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      "console.error('x'.repeat(50000)); console.log('x'.repeat(5*1024*1024));"
    );
    await service.start(repo);
    const result = await finished(service);
    expect(result.log.length).toBeLessThanOrEqual(16384);
    expect(result.error).toMatch(/exceeded/);
  });
  it('preserves Chinese characters split across native output chunks', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      "const b=Buffer.from(JSON.stringify({structuredContent:{value:'中文'}}));const split=b.indexOf(Buffer.from('中'))+1;process.stdout.write(b.subarray(0,split));setTimeout(()=>process.stdout.write(b.subarray(split)),50);"
    );
    const result = await service.callTool(repo, 'search_graph', {});
    expect(result.structuredContent.value).toBe('中文');
  });
  it('releases the index lock even if final status cannot be written', async () => {
    const service = runtime();
    await service.save(repo, config);
    const { identity } = require(runtimePath);
    const project = identity(fs.realpathSync.native(repo), path.join(root, 'cache'));
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === project.statusFile && fs.readFileSync(source, 'utf8').includes('succeeded'))
        throw new Error('status write failed');
      return rename(source, destination);
    });
    try {
      await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/status write/);
      expect(fs.existsSync(project.lock)).toBe(false);
    } finally {
      failure.mockRestore();
    }
  });
  it('kills a spawned child if its lock ownership cannot be recorded', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    const rename = fs.renameSync;
    let pid = 0;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination).endsWith('owner.json')) {
        const owner = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (owner.childPid) {
          pid = owner.childPid;
          throw new Error('owner write failed');
        }
      }
      return rename(source, destination);
    });
    try {
      await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/owner write/);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(pid, 'SIGKILL');
      expect(alive).toBe(false);
    } finally {
      failure.mockRestore();
    }
  });
  it('removes a newly acquired lock if its initial owner record cannot be written', async () => {
    const service = runtime();
    await service.save(repo, config);
    const { identity } = require(runtimePath);
    const project = identity(fs.realpathSync.native(repo), path.join(root, 'cache'));
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination).endsWith('owner.json')) throw new Error('initial owner write failed');
      return rename(source, destination);
    });
    try {
      await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/initial owner/);
      expect(fs.existsSync(project.lock)).toBe(false);
    } finally {
      failure.mockRestore();
    }
  });
  it('reports missing bundled native executable when an enabled project requests a session', async () => {
    const service = runtime({ binaryPath: path.join(root, 'missing.exe') });
    await service.save(repo, config);
    await expect(service.session(repo)).rejects.toThrow(/unavailable/);
  });
  it('rejects a refused start instead of returning the previous success status', async () => {
    const service = runtime();
    await service.save(repo, config);
    await service.start(repo);
    await finished(service);
    await service.save(repo, { ...config, enabled: false });
    await expect(service.start(repo)).rejects.toThrow(/disabled/);
  });
  it('rejects invalid save arguments without changing existing config', async () => {
    const service = runtime();
    await service.save(repo, config);
    await expect(service.save(repo, { ...config, mode: 'unsafe' })).rejects.toThrow(/configuration/);
    expect((await service.get(repo)).config).toEqual(config);
  });
  it('rejects start immediately if the bundled executable is missing', async () => {
    const service = runtime({ binaryPath: path.join(root, 'missing.exe') });
    await service.save(repo, config);
    await expect(service.start(repo)).rejects.toThrow(/unavailable/);
  });
  it('rejects GUI start while another owner is indexing', async () => {
    const service = runtime();
    const other = runtime();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'hang');
    await service.start(repo);
    await expect(other.start(repo)).rejects.toThrow(/already running/);
    await service.cancel(repo);
  });
  it('cancels descendants of its owned native process', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);"
    );
    await service.start(repo);
    const marker = path.join(repo, 'descendant.pid');
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    await service.cancel(repo);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(pid, 'SIGKILL');
    expect(alive).toBe(false);
  });
  it.skipIf(process.platform !== 'win32')(
    'cancels native-parent descendants without relying on Node child cleanup',
    async () => {
      const fixture = path.join(root, 'native-parent.ps1');
      fs.writeFileSync(
        fixture,
        `$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = '${process.execPath.replace(/'/g, "''")}'
$info.Arguments = '-e "setInterval(()=>{},1000)"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$ownedChild = [System.Diagnostics.Process]::Start($info)
[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'descendant.pid'), [string]$ownedChild.Id)
Start-Sleep -Seconds 120
`
      );
      const service = runtime({
        binaryPath: path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe'
        ),
        binaryArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture],
      });
      await service.save(repo, config);
      await service.start(repo);
      const marker = path.join(repo, 'descendant.pid');
      let pid = 0;
      try {
        for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
        pid = Number(fs.readFileSync(marker, 'utf8'));
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            service.cancel(repo),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Cancellation did not terminate inherited native pipes')),
                5000
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* Already terminated. */
          }
        }
      }
    },
    20000
  );
});
