import { dialog } from 'electron';
import { open } from 'node:fs/promises';
import { websitePasswords } from '@/common/adapter/websitePasswords';
import { MAX_IMPORT_BYTES } from '@process/services/websitePasswords/csv';
import { getWebsitePasswordRuntime, requireWebsitePasswordWindow } from '@process/services/websitePasswords/runtime';

const safeCodes = /^WEBSITE_PASSWORDS_(UNAVAILABLE|CORRUPT|INVALID_CSV|TOO_LARGE|LIMIT|IO|FORBIDDEN|CONFLICT)$/;
let importing = false;

/** Bound file reads even if the selected export grows after the picker closes. */
async function readExport(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('WEBSITE_PASSWORDS_IO');
    if (info.size > MAX_IMPORT_BYTES) throw new Error('WEBSITE_PASSWORDS_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_IMPORT_BYTES) throw new Error('WEBSITE_PASSWORDS_TOO_LARGE');
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Native-only account management; no provider accepts a path or returns a password. */
export function initWebsitePasswordsBridge(): void {
  const provide =
    <P, T>(handler: (params: P) => Promise<T>) =>
    async (params: P): Promise<T> => {
      requireWebsitePasswordWindow();
      try {
        return await handler(params);
      } catch (error) {
        const code = error instanceof Error && safeCodes.test(error.message) ? error.message : 'WEBSITE_PASSWORDS_IO';
        throw new Error(code);
      }
    };
  const accountId = (params: { id: string }): string => {
    if (!params || typeof params.id !== 'string' || !params.id || params.id.length > 128) {
      throw new Error('WEBSITE_PASSWORDS_IO');
    }
    return params.id;
  };
  websitePasswords.list.provider(provide(async () => getWebsitePasswordRuntime().store.status()));
  websitePasswords.importChrome.provider(
    provide(async () => {
      if (importing) throw new Error('WEBSITE_PASSWORDS_IO');
      importing = true;
      try {
        const window = requireWebsitePasswordWindow();
        const store = getWebsitePasswordRuntime().store;
        const status = await store.status();
        if (!status.available) throw new Error('WEBSITE_PASSWORDS_UNAVAILABLE');
        const selection = await dialog.showOpenDialog(window, {
          properties: ['openFile'],
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (selection.canceled || !selection.filePaths[0]) {
          return { cancelled: true, added: 0, updated: 0, skipped: 0, status };
        }
        requireWebsitePasswordWindow();
        return await store.importCsv(await readExport(selection.filePaths[0]));
      } finally {
        importing = false;
      }
    })
  );
  websitePasswords.remove.provider(
    provide(async (params: { id: string }) => getWebsitePasswordRuntime().store.remove(accountId(params)))
  );
  websitePasswords.setDefault.provider(
    provide(async (params: { id: string }) => getWebsitePasswordRuntime().store.setDefault(accountId(params)))
  );
  websitePasswords.setEnabled.provider(
    provide(async (params: { enabled: boolean }) => {
      if (!params || typeof params.enabled !== 'boolean') throw new Error('WEBSITE_PASSWORDS_IO');
      return getWebsitePasswordRuntime().store.setEnabled(params.enabled);
    })
  );
  websitePasswords.updatePassword.provider(
    provide(async (params: { id: string; password: string }) => {
      const id = accountId(params);
      if (typeof params.password !== 'string' || !params.password) throw new Error('WEBSITE_PASSWORDS_IO');
      return getWebsitePasswordRuntime().store.updatePassword(id, params.password);
    })
  );
}
