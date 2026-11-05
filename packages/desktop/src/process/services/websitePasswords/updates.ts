import type { IpcMainEvent, WebContents } from 'electron';
import { createHash } from 'node:crypto';
import type { WebsiteAccount } from '@/common/types/websitePasswords';
import type { AutofillCredential } from '@/common/utils/browser/types';
import { WEBSITE_PASSWORD_CAPTURE, WEBSITE_PASSWORD_WORLD } from '@/common/utils/browser/types';
import { installWebsitePasswordCapture, websiteLoginOutcome } from '@/common/utils/browser/passwordUpdates';
import type { WebsitePasswordStore } from './store';
import { websiteOrigin } from './csv';

type Target = Pick<
  WebContents,
  'id' | 'mainFrame' | 'getURL' | 'isDestroyed' | 'on' | 'removeListener' | 'executeJavaScriptInIsolatedWorld'
>;
export type ConfirmPasswordUpdate = (account: WebsiteAccount, signal: AbortSignal) => Promise<boolean>;
type Candidate = AutofillCredential & {
  expires: number;
  readySince?: number;
  expected?: { id: string; password: string };
};

/** Holds at most one short-lived candidate belonging to the active native browser. */
export class BrowserPasswordUpdates {
  private target?: Target;
  private candidate?: Candidate;
  private timer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private consent?: AbortController;
  private generation = 0;
  private readonly submissions = new Map<string, number>();
  constructor(
    private readonly store: Pick<WebsitePasswordStore, 'findForUpdate' | 'updatePassword'>,
    private readonly confirm: ConfirmPasswordUpdate,
    private readonly onError: () => void = () => {}
  ) {}

  private submissionKey(account: AutofillCredential): string {
    return JSON.stringify([
      account.origin,
      account.username,
      createHash('sha256').update(account.password).digest('hex'),
    ]);
  }

  /** Do not retry the previous saved password after a user has submitted a login. */
  blocksAutofill(account: AutofillCredential): boolean {
    for (const [key, expires] of this.submissions) if (expires <= Date.now()) this.submissions.delete(key);
    return this.submissions.has(this.submissionKey(account));
  }

  private clear(): void {
    this.generation++;
    this.consent?.abort();
    this.consent = undefined;
    this.candidate = undefined;
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.timer = undefined;
    this.expiryTimer = undefined;
  }

  private readonly install = (): void => {
    const target = this.target;
    if (!target || target.isDestroyed()) return;
    void target
      .executeJavaScriptInIsolatedWorld(WEBSITE_PASSWORD_WORLD, [
        { code: `(${installWebsitePasswordCapture.toString()})()` },
      ])
      .catch(() => {});
  };
  private readonly navigating = (_event: unknown, url: string, _inPlace: boolean, mainFrame: boolean): void => {
    if (!mainFrame) return;
    if (this.candidate && websiteOrigin(url) !== this.candidate.origin) this.clear();
    else if (this.candidate) this.candidate.readySince = undefined;
  };
  private readonly failed = (
    _event: unknown,
    _code: number,
    _description: string,
    _url: string,
    mainFrame: boolean
  ): void => {
    if (mainFrame) this.clear();
  };
  private readonly destroyed = (): void => this.detach();
  private readonly capture = (event: IpcMainEvent, channel: string, value: unknown): void => {
    const target = this.target;
    if (!target || target.isDestroyed() || channel !== WEBSITE_PASSWORD_CAPTURE) return;
    if (event.sender !== target || event.senderFrame !== target.mainFrame) return;
    if (!value || typeof value !== 'object') return;
    const input = value as AutofillCredential;
    if (
      typeof input.origin !== 'string' ||
      websiteOrigin(input.origin) !== input.origin ||
      typeof input.username !== 'string' ||
      !input.username ||
      input.username.length > 65536 ||
      typeof input.password !== 'string' ||
      !input.password ||
      input.password.length > 65536 ||
      websiteOrigin(target.getURL()) !== input.origin ||
      websiteOrigin(event.senderFrame.url) !== input.origin
    )
      return;
    if (
      this.candidate?.origin === input.origin &&
      this.candidate.username === input.username &&
      this.candidate.password === input.password
    )
      return;
    this.clear();
    this.candidate = {
      origin: input.origin,
      username: input.username,
      password: input.password,
      expires: Date.now() + 120_000,
    };
    this.expiryTimer = setTimeout(() => this.clear(), 120_000);
    void this.check();
  };

  attach(target: Target): void {
    if (this.target === target) return;
    this.detach();
    if (target.isDestroyed()) return;
    this.target = target;
    target.on('dom-ready', this.install);
    target.on('ipc-message', this.capture);
    target.on('did-start-navigation', this.navigating);
    target.on('did-fail-load', this.failed);
    target.on('destroyed', this.destroyed);
    this.install();
  }

  detach(): void {
    this.clear();
    const target = this.target;
    this.target = undefined;
    if (!target) return;
    target.removeListener('dom-ready', this.install);
    target.removeListener('ipc-message', this.capture);
    target.removeListener('did-start-navigation', this.navigating);
    target.removeListener('did-fail-load', this.failed);
    target.removeListener('destroyed', this.destroyed);
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, 1000);
  }

  private async check(): Promise<void> {
    const candidate = this.candidate;
    const target = this.target;
    const generation = this.generation;
    const current = (): boolean =>
      !!candidate &&
      this.candidate === candidate &&
      this.target === target &&
      !!target &&
      !target.isDestroyed() &&
      generation === this.generation &&
      Date.now() < candidate.expires &&
      websiteOrigin(target.getURL()) === candidate.origin;
    if (!candidate || !target || !current()) {
      this.clear();
      return;
    }
    try {
      const account = await this.store.findForUpdate(candidate.origin, candidate.username);
      if (!current()) return;
      if (!account) {
        this.clear();
        return;
      }
      this.blocksAutofill(account);
      this.submissions.set(this.submissionKey(account), Date.now() + 10 * 60_000);
      if (account.password === candidate.password) {
        this.clear();
        return;
      }
      candidate.expected ??= { id: account.id, password: account.password };
      if (candidate.expected.id !== account.id || candidate.expected.password !== account.password) {
        this.clear();
        return;
      }
      const result: unknown = await target.executeJavaScriptInIsolatedWorld(WEBSITE_PASSWORD_WORLD, [
        { code: `(${websiteLoginOutcome.toString()})(${JSON.stringify(candidate.origin)})` },
      ]);
      if (!current()) return;
      if (result === 'blocked') {
        this.clear();
        return;
      }
      if (result !== 'ready') candidate.readySince = undefined;
      else {
        candidate.readySince ??= Date.now();
        if (Date.now() - candidate.readySince >= 2000) {
          const signal = new AbortController();
          this.consent = signal;
          // The confirmation receives an explicit metadata projection, never the secret.
          const { id, name, origin, username, isDefault } = account;
          const accepted = await this.confirm({ id, name, origin, username, isDefault }, signal.signal);
          if (!current() || signal.signal.aborted) return;
          if (accepted) {
            const liveOutcome: unknown = await target.executeJavaScriptInIsolatedWorld(WEBSITE_PASSWORD_WORLD, [
              { code: `(${websiteLoginOutcome.toString()})(${JSON.stringify(candidate.origin)})` },
            ]);
            if (!current()) return;
            if (liveOutcome !== 'ready') {
              this.clear();
              return;
            }
            const latest = await this.store.findForUpdate(candidate.origin, candidate.username);
            if (!current()) return;
            if (latest?.id === account.id && latest.password === account.password) {
              await this.store.updatePassword(account.id, candidate.password, account.password, signal.signal);
            }
          }
          if (this.candidate === candidate) this.clear();
          return;
        }
      }
    } catch {
      if (current()) {
        this.clear();
        this.onError();
      }
      return;
    } finally {
      if (this.candidate === candidate && !current()) this.clear();
    }
    if (current()) this.schedule();
    else if (this.candidate === candidate) this.clear();
  }
}
