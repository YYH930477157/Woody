import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCmakeRpc } from '@/process/services/cmake/runtime/cmakeRpc';
import type { CmakeService } from '@/process/services/cmake/cmakeService';

describe('shared CMake AI access', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
  });

  async function setup() {
    const directory = await mkdtemp(path.join(tmpdir(), 'woody-cmake-rpc-'));
    const projectPath = await realpath(directory);
    await mkdir(path.join(projectPath, 'other'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = {
      inspect: vi.fn(async (root: string) => ({ projectPath: root })),
      start: vi.fn(async (root: string) => ({ id: 'job', projectPath: root })),
      read: vi.fn(() => ({ job: { id: 'job', projectPath }, output: 'build output', cursor: 12, truncated: false })),
      cancel: vi.fn(async () => undefined),
    };
    const debug = { request: vi.fn(async () => ({})) };
    const rpc = await startCmakeRpc(service as unknown as CmakeService, debug);
    cleanups.push(rpc.close);
    const call = (body: unknown, headers?: Record<string, string>) =>
      fetch(`http://127.0.0.1:${rpc.port}/cmake`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rpc.token}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    return { rpc, service, debug, projectPath, call };
  }

  it('denies invalid credentials and browser origins', async () => {
    const { call } = await setup();
    expect((await call({ action: 'projects' }, { authorization: 'Bearer wrong' })).status).toBe(403);
    expect((await call({ action: 'projects' }, { origin: 'http://localhost' })).status).toBe(403);
  });
  it('requires separate debug access even when build access is enabled', async () => {
    const { rpc, call, debug, projectPath } = await setup();
    await rpc.setEnabled(projectPath, true);
    expect((await (await call({ action: 'debug', request: { operation: 'status', projectPath } })).json()).error).toBe(
      'gdb.aiDisabled'
    );
    expect(debug.request).not.toHaveBeenCalled();
    await rpc.setDebugEnabled(projectPath, true);
    expect(await (await call({ action: 'debug', request: { operation: 'status', projectPath } })).json()).toEqual({
      result: {},
    });
    await rpc.setDebugEnabled(projectPath, false);
    expect((await (await call({ action: 'debugProjects' })).json()).result).toEqual([]);
  });
  it('validates debugger operations and does not expose arbitrary console commands', async () => {
    const { rpc, call, projectPath, debug } = await setup();
    await rpc.setDebugEnabled(projectPath, true);
    expect(
      (await call({ action: 'debug', request: { operation: 'console', command: 'shell cmd', projectPath } })).status
    ).toBe(400);
    expect(
      (
        await call({
          action: 'debug',
          request: { operation: 'memory', address: '0', count: 99999, projectPath, sessionId: 'x' },
        })
      ).status
    ).toBe(400);
    expect(debug.request).not.toHaveBeenCalled();
  });

  it('only lists projects explicitly enabled by the desktop panel', async () => {
    const { rpc, call, projectPath } = await setup();
    expect(await (await call({ action: 'projects' })).json()).toEqual({ result: [] });
    await rpc.setEnabled(projectPath, true);
    expect(await (await call({ action: 'projects' })).json()).toEqual({ result: [projectPath] });
  });

  it('does not authorize nested projects or allow MCP to override executable settings', async () => {
    const { rpc, call, projectPath, service } = await setup();
    await rpc.setEnabled(projectPath, true);
    const nested = await call({ action: 'start', projectPath: path.join(projectPath, 'other'), operation: 'build' });
    const override = await call({ action: 'start', projectPath, operation: 'build', executable: 'anything.exe' });
    expect((await nested.json()).error).toBe('cmake.aiDisabled');
    expect((await override.json()).error).toBeTruthy();
    expect(service.start).not.toHaveBeenCalled();
  });

  it('runs through the shared service and revokes access to existing jobs', async () => {
    const { rpc, call, projectPath, service } = await setup();
    await rpc.setEnabled(projectPath, true);
    await call({ action: 'start', projectPath, operation: 'build', selection: { buildType: 'Debug' } });
    expect(service.start).toHaveBeenCalledWith(projectPath, 'build', { buildType: 'Debug' });
    expect((await (await call({ action: 'read', jobId: 'job' })).json()).result.output).toBe('build output');
    await rpc.setEnabled(projectPath, false);
    expect((await (await call({ action: 'read', jobId: 'job' })).json()).error).toBe('cmake.aiDisabled');
  });
});
