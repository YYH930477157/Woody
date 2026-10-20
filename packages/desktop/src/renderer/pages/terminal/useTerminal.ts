import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { TerminalConnection, TerminalEvent, TerminalProfile } from '@/common/types/terminal';

const VIEW_BYTES = 256 * 1024;
const VIEW_EVENTS = 2000;
const POLL_ACTIVE_MS = 120;
const POLL_IDLE_MS = 400;

export type TerminalCounters = { rx: number; tx: number };

export function useTerminal() {
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [connections, setConnections] = useState<TerminalConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [events, setEvents] = useState<TerminalEvent[]>([]);
  const [counters, setCounters] = useState<TerminalCounters>({ rx: 0, tx: 0 });
  const [lost, setLost] = useState(false);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const generation = useRef(0);
  const wake = useRef<() => void>(() => undefined);
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const refreshProfiles = useCallback(async () => setProfiles(await ipcBridge.terminal.profiles.invoke()), []);
  const refreshConnections = useCallback(async () => setConnections(await ipcBridge.terminal.list.invoke()), []);
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
    let running = false;
    let again = false;
    const current = ++generation.current;
    cursor.current = 0;
    setEvents([]);
    setCounters({ rx: 0, tx: 0 });
    setLost(false);
    const poll = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(timer);
      let delay = POLL_IDLE_MS;
      try {
        if (!selectedId) return;
        const result = await ipcBridge.terminal.read.invoke({ id: selectedId, cursor: cursor.current });
        if (stopped || generation.current !== current) return;
        cursor.current = result.cursor;
        setLost((lost) => lost || result.lost);
        if (result.events.length) {
          let rx = 0;
          let tx = 0;
          for (const event of result.events) {
            if (event.direction === 'incoming') rx += event.byteLength;
            else if (event.direction === 'outgoing') tx += event.byteLength;
          }
          setCounters((previous) => ({ rx: previous.rx + rx, tx: previous.tx + tx }));
          setEvents((previous) => {
            const next = [...previous, ...result.events];
            let size = next.reduce((sum, event) => sum + event.byteLength, 0);
            while (size > VIEW_BYTES && next.length > 1) size -= next.shift()!.byteLength;
            return next.slice(-VIEW_EVENTS);
          });
        }
        delay = result.more ? 0 : result.events.length ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      } catch (error) {
        if (!stopped) report(error);
        delay = 1500;
      } finally {
        running = false;
        if (!stopped && selectedId) {
          if (again) {
            again = false;
            delay = 0;
          }
          timer = setTimeout(() => {
            void poll();
          }, delay);
        }
      }
    };
    wake.current = () => {
      void poll();
    };
    void poll();
    return () => {
      stopped = true;
      wake.current = () => undefined;
      clearTimeout(timer);
    };
  }, [selectedId, report]);
  const clear = useCallback(() => {
    setEvents([]);
    setCounters({ rx: 0, tx: 0 });
  }, []);
  /** Read new history right away, e.g. right after a send. */
  const refresh = useCallback(() => wake.current(), []);
  return {
    profiles,
    connections,
    selectedId,
    setSelectedId,
    events,
    counters,
    lost,
    error,
    setError,
    report,
    refreshProfiles,
    refreshConnections,
    refresh,
    clear,
    selected: connections.find((connection) => connection.id === selectedId),
  };
}
