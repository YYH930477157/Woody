import { contextBridge, ipcRenderer } from 'electron';
import { WEBSITE_PASSWORD_CAPTURE, WEBSITE_PASSWORD_WORLD } from '@/common/utils/browser/types';
import type { AutofillCredential } from '@/common/utils/browser/types';

// Only our isolated DOM helper can send a candidate. The website has no API.
contextBridge.exposeInIsolatedWorld(WEBSITE_PASSWORD_WORLD, 'woodyPasswordCapture', {
  report: (candidate: AutofillCredential): void => {
    ipcRenderer.send(WEBSITE_PASSWORD_CAPTURE, candidate);
  },
});
