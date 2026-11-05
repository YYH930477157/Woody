import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebsitePasswordCapture, websiteLoginOutcome } from '@/common/utils/browser/passwordUpdates';

const origin = location.origin;
const report = vi.fn();
const form = (extra = '') => `<form action="/session"><input name="username" value="alice" autocomplete="username">
<input name="password" type="password" value="new-password">${extra}<button type="submit">Sign in</button></form>`;
const host = window as Window & { woodyPasswordCapture?: { report: typeof report }; __woodyPasswordCapture?: boolean };
let bounds: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  document.body.innerHTML = form();
  host.woodyPasswordCapture = { report };
  bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
    height: 30,
    top: 0,
    left: 0,
    bottom: 30,
    right: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  report.mockClear();
  bounds.mockRestore();
});
/** jsdom keeps isTrusted on the implementation object behind each wrapper. */
const implOf = <T>(wrapper: object): T => {
  const symbol = Object.getOwnPropertySymbols(wrapper).find((item) => item.description === 'impl');
  if (!symbol) throw new Error('jsdom implementation not found');
  return (wrapper as Record<symbol, T>)[symbol];
};
/** Dispatch like a real user action: jsdom's public dispatchEvent always clears isTrusted. */
const dispatchTrusted = (target: EventTarget, event: Event): void => {
  const eventImpl = implOf<{ isTrusted: boolean }>(event);
  eventImpl.isTrusted = true;
  implOf<{ _dispatch: (event: unknown) => boolean }>(target)._dispatch(eventImpl);
};
/** The user types (or pastes) what each password field now holds. */
const typePasswords = () => {
  for (const input of document.querySelectorAll('input[type=password]'))
    dispatchTrusted(input, new Event('input', { bubbles: true }));
};
const submit = () =>
  dispatchTrusted(document.querySelector('form')!, new Event('submit', { bubbles: true, cancelable: true }));
describe('isolated login password capture', () => {
  it('captures an ordinary submitted login with the exact origin and identity', () => {
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).toHaveBeenCalledWith({ origin, username: 'alice', password: 'new-password' });
  });
  it('captures readonly identity on the second step and externally associated controls', () => {
    document.body.innerHTML = `<input name="username" value="alice" form="login" readonly>
      <form id="login"><input type="password" value="new-password"><button>Sign in</button></form>`;
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).toHaveBeenCalledWith({ origin, username: 'alice', password: 'new-password' });
  });
  it.each([
    '<input type="password">',
    '<input name="username" value="bob">',
    '<input autocomplete="one-time-code">',
    '<input name="captcha">',
  ])('rejects ambiguous or MFA forms: %s', (extra) => {
    document.body.innerHTML = form(extra);
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).not.toHaveBeenCalled();
  });
  it('rejects cross-origin submit destinations', () => {
    document.body.innerHTML = form().replace('/session', 'https://elsewhere.test/session');
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).not.toHaveBeenCalled();
  });
  it('rejects signup and change-password inputs', () => {
    document.body.innerHTML = form().replace('type="password"', 'type="password" autocomplete="new-password"');
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).not.toHaveBeenCalled();
  });
  it('captures a SPA login button click before the form is replaced', () => {
    document.body.innerHTML = form().replace('type="submit"', 'type="button"');
    installWebsitePasswordCapture();
    typePasswords();
    dispatchTrusted(document.querySelector('button')!, new MouseEvent('click', { bubbles: true }));
    expect(report).toHaveBeenCalledOnce();
  });
  it('ignores a submit event that a page script fabricates', () => {
    document.body.innerHTML = form().replace('type="submit"', 'type="button"');
    installWebsitePasswordCapture();
    typePasswords();
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(report).not.toHaveBeenCalled();
  });
  it('ignores a password the page put in the field, even when the browser submits it', () => {
    installWebsitePasswordCapture();
    typePasswords();
    document.querySelector<HTMLInputElement>('input[type=password]')!.value = 'chosen-by-the-page';
    // A scripted click on a submit button makes the browser fire a trusted submit event.
    document.querySelector('button')!.click();
    submit();
    expect(report).not.toHaveBeenCalled();
  });
  it('does not capture incomplete usernames or passwords', () => {
    document.body.innerHTML = form().replace('value="alice"', 'value=""');
    installWebsitePasswordCapture();
    typePasswords();
    submit();
    expect(report).not.toHaveBeenCalled();
  });
});
describe('conservative login outcome detection', () => {
  it('waits while a login or MFA input remains', () => {
    expect(websiteLoginOutcome(origin)).toBe('pending');
    document.body.innerHTML = '<input autocomplete="one-time-code">';
    expect(websiteLoginOutcome(origin)).toBe('pending');
  });
  it('rejects a visible error instead of treating form disappearance as success', () => {
    document.body.innerHTML = '<div role="alert">Invalid credentials</div>';
    expect(websiteLoginOutcome(origin)).toBe('blocked');
  });
  it('allows a fully loaded same-origin page with no authentication fields', () => {
    document.body.innerHTML = '<h1>Account</h1>';
    expect(websiteLoginOutcome(origin)).toBe('ready');
    expect(websiteLoginOutcome('https://different.test')).toBe('blocked');
  });
});
