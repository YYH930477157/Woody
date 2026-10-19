import { bridge } from '@/common/platform/bridge';
import type {
  TerminalConnection,
  TerminalProfile,
  TerminalReadResult,
  TerminalSendRequest,
  TerminalSendResult,
} from '@/common/types/terminal';

type TerminalReply<T> = { ok: true; value: T } | { ok: false; error: string };
type TerminalInvoke<T, P> = [P] extends [void] ? () => Promise<T> : (params: P) => Promise<T>;

/** The event bridge cannot transport thrown errors; always send a response envelope. */
function terminalProvider<T, P = void>(name: string) {
  const wire = bridge.buildProvider<TerminalReply<T>, P>(name);
  return {
    provider(handler: (params: P) => T | Promise<T>) {
      const wrapped = async (params: P): Promise<TerminalReply<T>> => {
        try {
          return { ok: true, value: await handler(params) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'terminal.failed' };
        }
      };
      return wire.provider(wrapped as Parameters<typeof wire.provider>[0]);
    },
    invoke: (async (params: P): Promise<T> => {
      const result = await (wire.invoke as (params: P) => Promise<TerminalReply<T>>)(params);
      if (result.ok === false) throw new Error(result.error);
      return result.value;
    }) as TerminalInvoke<T, P>,
  };
}

export const terminal = {
  profiles: terminalProvider<TerminalProfile[]>('terminal.profiles'),
  saveProfile: terminalProvider<TerminalProfile, TerminalProfile>('terminal.save-profile'),
  removeProfile: terminalProvider<void, { id: string }>('terminal.remove-profile'),
  ports: terminalProvider<Array<{ path: string; manufacturer?: string }>>('terminal.ports'),
  list: terminalProvider<TerminalConnection[]>('terminal.list'),
  open: terminalProvider<TerminalConnection, TerminalProfile>('terminal.open'),
  read: terminalProvider<TerminalReadResult, { id: string; cursor?: number }>('terminal.read'),
  send: terminalProvider<TerminalSendResult, { id: string; request: TerminalSendRequest }>('terminal.send'),
  cancel: terminalProvider<void, { id: string }>('terminal.cancel'),
  takeover: terminalProvider<void, { id: string }>('terminal.takeover'),
  interrupt: terminalProvider<void, { id: string }>('terminal.interrupt'),
  close: terminalProvider<void, { id: string }>('terminal.close'),
  grant: terminalProvider<
    void,
    { conversationId: string; connectionId?: string; profileId?: string; language: string }
  >('terminal.grant'),
};
