export type AutofillCredential = { origin: string; username: string; password: string };
export type AutofillPermissions = { username: boolean; password: boolean; continuation?: boolean };
export type AutofillResult = 'none' | 'identity-conflict' | 'username-submitted' | 'password-submitted';
export const WEBSITE_PASSWORD_WORLD = 1047;
export const WEBSITE_PASSWORD_CAPTURE = 'woody:website-password-capture';
