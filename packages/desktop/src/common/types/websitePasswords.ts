/** Metadata safe to display in settings; plaintext credentials stay in main. */
export type WebsiteAccount = {
  id: string;
  name: string;
  origin: string;
  username: string;
  isDefault: boolean;
};

export type WebsitePasswordStatus = {
  available: boolean;
  enabled: boolean;
  accounts: WebsiteAccount[];
};

export type WebsitePasswordImportResult = {
  cancelled: boolean;
  added: number;
  updated: number;
  skipped: number;
  status: WebsitePasswordStatus;
};
