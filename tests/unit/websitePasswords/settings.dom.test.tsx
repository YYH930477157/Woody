import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebsiteAccount, WebsitePasswordStatus } from '@/common/types/websitePasswords';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  importChrome: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
  setEnabled: vi.fn(),
  updatePassword: vi.fn(),
  navigate: vi.fn(),
  desktop: true,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  websitePasswords: Object.fromEntries(
    ['list', 'importChrome', 'remove', 'setDefault', 'setEnabled', 'updatePassword'].map((name) => [
      name,
      { invoke: api[name as 'list'] },
    ])
  ),
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => api.desktop,
  resolveExtensionAssetUrl: (value: string) => value,
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => api.navigate,
  useLocation: () => ({ pathname: '/settings/website-passwords' }),
}));
vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({ useExtensionSettingsTabs: () => [] }));
vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key.endsWith('importSummary') ? `${key}: ${values?.added}/${values?.updated}/${values?.skipped}` : key,
  }),
}));
vi.mock('@/renderer/components/settings/SettingsModal/contents/ToolsModalContent', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/pages/settings/components/SettingsPageHeader', () => ({ default: () => null }));

import ToolsSettings from '@/renderer/pages/settings/ToolsSettings';
import WebsitePasswordSettings from '@/renderer/pages/settings/ToolsSettings/WebsitePasswordSettings';
import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';

const key = (suffix: string) => `settings.websitePasswords.${suffix}`;
const first: WebsiteAccount = {
  id: 'account-one',
  name: 'Intranet',
  origin: 'https://intranet.example',
  username: 'alice',
  isDefault: true,
};
const second: WebsiteAccount = {
  id: 'account-two',
  name: 'Intranet',
  origin: 'https://intranet.example',
  username: 'bob',
  isDefault: false,
};
const status = (overrides: Partial<WebsitePasswordStatus> = {}): WebsitePasswordStatus => ({
  available: true,
  enabled: true,
  accounts: [first, second],
  ...overrides,
});

const ready = async () => {
  render(<WebsitePasswordSettings />);
  await screen.findByText('alice');
};
const row = (username: string) => screen.getByText(username).closest('li')!;

beforeEach(() => {
  vi.resetAllMocks();
  api.desktop = true;
  api.list.mockResolvedValue(status());
  api.remove.mockResolvedValue(status({ accounts: [second] }));
  api.setDefault.mockResolvedValue(
    status({
      accounts: [
        { ...first, isDefault: false },
        { ...second, isDefault: true },
      ],
    })
  );
  api.setEnabled.mockResolvedValue(status({ enabled: false }));
  api.updatePassword.mockResolvedValue(status());
  api.importChrome.mockResolvedValue({
    cancelled: false,
    added: 1,
    updated: 2,
    skipped: 3,
    status: status({ accounts: [first, second, { ...first, id: 'third', username: 'carol' }] }),
  });
});
afterEach(cleanup);

describe('website account settings', () => {
  it('opens website accounts from the Application group after Appearance', () => {
    const { container } = render(<SettingsSider />);
    const application = screen.getByText('settings.groupApp');
    const appearance = container.querySelector('[data-settings-id="appearance"]')!;
    const accounts = container.querySelector('[data-settings-id="website-passwords"]');
    expect(accounts).not.toBeNull();
    expect(application.compareDocumentPosition(accounts!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(appearance.nextElementSibling).toBe(accounts);
    fireEvent.click(accounts!);
    expect(api.navigate).toHaveBeenCalledWith('/settings/website-passwords', { replace: true });
  });

  it('does not mix website accounts into the Tools page', () => {
    render(<ToolsSettings />);
    expect(screen.queryByRole('button', { name: key('importChrome') })).not.toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('hides the native website account entry in browser mode', () => {
    api.desktop = false;
    const { container } = render(<SettingsSider />);
    expect(container.querySelector('[data-settings-id="website-passwords"]')).toBeNull();
  });

  it('includes the independent website account entry in compact navigation', async () => {
    const { getBuiltinSettingsNavItems } = await vi.importActual<
      typeof import('@/renderer/pages/settings/components/SettingsPageWrapper')
    >('@/renderer/pages/settings/components/SettingsPageWrapper');
    const entries = getBuiltinSettingsNavItems(true, (value) => value);
    const appearance = entries.findIndex((entry) => entry.id === 'appearance');
    expect(entries[appearance + 1]).toMatchObject({
      id: 'website-passwords',
      label: key('title'),
      path: 'website-passwords',
    });
    expect(getBuiltinSettingsNavItems(false, (value) => value).some((entry) => entry.id === 'website-passwords')).toBe(
      false
    );
  });

  it('edits a password through a blank field, preserving spaces, and clears it after saving', async () => {
    await ready();
    fireEvent.click(within(row('bob')).getByRole('button', { name: key('editPassword') }));
    const field = screen.getByLabelText(key('newPassword'));
    expect(field).toHaveValue('');
    fireEvent.change(field, { target: { value: ' new secret ' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(api.updatePassword).toHaveBeenCalledExactlyOnceWith({ id: second.id, password: ' new secret ' })
    );
    await waitFor(() => expect(screen.queryByLabelText(key('newPassword'))).not.toBeInTheDocument());
  });
  it('does not save an empty password and discards an edited password on cancel', async () => {
    await ready();
    fireEvent.click(within(row('alice')).getByRole('button', { name: key('editPassword') }));
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(key('newPassword')), { target: { value: 'discard-me' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByLabelText(key('newPassword'))).not.toBeInTheDocument());
    expect(api.updatePassword).not.toHaveBeenCalled();
  });
  it('shows a safe save error inside the password modal and does not retry after cancellation', async () => {
    api.updatePassword.mockRejectedValue(new Error('native secret'));
    await ready();
    fireEvent.click(within(row('alice')).getByRole('button', { name: key('editPassword') }));
    fireEvent.change(screen.getByLabelText(key('newPassword')), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    expect(await screen.findByText(key('errors.generic'))).toBeInTheDocument();
    expect(screen.queryByText('native secret')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.updatePassword).toHaveBeenCalledOnce();
  });
  it('does not invoke native account APIs in WebUI', () => {
    api.desktop = false;
    render(<WebsitePasswordSettings />);
    expect(screen.queryByText(key('title'))).not.toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('keeps controls disabled until metadata arrives', async () => {
    let resolve!: (value: WebsitePasswordStatus) => void;
    api.list.mockReturnValue(new Promise<WebsitePasswordStatus>((done) => (resolve = done)));
    render(<WebsitePasswordSettings />);
    expect(screen.getByRole('button', { name: key('importChrome') })).toBeDisabled();
    expect(screen.getByRole('switch', { name: key('automaticLogin') })).toBeDisabled();
    await act(async () => resolve(status()));
  });

  it('shows site, username and default metadata without credential fields', async () => {
    await ready();
    expect(within(row('alice')).getByText(first.origin)).toBeInTheDocument();
    expect(within(row('alice')).getByText(key('defaultAccount'))).toBeInTheDocument();
    expect(document.querySelector('input[type=password]')).toBeNull();
  });

  it('searches names, origins and usernames without changing stored accounts', async () => {
    await ready();
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'BOB' } });
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: key('search') }), { target: { value: 'missing' } });
    expect(screen.getByText(key('noMatches'))).toBeInTheDocument();
  });

  it('imports with the native picker and adopts returned metadata and counts', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: key('importChrome') }));
    expect(await screen.findByText('carol')).toBeInTheDocument();
    expect(screen.getByText(`${key('importSummary')}: 1/2/3`)).toBeInTheDocument();
    expect(api.importChrome.mock.calls[0]).toEqual([]);
  });

  it('leaves the list and summary unchanged when the picker is cancelled', async () => {
    api.importChrome.mockResolvedValue({ cancelled: true, added: 0, updated: 0, skipped: 0, status: status() });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: key('importChrome') }));
    await waitFor(() => expect(api.importChrome).toHaveBeenCalledOnce());
    expect(screen.queryByText(new RegExp(key('importSummary')))).not.toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows an empty account state after an empty import', async () => {
    api.list.mockResolvedValue(status({ accounts: [] }));
    api.importChrome.mockResolvedValue({
      cancelled: false,
      added: 0,
      updated: 0,
      skipped: 0,
      status: status({ accounts: [] }),
    });
    render(<WebsitePasswordSettings />);
    await screen.findByText(key('empty'));
    fireEvent.click(screen.getByRole('button', { name: key('importChrome') }));
    expect(await screen.findByText(`${key('importSummary')}: 0/0/0`)).toBeInTheDocument();
  });

  it('updates a site default using only the selected account ID', async () => {
    await ready();
    fireEvent.click(within(row('bob')).getByRole('button', { name: key('setDefault') }));
    await waitFor(() => expect(within(row('bob')).getByText(key('defaultAccount'))).toBeInTheDocument());
    expect(api.setDefault).toHaveBeenCalledExactlyOnceWith({ id: second.id });
  });

  it('requires confirmation before deleting an account', async () => {
    await ready();
    fireEvent.click(within(row('alice')).getByRole('button', { name: 'common.delete' }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(screen.queryByText('alice')).not.toBeInTheDocument());
    expect(api.remove).toHaveBeenCalledExactlyOnceWith({ id: first.id });
  });

  it('keeps an account when deletion is cancelled', async () => {
    await ready();
    fireEvent.click(within(row('alice')).getByRole('button', { name: 'common.delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'common.cancel' }));
    expect(api.remove).not.toHaveBeenCalled();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('persists automatic login and reflects only the returned setting', async () => {
    await ready();
    fireEvent.click(screen.getByRole('switch', { name: key('automaticLogin') }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith({ enabled: false });
  });

  it('states that AI controlling the browser can read filled passwords, whatever the toggle says', async () => {
    await ready();
    expect(screen.getByText(key('agentRisk'))).toBeInTheDocument();
    cleanup();
    api.list.mockResolvedValue(status({ enabled: false }));
    await ready();
    expect(screen.getByText(key('agentRisk'))).toBeInTheDocument();
  });

  it('shows encryption unavailability and prevents credential mutations', async () => {
    api.list.mockResolvedValue(status({ available: false }));
    await ready();
    expect(screen.getByText(key('errors.UNAVAILABLE'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: key('importChrome') })).toBeDisabled();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('retries failed initial loading and never displays native error details', async () => {
    api.list.mockRejectedValueOnce(new Error('sensitive native path'));
    render(<WebsitePasswordSettings />);
    await screen.findByText(key('errors.generic'));
    expect(screen.queryByText('sensitive native path')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('alice')).toBeInTheDocument();
  });

  it('maps safe native codes and allows retrying a failed import', async () => {
    api.importChrome.mockRejectedValueOnce(new Error('WEBSITE_PASSWORDS_INVALID_CSV'));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: key('importChrome') }));
    expect(await screen.findByText(key('errors.INVALID_CSV'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('carol')).toBeInTheDocument();
  });

  it('blocks concurrent mutations while the native picker is open', async () => {
    let resolve!: (value: unknown) => void;
    api.importChrome.mockReturnValue(new Promise((done) => (resolve = done)));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: key('importChrome') }));
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(within(row('bob')).getByRole('button', { name: key('setDefault') })).toBeDisabled();
    await act(async () => resolve({ cancelled: true, added: 0, updated: 0, skipped: 0, status: status() }));
  });

  it('preserves the current toggle when saving fails', async () => {
    api.setEnabled.mockRejectedValue(new Error('WEBSITE_PASSWORDS_IO'));
    await ready();
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText(key('errors.IO'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
