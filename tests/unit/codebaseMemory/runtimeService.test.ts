import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodebaseMemoryService } from '@/process/services/codebaseMemory/service';
import { createLensManager } from '@/process/services/codebaseMemory/lens';

it('loads the shared runtime beside the packaged adapter and returns managed Node transport', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-service-'));
  const service = createCodebaseMemoryService({
    binaryPath: process.execPath,
    adapterPath: path.resolve('resources/bundled-mcp/codebase-memory/index.cjs'),
    cacheRoot: path.join(repo, 'cache'),
    skillPath: 'bundled-skill',
  });
  try {
    await service.save(repo, { version: 1, enabled: true, mode: 'fast' });
    expect(await service.session(repo)).toMatchObject({
      enabled: true,
      skillPath: 'bundled-skill',
      transport: { command: 'node', env: { WOODY_CBM_REPO: fs.realpathSync.native(repo) } },
    });
    await expect(service.openLens(repo)).rejects.toThrow(/Initialize/);
    await service.save(repo, { version: 1, enabled: false, mode: 'fast' });
    await expect(service.openLens(repo)).rejects.toThrow(/disabled/);
  } finally {
    await service.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('project Lens lifecycle', () => {
  let root: string;
  let manager: ReturnType<typeof createLensManager>;
  const openExternal = vi.fn(async (_url: string) => {});
  const terminateProcess = vi.fn();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-lens-test-'));
    openExternal.mockReset();
    fs.writeFileSync(
      path.join(root, 'server.cjs'),
      `
      const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
      if(process.argv.includes('config'))process.exit(0);
      const cache=process.env.CBM_CACHE_DIR;
      if(process.env.CBM_RUNTIME_DIR!==cache){console.error('Missing daemon isolation');process.exit(9)}
      fs.appendFileSync(path.join(cache,'launches'),String(process.pid)+'\\n');
      const marker=path.join(process.cwd(),'behavior');
      const behavior=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):'';
      if(behavior==='exit'){console.error('fixture launch failed');process.exit(3)}
      if(behavior==='hang'){setInterval(()=>{},1000)}else{
        const port=Number(process.argv.find(x=>x.startsWith('--port=')).split('=')[1]);
        const server=http.createServer((req,res)=>{const respond=()=>res.end(req.url==='/'?'<title>CBM Lens Beta</title>':JSON.stringify({root_path:behavior==='wrong'?'some-other-project':process.cwd()})); if(behavior==='slow'&&req.url!=='/')setTimeout(respond,800);else respond()}).listen(port,'127.0.0.1');
        process.stdin.resume();process.stdin.on('end',()=>{if(behavior!=='uncooperative')server.close()});
      }
    `
    );
    const { terminateOwnedProcess } = createRequire(import.meta.url)(
      path.resolve('resources/bundled-mcp/codebase-memory/runtime.cjs')
    );
    terminateProcess.mockReset().mockImplementation(terminateOwnedProcess);
    manager = createLensManager({
      binaryPath: process.execPath,
      binaryArgs: [path.join(root, 'server.cjs')],
      openExternal,
      terminateProcess,
      timeoutMs: 2000,
    });
  });
  afterEach(async () => {
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function project(name = 'one') {
    const repo = path.join(root, name);
    const cache = path.join(root, name + '-cache');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    return { root: fs.realpathSync.native(repo), cache, name };
  }
  it('coalesces concurrent opens and reuses the same ready process for later opens', async () => {
    const p = project();
    await Promise.all([manager.open(p), manager.open(p)]);
    expect(openExternal).toHaveBeenCalledTimes(1);
    await manager.open(p);
    expect(new Set(openExternal.mock.calls.map(([url]) => url)).size).toBe(1);
    expect(fs.readFileSync(path.join(p.cache, 'launches'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
  it('uses distinct ports and caches for different project folders', async () => {
    const a = project('中文 one'),
      b = project('two');
    await Promise.all([manager.open(a), manager.open(b)]);
    expect(new Set(openExternal.mock.calls.map(([url]) => new URL(url).port)).size).toBe(2);
    expect(openExternal.mock.calls.map(([url]) => new URL(url).searchParams.get('project')).toSorted()).toEqual(
      [a.name, b.name].toSorted()
    );
  });
  it('allows project metadata to take longer than half a second on Windows', async () => {
    const p = project();
    fs.writeFileSync(path.join(p.root, 'behavior'), 'slow');
    await manager.open(p);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
  it.each(['exit', 'hang', 'wrong'])('reports %s startup failures without opening a browser', async (behavior) => {
    const p = project();
    fs.writeFileSync(path.join(p.root, 'behavior'), behavior);
    await expect(manager.open(p)).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
    const pid = Number(fs.readFileSync(path.join(p.cache, 'launches'), 'utf8').trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('stops a ready project and starts a fresh process on reopening', async () => {
    const p = project();
    await manager.open(p);
    const pid = Number(fs.readFileSync(path.join(p.cache, 'launches'), 'utf8').trim());
    await manager.stop(p.name);
    expect(() => process.kill(pid, 0)).toThrow();
    await manager.open(p);
    expect(fs.readFileSync(path.join(p.cache, 'launches'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
  it('releases its native client gracefully without killing a daemon shared with other commands', async () => {
    const p = project();
    await manager.open(p);
    await manager.stop(p.name);
    expect(terminateProcess).not.toHaveBeenCalled();
  });
  it('can retry a failed shutdown instead of caching the rejection forever', async () => {
    const p = project();
    fs.writeFileSync(path.join(p.root, 'behavior'), 'uncooperative');
    await manager.open(p);
    terminateProcess.mockRejectedValueOnce(new Error('Temporary cleanup failure'));
    await expect(manager.stop(p.name)).rejects.toThrow('Temporary cleanup failure');
    fs.unlinkSync(path.join(p.root, 'behavior'));
    await manager.open(p);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
  it('cancels startup on dispose and rejects subsequent opens', async () => {
    const p = project();
    fs.writeFileSync(path.join(p.root, 'behavior'), 'hang');
    const pending = expect(manager.open(p)).rejects.toThrow();
    await manager.dispose();
    await pending;
    expect(openExternal).not.toHaveBeenCalled();
    await expect(manager.open(p)).rejects.toThrow(/disposed/);
  });
  it('surfaces a browser launch error and allows retry', async () => {
    const p = project();
    openExternal.mockRejectedValueOnce(new Error('Browser unavailable'));
    await expect(manager.open(p)).rejects.toThrow('Browser unavailable');
    await manager.open(p);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});
