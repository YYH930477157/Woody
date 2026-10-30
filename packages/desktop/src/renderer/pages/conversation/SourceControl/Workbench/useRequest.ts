import { useEffect, useState } from 'react';

export type ReadState<T> = { loading: boolean; data?: T; error?: string };

/** A cancelled read cannot publish data or an error into the next selection. */
export function useRequest<T>(read: () => Promise<T>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState<T>>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    void read().then(
      (data) => {
        if (active) setState({ loading: false, data });
      },
      (error: unknown) => {
        if (active) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    );
    return () => {
      active = false;
    };
  }, [read, revision]);
  return { ...state, retry: () => setRevision((value) => value + 1) };
}
