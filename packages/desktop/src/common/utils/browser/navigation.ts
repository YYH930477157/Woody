/** Serialized into a webview. Forms retain native submission so POST bodies survive. */
export function installWebviewNavigationInterceptor(): void {
  const host = window as Window & { __webviewHostInjected?: boolean };
  if (host.__webviewHostInjected) return;
  host.__webviewHostInjected = true;
  document.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (anchor instanceof HTMLAnchorElement && /^https?:/i.test(anchor.href)) {
        event.preventDefault();
        event.stopPropagation();
        window.postMessage({ type: '__WEBVIEW_HOST_NAVIGATE__', url: anchor.href }, '*');
      }
    },
    true
  );
  const originalOpen = window.open;
  window.open = function (...args: Parameters<typeof window.open>) {
    const url = args[0]?.toString();
    if (url && /^https?:/i.test(url)) {
      window.postMessage({ type: '__WEBVIEW_HOST_NAVIGATE__', url }, '*');
      return null;
    }
    return originalOpen.apply(window, args);
  };
}
