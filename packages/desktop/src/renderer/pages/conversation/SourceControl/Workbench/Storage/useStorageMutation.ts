import { useEffect, useRef, useState } from 'react';

/** Keep confirmations single-flight and ignore feedback after the scoped view closes. */
export function useStorageMutation(refresh: () => void, onBusyChange?: (busy: boolean) => void) {
  const running = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    try {
      await action();
      return true;
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange?.(false);
        refresh();
      }
    }
  };
  return { busy, error, run };
}
