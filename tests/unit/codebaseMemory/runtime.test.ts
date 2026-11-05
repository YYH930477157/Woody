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
    powerShell: null,
    ...extra,
  });
  disposables.push(value);
  return value;
}
const config = { version: 1, enabled: true, mode: 'fast' };
const installedPowerShell = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-cbm-test-'));
  repo = path.join(root, '中文 project');
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(root, 'fixture.cjs'),
    `const fs=require('node:fs'); const path=require('node:path'); const marker=path.join(process.cwd(),'behavior'); const b=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):''; if(b==='hang')setInterval(()=>{},1000); else if(b==='invalid')console.log('oops'); else if(b==='exit'){console.error('fixture error');process.exit(3)} else if(b==='error')console.log(JSON.stringify({isError:true,content:[{type:'text',text:'native refused'}]})); else { console.error('index diagnostic');console.log(JSON.stringify({isError:false,structuredContent:{nodes:13,args:process.argv.slice(2),cache:process.env.CBM_CACHE_DIR,runtime:process.env.CBM_RUNTIME_DIR}})); }`
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
/** The failure phase lands first; the report follows once the probes finish. */
async function diagnosed(service: ReturnType<typeof runtime>) {
  let result = await finished(service);
  for (let i = 0; i < 150 && result.phase === 'failed' && result.diagnostics === undefined; i++) {
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
    const result = await diagnosed(service);
    expect(result.phase).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.diagnostics).toContain('Woody codebase-memory diagnostics');
    expect(result.diagnostics).toContain('--- native stderr (tail) ---');
    expect(result.conclusion).toBeTruthy();
    expect(fs.existsSync(result.diagnosticsPath as string)).toBe(true);
  });
  it('refuses to index before spawning when this process reads ciphertext', async () => {
    const service = runtime({
      powerShell: 'pwsh.exe',
      // The encryption client hands plaintext to PowerShell 7 but ciphertext to the indexer.
      readThroughPowerShell: async (_executable: string, files: string[]) =>
        files.map(() => Buffer.from('export function checkoutTotal() { return 1 }\n')),
    });
    await service.save(repo, config);
    fs.writeFileSync(
      path.join(repo, 'cipher.ts'),
      Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256))
    );
    const started = Date.now();
    // The panel gets a recorded, explained refusal rather than a raw exception.
    const result = await service.start(repo);
    // Rejected by the preflight, not after a multi-minute native run.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({
      phase: 'failed',
      reason: 'unreadable',
      precheckRefused: true,
      conclusion: 'encrypted-for-app',
    });
    expect(result.error).toMatch(/encrypted for Woody/);
    expect(result.diagnostics).toContain('conclusion: encrypted-for-app');
    expect(result.diagnostics).toContain('CIPHERTEXT');
    // An agent's index_repository call still fails loudly.
    await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/encrypted for Woody/);
  });
  it('never takes identical bytes for encryption, whatever they look like', async () => {
    const { encryptedForThisProcess, readingProbe } = require(runtimePath);
    // Unreadable to this process, and PowerShell 7 reads exactly the same bytes.
    fs.writeFileSync(
      path.join(repo, 'cipher.ts'),
      Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256))
    );
    const probe = await readingProbe(repo, 'pwsh.exe', async (_executable: string, files: string[]) =>
      files.map((file) => fs.readFileSync(file))
    );
    expect(probe.direct[0].text).toBe(false);
    expect(probe.shell[0].differs).toBe(false);
    expect(encryptedForThisProcess(probe)).toBe(false);
  });
  it('reads GBK and UTF-16 sources as text, and random bytes as ciphertext', () => {
    const { looksLikeText } = require(runtimePath);
    // "/* 读取配置文件并初始化设备 */" in GBK, between lines of C.
    const comment = Buffer.from([
      0x2f, 0x2a, 0x20, 0xb6, 0xc1, 0xc8, 0xa1, 0xc5, 0xe4, 0xd6, 0xc3, 0xce, 0xc4, 0xbc, 0xfe, 0xb2, 0xa2, 0xb3, 0xf5,
      0xca, 0xbc, 0xbb, 0xaf, 0xc9, 0xe8, 0xb1, 0xb8, 0x20, 0x2a, 0x2f, 0x0d, 0x0a,
    ]);
    const code = Buffer.from('int init_device(const char *path)\r\n{\r\n    return open_config(path);\r\n}\r\n');
    const gbk = Buffer.concat(Array.from({ length: 30 }, () => [comment, code]).flat());
    expect(gbk.toString('utf8')).toContain('�');
    expect(looksLikeText(gbk)).toBe(true);
    const source = '// 资源脚本\r\nIDS_TITLE "设备配置"\r\n'.repeat(40);
    expect(looksLikeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]))).toBe(true);
    expect(looksLikeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(source, 'utf16le').swap16()]))).toBe(
      true
    );
    let seed = 7;
    const random = Buffer.from(
      Array.from({ length: 8192 }, () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed >> 16;
      }).map((value) => value % 256)
    );
    expect(looksLikeText(random)).toBe(false);
  });
  it('publishes a failed run together with its reason', async () => {
    const service = runtime();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'exit');
    await service.start(repo);
    const seen: Array<{ phase: string; error?: string; diagnostics?: string }> = [];
    for (let i = 0; i < 400; i++) {
      const state = await service.get(repo);
      seen.push(state);
      if (state.phase !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const failed = seen.filter((state) => state.phase === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const state of failed) {
      expect(state.error).toMatch(/exited 3/);
      expect(state.diagnostics).toContain('Woody codebase-memory diagnostics');
    }
  });
  it('explains ciphertext reads as an encryption whitelist problem', async () => {
    const { classifyFailure, readingProbe } = require(runtimePath);
    fs.writeFileSync(
      path.join(repo, 'cipher.ts'),
      Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256))
    );
    // The encryption client hands plaintext to PowerShell 7 but ciphertext to this process.
    const probe = await readingProbe(repo, 'pwsh.exe', async (_executable: string, files: string[]) =>
      files.map(() => Buffer.from('export function checkoutTotal() { return 1 }\n'))
    );
    expect(probe.direct[0].text).toBe(false);
    expect(probe.shell[0].text).toBe(true);
    expect(probe.shell[0].differs).toBe(true);
    const scan = { directories: 1, files: 1, unreadable: [], truncated: false };
    expect(classifyFailure({ binaryAvailable: true, error: new Error('exit 3'), probe, scan })).toBe(
      'encrypted-for-app'
    );
    expect(classifyFailure({ binaryAvailable: false, error: new Error('x'), probe, scan })).toBe('missing-binary');
    expect(classifyFailure({ binaryAvailable: true, error: new Error('timed out'), probe, scan })).toBe('timeout');
    expect(
      classifyFailure({
        binaryAvailable: true,
        error: new Error('exit 3'),
        probe: { direct: [{ ok: false, text: true, error: 'EACCES' }], shell: [] },
        scan,
      })
    ).toBe('permission-denied');
    expect(
      classifyFailure({
        binaryAvailable: true,
        error: new Error('exit 3'),
        probe: { direct: [{ ok: true, text: true }], shell: [] },
        scan,
      })
    ).toBe('unknown');
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
    expect(first.structuredContent.runtime).toBe(first.structuredContent.cache);
    expect(second.structuredContent.runtime).toBe(second.structuredContent.cache);
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

describe.runIf(fs.existsSync(installedPowerShell))('native commands started through PowerShell 7', () => {
  const started = () => runtime({ powerShell: installedPowerShell });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('runs the native program as a child of PowerShell 7', async () => {
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      `const { spawnSync } = require('node:child_process');
      const filter = 'PID eq ' + process.ppid;
      const parent = spawnSync('tasklist', ['/FI', filter, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
      console.log(JSON.stringify({ structuredContent: { parent } }));`
    );
    const service = started();
    await service.save(repo, config);
    const result = await service.callTool(repo, 'search_graph', { query: 'main' });
    expect(result.structuredContent.parent).toMatch(/^"pwsh\.exe"/i);
  }, 20000);

  it('keeps non-ASCII paths and reports the launcher it used', async () => {
    const service = started();
    await service.save(repo, config);
    await service.start(repo);
    const result = await finished(service);
    expect(result).toMatchObject({ phase: 'succeeded', launcher: 'powershell' });
    expect(result.reason).toBeUndefined();
    expect(JSON.parse(result.summary as string).args).toEqual([
      'cli',
      '--json',
      'index_repository',
      '--repo-path',
      fs.realpathSync.native(repo),
      '--name',
      expect.stringMatching(/^woody-/),
      '--mode',
      'fast',
    ]);
  }, 20000);

  it('passes JSON arguments with quotes and spaces unchanged', async () => {
    const service = started();
    await service.save(repo, config);
    const result = await service.callTool(repo, 'search_graph', { query: 'say "hi" 你好' });
    const args = result.structuredContent.args as string[];
    expect(JSON.parse(args.at(-1) as string).query).toBe('say "hi" 你好');
  }, 20000);

  it('keeps the native exit code and its diagnostics', async () => {
    const service = started();
    await service.save(repo, config);
    fs.writeFileSync(path.join(repo, 'behavior'), 'exit');
    await service.start(repo);
    const result = await finished(service);
    expect(result.phase).toBe('failed');
    expect(result.error).toMatch(/exited 3: .*fixture error/s);
  }, 20000);

  it('leaves no native process behind after cancelling', async () => {
    const pidFile = path.join(root, 'native.pid');
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`
    );
    const service = started();
    await service.save(repo, config);
    await service.start(repo);
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 10000 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    expect((await service.cancel(repo)).phase).toBe('cancelled');
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
  }, 20000);

  describe('checking that the indexer saw plain content', () => {
    const plainText = Buffer.from('int compute_total(int value) { return value; }\n');
    const queries = () => path.join(root, 'queries.log');
    const readThrough = (content: Buffer) => async (_executable: string, files: string[]) => files.map(() => content);
    // Answers search_graph the way the native tool does when asked for JSON.
    function fixtureWithGraph(total: number) {
      fs.writeFileSync(
        path.join(root, 'fixture.cjs'),
        `const fs = require('node:fs');
        if (process.argv.includes('search_graph')) {
          fs.appendFileSync(${JSON.stringify(queries())}, process.argv.at(-1) + '\\n');
          console.log(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ total: ${total} }) }] }));
        } else console.log(JSON.stringify({ structuredContent: { nodes: 28 } }));`
      );
    }
    async function index(extra: Record<string, unknown>) {
      const service = runtime({ powerShell: installedPowerShell, ...extra });
      await service.save(repo, config);
      await service.start(repo);
      return finished(service);
    }

    it('fails an index that holds none of the symbols PowerShell can read', async () => {
      fs.writeFileSync(path.join(repo, 'app.cpp'), 'ciphertext as seen directly');
      fixtureWithGraph(0);
      const result = await index({ readThroughPowerShell: readThrough(plainText) });
      expect(result).toMatchObject({ phase: 'failed', reason: 'unreadable', launcher: 'powershell' });
      expect(result.error).toMatch(/encrypted content/);
      expect(JSON.parse(fs.readFileSync(queries(), 'utf8').trim()).name_pattern).toBe('^(compute_total)$');
    }, 20000);

    it('tells an MCP client why the index cannot be used', async () => {
      fs.writeFileSync(path.join(repo, 'app.cpp'), 'ciphertext as seen directly');
      fixtureWithGraph(0);
      const service = runtime({ powerShell: installedPowerShell, readThroughPowerShell: readThrough(plainText) });
      await service.save(repo, config);
      await expect(service.callTool(repo, 'index_repository', {})).rejects.toThrow(/encrypted content/);
    }, 20000);

    it('keeps the index when its graph holds those symbols', async () => {
      fs.writeFileSync(path.join(repo, 'app.cpp'), 'ciphertext as seen directly');
      fixtureWithGraph(3);
      expect((await index({ readThroughPowerShell: readThrough(plainText) })).phase).toBe('succeeded');
    }, 20000);

    it('indexes a plain folder holding GBK sources without asking about encryption', async () => {
      const comment = Buffer.from([
        0x2f, 0x2a, 0x20, 0xb6, 0xc1, 0xc8, 0xa1, 0xc5, 0xe4, 0xd6, 0xc3, 0xce, 0xc4, 0xbc, 0xfe, 0x20, 0x2a, 0x2f,
        0x0a,
      ]);
      const code = Buffer.from('int init_device(const char *path) { return open_config(path); }\n');
      fs.writeFileSync(
        path.join(repo, 'device.c'),
        Buffer.concat(Array.from({ length: 30 }, () => [comment, code]).flat())
      );
      fixtureWithGraph(0);
      const result = await index({});
      expect(result).toMatchObject({ phase: 'succeeded', launcher: 'powershell' });
      expect(result.precheckRefused).toBeUndefined();
      expect(fs.existsSync(queries())).toBe(false);
    }, 20000);

    it('does not refuse files that PowerShell 7 reads exactly as Woody does', async () => {
      fs.writeFileSync(
        path.join(repo, 'app.cpp'),
        Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256))
      );
      fixtureWithGraph(0);
      const identical = async (_executable: string, files: string[]) => files.map((file) => fs.readFileSync(file));
      const result = await index({ readThroughPowerShell: identical });
      expect(result.phase).toBe('succeeded');
      expect(result.precheckRefused).toBeUndefined();
    }, 20000);

    it('indexes anyway on request, and remembers once the indexer proves it reads plaintext', async () => {
      const cipher = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 256));
      fs.writeFileSync(path.join(repo, 'app.cpp'), cipher);
      fixtureWithGraph(3);
      const service = runtime({ powerShell: installedPowerShell, readThroughPowerShell: readThrough(plainText) });
      await service.save(repo, config);
      // Woody reads ciphertext, so the pre-check refuses: it cannot see the indexer's whitelist.
      expect(await service.start(repo)).toMatchObject({ phase: 'failed', precheckRefused: true });
      // The user had codebase-memory-mcp.exe whitelisted and indexes anyway.
      await service.start(repo, { bypassPrecheck: true });
      expect(await finished(service)).toMatchObject({ phase: 'succeeded', indexerReadsPlain: true });
      expect((await service.get(repo)).precheckRefused).toBeUndefined();
      // Later runs, including an agent's, no longer stop at the pre-check.
      await service.start(repo);
      expect(await finished(service)).toMatchObject({ phase: 'succeeded', indexerReadsPlain: true });
      await expect(service.callTool(repo, 'index_repository', {})).resolves.toBeTruthy();
      // Woody still reads ciphertext, yet another failure is not blamed on encryption.
      fs.writeFileSync(path.join(root, 'fixture.cjs'), `console.error('worker died'); process.exit(3);`);
      await service.start(repo);
      const crashed = await finished(service);
      expect(crashed).toMatchObject({ phase: 'failed', indexerReadsPlain: true });
      expect(crashed.conclusion).not.toMatch(/^encrypted/);
      expect(crashed.diagnostics).toContain('indexer_reads_plain: proven by an earlier index');
      // The whitelist entry is gone: the index fails, and the pre-check guards the next run again.
      fixtureWithGraph(0);
      await service.start(repo);
      const lost = await finished(service);
      expect(lost).toMatchObject({ phase: 'failed', reason: 'unreadable' });
      expect(lost.indexerReadsPlain).toBeUndefined();
      expect(await service.start(repo)).toMatchObject({ phase: 'failed', precheckRefused: true });
    }, 40000);

    it('reads samples through real PowerShell and asks nothing for an unencrypted folder', async () => {
      fs.mkdirSync(path.join(repo, '源码'));
      fs.writeFileSync(path.join(repo, '源码', '模块.cpp'), `// 中文注释\n${'int value;\n'.repeat(8000)}`);
      fixtureWithGraph(0);
      expect((await index({})).phase).toBe('succeeded');
      expect(fs.existsSync(queries())).toBe(false);
    }, 20000);

    it.each([
      [
        'PowerShell cannot read the samples',
        { readThroughPowerShell: async () => Promise.reject(new Error('denied')) },
      ],
      ['the plain text has no symbols to look for', { readThroughPowerShell: readThrough(Buffer.from('// notes\n')) }],
    ])(
      'does not blame encryption when %s',
      async (_name, extra) => {
        fs.writeFileSync(path.join(repo, 'app.cpp'), 'ciphertext as seen directly');
        fixtureWithGraph(0);
        expect((await index(extra)).phase).toBe('succeeded');
      },
      20000
    );

    it('skips build output and folders without source', async () => {
      fs.mkdirSync(path.join(repo, 'node_modules'));
      fs.writeFileSync(path.join(repo, 'node_modules', 'dependency.js'), 'ciphertext as seen directly');
      fs.writeFileSync(path.join(repo, 'notes.txt'), 'ciphertext as seen directly');
      fixtureWithGraph(0);
      const readThroughPowerShell = vi.fn(readThrough(plainText));
      expect((await index({ readThroughPowerShell })).phase).toBe('succeeded');
      expect(readThroughPowerShell).not.toHaveBeenCalled();
    }, 20000);
  });
});

describe('finding PowerShell 7', () => {
  const find = (env: Record<string, string>) => require(runtimePath).findPowerShell(env);
  const program = (directory: string) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'pwsh.exe'), '');
    return path.join(directory, 'pwsh.exe');
  };

  it('prefers PATH and falls back to the default install folder', () => {
    const fromPath = program(path.join(root, 'tools'));
    const installed = program(path.join(root, 'Program Files', 'PowerShell', '7'));
    const ProgramFiles = path.join(root, 'Program Files');
    expect(find({ Path: path.join(root, 'tools'), ProgramFiles })).toBe(fromPath);
    expect(find({ Path: path.join(root, 'empty'), ProgramFiles })).toBe(installed);
  });

  it('never takes a program from a relative PATH entry', () => {
    program(path.join(process.cwd(), 'tests', 'unit', 'zz-cbm-relative'));
    try {
      expect(find({ PATH: path.join('tests', 'unit', 'zz-cbm-relative'), ProgramFiles: root })).toBeUndefined();
    } finally {
      fs.rmSync(path.join(process.cwd(), 'tests', 'unit', 'zz-cbm-relative'), { recursive: true, force: true });
    }
  });

  it('runs directly and says so when PowerShell 7 is absent', async () => {
    const service = runtime();
    await service.save(repo, config);
    await service.start(repo);
    expect(await finished(service)).toMatchObject({ phase: 'succeeded', launcher: 'direct' });
  });
});
