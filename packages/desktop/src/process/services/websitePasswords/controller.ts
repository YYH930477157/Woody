import type { WebContents } from 'electron';
import { createHash } from 'node:crypto';
import { autofillWebsiteLogin } from '@/common/utils/browser/autofill';
import { WEBSITE_PASSWORD_WORLD, type AutofillPermissions } from '@/common/utils/browser/types';
import type { WebsitePasswordStore } from './store';
import type { BrowserPasswordUpdates } from './updates';
import { websiteOrigin } from './csv';

type BrowserTarget = Pick<
  WebContents,
  'id' | 'getURL' | 'isDestroyed' | 'on' | 'removeListener' | 'executeJavaScriptInIsolatedWorld'
>;
type Attempt = AutofillPermissions & { expires: number };

/** Follows one active webview and bounds both polling and automatic submissions. */
export class BrowserPasswordController {
  private target?: BrowserTarget;
  private timer?: ReturnType<typeof setTimeout>;
  private remaining = 0;
  private running = false;
  private generation = 0;
  private disposed = false;
  private continuation?: { key: string; origin: string; expires: number };
  private continuationEpoch = 0;
  private targetOrigin?: string;
  private readonly attempts = new Map<string, Attempt>();
  constructor(
    private readonly store: Pick<WebsitePasswordStore, 'find'>,
    private readonly updates?: Pick<BrowserPasswordUpdates, 'attach' | 'detach' | 'blocksAutofill'>
  ) {}

  private readonly refresh = (): void => {
    const origin = websiteOrigin(this.target?.getURL() ?? '');
    if (origin !== this.targetOrigin) {
      this.continuation = undefined;
      this.continuationEpoch++;
      this.targetOrigin = origin;
    }
    this.remaining = 60;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    void this.tick();
  };
  private readonly destroyed = (): void => {
    this.detach();
  };

  attach(target: BrowserTarget): void {
    if (this.disposed || target.isDestroyed()) return;
    if (this.target !== target) {
      this.detach();
      this.target = target;
      target.on('dom-ready', this.refresh);
      target.on('did-navigate', this.refresh);
      target.on('did-navigate-in-page', this.refresh);
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
      this.target.removeListener('destroyed', this.destroyed);
    }
    this.target = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running || !this.target || this.disposed || this.remaining-- <= 0) return;
    const target = this.target;
    const generation = this.generation;
    const continuationEpoch = this.continuationEpoch;
    this.running = true;
    try {
      if (target.isDestroyed()) return;
      const account = await this.store.find(target.getURL());
      if (!account || this.target !== target || generation !== this.generation || target.isDestroyed()) return;
      if (websiteOrigin(target.getURL()) !== account.origin) return;
      if (this.updates?.blocksAutofill(account)) return;
      const key = JSON.stringify([
        account.origin,
        account.id,
        createHash('sha256').update(account.password).digest('hex'),
      ]);
      const now = Date.now();
      if (this.continuation && (this.continuation.key !== key || this.continuation.expires <= now)) {
        this.continuation = undefined;
      }
      for (const [id, attempt] of this.attempts) if (attempt.expires <= now) this.attempts.delete(id);
      const attempt = this.attempts.get(key) ?? { username: true, password: true, expires: now + 10 * 60_000 };
      const payload = JSON.stringify({
        origin: account.origin,
        username: account.username,
        password: account.password,
      });
      // Do not include the account in any IPC/MCP payload or error. Only the isolated
      // world receives it, immediately before checking the live document origin.
      try {
        const result: unknown = await target.executeJavaScriptInIsolatedWorld(WEBSITE_PASSWORD_WORLD, [
          {
            code: `(${autofillWebsiteLogin.toString()})(${payload},${JSON.stringify({ username: attempt.username, password: attempt.password, continuation: this.continuation !== undefined })})`,
          },
        ]);
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
    } catch {
      // An unavailable/corrupt vault disables this attempt; never log website exceptions.
    } finally {
      this.running = false;
      if (this.target && !this.disposed && this.remaining > 0) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.tick();
        }, 1000);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.attempts.clear();
  }
}
