import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WebsitePasswordStore } from '@process/services/websitePasswords/store';
import { parseChromeCsv } from '@process/services/websitePasswords/csv';

const directories: string[] = [];
const key = randomBytes(32);
const encryption = {
  isAvailable: () => true,
  encrypt: (value: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decrypt: (value: Buffer) => {
    const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'woody-passwords-'));
  directories.push(directory);
  const file = path.join(directory, 'vault.bin');
  return { file, store: new WebsitePasswordStore(file, encryption) };
}
const csv = (rows: string) => 'name,url,username,password,note\r\n' + rows;
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Chrome password import', () => {
  it('preserves passwords as text including quotes, commas, newlines, and leading zeros', () => {
    const result = parseChromeCsv('\uFEFF' + csv('Example,https://example.test/login,alice,"001,=""x""\nnext",'));
    expect(result.entries[0].password).toBe('001,="x"\nnext');
  });
  it('keeps formula-looking passwords literal', () => {
    expect(parseChromeCsv(csv('Example,https://example.test/,alice,=SUM(A1),')).entries[0].password).toBe('=SUM(A1)');
  });
  it('rejects missing headers and oversized input without leaking contents', () => {
    expect(() => parseChromeCsv('url,password\nhttps://x.test,secret')).toThrow('WEBSITE_PASSWORDS_INVALID_CSV');
    expect(() => parseChromeCsv('x'.repeat(5 * 1024 * 1024 + 1))).toThrow('WEBSITE_PASSWORDS_TOO_LARGE');
  });
  it('skips unsupported URLs, empty secrets, and rows containing URL credentials', () => {
    const result = parseChromeCsv(
      csv(
        'Android,android://hash/package,a,secret,\nX,https://x.test,a,,\nX,https://u:p@x.test,a,p,\nX,https://x.test/a,a,p,'
      )
    );
    expect(result.skipped).toBe(3);
    expect(result.entries).toHaveLength(1);
  });
});

describe('encrypted website password store', () => {
  it('cancels a captured update queued before tab detach without replacing its password', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,'));
    const id = (await store.status()).accounts[0].id;
    const signal = new AbortController();
    const queued = store.status();
    const update = store.updatePassword(id, 'new', 'old', signal.signal);
    signal.abort();
    await queued;
    await expect(update).rejects.toThrow('WEBSITE_PASSWORDS_CANCELLED');
    expect((await store.find('https://x.test'))?.password).toBe('old');
  });
  it('cancels a captured replacement if aborted while preparing encrypted bytes', async () => {
    const { store, file } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,'));
    const id = (await store.status()).accounts[0].id;
    const signal = new AbortController();
    const cancellable = new WebsitePasswordStore(file, {
      ...encryption,
      encrypt: (value) => {
        signal.abort();
        return encryption.encrypt(value);
      },
    });
    await expect(cancellable.updatePassword(id, 'new', 'old', signal.signal)).rejects.toThrow(
      'WEBSITE_PASSWORDS_CANCELLED'
    );
    expect((await store.find('https://x.test'))?.password).toBe('old');
  });
  it('manually replaces only the selected secret and persists encrypted metadata-only results', async () => {
    const { store, file } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,\nX,https://x.test/,b,other,'));
    const original = (await store.status()).accounts;
    const result = await store.updatePassword(original[1].id, ' new-password ');
    expect(result.accounts).toEqual(original);
    expect(JSON.stringify(result)).not.toContain('new-password');
    const reopened = new WebsitePasswordStore(file, encryption);
    expect((await reopened.findForUpdate('https://x.test/login', 'b'))?.password).toBe(' new-password ');
    expect((await readFile(file)).includes(Buffer.from('new-password'))).toBe(false);
  });
  it('refuses empty, oversized and deleted-account edits without changing the vault', async () => {
    const { store, file } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,'));
    const id = (await store.status()).accounts[0].id;
    const before = await readFile(file);
    await expect(store.updatePassword(id, '')).rejects.toThrow('WEBSITE_PASSWORDS_IO');
    await expect(store.updatePassword(id, 'x'.repeat(65537))).rejects.toThrow('WEBSITE_PASSWORDS_LIMIT');
    await expect(store.updatePassword('deleted', 'new')).rejects.toThrow('WEBSITE_PASSWORDS_CONFLICT');
    expect((await readFile(file)).equals(before)).toBe(true);
  });
  it('does not overwrite a newer manual or imported password with a stale captured value', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,'));
    const id = (await store.status()).accounts[0].id;
    await store.updatePassword(id, 'manual-new');
    await expect(store.updatePassword(id, 'captured', 'old')).rejects.toThrow('WEBSITE_PASSWORDS_CONFLICT');
    expect((await store.find('https://x.test'))?.password).toBe('manual-new');
  });
  it('finds a nondefault update account only for the exact origin and username while enabled', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,old,\nX,https://x.test/,b,other,'));
    expect((await store.findForUpdate('https://x.test/login', 'b'))?.username).toBe('b');
    expect(await store.findForUpdate('https://sub.x.test', 'b')).toBeUndefined();
    expect(await store.findForUpdate('https://x.test', 'B')).toBeUndefined();
    await store.setEnabled(false);
    expect(await store.findForUpdate('https://x.test', 'b')).toBeUndefined();
  });
  it('returns only metadata and persists encrypted bytes across restart', async () => {
    const { store, file } = await fixture();
    const result = await store.importCsv(csv('Example,https://example.test/login,alice,super-secret,'));
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect((await readFile(file)).includes(Buffer.from('super-secret'))).toBe(false);
    const reopened = new WebsitePasswordStore(file, encryption);
    expect((await reopened.find('https://example.test/another'))?.password).toBe('super-secret');
  });
  it('matches only exact scheme, hostname, and port', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('Example,https://example.test/,alice,p,'));
    const urls = [
      'http://example.test',
      'https://sub.example.test',
      'https://example.test:444',
      'https://example.test.evil.test',
    ];
    expect(await Promise.all(urls.map((url) => store.find(url)))).toEqual([undefined, undefined, undefined, undefined]);
  });
  it('updates by origin and username, and preserves the selected default', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,first,\nX,https://x.test/,b,second,'));
    const accounts = (await store.status()).accounts;
    await store.setDefault(accounts.find((account) => account.username === 'b')!.id);
    const result = await store.importCsv(csv('New,https://x.test/login,a,changed,'));
    expect([result.added, result.updated]).toEqual([0, 1]);
    expect((await store.find('https://x.test'))?.username).toBe('b');
    await store.remove(accounts.find((account) => account.username === 'b')!.id);
    expect((await store.find('https://x.test'))?.password).toBe('changed');
  });
  it('disables lookup without deleting saved accounts', async () => {
    const { store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,p,'));
    await store.setEnabled(false);
    expect(await store.find('https://x.test')).toBeUndefined();
    expect((await store.status()).accounts).toHaveLength(1);
  });
  it('serializes concurrent imports without losing accounts', async () => {
    const { store } = await fixture();
    await Promise.all([store.importCsv(csv('X,https://x.test/,a,p,')), store.importCsv(csv('Y,https://y.test/,b,q,'))]);
    expect((await store.status()).accounts).toHaveLength(2);
  });
  it('refuses plaintext fallback when encryption is unavailable', async () => {
    const { file } = await fixture();
    const store = new WebsitePasswordStore(file, { ...encryption, isAvailable: () => false });
    expect((await store.status()).available).toBe(false);
    await expect(store.importCsv(csv('X,https://x.test/,a,p,'))).rejects.toThrow('WEBSITE_PASSWORDS_UNAVAILABLE');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses to overwrite an unreadable vault', async () => {
    const { file, store } = await fixture();
    await writeFile(file, 'damaged');
    await expect(store.importCsv(csv('X,https://x.test/,a,p,'))).rejects.toThrow('WEBSITE_PASSWORDS_CORRUPT');
    expect(await readFile(file, 'utf8')).toBe('damaged');
  });
  it('leaves the original encrypted vault intact when replacement fails', async () => {
    const { file, store } = await fixture();
    await store.importCsv(csv('X,https://x.test/,a,p,'));
    const original = await readFile(file);
    const failing = new WebsitePasswordStore(file, {
      ...encryption,
      encrypt: () => {
        throw new Error('secret-failure');
      },
    });
    await expect(failing.setEnabled(false)).rejects.toThrow('WEBSITE_PASSWORDS_IO');
    expect(await readFile(file)).toEqual(original);
    expect((await failing.status()).enabled).toBe(true);
  });
  it('rejects aggregate vault growth before replacing a readable file', async () => {
    const { file, store } = await fixture();
    const password = 'x'.repeat(4 * 1024 * 1024);
    await store.importCsv(csv(`X,https://x.test/,a,${password},`));
    await store.importCsv(csv(`X,https://x.test/,b,${password},`));
    const previous = await readFile(file);
    await expect(store.importCsv(csv(`X,https://x.test/,c,${password},`))).rejects.toThrow('WEBSITE_PASSWORDS_LIMIT');
    expect((await readFile(file)).equals(previous)).toBe(true);
    expect((await store.status()).accounts).toHaveLength(2);
  });
});
