import { useEffect, useRef, useState } from 'react';
import type { TerminalCounters } from './useTerminal';

const WINDOW_MS = 3000;
type Sample = { time: number; rx: number; tx: number };

export type TerminalRates = { rx: number; tx: number };

/**
 * Byte rates averaged over the last few seconds, plus a clock that ticks once a second for the connection timer.
 * Restarts when `resetKey` changes (another session) and when the counters go down (the view was cleared).
 */
export function useTerminalStats(counters: TerminalCounters, resetKey?: string) {
  const latest = useRef(counters);
  const [rates, setRates] = useState<TerminalRates>({ rx: 0, tx: 0 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    latest.current = counters;
  }, [counters]);
  useEffect(() => {
    const samples: Sample[] = [];
    const tick = () => {
      const time = Date.now();
      const { rx, tx } = latest.current;
      const previous = samples.at(-1);
      if (previous && (rx < previous.rx || tx < previous.tx)) samples.length = 0;
      samples.push({ time, rx, tx });
      while (samples.length > 1 && time - samples[0].time > WINDOW_MS) samples.shift();
      const first = samples[0];
      const span = (time - first.time) / 1000;
      setRates(span > 0 ? { rx: (rx - first.rx) / span, tx: (tx - first.tx) / span } : { rx: 0, tx: 0 });
      setNow(time);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [resetKey]);
  return { rates, now };
}
