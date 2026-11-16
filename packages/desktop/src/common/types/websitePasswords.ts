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

/**
 * The saved-login state of the page open in the in-app browser. It names the site and
 * the outcome only: never a username or password.
 */
export type SavedLoginPageStatus = {
  /** Origin of the page, or null when no in-app browser page is attached. */
  site: string | null;
  account: 'saved' | 'none' | 'disabled' | 'unavailable';
  /** The latest attempt on this page, when there was one. */
  result?: 'password-submitted' | 'username-submitted' | 'skipped';
  /** Why the latest attempt did not submit (an AutofillSkipReason or 'identityConflict'). */
  reason?: string;
};

export type WebsitePasswordImportResult = {
  cancelled: boolean;
  added: number;
  updated: number;
  skipped: number;
  status: WebsitePasswordStatus;
};
