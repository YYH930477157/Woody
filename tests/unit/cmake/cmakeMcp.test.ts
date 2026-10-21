import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCmakeRpc } from '@/process/services/cmake/runtime/cmakeRpc';
import type { CmakeService } from '@/process/services/cmake/cmakeService';

describe('bundled offline CMake MCP', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await close?.();
  });
  async function client() {
    const rpc = await startCmakeRpc({} as CmakeService);
    close = rpc.close;
    child = spawn(process.execPath, [path.resolve('resources/bundled-mcp/cmake-mcp/index.cjs')], {
      env: { ...process.env, AIONUI_CMAKE_PORT: String(rpc.port), AIONUI_CMAKE_TOKEN: rpc.token },
      stdio: 'pipe',
      windowsHide: true,
    });
    const pending = new Map<number, (value: Record<string, unknown>) => void>();
    let id = 0;
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id: number; result: Record<string, unknown> };
        buffer = buffer.slice(newline + 1);
        pending.get(message.id)?.(message.result);
        pending.delete(message.id);
      }
    });
    return (method: string, params = {}): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => reject(new Error('MCP test timeout')), 3000);
        pending.set(requestId, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
  }
  it('lists offline tools and reads the desktop allowlist', async () => {
    const call = await client();
    const tools = (await call('tools/list')).tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'cmake_projects',
        'cmake_inspect',
        'cmake_start',
        'cmake_read',
        'cmake_cancel',
        'gdb_projects',
        'gdb_start',
        'gdb_status',
        'gdb_stop',
        'gdb_evaluate',
        'gdb_memory',
      ])
    );
    const result = await call('tools/call', { name: 'cmake_projects', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
  });
  it('returns tool errors without treating denied access as successful output', async () => {
    const call = await client();
    const result = await call('tools/call', {
      name: 'cmake_start',
      arguments: { projectPath: process.cwd(), operation: 'build' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'cmake.aiDisabled' }]);
  });
  it('routes GDB tools through the separately authorized shared debugger', async () => {
    const call = await client();
    expect((await call('tools/call', { name: 'gdb_projects', arguments: {} })).content).toEqual([
      { type: 'text', text: '[]' },
    ]);
    const denied = await call('tools/call', { name: 'gdb_start', arguments: { projectPath: process.cwd() } });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([{ type: 'text', text: 'gdb.aiDisabled' }]);
  });
});
