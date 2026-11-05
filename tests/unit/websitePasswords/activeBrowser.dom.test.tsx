import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserTabLayer from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const { report } = vi.hoisted(() => ({ report: vi.fn(async () => ({ success: true })) }));
vi.mock('@/common', () => ({ ipcBridge: { application: { reportBrowserWebContentsId: { invoke: report } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const tabs: PreviewTab[] = [
  { id: 'first', content: 'https://first.test', content_type: 'browser', title: 'First' },
  { id: 'second', content: 'https://second.test', content_type: 'browser', title: 'Second' },
];
const updateTab = vi.fn();
function ready(webview: Element, id: number) {
  Object.assign(webview, {
    getWebContentsId: () => id,
    executeJavaScript: async () => true,
    canGoBack: () => false,
    canGoForward: () => false,
    setZoomFactor: () => {},
  });
  act(() => {
    webview.dispatchEvent(new Event('dom-ready'));
  });
}
beforeEach(() => report.mockClear());
afterEach(cleanup);

describe('visible browser password target lifecycle', () => {
  it('does not replay a native POST navigation by writing the new address into src', () => {
    const view = render(<WebviewHost url='https://login.test/login' isActiveBrowser />);
    const webview = view.container.querySelector('webview')!;
    ready(webview, 11);
    act(() => {
      webview.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://login.test/session' }));
    });
    expect(webview.getAttribute('src')).toBe('https://login.test/login');
    view.rerender(<WebviewHost url='https://login.test/session' isActiveBrowser />);
    expect(webview.getAttribute('src')).toBe('https://login.test/login');
  });
  it('still applies an explicit external destination to the existing webview', () => {
    const view = render(<WebviewHost url='https://first.test' />);
    const webview = view.container.querySelector('webview')! as unknown as { src: string };
    view.rerender(<WebviewHost url='https://second.test' />);
    expect(webview.src).toBe('https://second.test');
  });
  it('keeps two tabs mounted while attaching only the visible browser, including after background navigation', () => {
    const view = render(<BrowserTabLayer browserTabs={tabs} activeTabId='first' updateTab={updateTab} />);
    const [first, second] = view.container.querySelectorAll('webview');
    ready(first, 11);
    ready(second, 22);
    expect(report.mock.calls).toEqual([[{ webContentsId: 11, active: true }]]);
    view.rerender(<BrowserTabLayer browserTabs={tabs} activeTabId='second' updateTab={updateTab} />);
    expect(view.container.querySelectorAll('webview')[0]).toBe(first);
    expect(view.container.querySelectorAll('webview')[1]).toBe(second);
    expect(report).toHaveBeenCalledWith({ webContentsId: 11, active: false });
    expect(report).toHaveBeenLastCalledWith({ webContentsId: 22, active: true });
    report.mockClear();
    ready(first, 11);
    expect(report).not.toHaveBeenCalled();
    view.rerender(<BrowserTabLayer browserTabs={tabs} activeTabId='document' updateTab={updateTab} />);
    expect(report).toHaveBeenLastCalledWith({ webContentsId: 22, active: false });
    report.mockClear();
    view.rerender(<BrowserTabLayer browserTabs={tabs} activeTabId='first' updateTab={updateTab} />);
    expect(report).toHaveBeenLastCalledWith({ webContentsId: 11, active: true });
    view.unmount();
    expect(report).toHaveBeenLastCalledWith({ webContentsId: 11, active: false });
  });

  it('does not attach unrelated embedded webviews by default', () => {
    const view = render(<WebviewHost url='https://settings.test' />);
    ready(view.container.querySelector('webview')!, 33);
    expect(report).not.toHaveBeenCalled();
  });
});
