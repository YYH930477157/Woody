import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserPasswordController } from '@process/services/websitePasswords/controller';

class Target extends EventEmitter {
  id = 1;
  url = 'https://login.test/login';
  destroyed = false;
  getURL = () => this.url;
  isDestroyed = () => this.destroyed;
  executeJavaScriptInIsolatedWorld = vi.fn(async () => 'password-submitted');
}
const credential = {
  id: 'account-1',
  name: 'X',
  origin: 'https://login.test',
  username: 'alice',
  password: 'secret',
  isDefault: true,
};
const settle = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('active browser automatic login controller', () => {
  it('allows a fresh login attempt when the saved password was replaced', async () => {
    const target = new Target();
    let password = 'old';
    const controller = new BrowserPasswordController({ find: async () => ({ ...credential, password }) });
    controller.attach(target);
    await settle();
    password = 'replacement';
    target.emit('did-navigate');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls[1][1][0].code).toContain('"username":true,"password":true');
    controller.dispose();
  });
  it('runs in an isolated world and avoids a second password submission after navigation', async () => {
    const target = new Target();
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    const [world, scripts] = target.executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as [
      number,
      { code: string }[],
    ];
    expect(world).toBeGreaterThan(999);
    expect(scripts[0].code).toContain('"password":true');
    target.emit('did-navigate');
    await settle();
    expect(
      (target.executeJavaScriptInIsolatedWorld.mock.calls[1] as unknown as [number, { code: string }[]])[1][0].code
    ).toContain('"password":false');
    controller.dispose();
  });
  it('allows the password step after a username-first continuation', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('username-submitted');
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    target.emit('did-navigate-in-page');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls[1][1][0].code).toContain('"username":false,"password":true');
    expect(calls[1][1][0].code).toContain('"continuation":true');
    controller.dispose();
  });
  it('does not share a username continuation with another browser target', async () => {
    const first = new Target();
    first.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('username-submitted');
    const second = new Target();
    second.id = 2;
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(first);
    await settle();
    controller.attach(second);
    await settle();
    const calls = second.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls[0][1][0].code).toContain('"continuation":false');
    controller.dispose();
  });
  it('invalidates a username continuation after leaving its origin', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce('username-submitted');
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    target.url = 'https://other.test/';
    target.emit('did-navigate');
    await settle();
    target.url = credential.origin + '/password';
    target.emit('did-navigate');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls.at(-1)![1][0].code).toContain('"continuation":false');
    controller.dispose();
  });
  it('invalidates a username continuation after an account conflict', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce('username-submitted')
      .mockResolvedValueOnce('identity-conflict');
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    target.emit('did-navigate');
    await settle();
    target.emit('did-navigate');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls[2][1][0].code).toContain('"continuation":false');
    controller.dispose();
  });
  it('expires a username continuation while waiting for the password page', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValue('none').mockResolvedValueOnce('username-submitted');
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    await vi.advanceTimersByTimeAsync(61_000);
    target.emit('did-navigate');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls.at(-1)![1][0].code).toContain('"continuation":false');
    controller.dispose();
  });
  it.each(['detach', 'cross-origin'])('does not restore a pending continuation after %s and return', async (change) => {
    const target = new Target();
    let resolve!: (result: string) => void;
    target.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        })
    );
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    if (change === 'detach') {
      controller.detach(target.id);
      controller.attach(target);
    } else {
      target.url = 'https://other.test/';
      target.emit('did-navigate');
      target.url = credential.origin + '/password';
      target.emit('did-navigate');
    }
    resolve('username-submitted');
    await settle();
    target.emit('did-navigate');
    await settle();
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls.at(-1)![1][0].code).toContain('"continuation":false');
    controller.dispose();
  });
  it('does not inject credentials when a lookup is disabled or absent', async () => {
    const target = new Target();
    const controller = new BrowserPasswordController({ find: async () => undefined });
    controller.attach(target);
    await settle();
    expect(target.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('rejects an origin that changed while loading the account', async () => {
    const target = new Target();
    let resolve!: (value: typeof credential) => void;
    const controller = new BrowserPasswordController({
      find: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    controller.attach(target);
    target.url = 'https://evil.test';
    resolve(credential);
    await settle();
    expect(target.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('detaches old targets and stops polling on destruction', async () => {
    const first = new Target();
    const second = new Target();
    second.id = 2;
    const controller = new BrowserPasswordController({ find: async () => undefined });
    controller.attach(first);
    controller.attach(second);
    expect(first.listenerCount('dom-ready')).toBe(0);
    second.destroyed = true;
    second.emit('destroyed');
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
  it('detaches only the matching target when tab visibility changes', async () => {
    const first = new Target();
    const second = new Target();
    second.id = 2;
    const controller = new BrowserPasswordController({ find: async () => undefined });
    controller.attach(first);
    await settle();
    controller.attach(second);
    await settle();
    controller.detach(first.id);
    expect(second.listenerCount('dom-ready')).toBe(1);
    controller.detach(second.id);
    expect(second.listenerCount('dom-ready')).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
  it('publishes the outcome and why a login did not run, without the account', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValue(['none', 'verification'] as never);
    const statuses: unknown[] = [];
    const controller = new BrowserPasswordController({ find: async () => credential }, undefined, (status) =>
      statuses.push(status)
    );
    controller.attach(target);
    await settle();
    expect(statuses.at(-1)).toEqual({
      site: 'https://login.test',
      account: 'saved',
      result: 'skipped',
      reason: 'verification',
    });
    expect(JSON.stringify(statuses)).not.toContain('alice');
    const code = (
      target.executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as [number, { code: string }[]]
    )[1][0].code;
    expect(code).toContain('woodyLoginWatch');
    controller.dispose();
    expect(statuses.at(-1)).toEqual({ site: null, account: 'none' });
  });
  it('keeps a submitted login reported until the page changes', async () => {
    const target = new Target();
    target.executeJavaScriptInIsolatedWorld
      .mockResolvedValueOnce(['password-submitted', undefined] as never)
      .mockResolvedValue(['none', 'alreadyTried'] as never);
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await controller.describe()).toMatchObject({ result: 'password-submitted' });
    controller.dispose();
  });
  it('says whether a site without an account has none or automatic login is off', async () => {
    const target = new Target();
    const lookup = vi.fn(async () => 'disabled' as const);
    const controller = new BrowserPasswordController({ find: async () => undefined, lookup });
    controller.attach(target);
    await settle();
    expect(await controller.describe()).toEqual({ site: 'https://login.test', account: 'disabled' });
    expect(target.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    controller.dispose();
    expect(await controller.describe()).toEqual({ site: null, account: 'none' });
  });
  it('gives a requested login one fresh attempt after the automatic one was used', async () => {
    const target = new Target();
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await settle();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(['password-submitted', undefined] as never);
    expect(await controller.loginNow()).toMatchObject({ account: 'saved', result: 'password-submitted' });
    const calls = target.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    expect(calls.at(-1)![1][0].code).toContain('"username":true,"password":true');
    // Automatic polling keeps respecting the limit afterwards.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)![1][0].code).toContain('"password":false');
    controller.dispose();
    expect(await controller.loginNow()).toEqual({ site: null, account: 'none' });
  });
  it('looks again when the page reports a login form, at most once per interval', async () => {
    const target = new Target();
    const controller = new BrowserPasswordController({ find: async () => credential });
    controller.attach(target);
    await vi.advanceTimersByTimeAsync(70_000);
    const before = target.executeJavaScriptInIsolatedWorld.mock.calls.length;
    target.emit('ipc-message', { sender: target }, 'woody:website-login-form');
    target.emit('ipc-message', { sender: target }, 'woody:website-login-form');
    target.emit('ipc-message', { sender: {} }, 'woody:website-login-form');
    target.emit('ipc-message', { sender: target }, 'other-channel');
    await settle();
    expect(target.executeJavaScriptInIsolatedWorld.mock.calls.length).toBe(before + 1);
    controller.dispose();
  });
  it('stops bounded polling and tolerates lookup failures without unhandled rejections', async () => {
    const target = new Target();
    const find = vi.fn(async () => {
      throw new Error('vault-unreadable');
    });
    const controller = new BrowserPasswordController({ find });
    controller.attach(target);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(find.mock.calls.length).toBeLessThanOrEqual(61);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
});
