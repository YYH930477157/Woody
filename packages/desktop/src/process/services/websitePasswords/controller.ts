import type { WebContents } from 'electron';
import { createHash } from 'node:crypto';
import type { SavedLoginPageStatus } from '@/common/types/websitePasswords';
import { autofillWebsiteLogin } from '@/common/utils/browser/autofill';
import { watchLoginForms } from '@/common/utils/browser/loginWatch';
import { WEBSITE_LOGIN_FORM, WEBSITE_PASSWORD_WORLD, type AutofillPermissions } from '@/common/utils/browser/types';
import type { WebsitePasswordStore } from './store';
import type { BrowserPasswordUpdates } from './updates';
import { websiteOrigin } from './csv';

type BrowserTarget = Pick<
  WebContents,
  'id' | 'getURL' | 'isDestroyed' | 'on' | 'removeListener' | 'executeJavaScriptInIsolatedWorld'
> & { mainFrame?: WebContents['mainFrame'] };
type Attempt = AutofillPermissions & { expires: number };
type Store = Pick<WebsitePasswordStore, 'find'> & Partial<Pick<WebsitePasswordStore, 'lookup'>>;

const NO_PAGE: SavedLoginPageStatus = { site: null, account: 'none' };
/** A password field appearing again soon after is the same dialog. */
const NOTICE_INTERVAL_MS = 1500;

/** The page script: watch for login dialogs, then try the login and say why it did not run. */
const autofillScript = (payload: string, permissions: string): string =>
  `(()=>{(${watchLoginForms.toString()})();let reason;const result=(${autofillWebsiteLogin.toString()})(${payload},${permissions},(value)=>{reason=value;});return [result,reason];})()`;

/** Follows one active webview and bounds both polling and automatic submissions. */
export class BrowserPasswordController {
  private target?: BrowserTarget;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 0;
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private generation = 0;
  private disposed = false;
  private continuation?: { key: string; origin: string; expires: number };
  private continuationEpoch = 0;
  private targetOrigin?: string;
  private lastNotice = 0;
  private status: SavedLoginPageStatus = NO_PAGE;
  private readonly attempts = new Map<string, Attempt>();
  constructor(
    private readonly store: Store,
    private readonly updates?: Pick<BrowserPasswordUpdates, 'attach' | 'detach' | 'blocksAutofill'>,
    private readonly onStatus?: (status: SavedLoginPageStatus) => void
  ) {}

  private publish(next: SavedLoginPageStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.onStatus?.(next);
  }

  private readonly refresh = (): void => {
    const origin = websiteOrigin(this.target?.getURL() ?? '');
    if (origin !== this.targetOrigin) {
      this.continuation = undefined;
      this.continuationEpoch++;
      this.targetOrigin = origin;
    }
    // A new page starts without an outcome; the next attempt fills it in.
    this.publish({
      site: origin ?? null,
      account: this.status.site === (origin ?? null) ? this.status.account : 'none',
    });
    this.remaining = 60;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick();
  };
  private readonly destroyed = (): void => {
    this.detach();
  };
  /** The page's watcher saw a password field appear without a navigation. */
  private readonly message = (event: { sender?: unknown; senderFrame?: unknown }, channel: string): void => {
    const target = this.target;
    if (!target || channel !== WEBSITE_LOGIN_FORM || (event.sender && event.sender !== target)) return;
    if (target.mainFrame && event.senderFrame !== target.mainFrame) return;
    const now = Date.now();
    if (now - this.lastNotice < NOTICE_INTERVAL_MS) return;
    this.lastNotice = now;
    this.refresh();
  };

  attach(target: BrowserTarget): void {
    if (this.disposed || target.isDestroyed()) return;
    if (this.target !== target) {
      this.detach();
      this.target = target;
      target.on('dom-ready', this.refresh);
      target.on('did-navigate', this.refresh);
      target.on('did-navigate-in-page', this.refresh);
      target.on('ipc-message', this.message);
      target.on('destroyed', this.destroyed);
      this.updates?.attach(target as WebContents);
    }
    this.refresh();
  }

  detach(id?: number): void {
    if (id !== undefined && this.target?.id !== id) return;
    this.generation++;
    this.continuation = undefined;
    this.continuationEpoch++;
    this.targetOrigin = undefined;
    this.updates?.detach();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.target) {
      this.target.removeListener('dom-ready', this.refresh);
      this.target.removeListener('did-navigate', this.refresh);
      this.target.removeListener('did-navigate-in-page', this.refresh);
      this.target.removeListener('ipc-message', this.message);
      this.target.removeListener('destroyed', this.destroyed);
    }
    this.target = undefined;
    this.publish(NO_PAGE);
  }

  /** The saved-login state of the attached page; names the site, never the account. */
  async describe(): Promise<SavedLoginPageStatus> {
    const target = this.target;
    if (!target || target.isDestroyed()) return NO_PAGE;
    const site = websiteOrigin(target.getURL()) ?? null;
    if (this.status.site === site && this.status.account !== 'none') return this.status;
    try {
      const account = this.store.lookup ? await this.store.lookup(target.getURL()) : 'none';
      if (this.target === target) this.publish({ ...this.status, site, account });
    } catch {
      if (this.target === target) this.publish({ site, account: 'unavailable' });
    }
    return this.status;
  }

  /**
   * Log in now on the attached page, because the user or the agent asked. It may repeat
   * a submission the automatic attempts already made, once per request.
   */
  async loginNow(): Promise<SavedLoginPageStatus> {
    const target = this.target;
    if (!target || target.isDestroyed() || this.disposed) return NO_PAGE;
    // eslint-disable-next-line no-await-in-loop -- each wait ends one attempt already running.
    while (this.running) await this.current;
    if (this.target !== target) return this.status;
    this.running = true;
    const run = this.attempt(target, true);
    this.current = run;
    try {
      await run;
    } finally {
      this.running = false;
    }
    return this.status;
  }

  private schedule(): void {
    if (this.timer || !this.target || this.disposed || this.remaining <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, 1000);
  }

  private async tick(): Promise<void> {
    if (!this.target || this.disposed) return;
    // Busy with another attempt (a requested login): keep the polling alive.
    if (this.running) return this.schedule();
    if (this.remaining-- <= 0) return;
    const target = this.target;
    this.running = true;
    const run = this.attempt(target, false);
    this.current = run;
    try {
      await run;
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async attempt(target: BrowserTarget, forced: boolean): Promise<void> {
    const generation = this.generation;
    const continuationEpoch = this.continuationEpoch;
    const site = websiteOrigin(target.getURL()) ?? null;
    const current = (): boolean => this.target === target && generation === this.generation && !target.isDestroyed();
    try {
      if (target.isDestroyed()) return;
      const account = await this.store.find(target.getURL());
      if (!current()) return;
      if (!account) {
        if (forced || this.status.site !== site || this.status.account === 'saved') {
          const state = this.store.lookup ? await this.store.lookup(target.getURL()) : 'none';
          if (current()) this.publish({ site, account: state });
        }
        return;
      }
      if (websiteOrigin(target.getURL()) !== account.origin) return;
      if (!forced && this.updates?.blocksAutofill(account)) return;
      const key = JSON.stringify([
        account.origin,
        account.id,
        createHash('sha256').update(account.password).digest('hex'),
      ]);
      const now = Date.now();
      if (this.continuation && (this.continuation.key !== key || this.continuation.expires <= now)) {
        this.continuation = undefined;
      }
      for (const [id, entry] of this.attempts) if (entry.expires <= now) this.attempts.delete(id);
      // An explicit request gets one fresh attempt; automatic ones respect the limit.
      const attempt = forced
        ? { username: true, password: true, expires: now + 10 * 60_000 }
        : (this.attempts.get(key) ?? { username: true, password: true, expires: now + 10 * 60_000 });
      const payload = JSON.stringify({
        origin: account.origin,
        username: account.username,
        password: account.password,
      });
      const permissions = JSON.stringify({
        username: attempt.username,
        password: attempt.password,
        continuation: this.continuation !== undefined,
      });
      let result: unknown;
      let reason: unknown;
      // Do not include the account in any IPC/MCP payload or error. Only the isolated
      // world receives it, immediately before checking the live document origin.
      try {
        const value: unknown = await target.executeJavaScriptInIsolatedWorld(WEBSITE_PASSWORD_WORLD, [
          { code: autofillScript(payload, permissions) },
        ]);
        [result, reason] = Array.isArray(value) ? value : [value, undefined];
        if (result === 'password-submitted') attempt.password = false;
        if (result === 'password-submitted' || result === 'identity-conflict') this.continuation = undefined;
        if (result === 'username-submitted') {
          attempt.username = false;
          if (
            this.continuationEpoch === continuationEpoch &&
            this.target === target &&
            !target.isDestroyed() &&
            websiteOrigin(target.getURL()) === account.origin
          ) {
            this.continuation = { key, origin: account.origin, expires: Date.now() + 60_000 };
          }
        }
      } catch {
        // Navigation can reject execution after a submit; never repeat an uncertain attempt.
        attempt.username = false;
        attempt.password = false;
        this.continuation = undefined;
      }
      this.attempts.set(key, attempt);
      if (!current()) return;
      if (result === 'password-submitted' || result === 'username-submitted') {
        this.publish({ site, account: 'saved', result });
      } else if (result !== undefined && (forced || this.status.result !== 'password-submitted')) {
        // A submitted login stays reported until the page changes.
        const why =
          result === 'identity-conflict' ? 'filledByUser' : typeof reason === 'string' ? reason : 'noLoginForm';
        this.publish({ site, account: 'saved', result: 'skipped', reason: why });
      } else if (this.status.account !== 'saved') {
        this.publish({ ...this.status, site, account: 'saved' });
      }
    } catch {
      // An unavailable/corrupt vault disables this attempt; never log website exceptions.
      if (current()) this.publish({ site, account: 'unavailable' });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.attempts.clear();
  }
}
