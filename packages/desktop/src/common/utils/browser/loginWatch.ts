/* eslint-disable unicorn/consistent-function-scoping -- the page receives only this function's source, so its helpers stay inside it */
/**
 * Runs inside the isolated world, once per document. Login dialogs often appear without a
 * navigation, after the automatic login has stopped looking; this tells the main process
 * when a visible password field appears so it looks again. It reports nothing else.
 * Keep every runtime dependency inside the function: it is serialized.
 */
export function watchLoginForms(): void {
  const scope = window as unknown as {
    woodyLoginWatch?: boolean;
    woodyPasswordCapture?: { loginForm?: () => void };
  };
  if (scope.woodyLoginWatch || typeof scope.woodyPasswordCapture?.loginForm !== 'function') return;
  scope.woodyLoginWatch = true;
  const shown = (): boolean =>
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]')).some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    });
  let last = shown();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    timer = undefined;
    const now = shown();
    if (now && !last) scope.woodyPasswordCapture?.loginForm?.();
    last = now;
  };
  new MutationObserver(() => {
    timer ??= setTimeout(check, 400);
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'type'],
  });
}
