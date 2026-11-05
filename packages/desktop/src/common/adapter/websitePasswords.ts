import { replyProvider } from '@/common/platform/replyProvider';
import type { WebsitePasswordImportResult, WebsitePasswordStatus } from '@/common/types/websitePasswords';

/** Password editing is write-only; no provider returns a plaintext password. */
export const websitePasswords = {
  list: replyProvider<WebsitePasswordStatus, void>('website-passwords.list'),
  importChrome: replyProvider<WebsitePasswordImportResult, void>('website-passwords.import-chrome'),
  remove: replyProvider<WebsitePasswordStatus, { id: string }>('website-passwords.remove'),
  setDefault: replyProvider<WebsitePasswordStatus, { id: string }>('website-passwords.set-default'),
  setEnabled: replyProvider<WebsitePasswordStatus, { enabled: boolean }>('website-passwords.set-enabled'),
  updatePassword: replyProvider<WebsitePasswordStatus, { id: string; password: string }>('website-passwords.update'),
};
