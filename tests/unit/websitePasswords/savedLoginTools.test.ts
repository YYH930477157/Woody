import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }));

import { startCdpBridge, type CdpBridgeHandle } from '@process/resources/builtinMcp/cdpBridge';
import {
  createSavedLoginProxy,
  describeSavedLogin,
  requestSavedLogin,
  SAVED_LOGIN_TOOLS,
} from '@process/resources/builtinMcp/savedLoginTools';

const site = 'https://login.test';

describe('saved-login tools in the browser MCP stream', () => {
  const setup = (
    call = vi.fn(async () => ({ site, account: 'saved' as const, result: 'password-submitted' as const }))
  ) => {
    const toClient = vi.fn();
    const toServer = vi.fn();
    return { call, toClient, toServer, proxy: createSavedLoginProxy({ call, toClient, toServer }) };
  };

  it('appends its tools to the first tool list page and passes everything else through unchanged', () => {
    const { proxy, toClient, toServer } = setup();
    const request = '{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}';
    proxy.fromClient(request);
    expect(toServer).toHaveBeenCalledWith(request);
    proxy.fromServer('{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"navigate_page"}]}}');
    const listed = JSON.parse(toClient.mock.calls[0][0]) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      'navigate_page',
      ...SAVED_LOGIN_TOOLS.map((tool) => tool.name),
    ]);
    // Other responses, server requests, notifications and broken lines are untouched.
    for (const line of [
      '{"jsonrpc":"2.0","id":8,"result":{"content":[]}}',
      '{"jsonrpc":"2.0","id":7,"method":"roots/list"}',
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      'not json',
    ])
      proxy.fromServer(line);
    expect(toClient.mock.calls.slice(1).map(([line]) => line)).toEqual([
      '{"jsonrpc":"2.0","id":8,"result":{"content":[]}}',
      '{"jsonrpc":"2.0","id":7,"method":"roots/list"}',
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      'not json',
    ]);
    const paged = '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{"cursor":"2"}}';
    proxy.fromClient(paged);
    proxy.fromServer('{"jsonrpc":"2.0","id":9,"result":{"tools":[]}}');
    expect(toClient).toHaveBeenLastCalledWith('{"jsonrpc":"2.0","id":9,"result":{"tools":[]}}');
  });

  it('answers its own tool calls and forwards the browser tools', async () => {
    const { proxy, call, toClient, toServer } = setup();
    proxy.fromClient('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click","arguments":{}}}');
    expect(toServer).toHaveBeenCalledOnce();
    proxy.fromClient('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"login_with_saved_account"}}');
    await vi.waitFor(() => expect(toClient).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith('login');
    expect(toServer).toHaveBeenCalledOnce();
    const reply = JSON.parse(toClient.mock.calls[0][0]) as { id: number; result: { content: { text: string }[] } };
    expect(reply.id).toBe(4);
    expect(reply.result.content[0].text).toContain('submitted the login form');
  });

  it('reports an unreachable Woody as a tool error', async () => {
    const { proxy, toClient } = setup(vi.fn(async () => Promise.reject(new Error('offline'))));
    proxy.fromClient('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"saved_login_status"}}');
    await vi.waitFor(() => expect(toClient).toHaveBeenCalledOnce());
    expect(JSON.parse(toClient.mock.calls[0][0])).toMatchObject({ id: 5, result: { isError: true } });
  });

  it('tells the agent what happened and what to do, without any account detail', () => {
    expect(describeSavedLogin('status', { site: null, account: 'none' })).toContain('No page is open');
    expect(describeSavedLogin('login', { site, account: 'none' })).toContain('No account is saved');
    expect(describeSavedLogin('login', { site, account: 'disabled' })).toContain('turned off');
    expect(
      describeSavedLogin('login', { site, account: 'saved', result: 'skipped', reason: 'verification' })
    ).toContain('captcha');
    expect(describeSavedLogin('status', { site, account: 'saved' })).toContain('call login_with_saved_account');
    expect(describeSavedLogin('login', { site, account: 'saved', result: 'username-submitted' })).toContain('username');
  });

  it('asks the bridge with the token in a header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ site, account: 'none' })));
    expect(await requestSavedLogin('http://127.0.0.1:9', 'secret', 'status', fetchImpl)).toEqual({
      site,
      account: 'none',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:9/woody/saved-login');
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' });
    await expect(
      requestSavedLogin('http://127.0.0.1:9', 'secret', 'login', async () => new Response('', { status: 403 }))
    ).rejects.toThrow('403');
  });
});

describe('saved-login route on the CDP bridge', () => {
  let bridge: CdpBridgeHandle | undefined;
  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it('requires the token and a known action, and returns only the handler result', async () => {
    const savedLogin = vi.fn(async (action: string) => ({ site, account: 'saved', action }));
    bridge = await startCdpBridge({ savedLogin });
    const url = `http://127.0.0.1:${bridge.port}/woody/saved-login`;
    const post = (body: unknown, token = bridge!.token) =>
      fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await post({ action: 'login' }, 'wrong')).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    expect((await post({ action: 'steal' })).status).toBe(400);
    expect(savedLogin).not.toHaveBeenCalled();
    const response = await post({ action: 'status' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ site, account: 'saved', action: 'status' });
  });

  it('is absent when no handler was given', async () => {
    bridge = await startCdpBridge();
    expect((await fetch(`http://127.0.0.1:${bridge.port}/woody/saved-login`, { method: 'POST' })).status).toBe(404);
  });
});
