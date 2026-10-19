import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { TerminalConnection, TerminalEvent, TerminalProfile } from '@/common/types/terminal';

export function useTerminal() {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [connections, setConnections] = useState<TerminalConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const generation = useRef(0);
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const refreshProfiles = useCallback(async () => setProfiles(await ipcBridge.terminal.profiles.invoke()), []);
  useEffect(() => {
    void refreshProfiles().catch(report);
  }, [refreshProfiles, report]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await ipcBridge.terminal.list.invoke();
        if (!stopped) setConnections(result);
      } catch (error) {
        if (!stopped) report(error);
      }
      if (!stopped)
        timer = setTimeout(() => {
          void poll();
        }, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [report]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = ++generation.current;
    cursor.current = 0;
    setEvents([]);
    setLost(false);
    const poll = async () => {
      try {
        if (!selectedId) return;
        const result = await ipcBridge.terminal.read.invoke({ id: selectedId, cursor: cursor.current });
        if (stopped || generation.current !== current) return;
        cursor.current = result.cursor;
        setLost((lost) => lost || result.lost);
        setEvents((previous) => {
          const next = [...previous, ...result.events];
          let size = next.reduce((sum, event) => sum + event.byteLength, 0);
          while (size > 256 * 1024 && next.length > 1) size -= next.shift()!.byteLength;
          return next.slice(-2000);
        });
        timer = setTimeout(
          () => {
            void poll();
          },
          result.more ? 0 : 500
        );
      } catch (error) {
        if (!stopped) {
          report(error);
          timer = setTimeout(() => {
            void poll();
          }, 1500);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selectedId, report]);
  const clear = () => setEvents([]);
  return {
    profiles,
    connections,
    selectedId,
    setSelectedId,
    events,
    lost,
    error,
    setError,
    report,
    refreshProfiles,
    clear,
    selected: connections.find((connection) => connection.id === selectedId),
  };
}
