export type TerminalProfile =
  | { id: string; name: string; kind: 'shell'; executable?: string; cwd?: string; args?: string[] }
  | {
      id: string;
      name: string;
      kind: 'serial';
      path: string;
      baudRate: number;
      dataBits: 5 | 6 | 7 | 8;
      parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
      stopBits: 1 | 1.5 | 2;
      rtscts: boolean;
      xon: boolean;
      xoff: boolean;
    };

export type TerminalSerialAccessMode = 'ask' | 'auto';
export type TerminalActor = { ticket: string; leaseId: string };
export type TerminalConnection = {
  id: string;
  profile: TerminalProfile;
  status: 'open' | 'closed';
  owner: 'manual' | 'ai';
  /** Automatic access cannot reclaim this connection after a manual takeover. */
  aiAccessBlocked?: boolean;
  createdAt: number;
  error?: string;
};
export type TerminalEvent = {
  /** Logical byte position immediately after this event or event slice. */
  cursor: number;
  timestamp: number;
  direction: 'incoming' | 'outgoing' | 'system';
  source: 'manual' | 'ai' | 'transport';
  /** Raw bytes encoded as base64; never decode individual chunks as UTF-8. */
  data: string;
  byteLength: number;
  status?: 'completed' | 'failed';
  error?: string;
};
export type TerminalReadResult = { events: TerminalEvent[]; cursor: number; lost: boolean; more: boolean };
export type TerminalWait = {
  mode: 'count' | 'pattern' | 'idle';
  count?: number;
  pattern?: string;
  patternEncoding?: 'hex' | 'utf8';
  idleMs?: number;
  timeoutMs: number;
};
export type TerminalSendOptions = {
  data: string;
  encoding: 'hex' | 'utf8';
  ending: 'none' | 'cr' | 'lf' | 'crlf';
  /** Serial only. Write the payload one byte at a time. */
  slow?: boolean;
  wait?: TerminalWait;
};
export type TerminalSendRequest = TerminalSendOptions;
export type TerminalTransport = {
  write(data: Buffer): Promise<number>;
  close(): Promise<void>;
  interrupt?(): Promise<void>;
  setBaud?(baudRate: number): Promise<void>;
  onData(listener: (data: Buffer) => void): () => void;
  onClose(listener: (error?: string) => void): () => void;
};
export type TerminalWaitStatus = 'matched' | 'timeout' | 'cancelled' | 'taken-over' | 'disconnected';
export type TerminalSendResult = {
  /** Bytes confirmed by the adapter when this result was produced. */
  writtenBytes: number;
  /** A cancelled/timed out native write may finish later; history records its eventual actual bytes. */
  writePending?: boolean;
  status: 'completed' | 'failed' | Exclude<TerminalWaitStatus, 'matched'>;
  error?: string;
  wait?: { status: TerminalWaitStatus; data: string; byteLength: number; truncated: boolean };
};
export type TerminalGrantRequest = {
  connectionId?: string;
  profile?: TerminalProfile;
  conversationId: string;
  /** Observe an open connection without taking control away from manual input. */
  readOnly?: boolean;
};
export type TerminalCapability = {
  ticket: string;
  conversationId: string;
  connectionId?: string;
  profile?: TerminalProfile;
  canWrite: boolean;
};
