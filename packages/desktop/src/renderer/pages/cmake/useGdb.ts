import { useEffect, useRef, useState } from 'react';
import { cmake } from '@/common/adapter/cmake';
import type { CmakeConfiguration } from '@/common/types/cmake';
import type { GdbReply, GdbRequest, GdbSession } from '@/common/types/cmake/gdb';

type Command = GdbRequest extends infer Request
  ? Request extends { sessionId: string }
    ? Omit<Request, 'projectPath' | 'sessionId'>
    : never
  : never;
export type GdbInspection = { sessionId: string; revision: number; reply: GdbReply };
export const isDebugActive = (session?: GdbSession) => !!session && !['exited', 'failed'].includes(session.state);

/** Observe the desktop-owned session; discard replies from old projects and older execution revisions. */
export function useGdb(projectPath: string) {
  const [session, setSession] = useState<GdbSession>();
  const [inspection, setInspection] = useState<GdbInspection>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const generation = useRef(0);
  const sequence = useRef(0);
  const busy = useRef(false);
  const latest = useRef<GdbSession | undefined>(undefined);
  function accept(reply: GdbReply) {
    const next = reply.session;
    if (next && latest.current?.id === next.id && next.revision < latest.current.revision) return false;
    latest.current = next;
    setSession(next);
    return true;
  }
  useEffect(() => {
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    latest.current = undefined;
    setSession(undefined);
    setInspection(undefined);
    setError('');
    setAiEnabled(false);
    setPending(false);
    busy.current = false;
    async function poll() {
      const observed = sequence.current;
      try {
        const reply = await cmake.debug.invoke({ projectPath, operation: 'status' });
        const enabled = await cmake.debugAiEnabled.invoke({ projectPath });
        if (disposed || current !== generation.current || observed !== sequence.current || busy.current) return;
        accept(reply);
        setAiEnabled(enabled);
      } catch (reason) {
        if (!disposed && current === generation.current && observed === sequence.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!disposed)
          timer = setTimeout(() => {
            void poll();
          }, 800);
      }
    }
    if (projectPath) void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      generation.current++;
    };
  }, [projectPath]);

  async function perform(operation: () => Promise<GdbReply | void>) {
    if (busy.current) return;
    const current = generation.current;
    busy.current = true;
    sequence.current++;
    setPending(true);
    setError('');
    try {
      const reply = await operation();
      if (current !== generation.current || !reply || !accept(reply)) return;
      if (reply.session?.state === 'stopped' && ['value', 'stack', 'variables', 'memory'].some((key) => key in reply)) {
        setInspection({ sessionId: reply.session.id, revision: reply.session.revision, reply });
      }
      return reply;
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setPending(false);
        sequence.current++;
      }
    }
  }
  return {
    session,
    pending,
    error,
    aiEnabled,
    active: isDebugActive(session),
    inspection:
      session?.state === 'stopped' && inspection?.sessionId === session.id && inspection.revision === session.revision
        ? inspection
        : undefined,
    execute: (command: Command) =>
      perform(async () => {
        const snapshot = latest.current;
        if (!snapshot) return;
        return cmake.debug.invoke({ ...command, projectPath, sessionId: snapshot.id });
      }),
    save: (config: CmakeConfiguration) =>
      perform(async () => {
        await cmake.save.invoke({ projectPath, config });
      }),
    start: (config: CmakeConfiguration) => {
      const current = generation.current;
      return perform(async () => {
        await cmake.save.invoke({ projectPath, config });
        if (current !== generation.current) return;
        setInspection(undefined);
        return cmake.debug.invoke({ projectPath, operation: 'start' });
      });
    },
    setAiEnabled: (enabled: boolean) => {
      const current = generation.current;
      return perform(async () => {
        await cmake.setDebugAiEnabled.invoke({ projectPath, enabled });
        if (current === generation.current) setAiEnabled(enabled);
      });
    },
  };
}
