import type { AutofillCredential, AutofillPermissions, AutofillResult } from './types';

/**
 * Runs only inside an isolated browser world. Keep every runtime dependency inside
 * the function: the main process serializes it rather than invoking it directly.
 */
export function autofillWebsiteLogin(credential: AutofillCredential, allowed: AutofillPermissions): AutofillResult {
  if (location.origin !== credential.origin || window.top !== window) return 'none';
  const visible = (element: HTMLElement): boolean => {
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || parent.hidden) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const editable = (element: HTMLInputElement): boolean =>
    !element.disabled && !element.readOnly && !['hidden', 'search'].includes(element.type) && visible(element);
  const passwords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]'));
  if (passwords.length > 1) return 'none';
  const password = passwords[0];
  if (
    password &&
    (!editable(password) || password.value || password.autocomplete === 'new-password' || !allowed.password)
  )
    return 'none';
  const fields = password?.form
    ? Array.from(password.form.elements).filter(
        (element): element is HTMLInputElement => element instanceof HTMLInputElement
      )
    : Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  const isUsername = (element: HTMLInputElement): boolean =>
    ['text', 'email', 'tel', 'hidden'].includes(element.type) &&
    (element.type === 'email' ||
      element.autocomplete === 'username' ||
      /^(user(name|id)?|email|login|account|identifier)$/i.test(element.name || element.id));
  const identities = fields.filter(isUsername);
  const identityConflict = (): AutofillResult => (allowed.continuation ? 'identity-conflict' : 'none');
  if (identities.some((element) => element.value && element.value !== credential.username)) return identityConflict();
  const explicit = identities.filter(editable);
  const usernames =
    explicit.length || !password
      ? explicit
      : fields.filter((element) => ['text', 'email', 'tel'].includes(element.type) && editable(element));
  if (usernames.length > 1 || (!password && (!allowed.username || usernames.length !== 1))) return 'none';
  const username = usernames[0];
  if (username?.value && username.value !== credential.username) return identityConflict();
  if (
    password &&
    !username &&
    !identities.some((element) => element.value === credential.username) &&
    !allowed.continuation
  )
    return 'none';
  const form = password?.form ?? username?.form ?? null;
  const scope: ParentNode = form ?? document.body;
  if (password && username && password.form !== username.form) return 'none';
  if (scope.querySelector('input[autocomplete="new-password"], input[autocomplete="one-time-code"]')) return 'none';
  if (
    fields.some((element) =>
      element.matches(
        'input[autocomplete="one-time-code"], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
      )
    )
  )
    return 'none';
  if (
    scope.querySelector(
      'iframe[src*="captcha"], [data-sitekey], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
    )
  )
    return 'none';
  const wrongFlow =
    /sign.?up|register|registration|reset|forgot|change.?password|create.?account|注册|註冊|重置|忘记|修改密码/i;
  if (wrongFlow.test(`${form?.id ?? ''} ${form?.getAttribute('action') ?? ''} ${location.pathname}`)) return 'none';
  const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type=submit]'))
    .filter((button) => visible(button) && !button.disabled && button.type !== 'reset')
    .filter((button) =>
      /log.?in|sign.?in|continue|next|submit|登录|登陆|登入|登錄|继续|繼續|下一步|提交/i.test(
        button.textContent || button.value || button.getAttribute('aria-label') || ''
      )
    );
  if (buttons.length !== 1) return 'none';
  const button = buttons[0];
  if (wrongFlow.test(button.textContent || button.value)) return 'none';
  const safeDestination = (): boolean => {
    if (location.origin !== credential.origin) return false;
    try {
      const action = button.getAttribute('formaction') ?? form?.getAttribute('action');
      const destination = new URL(action || location.href, document.baseURI);
      return (
        destination.origin === credential.origin &&
        (!form || !form.target || form.target === '_self') &&
        (!button.getAttribute('formtarget') || button.getAttribute('formtarget') === '_self')
      );
    } catch {
      return false;
    }
  };
  if (!safeDestination()) return 'none';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return 'none';
  const fill = (element: HTMLInputElement, value: string): void => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (username && !username.value) fill(username, credential.username);
  // Input handlers may replace the form, navigate, or change its destination.
  if (!safeDestination() || (username && !username.isConnected)) return 'none';
  if (username && username.value !== credential.username) return identityConflict();
  if (password) {
    if (!password.isConnected || password.value) return 'none';
    fill(password, credential.password);
  }
  if (!safeDestination() || !button.isConnected || (password && !password.isConnected)) return 'none';
  const liveFields = form
    ? Array.from(form.elements).filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
    : Array.from(document.querySelectorAll<HTMLInputElement>('input'));
  if (liveFields.some((element) => isUsername(element) && element.value && element.value !== credential.username))
    return identityConflict();
  if (username && !username.isConnected) return 'none';
  if (username && username.value !== credential.username) return identityConflict();
  if (
    password &&
    (!editable(password) ||
      password.type !== 'password' ||
      password.form !== form ||
      password.value !== credential.password)
  )
    return 'none';
  if (button.disabled || liveFields.filter((element) => element.type === 'password').length > 1) return 'none';
  if (
    liveFields.some((element) =>
      element.matches(
        'input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
      )
    )
  )
    return 'none';
  if (scope.querySelector('iframe[src*="captcha"], [data-sitekey]')) return 'none';
  if (form && button.type === 'submit') form.requestSubmit(button);
  else button.click();
  return password ? 'password-submitted' : 'username-submitted';
}
