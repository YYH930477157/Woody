/* eslint-disable unicorn/consistent-function-scoping -- the page receives only this function's source, so its helpers stay inside it */
import type { AutofillCredential, AutofillPermissions, AutofillResult, AutofillSkipReason } from './types';

/**
 * Runs only inside an isolated browser world. Keep every runtime dependency inside
 * the function: the main process serializes it rather than invoking it directly.
 * `report` receives why nothing was submitted; it never receives page content.
 */
export function autofillWebsiteLogin(
  credential: AutofillCredential,
  allowed: AutofillPermissions,
  report?: (reason: AutofillSkipReason) => void
): AutofillResult {
  const skip = (reason: AutofillSkipReason): AutofillResult => {
    report?.(reason);
    return 'none';
  };
  if (location.origin !== credential.origin || window.top !== window) return skip('otherOrigin');
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
  const compact = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, '').toLowerCase();
  const inputs = (scope: ParentNode): HTMLInputElement[] =>
    scope instanceof HTMLFormElement
      ? Array.from(scope.elements).filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
      : Array.from(scope.querySelectorAll<HTMLInputElement>('input'));

  // Login controls. Words are compared without whitespace, so "登 录" and "Log In" match.
  const exactWords = new Set([
    '登录',
    '登陆',
    '登入',
    '登錄',
    '立即登录',
    '马上登录',
    '安全登录',
    'login',
    'log-in',
    'signin',
    'sign-in',
    'logon',
    'continue',
    'next',
    'submit',
    '继续',
    '繼續',
    '下一步',
    '提交',
  ]);
  const partialWords = /log.?in|sign.?in|continue|next|submit|登录|登陆|登入|登錄|继续|繼續|下一步|提交/;
  // Other ways to sign in, which the saved password cannot complete.
  const otherWays =
    /短信|验证码|驗證碼|扫码|掃碼|二维码|二維碼|微信|qq|钉钉|釘釘|飞书|飛書|手机|手機|google|apple|github|microsoft|facebook|twitter|wechat|weixin|sso|saml|oauth|passkey|qrcode|sms|with/;
  const wrongFlow =
    /sign.?up|register|registration|reset|forgot|change.?password|create.?account|注册|註冊|重置|忘记|修改密码/i;
  const native = (element: HTMLElement): boolean =>
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLAnchorElement ||
    element.getAttribute('role') === 'button';
  const controlText = (element: HTMLElement): string =>
    compact(
      element instanceof HTMLInputElement
        ? element.value
        : element.textContent || element.getAttribute('aria-label') || element.getAttribute('title')
    );
  const rank = (element: HTMLElement): number => {
    if (element instanceof HTMLButtonElement && element.type === 'reset') return 0;
    if (element instanceof HTMLInputElement && !['submit', 'button', 'image'].includes(element.type)) return 0;
    if (element instanceof HTMLAnchorElement) {
      // A link to another page is navigation, not a submit control.
      const href = (element.getAttribute('href') ?? '').trim();
      if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) return 0;
    }
    if (!native(element)) {
      // Plain elements count only when they look like a button and hold no fields.
      if (
        !/btn|button|submit|login|signin/i.test(`${element.className} ${element.id}`) &&
        !element.hasAttribute('onclick')
      )
        return 0;
      if (element.querySelector('input, select, textarea, button')) return 0;
    }
    const text = controlText(element);
    if (!text || text.length > 40 || otherWays.test(text) || wrongFlow.test(text)) return 0;
    if (exactWords.has(text)) return 2;
    return native(element) && partialWords.test(text) ? 1 : 0;
  };
  const loginControls = (scope: ParentNode): HTMLElement[] => {
    const found = Array.from(
      scope.querySelectorAll<HTMLElement>(
        'button, input[type=submit], input[type=button], input[type=image], [role=button], a, div, span'
      )
    ).filter((element) => rank(element) > 0 && !(element as HTMLButtonElement).disabled && visible(element));
    // Prefer a native control over the label inside it, and the innermost plain element
    // over its wrappers: a click on it reaches the handlers above it.
    const kept = found.filter(
      (element) =>
        !found.some((other) => other !== element && native(other) && other.contains(element)) &&
        (native(element) || !found.some((other) => other !== element && element.contains(other)))
    );
    const best = Math.max(0, ...kept.map(rank));
    const top = kept.filter((element) => rank(element) === best);
    if (top.length < 2) return top;
    const submits = top.filter(
      (element) =>
        (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit'
    );
    return submits.length === 1 ? submits : top;
  };
  /** The smallest area around a field that also holds a login control. */
  const container = (start: HTMLElement): ParentNode => {
    for (let node = start.parentElement; node && node !== document.body; node = node.parentElement) {
      if (loginControls(node).length) return node;
    }
    return document.body;
  };

  const allPasswords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]'));
  const shown = allPasswords.filter(visible);
  if (shown.length > 1) return skip('multiplePasswords');
  // A lone hidden password field is a trap, never a username-first page.
  const password = shown[0] ?? (allPasswords.length === 1 ? allPasswords[0] : undefined);
  if (password && !editable(password)) return skip('noLoginForm');
  if (password?.value) return skip('filledByUser');
  if (password?.autocomplete === 'new-password') return skip('registration');
  if (password && !allowed.password) return skip('alreadyTried');
  const fields = password ? inputs(password.form ?? container(password)) : inputs(document);
  const namePattern =
    /^(j_)?(user|login|account|acct|member|staff|emp)[-_.]?(name|id|no|code|account|mail)?$|^(e-?mail|mail|phone|mobile|tel|cellphone|identifier|uname|uid|loginid)$/i;
  const labelPattern =
    /用户名|用户账号|账号|帳號|账户|帳戶|手机号|手機號|邮箱|郵箱|工号|登录名|user ?name|e-?mail|account|phone/i;
  const isUsername = (element: HTMLInputElement): boolean =>
    ['text', 'email', 'tel', 'hidden'].includes(element.type) &&
    (element.type === 'email' ||
      ['username', 'email', 'tel'].includes(element.autocomplete) ||
      namePattern.test(element.name || element.id) ||
      (element.type !== 'hidden' &&
        labelPattern.test(`${element.placeholder ?? ''} ${element.getAttribute('aria-label') ?? ''}`)));
  const identities = fields.filter(isUsername);
  const identityConflict = (): AutofillResult => (allowed.continuation ? 'identity-conflict' : skip('filledByUser'));
  if (identities.some((element) => element.value && element.value !== credential.username)) return identityConflict();
  const explicit = identities.filter(editable);
  const usernames =
    explicit.length || !password
      ? explicit
      : fields.filter((element) => ['text', 'email', 'tel'].includes(element.type) && editable(element));
  if (usernames.length > 1) return skip('noLoginForm');
  if (!password && !allowed.username) return skip('alreadyTried');
  if (!password && usernames.length !== 1) return skip('noLoginForm');
  const username = usernames[0];
  if (username?.value && username.value !== credential.username) return identityConflict();
  if (
    password &&
    !username &&
    !identities.some((element) => element.value === credential.username) &&
    !allowed.continuation
  )
    return skip('noLoginForm');
  const form = password?.form ?? username?.form ?? null;
  if (password && username && password.form !== username.form) return skip('noLoginForm');
  const scope: ParentNode = form ?? container((password ?? username)!);
  const scopeFields = inputs(scope);
  if (!password && scopeFields.some((element) => element.type === 'password')) return skip('noLoginForm');
  if (scope.querySelector('input[autocomplete="new-password"]')) return skip('registration');
  if (
    scope.querySelector('input[autocomplete="one-time-code"]') ||
    fields.some((element) =>
      element.matches(
        'input[autocomplete="one-time-code"], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
      )
    ) ||
    scope.querySelector(
      'iframe[src*="captcha"], [data-sitekey], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
    )
  )
    return skip('verification');
  // Another empty field (an image code, a tenant) would make the submission fail.
  if (
    scopeFields.some(
      (element) =>
        element !== username &&
        element !== password &&
        ['text', 'email', 'tel', 'number'].includes(element.type) &&
        !element.value &&
        editable(element)
    )
  )
    return skip('verification');
  if (wrongFlow.test(`${form?.id ?? ''} ${form?.getAttribute('action') ?? ''} ${location.pathname}`))
    return skip('registration');
  const controls = loginControls(scope);
  if (!controls.length) return skip('noButton');
  if (controls.length > 1) return skip('ambiguousButton');
  const button = controls[0];
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
  if (!safeDestination()) return skip('unsafeDestination');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return skip('noLoginForm');
  const fill = (element: HTMLInputElement, value: string): void => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (username && !username.value) fill(username, credential.username);
  // Input handlers may replace the form, navigate, or change its destination.
  if (!safeDestination()) return skip('unsafeDestination');
  if (username && !username.isConnected) return skip('noLoginForm');
  if (username && username.value !== credential.username) return identityConflict();
  if (password) {
    if (!password.isConnected) return skip('noLoginForm');
    if (password.value) return skip('filledByUser');
    fill(password, credential.password);
  }
  if (!safeDestination()) return skip('unsafeDestination');
  if (!button.isConnected || (password && !password.isConnected)) return skip('noLoginForm');
  const liveFields = inputs(form ?? scope);
  if (liveFields.some((element) => isUsername(element) && element.value && element.value !== credential.username))
    return identityConflict();
  if (username && !username.isConnected) return skip('noLoginForm');
  if (username && username.value !== credential.username) return identityConflict();
  if (
    password &&
    (!editable(password) ||
      password.type !== 'password' ||
      password.form !== form ||
      password.value !== credential.password)
  )
    return skip('noLoginForm');
  if ((button as HTMLButtonElement).disabled) return skip('noButton');
  if (liveFields.filter((element) => element.type === 'password').length > 1) return skip('multiplePasswords');
  if (
    liveFields.some((element) =>
      element.matches(
        'input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[name*="captcha"], input[name*="otp"], input[name*="totp"]'
      )
    )
  )
    return skip('verification');
  if (scope.querySelector('iframe[src*="captcha"], [data-sitekey]')) return skip('verification');
  if (
    form &&
    (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) &&
    button.type === 'submit' &&
    button.form === form
  )
    form.requestSubmit(button);
  else button.click();
  return password ? 'password-submitted' : 'username-submitted';
}
