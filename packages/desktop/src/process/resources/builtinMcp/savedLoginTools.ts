/**
 * Saved-login tools for the in-app browser MCP.
 *
 * The browser launcher sits between the MCP client and chrome-devtools-mcp. This module
 * adds two tools to that conversation: it appends them to the server's tool list and
 * answers their calls itself, through Woody's CDP bridge. Every other message passes
 * through unchanged. The agent learns whether a site has a saved account and how a
 * login went; it never receives a username or password.
 */

import type { SavedLoginPageStatus } from '@/common/types/websitePasswords';

/** Woody's own route on the CDP bridge; not part of CDP. */
export const SAVED_LOGIN_PATH = '/woody/saved-login';

export const SAVED_LOGIN_TOOLS = [
  {
    name: 'saved_login_status',
    description:
      'Check whether the page open in the in-app browser belongs to a site with an account the user saved in Woody, and how the last automatic login attempt on it went. Never returns the username or password.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'login_with_saved_account',
    description:
      'Sign in on the page open in the in-app browser with the account the user saved in Woody for this site. Call it when a page asks you to sign in, before asking the user for credentials. Woody fills and submits the form itself and you never see the password. Afterwards take a snapshot to check the result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

type ToolName = (typeof SAVED_LOGIN_TOOLS)[number]['name'];
const ACTIONS: Record<ToolName, 'status' | 'login'> = {
  saved_login_status: 'status',
  login_with_saved_account: 'login',
};

const REASONS: Record<string, string> = {
  noLoginForm: 'no login form that Woody can fill was found on this page',
  otherOrigin: 'the page is not on the saved site',
  filledByUser: 'the form already holds a different account or a typed password',
  multiplePasswords: 'the page shows more than one password field, like a sign-up or password change form',
  registration: 'the form looks like sign-up, password reset or password change',
  verification: 'the form also needs a captcha, a verification code or another field Woody cannot fill',
  noButton: 'no login button was found',
  ambiguousButton: 'several buttons could submit the form, so Woody did not guess',
  unsafeDestination: 'the form would send the password to another site',
  alreadyTried: 'Woody already submitted this account on this page',
};
const ASK_USER = 'Ask the user to finish signing in in the in-app browser, then continue.';

/** What the agent reads back. */
export function describeSavedLogin(action: 'status' | 'login', status: SavedLoginPageStatus): string {
  const site = status.site;
  if (!site) return 'No page is open in the in-app browser.';
  if (status.account === 'unavailable')
    return `Saved accounts are locked (system encryption is unavailable or the account file is unreadable). ${ASK_USER}`;
  if (status.account === 'disabled')
    return `Automatic login is turned off in Woody (Settings → Website accounts). ${ASK_USER}`;
  if (status.account === 'none')
    return `No account is saved in Woody for ${site}. ${ASK_USER} The user can also import accounts under Settings → Website accounts.`;
  const why = status.reason ? (REASONS[status.reason] ?? 'the page did not allow it') : '';
  if (status.result === 'password-submitted')
    return action === 'login'
      ? `Woody filled the saved account on ${site} and submitted the login form. Take a snapshot to confirm the sign-in worked.`
      : `An account is saved in Woody for ${site}, and Woody already submitted it on this page.`;
  if (status.result === 'username-submitted')
    return `Woody submitted the saved username on ${site}. Woody fills the password automatically when the next step appears; take a snapshot in a few seconds.`;
  if (action === 'login')
    return `Woody did not sign in on ${site}: ${why || 'no login form that Woody can fill was found on this page'}. ${ASK_USER}`;
  return why && status.reason !== 'noLoginForm'
    ? `An account is saved in Woody for ${site}. The last automatic attempt stopped because ${why}. Call login_with_saved_account to try again.`
    : `An account is saved in Woody for ${site}. When the page shows its login form, call login_with_saved_account.`;
}

type Message = { id?: string | number | null; method?: string; params?: { name?: unknown; cursor?: unknown } };
const parse = (line: string): Message | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Message) : undefined;
  } catch {
    return undefined;
  }
};

/** Line-based proxy over the MCP stdio stream; unparseable or unrelated lines pass through. */
export function createSavedLoginProxy(deps: {
  call: (action: 'status' | 'login') => Promise<SavedLoginPageStatus>;
  toClient: (line: string) => void;
  toServer: (line: string) => void;
}) {
  const listRequests = new Set<string | number>();
  const reply = (id: Message['id'], text: string, isError = false) =>
    deps.toClient(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) },
      })
    );
  return {
    fromClient(line: string): void {
      const message = parse(line);
      const name = message?.params?.name;
      if (message?.method === 'tools/call' && typeof name === 'string' && name in ACTIONS) {
        const action = ACTIONS[name as ToolName];
        deps.call(action).then(
          (status) => reply(message.id, describeSavedLogin(action, status)),
          (error: unknown) =>
            reply(
              message.id,
              `Woody could not reach its saved accounts: ${error instanceof Error ? error.message : String(error)}`,
              true
            )
        );
        return;
      }
      // Only the first page of the list gets the extra tools.
      if (message?.method === 'tools/list' && message.id != null && !message.params?.cursor)
        listRequests.add(message.id);
      deps.toServer(line);
    },
    fromServer(line: string): void {
      const message = parse(line) as (Message & { result?: { tools?: unknown } }) | undefined;
      if (message && !message.method && message.id != null && listRequests.has(message.id)) {
        listRequests.delete(message.id);
        if (Array.isArray(message.result?.tools)) {
          message.result.tools = [...message.result.tools, ...SAVED_LOGIN_TOOLS];
          deps.toClient(JSON.stringify(message));
          return;
        }
      }
      deps.toClient(line);
    },
  };
}

/** Ask Woody's CDP bridge, which holds the in-app browser and the saved accounts. */
export async function requestSavedLogin(
  browserUrl: string,
  token: string,
  action: 'status' | 'login',
  fetchImpl: typeof fetch = fetch
): Promise<SavedLoginPageStatus> {
  const response = await fetchImpl(new URL(SAVED_LOGIN_PATH, browserUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`the in-app browser answered ${response.status}`);
  return (await response.json()) as SavedLoginPageStatus;
}
