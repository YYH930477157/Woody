export type AutofillCredential = { origin: string; username: string; password: string };
export type AutofillPermissions = { username: boolean; password: boolean; continuation?: boolean };
export type AutofillResult = 'none' | 'identity-conflict' | 'username-submitted' | 'password-submitted';
/** Why an automatic login did not run on a page; never contains page or account content. */
export type AutofillSkipReason =
  | 'noLoginForm'
  | 'otherOrigin'
  | 'filledByUser'
  | 'multiplePasswords'
  | 'registration'
  | 'verification'
  | 'noButton'
  | 'ambiguousButton'
  | 'unsafeDestination'
  | 'alreadyTried';
export const WEBSITE_PASSWORD_WORLD = 1047;
export const WEBSITE_PASSWORD_CAPTURE = 'woody:website-password-capture';
/** Sent by the isolated-world watcher when a password field appears without a navigation. */
export const WEBSITE_LOGIN_FORM = 'woody:website-login-form';
