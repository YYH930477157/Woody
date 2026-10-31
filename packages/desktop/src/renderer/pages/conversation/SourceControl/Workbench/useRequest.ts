import { useEffect, useRef, useState } from 'react';

export type ReadState<T> = { loading: boolean; data?: T; error?: string };

/**
 * A cancelled read cannot publish data or an error into the next selection. Data is cleared while reading unless the
 * caller names what it describes with `retainFor`: reloads of the same subject then keep showing the last result.
 */
export function useRequest<T>(read: () => Promise<T>, retainFor?: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ReadState<T>>({ loading: true });
  const subject = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const sameSubject = retainFor !== undefined && subject.current === retainFor;
    subject.current = retainFor;
    setState((current) => (sameSubject ? { loading: true, data: current.data } : { loading: true }));
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
