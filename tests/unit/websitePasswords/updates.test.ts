import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPasswordUpdates } from '@process/services/websitePasswords/updates';
import { WEBSITE_PASSWORD_CAPTURE } from '@/common/utils/browser/types';

const account = { id: 'a', name: 'X', origin: 'https://x.test', username: 'alice', password: 'old', isDefault: true };
class Target extends EventEmitter {
  id = 1;
  url = 'https://x.test/login';
  mainFrame = { url: this.url };
  isDestroyed = () => false;
  getURL = () => this.url;
  executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, scripts: { code: string }[]) =>
    scripts[0].code.includes('websiteLoginOutcome') ? 'ready' : undefined
  );
  submit(password = 'new') {
    this.emit('ipc-message', { sender: this, senderFrame: this.mainFrame }, WEBSITE_PASSWORD_CAPTURE, {
      origin: 'https://x.test',
      username: 'alice',
      password,
    });
  }
}
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const instances: BrowserPasswordUpdates[] = [];
function fixture() {
  const store = {
    findForUpdate: vi.fn(async () => ({ ...account })),
    updatePassword: vi.fn(async () => ({ available: true, enabled: true, accounts: [account] })),
  };
  const confirm = vi.fn(async (_account: typeof account, _signal: AbortSignal) => true);
  const error = vi.fn();
  const updates = new BrowserPasswordUpdates(store, confirm, error);
  instances.push(updates);
  const target = new Target();
  updates.attach(target as never);
  return { updates, target, store, confirm, error };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const instance of instances.splice(0)) instance.detach();
  vi.useRealTimers();
});
describe('confirmed website password updates', () => {
  it('blocks automatic retry of an account after a manual submission, including the unchanged password', async () => {
    const { target, updates } = fixture();
    target.submit('old');
    await settle();
    expect(updates.blocksAutofill(account)).toBe(true);
    expect(updates.blocksAutofill({ ...account, password: 'manually-updated-later' })).toBe(false);
  });
  it('aborts an unanswered confirmation when the candidate expires', async () => {
    const { target, confirm, store } = fixture();
    let finish!: (value: boolean) => void;
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    target.submit();
    await vi.advanceTimersByTimeAsync(4000);
    const signal = confirm.mock.calls[0][1];
    await vi.advanceTimersByTimeAsync(120_000);
    finish(true);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(store.updatePassword).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for a stable completed page, asks without secrets, and replaces with compare-and-set', async () => {
    const { target, store, confirm } = fixture();
    target.submit();
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(confirm).toHaveBeenCalledWith(
      expect.not.objectContaining({ password: expect.anything() }),
      expect.any(AbortSignal)
    );
    expect(store.updatePassword).toHaveBeenCalledExactlyOnceWith('a', 'new', 'old', expect.any(AbortSignal));
  });
  it('does not save a declined update or prompt again for the same submission', async () => {
    const { target, store, confirm } = fixture();
    confirm.mockResolvedValue(false);
    target.submit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.updatePassword).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('does not prompt for unchanged passwords or missing/disabled accounts', async () => {
    const { target, store, confirm } = fixture();
    target.submit('old');
    await vi.advanceTimersByTimeAsync(5000);
    store.findForUpdate.mockResolvedValue(undefined as never);
    target.submit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('does not accept a capture from a child frame or different origin', async () => {
    const { target, store } = fixture();
    target.emit('ipc-message', { sender: target, senderFrame: {} }, WEBSITE_PASSWORD_CAPTURE, {
      ...account,
      password: 'new',
    });
    target.emit('ipc-message', { sender: target, senderFrame: target.mainFrame }, WEBSITE_PASSWORD_CAPTURE, {
      ...account,
      origin: 'https://evil.test',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.findForUpdate).not.toHaveBeenCalled();
  });
  it('keeps failed logins and MFA pending until expiry and releases listeners on detach', async () => {
    const { target, updates, confirm, store } = fixture();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValue('pending');
    target.submit();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(confirm).not.toHaveBeenCalled();
    expect(store.updatePassword).not.toHaveBeenCalled();
    updates.detach();
    expect(target.listenerCount('ipc-message')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('discards a capture when the page reports an error', async () => {
    const { target, confirm } = fixture();
    target.executeJavaScriptInIsolatedWorld.mockResolvedValue('blocked');
    target.submit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('aborts a pending prompt on tab switch and ignores its late acceptance', async () => {
    const { target, updates, confirm, store } = fixture();
    let finish!: (value: boolean) => void;
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    target.submit();
    await vi.advanceTimersByTimeAsync(4000);
    const signal = confirm.mock.calls[0][1];
    updates.detach();
    finish(true);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(store.updatePassword).not.toHaveBeenCalled();
  });
  it('discards candidates on cross-origin navigation', async () => {
    const { target, confirm } = fixture();
    target.submit();
    await settle();
    target.url = 'https://elsewhere.test';
    target.emit('did-start-navigation', {}, target.url, false, true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(confirm).not.toHaveBeenCalled();
  });
  it('does not overwrite an account changed while a prompt was open', async () => {
    const { target, store, confirm } = fixture();
    confirm.mockImplementation(async () => {
      store.findForUpdate.mockResolvedValue({ ...account, password: 'manual-edit' });
      return true;
    });
    target.submit();
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.updatePassword).not.toHaveBeenCalled();
  });
  it('rechecks the live page after consent and does not save when MFA or errors have appeared', async () => {
    const { target, confirm, store } = fixture();
    confirm.mockImplementation(async () => {
      target.executeJavaScriptInIsolatedWorld.mockResolvedValue('pending');
      return true;
    });
    target.submit();
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.updatePassword).not.toHaveBeenCalled();
  });
  it('does not clear a newer submission when a superseded save finishes late', async () => {
    const { target, store } = fixture();
    let finish!: () => void;
    store.updatePassword.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ available: true, enabled: true, accounts: [account] });
        })
    );
    target.submit('first');
    await vi.advanceTimersByTimeAsync(4000);
    target.submit('second');
    await settle();
    finish();
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.updatePassword).toHaveBeenCalledTimes(2);
  });
  it('reports a generic save failure without retaining or retrying a candidate', async () => {
    const { target, store, error } = fixture();
    store.updatePassword.mockRejectedValue(new Error('secret-detail'));
    target.submit();
    await vi.advanceTimersByTimeAsync(8000);
    expect(error).toHaveBeenCalledExactlyOnceWith();
    expect(store.updatePassword).toHaveBeenCalledOnce();
  });
});
