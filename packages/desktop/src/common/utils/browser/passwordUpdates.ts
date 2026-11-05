import type { AutofillCredential } from './types';

/** Serialized into an isolated world; its send-only bridge is absent from the website's world. */
export function installWebsitePasswordCapture(): void {
  const host = window as Window & {
    __woodyPasswordCapture?: boolean;
    woodyPasswordCapture?: { report: (candidate: AutofillCredential) => void };
  };
  if (window.top !== window || host.__woodyPasswordCapture || !host.woodyPasswordCapture) return;
  host.__woodyPasswordCapture = true;
  const wrongFlow =
    /sign.?up|register|registration|reset|forgot|change.?password|create.?account|注册|註冊|重置|忘记|修改密码/i;
  const capture = (event: Event): void => {
    if (!/^https?:$/.test(location.protocol)) return;
    const button =
      event instanceof SubmitEvent
        ? event.submitter
        : event.target instanceof Element
          ? event.target.closest('button, input[type="submit"]')
          : null;
    if (event.type === 'click' && !button) return;
    const form =
      button instanceof HTMLButtonElement || button instanceof HTMLInputElement
        ? button.form
        : event.target instanceof HTMLFormElement
          ? event.target
          : null;
    const scope = form ?? document.body;
    if (wrongFlow.test(`${location.pathname} ${form?.id ?? ''} ${form?.getAttribute('action') ?? ''}`)) return;
    if (button && wrongFlow.test(button.textContent || button.getAttribute('value') || '')) return;
    if (
      button &&
      !/log.?in|sign.?in|submit|continue|next|登录|登陆|登入|登錄|提交|继续|繼續|下一步/i.test(
        button.textContent || button.getAttribute('value') || button.getAttribute('aria-label') || ''
      )
    )
      return;
    try {
      const destination = new URL(
        button?.getAttribute('formaction') || form?.getAttribute('action') || location.href,
        document.baseURI
      );
      if (destination.origin !== location.origin || (form?.target && form.target !== '_self')) return;
      const target = button?.getAttribute('formtarget');
      if (target && target !== '_self') return;
    } catch {
      return;
    }
    const fields = form
      ? Array.from(form.elements).filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
      : Array.from(scope.querySelectorAll<HTMLInputElement>('input'));
    const passwords = fields.filter((field) => field.type === 'password');
    if (passwords.length !== 1) return;
    const password = passwords[0];
    const visible = (element: HTMLElement): boolean => {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    };
    if (password.disabled || !password.value || password.value.length > 65536 || !visible(password)) return;
    if (
      fields.some((field) =>
        field.matches(
          'input[autocomplete="new-password"], input[autocomplete="one-time-code"], input[name*="captcha" i], input[name*="otp" i], input[name*="totp" i]'
        )
      ) ||
      scope.querySelector('iframe[src*="captcha"], [data-sitekey]')
    )
      return;
    const identities = fields.filter(
      (field) =>
        ['text', 'email', 'tel', 'hidden'].includes(field.type) &&
        (field.autocomplete === 'username' ||
          field.type === 'email' ||
          /^(user(name|id)?|email|login|account|identifier)$/i.test(field.name || field.id))
    );
    const names = new Set(identities.map((field) => field.value).filter(Boolean));
    if (names.size !== 1) return;
    const username = [...names][0];
    if (username.length > 65536) return;
    host.woodyPasswordCapture?.report({ origin: location.origin, username, password: password.value });
  };
  document.addEventListener('submit', capture, true);
  document.addEventListener('click', capture, true);
}

/** A conservative signal for asking the user, never proof that authentication succeeded. */
export function websiteLoginOutcome(origin: string): 'ready' | 'pending' | 'blocked' {
  if (window.top !== window || location.origin !== origin) return 'blocked';
  if (document.readyState !== 'complete') return 'pending';
  const visible = (element: Element): boolean => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
  };
  if (
    Array.from(document.querySelectorAll('[role="alert"], .error, .error-message, [aria-invalid="true"]')).some(visible)
  )
    return 'blocked';
  if (
    document.querySelector(
      'input[type="password"], input[autocomplete="username"], input[autocomplete="one-time-code"], input[name*="captcha" i], input[name*="otp" i], [data-sitekey], iframe[src*="captcha"]'
    )
  )
    return 'pending';
  return 'ready';
}
