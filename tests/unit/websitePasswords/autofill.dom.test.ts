import { beforeEach, describe, expect, it, vi } from 'vitest';
import { autofillWebsiteLogin } from '@/common/utils/browser/autofill';

const credential = { origin: 'https://login.test', username: 'alice', password: 's3cret' };
const permissions = { username: true, password: true };
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
let submit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('location', new URL('https://login.test/login'));
  document.body.innerHTML =
    '<form action="https://login.test/session"><input name="username" autocomplete="username"><input name="password" type="password"><button type="submit">Sign in</button></form>';
  submit = vi.fn();
  HTMLFormElement.prototype.requestSubmit = submit;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 20 } as DOMRect);
});

describe('isolated website login autofill', () => {
  it('fills credentials, dispatches input events, and submits a login form', () => {
    const changed = vi.fn();
    input('password').addEventListener('input', changed);
    expect(autofillWebsiteLogin(credential, permissions)).toBe('password-submitted');
    expect([input('username').value, input('password').value, changed.mock.calls.length]).toEqual([
      'alice',
      's3cret',
      1,
    ]);
    expect(submit).toHaveBeenCalledOnce();
  });
  it('refuses credentials after navigation to a different origin', () => {
    vi.stubGlobal('location', new URL('https://evil.test'));
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('refuses cross-origin form actions and formtarget overrides', () => {
    document.querySelector('form')!.action = 'https://evil.test/steal';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    document.querySelector('form')!.action = 'https://login.test/session';
    document.querySelector('button')!.setAttribute('formaction', 'https://evil.test/steal');
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
  });
  it('preserves a manually entered different username', () => {
    input('username').value = 'bob';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('does not submit the default password after a different account was manually continued', () => {
    input('username').value = 'bob';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    document.body.innerHTML =
      '<p>Enter password for bob</p><form><input name="password" type="password"><button>Sign in</button></form>';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('allows an identity-free password step only with a verified continuation', () => {
    input('username').remove();
    const continuation = { ...permissions, continuation: true };
    expect(autofillWebsiteLogin(credential, continuation)).toBe('password-submitted');
    expect(input('password').value).toBe(credential.password);
  });
  it('allows a password-only form with a matching hidden identity', () => {
    input('username').type = 'hidden';
    input('username').value = credential.username;
    expect(autofillWebsiteLogin(credential, permissions)).toBe('password-submitted');
  });
  it('invalidates a verified continuation when the account identity conflicts', () => {
    input('username').value = 'bob';
    const continuation = { ...permissions, continuation: true };
    expect(autofillWebsiteLogin(credential, continuation)).toBe('identity-conflict');
    expect(input('password').value).toBe('');
  });
  it.each(['hidden', 'readonly', 'disabled'])('refuses a different account identity in a %s field', (kind) => {
    input('username').value = 'bob';
    if (kind === 'hidden') input('username').type = 'hidden';
    if (kind === 'readonly') input('username').readOnly = true;
    if (kind === 'disabled') input('username').disabled = true;
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('checks hidden account identifiers associated outside the form', () => {
    document.querySelector('form')!.id = 'login';
    input('username').remove();
    document.body.insertAdjacentHTML('afterbegin', '<input form="login" type="hidden" name="username" value="bob">');
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('recognizes common userid fields and an unlabelled single email field', () => {
    input('username').name = 'userid';
    input('userid').value = 'bob';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    input('userid').name = 'address';
    input('address').autocomplete = '';
    input('address').type = 'email';
    input('address').value = '';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('password-submitted');
    expect(input('address').value).toBe('alice');
  });
  it('preserves a manually entered password without submitting', () => {
    input('password').value = 'typed-secret';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(submit).not.toHaveBeenCalled();
  });
  it('rechecks account identity after password input handlers run', () => {
    input('password').addEventListener('input', () => {
      input('username').value = 'bob';
    });
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(submit).not.toHaveBeenCalled();
  });
  it('rechecks newly added external form identity fields before submitting', () => {
    document.querySelector('form')!.id = 'login';
    input('password').addEventListener('change', () => {
      document.body.insertAdjacentHTML('afterbegin', '<input form="login" type="hidden" name="userid" value="bob">');
    });
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(submit).not.toHaveBeenCalled();
  });
  it('refuses registration and password-change forms', () => {
    input('password').autocomplete = 'new-password';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    input('password').autocomplete = '';
    document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input type="password" name="confirm">');
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
  });
  it('ignores hidden password traps and ambiguous login forms', () => {
    input('password').style.display = 'none';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    input('password').style.display = '';
    document.body.insertAdjacentHTML('beforeend', '<form><input type="password"></form>');
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
  });
  it('continues a username-first login only with an explicit username and next control', () => {
    document.body.innerHTML =
      '<form action="https://login.test/login"><input name="username" autocomplete="username"><button>Continue</button></form>';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('username-submitted');
    expect(input('username').value).toBe('alice');
    expect(submit).toHaveBeenCalledOnce();
  });
  it('does not treat search boxes as username-first login', () => {
    document.body.innerHTML = '<form><input name="search"><button>Search</button></form>';
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(submit).not.toHaveBeenCalled();
  });
  it('honors the submission limit before filling secrets again', () => {
    expect(autofillWebsiteLogin(credential, { username: true, password: false })).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('waits for captcha, one-time codes, and disabled controls', () => {
    document.querySelector('form')!.insertAdjacentHTML('beforeend', '<input autocomplete="one-time-code" name="otp">');
    expect(autofillWebsiteLogin(credential, permissions)).toBe('none');
    expect(input('password').value).toBe('');
  });
  it('works as a serialized standalone function in the isolated world', () => {
    const standalone = window.eval(`(${autofillWebsiteLogin.toString()})`);
    expect(standalone(credential, permissions)).toBe('password-submitted');
  });
});
