import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  WebsiteAccount,
  WebsitePasswordImportResult,
  WebsitePasswordStatus,
} from '@/common/types/websitePasswords';
import { MAX_ACCOUNTS, parseChromeCsv, websiteOrigin } from './csv';

type Credential = WebsiteAccount & { password: string };
type Vault = { version: 1; enabled: boolean; accounts: Credential[] };
export type PasswordEncryption = {
  isAvailable: () => boolean;
  encrypt: (plaintext: string) => Buffer;
  decrypt: (encrypted: Buffer) => string;
};
const fail = (code: string): Error => new Error(`WEBSITE_PASSWORDS_${code}`);
const MAX_VAULT_BYTES = 12 * 1024 * 1024;

function validate(value: unknown): value is Vault {
  if (!value || typeof value !== 'object') return false;
  const vault = value as Vault;
  if (vault.version !== 1 || typeof vault.enabled !== 'boolean' || !Array.isArray(vault.accounts)) return false;
  if (vault.accounts.length > MAX_ACCOUNTS) return false;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const origins = new Map<string, number>();
  for (const account of vault.accounts) {
    if (
      !account ||
      !['id', 'name', 'origin', 'username', 'password'].every(
        (key) => typeof account[key as keyof Credential] === 'string'
      )
    )
      return false;
    if (!account.id || !account.username || !account.password || typeof account.isDefault !== 'boolean') return false;
    if (websiteOrigin(account.origin) !== account.origin) return false;
    const key = JSON.stringify([account.origin, account.username]);
    if (ids.has(account.id) || keys.has(key)) return false;
    ids.add(account.id);
    keys.add(key);
    origins.set(account.origin, (origins.get(account.origin) ?? 0) + Number(account.isDefault));
  }
  return [...origins.values()].every((count) => count === 1);
}

/** Owns the encrypted vault; management callers receive explicit metadata projections only. */
export class WebsitePasswordStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly encryption: PasswordEncryption
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch((): void => undefined);
    return result;
  }

  private async load(): Promise<Vault> {
    if (!this.encryption.isAvailable()) throw fail('UNAVAILABLE');
    let bytes: Buffer;
    try {
      bytes = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, enabled: true, accounts: [] };
      throw fail('IO');
    }
    try {
      if (bytes.length > MAX_VAULT_BYTES) throw fail('CORRUPT');
      const value: unknown = JSON.parse(this.encryption.decrypt(bytes));
      if (!validate(value)) throw fail('CORRUPT');
      return value;
    } catch {
      throw fail('CORRUPT');
    }
  }

  private metadata(vault: Vault): WebsitePasswordStatus {
    return {
      available: true,
      enabled: vault.enabled,
      accounts: vault.accounts.map(({ id, name, origin, username, isDefault }) => ({
        id,
        name,
        origin,
        username,
        isDefault,
      })),
    };
  }

  private async save(vault: Vault, signal?: AbortSignal): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const bytes = this.encryption.encrypt(JSON.stringify(vault));
      if (bytes.length > MAX_VAULT_BYTES) throw fail('LIMIT');
      if (signal?.aborted) throw fail('CANCELLED');
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      if (signal?.aborted) throw fail('CANCELLED');
      await rename(temporary, this.file);
    } catch (error) {
      if (error instanceof Error && ['WEBSITE_PASSWORDS_LIMIT', 'WEBSITE_PASSWORDS_CANCELLED'].includes(error.message))
        throw error;
      throw fail('IO');
    } finally {
      await unlink(temporary).catch((): void => undefined);
    }
  }

  status(): Promise<WebsitePasswordStatus> {
    return this.serial(async () => {
      if (!this.encryption.isAvailable()) return { available: false, enabled: false, accounts: [] };
      return this.metadata(await this.load());
    });
  }

  importCsv(csv: string): Promise<WebsitePasswordImportResult> {
    return this.serial(async () => {
      const vault = await this.load();
      const parsed = parseChromeCsv(csv);
      let added = 0;
      let updated = 0;
      for (const entry of parsed.entries) {
        const existing = vault.accounts.find(
          (account) => account.origin === entry.origin && account.username === entry.username
        );
        if (existing) {
          Object.assign(existing, entry);
          updated++;
        } else {
          const isDefault = !vault.accounts.some((account) => account.origin === entry.origin);
          vault.accounts.push({ ...entry, id: randomUUID(), isDefault });
          added++;
        }
      }
      if (vault.accounts.length > MAX_ACCOUNTS) throw fail('LIMIT');
      await this.save(vault);
      return { cancelled: false, added, updated, skipped: parsed.skipped, status: this.metadata(vault) };
    });
  }

  private mutate(operation: (vault: Vault) => void, signal?: AbortSignal): Promise<WebsitePasswordStatus> {
    return this.serial(async () => {
      if (signal?.aborted) throw fail('CANCELLED');
      const vault = await this.load();
      if (signal?.aborted) throw fail('CANCELLED');
      operation(vault);
      await this.save(vault, signal);
      return this.metadata(vault);
    });
  }

  remove(id: string): Promise<WebsitePasswordStatus> {
    return this.mutate((vault) => {
      const removed = vault.accounts.find((account) => account.id === id);
      vault.accounts = vault.accounts.filter((account) => account.id !== id);
      if (removed?.isDefault) {
        const replacement = vault.accounts.find((account) => account.origin === removed.origin);
        if (replacement) replacement.isDefault = true;
      }
    });
  }

  setDefault(id: string): Promise<WebsitePasswordStatus> {
    return this.mutate((vault) => {
      const selected = vault.accounts.find((account) => account.id === id);
      if (selected)
        for (const account of vault.accounts) {
          if (account.origin === selected.origin) account.isDefault = account.id === id;
        }
    });
  }

  setEnabled(enabled: boolean): Promise<WebsitePasswordStatus> {
    return this.mutate((vault) => {
      vault.enabled = enabled;
    });
  }

  /** Write-only replacement; captured updates use compare-and-set against the old secret. */
  updatePassword(
    id: string,
    password: string,
    expectedPassword?: string,
    signal?: AbortSignal
  ): Promise<WebsitePasswordStatus> {
    return this.mutate((vault) => {
      if (typeof password !== 'string' || !password) throw fail('IO');
      if (password.length > 65536) throw fail('LIMIT');
      const account = vault.accounts.find((entry) => entry.id === id);
      if (!account || (expectedPassword !== undefined && (!vault.enabled || account.password !== expectedPassword)))
        throw fail('CONFLICT');
      account.password = password;
    }, signal);
  }

  /** Main-only exact account lookup for confirmed updates, including nondefault accounts. */
  findForUpdate(url: string, username: string): Promise<Credential | undefined> {
    return this.serial(async () => {
      const origin = websiteOrigin(url);
      if (!origin || !this.encryption.isAvailable()) return undefined;
      const vault = await this.load();
      return vault.enabled
        ? vault.accounts.find((account) => account.origin === origin && account.username === username)
        : undefined;
    });
  }

  /** Main-process-only lookup; never expose this through IPC, MCP, or logging. */
  find(url: string): Promise<Credential | undefined> {
    return this.serial(async () => {
      const origin = websiteOrigin(url);
      if (!origin || !this.encryption.isAvailable()) return undefined;
      const vault = await this.load();
      return vault.enabled
        ? vault.accounts.find((account) => account.origin === origin && account.isDefault)
        : undefined;
    });
  }
}
