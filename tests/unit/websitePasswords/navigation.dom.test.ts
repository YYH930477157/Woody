import { beforeEach, describe, expect, it } from 'vitest';
import { installWebviewNavigationInterceptor } from '@/common/utils/browser/navigation';

beforeEach(() => {
  document.body.innerHTML =
    '<form method="post" action="https://login.test/session"><input name="password" value="secret"><button>Sign in</button></form>';
});
describe('browser login form navigation', () => {
  it('keeps the native POST submission, including its fields, available to Chromium', () => {
    installWebviewNavigationInterceptor();
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    document.querySelector('form')!.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(false);
    expect(new FormData(document.querySelector('form')!).get('password')).toBe('secret');
  });
});
