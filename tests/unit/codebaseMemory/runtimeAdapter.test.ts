import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('project MCP adapter', () => {
  it('lists tools without a project and refuses unbound execution without launching native', async () => {
    const child = spawn(process.execPath, [path.resolve('resources/bundled-mcp/codebase-memory/index.cjs')], {
      env: { ...process.env, WOODY_CBM_REPO: '', WOODY_CBM_BINARY: 'must-not-launch.exe' },
      stdio: 'pipe',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_graph', arguments: { query: 'main' } } },
      ]
        .map((request) => JSON.stringify(request))
        .join('\n') + '\n'
    );
    expect(await exited).toBe(0);
    const replies = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies.find((reply) => reply.id === 2).result.tools.map((tool: { name: string }) => tool.name)).toContain(
      'get_architecture'
    );
    expect(replies.find((reply) => reply.id === 3).result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/bound project/) }],
    });
    expect(stderr).toBe('');
  });
});
