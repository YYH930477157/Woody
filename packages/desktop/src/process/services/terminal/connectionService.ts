import { randomBytes, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type {
  TerminalActor,
  TerminalCapability,
  TerminalConnection,
  TerminalGrantRequest,
  TerminalProfile,
  TerminalReadResult,
  TerminalSendOptions,
  TerminalSendResult,
  TerminalTransport,
  TerminalWaitStatus,
} from '@/common/types/terminal';
import { ByteHistory, validateHistoryCapacity } from './byteHistory';
import { encodeTerminalData, TERMINAL_MAX_IO_BYTES, validateTerminalProfile, validateTerminalWait } from './serialData';

export type { TerminalTransport } from '@/common/types/terminal';
type StopReason = Exclude<TerminalWaitStatus, 'matched'>;
type Grant = TerminalCapability & { createdAt: number; leaseId?: string; opening?: boolean };
type Pending = { actor?: TerminalActor; cancel(reason: StopReason): void; receive(data: Buffer): void };
type ConnectionState = {
  info: TerminalConnection;
  transport: TerminalTransport;
  history: ByteHistory;
  pending: Set<Pending>;
  queued: number;
  tail: Promise<void>;
  detach: (() => void)[];
};
export type TerminalServiceOptions = { historyBytes?: number; maxConnections?: number };
export const TERMINAL_UNCLAIMED_GRANT_TTL_MS = 5 * 60_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cloneProfile = (profile: TerminalProfile) => validateTerminalProfile(profile);

/** Owns shared shell/serial resources; UI and MCP use the same connection and history. */
export class TerminalConnectionService {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly grants = new Map<string, Grant>();
  private readonly maxConnections: number;
  private pendingOpens = 0;
  private disposed = false;

  constructor(
    private readonly factory: (profile: TerminalProfile) => Promise<TerminalTransport>,
    private readonly options: TerminalServiceOptions = {}
  ) {
    this.maxConnections = options.maxConnections ?? 32;
    if (!Number.isInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 128) {
      throw new Error('Invalid terminal connection limit');
    }
    // Validate capacity before opening a native resource.
    validateHistoryCapacity(options.historyBytes);
  }

  private connection(id: string): ConnectionState {
    const state = this.connections.get(id);
    if (!state) throw new Error('Terminal connection not found');
    return state;
  }

  private capability(actor: TerminalActor): Grant {
    if (!actor || typeof actor.ticket !== 'string' || typeof actor.leaseId !== 'string' || !actor.leaseId) {
      throw new Error('Invalid terminal capability');
    }
    const grant = this.grants.get(actor.ticket);
    if (!grant || grant.leaseId !== actor.leaseId) throw new Error('Terminal capability is not claimed by this lease');
    return grant;
  }

  private authorize(id: string, actor?: TerminalActor, write = false): Grant | undefined {
    if (!actor) return undefined;
    const grant = this.capability(actor);
    if (grant.connectionId !== id) throw new Error('Terminal connection is outside capability scope');
    if (write && !grant.canWrite) throw new Error('Terminal write permission was revoked');
    return grant;
  }

  private authorizeControl(id: string, actor?: TerminalActor): ConnectionState {
    this.authorize(id, actor, true);
    const state = this.connection(id);
    if (!actor && state.info.owner !== 'manual') throw new Error('Take over the terminal before manual control');
    return state;
  }

  private snapshot(state: ConnectionState): TerminalConnection {
    return { ...state.info, profile: cloneProfile(state.info.profile) };
  }

  /** Open one configuration, or exactly the immutable configuration authorized by a grant. */
  async open(profile: TerminalProfile, actor?: TerminalActor): Promise<TerminalConnection> {
    if (this.disposed) throw new Error('Terminal service is disposed');
    const normalized = validateTerminalProfile(profile);
    let grant: Grant | undefined;
    if (actor) {
      grant = this.capability(actor);
      if (
        !grant.canWrite ||
        !grant.profile ||
        grant.connectionId ||
        grant.opening ||
        JSON.stringify(grant.profile) !== JSON.stringify(normalized)
      ) {
        throw new Error('Terminal creation is outside capability scope');
      }
    }
    for (const [id, state] of this.connections) {
      if (this.connections.size + this.pendingOpens < this.maxConnections) break;
      if (state.info.status === 'closed') this.connections.delete(id);
    }
    if (this.connections.size + this.pendingOpens >= this.maxConnections)
      throw new Error('Terminal connection limit reached');
    if (grant) grant.opening = true;
    this.pendingOpens++;
    let transport: TerminalTransport | undefined;
    let state: ConnectionState | undefined;
    try {
      transport = await this.factory(cloneProfile(normalized));
      if (this.disposed || (actor && (this.capability(actor) !== grant || !grant.canWrite))) {
        throw new Error('Terminal creation was revoked');
      }
      const id = randomUUID();
      state = {
        info: { id, profile: normalized, status: 'open', owner: actor ? 'ai' : 'manual', createdAt: Date.now() },
        transport,
        history: new ByteHistory(this.options.historyBytes),
        pending: new Set(),
        queued: 0,
        tail: Promise.resolve(),
        detach: [],
      };
      state.detach.push(
        transport.onData((data) => {
          if (state.info.status !== 'open' || !Buffer.isBuffer(data) || !data.length) return;
          state.history.append(data, { direction: 'incoming', source: 'transport' });
          for (const pending of state.pending) pending.receive(data);
        })
      );
      const detachClose = transport.onClose((error) => this.disconnected(state, error));
      if (state.info.status === 'closed') detachClose();
      else state.detach.push(detachClose);
      this.connections.set(id, state);
      if (grant) grant.connectionId = id;
      return this.snapshot(state);
    } catch (error) {
      if (state) this.detachListeners(state);
      if (transport) await this.safeClose(transport).catch((): void => undefined);
      throw error;
    } finally {
      this.pendingOpens--;
      if (grant) grant.opening = false;
    }
  }

  /** List only the connection authorized by an MCP lease, or all UI connections. */
  list(actor?: TerminalActor): TerminalConnection[] {
    const grant = actor ? this.capability(actor) : undefined;
    return [...this.connections.values()]
      .filter((state) => !actor || state.info.id === grant.connectionId)
      .map((state) => this.snapshot(state));
  }

  /** Read raw history with an independent caller-owned cursor. */
  read(id: string, cursor = 0, maxBytes = TERMINAL_MAX_IO_BYTES, actor?: TerminalActor): TerminalReadResult {
    this.authorize(id, actor);
    return this.connection(id).history.read(cursor, maxBytes);
  }

  /** Queue a bounded write and optional byte-stream observation. */
  async send(id: string, options: TerminalSendOptions, actor?: TerminalActor): Promise<TerminalSendResult> {
    const state = this.authorizeControl(id, actor);
    if (state.info.status !== 'open') throw new Error('Terminal connection is closed');
    if (state.queued >= 64) throw new Error('Terminal write queue limit reached');
    if (options.slow !== undefined && typeof options.slow !== 'boolean') throw new Error('Invalid slow send flag');
    if (options.slow && state.info.profile.kind !== 'serial') {
      throw new Error('Slow send is only available for serial connections');
    }
    const data = encodeTerminalData(options);
    if (state.info.profile.kind === 'shell' && !isUtf8(data)) {
      throw new Error('Shell connections support UTF-8 bytes only');
    }
    const condition = validateTerminalWait(options.wait);
    const identity = actor ? { ...actor } : undefined;
    let resolve!: (result: TerminalSendResult) => void;
    const completion = new Promise<TerminalSendResult>((done) => {
      resolve = done;
    });
    let done = false;
    let started = false;
    let writeCompleted = false;
    let matched = false;
    let writtenBytes = 0;
    let receivedBytes = 0;
    let retainedBytes = 0;
    const parts: Buffer[] = [];
    let searchTail = Buffer.alloc(0);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: TerminalSendResult['status'], error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(overallTimer);
      state.pending.delete(operation);
      resolve({
        status,
        writtenBytes,
        ...(started && !writeCompleted ? { writePending: true } : {}),
        ...(error ? { error } : {}),
        ...(condition
          ? {
              wait: {
                status: status === 'completed' ? 'matched' : status === 'failed' ? 'disconnected' : status,
                data: Buffer.concat(parts, retainedBytes).toString('base64'),
                byteLength: retainedBytes,
                truncated: receivedBytes > retainedBytes,
              },
            }
          : {}),
      });
    };
    const match = () => {
      matched = true;
      clearTimeout(idleTimer);
      if (writeCompleted) finish('completed');
    };
    const operation: Pending = {
      actor: identity,
      cancel: (reason) => finish(reason),
      receive: (bytes) => {
        if (done || !started || !condition || matched) return;
        receivedBytes += bytes.length;
        const keep = Math.min(bytes.length, TERMINAL_MAX_IO_BYTES - retainedBytes);
        if (keep) parts.push(Buffer.from(bytes.subarray(0, keep)));
        retainedBytes += keep;
        if (condition.wait.mode === 'count' && receivedBytes >= condition.wait.count) match();
        else if (condition.wait.mode === 'pattern') {
          const overlap = condition.pattern.length - 1;
          const boundary = Buffer.concat([searchTail, bytes.subarray(0, overlap)]);
          if (bytes.indexOf(condition.pattern) !== -1 || boundary.indexOf(condition.pattern) !== -1) match();
          else {
            searchTail =
              bytes.length >= overlap
                ? Buffer.from(bytes.subarray(bytes.length - overlap))
                : Buffer.from(boundary.subarray(Math.max(0, boundary.length - overlap)));
          }
        } else if (condition.wait.mode === 'idle' && receivedBytes) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(match, condition.wait.idleMs);
        }
      },
    };
    state.pending.add(operation);
    state.queued++;
    overallTimer = setTimeout(() => finish('timeout'), condition?.wait.timeoutMs ?? 30_000);
    const run = async () => {
      if (done) return;
      try {
        this.authorizeControl(id, identity);
        if (state.info.status !== 'open') {
          finish('disconnected');
          return;
        }
        started = true;
        let errorText: string | undefined;
        try {
          const pieces =
            options.slow && data.length > 0
              ? Array.from({ length: data.length }, (_, index) => data.subarray(index, index + 1))
              : [data];
          for (const piece of pieces) {
            if (done) break;
            const actual = await state.transport.write(piece);
            if (!Number.isInteger(actual) || actual < 0 || actual > piece.length) {
              throw new Error('Transport returned an invalid written byte count');
            }
            writtenBytes += actual;
            if (actual !== piece.length) {
              errorText = 'Transport completed a partial write';
              break;
            }
          }
        } catch (error) {
          const actual = (error as { bytesWritten?: unknown })?.bytesWritten;
          if (typeof actual === 'number' && Number.isInteger(actual) && actual >= 0 && actual <= data.length) {
            writtenBytes = actual;
          }
          errorText = message(error);
        }
        state.history.append(data.subarray(0, writtenBytes), {
          direction: 'outgoing',
          source: identity ? 'ai' : 'manual',
          status: errorText ? 'failed' : 'completed',
          ...(errorText ? { error: errorText } : {}),
        });
        writeCompleted = true;
        if (!done) {
          if (errorText) finish('failed', errorText);
          else if (!condition || matched) finish('completed');
        }
        // Keep the queue locked for the actual native write and receive condition.
        await completion;
      } catch (error) {
        if (!done) finish('failed', message(error));
      }
    };
    state.tail = state.tail
      .then(run)
      .catch((): void => undefined)
      .finally(() => {
        state.queued--;
      });
    return completion;
  }

  /** Cancel current and queued sends in the caller's scope, retaining observed bytes. */
  cancel(id: string, actor?: TerminalActor): void {
    this.authorize(id, actor, true);
    for (const operation of this.connection(id).pending) {
      if (!actor || operation.actor?.ticket === actor.ticket) operation.cancel('cancelled');
    }
  }

  /** Atomically remove every AI write capability before cancelling AI operations. */
  takeover(id: string): TerminalConnection {
    const state = this.connection(id);
    state.info.owner = 'manual';
    for (const grant of this.grants.values()) {
      if (grant.connectionId === id) grant.canWrite = false;
    }
    for (const operation of state.pending) {
      if (operation.actor) operation.cancel('taken-over');
    }
    return this.snapshot(state);
  }

  /** Change baud on an open serial port without dropping the connection. */
  async setBaud(id: string, baudRate: number, actor?: TerminalActor): Promise<TerminalConnection> {
    const state = this.authorizeControl(id, actor);
    if (state.info.status !== 'open') throw new Error('Terminal connection is closed');
    if (state.info.profile.kind !== 'serial') throw new Error('Baud rate applies to serial connections only');
    if (!Number.isInteger(baudRate) || baudRate < 1 || baudRate > 12_000_000) throw new Error('Invalid serial baud rate');
    if (!state.transport.setBaud) throw new Error('Terminal transport does not support baud changes');
    await state.transport.setBaud(baudRate);
    state.info.profile = { ...state.info.profile, baudRate };
    return this.snapshot(state);
  }

  /** Interrupt the underlying shell only while the caller still has write authority. */
  async interrupt(id: string, actor?: TerminalActor): Promise<void> {
    const state = this.authorizeControl(id, actor);
    if (state.info.status !== 'open') throw new Error('Terminal connection is closed');
    if (!state.transport.interrupt) throw new Error('Terminal transport does not support interruption');
    await state.transport.interrupt();
  }

  private detachListeners(state: ConnectionState): void {
    for (const detach of state.detach.splice(0)) {
      try {
        detach();
      } catch (error) {
        state.info.error ??= message(error);
      }
    }
  }

  private disconnected(state: ConnectionState, error?: string): void {
    if (state.info.status === 'closed') return;
    state.info.status = 'closed';
    state.info.owner = 'manual';
    if (error) state.info.error = error;
    for (const grant of this.grants.values()) {
      if (grant.connectionId === state.info.id) grant.canWrite = false;
    }
    for (const operation of state.pending) operation.cancel('disconnected');
    this.detachListeners(state);
    state.history.append(Buffer.alloc(0), {
      direction: 'system',
      source: 'transport',
      ...(error ? { error } : {}),
    });
  }

  private async safeClose(transport: TerminalTransport): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => transport.close()),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Close without discarding history or other readers' cursors. */
  async close(id: string, actor?: TerminalActor): Promise<void> {
    this.authorize(id, actor, true);
    const state = this.connection(id);
    this.disconnected(state);
    await this.safeClose(state.transport);
  }

  /** Create an in-memory random capability; caller-supplied conversation ids are never credentials. */
  grant(request: TerminalGrantRequest): { ticket: string } {
    if (this.disposed || !request || typeof request.conversationId !== 'string' || !request.conversationId.trim()) {
      throw new Error('Invalid terminal grant');
    }
    if (Boolean(request.connectionId) === Boolean(request.profile)) {
      throw new Error('Grant must select one connection or profile');
    }
    const profile = request.profile ? cloneProfile(request.profile) : undefined;
    const state = request.connectionId ? this.connection(request.connectionId) : undefined;
    if (state?.info.status === 'closed') throw new Error('Terminal connection is closed');
    this.pruneGrants();
    for (const grant of this.grants.values()) {
      if (
        !grant.leaseId &&
        grant.conversationId === request.conversationId &&
        (profile ? grant.profile?.id === profile.id : grant.connectionId === request.connectionId)
      ) {
        this.revoke(grant.ticket);
      }
    }
    if (this.grants.size >= 256) throw new Error('Terminal grant limit reached');
    if (state) state.info.owner = 'ai';
    const ticket = randomBytes(32).toString('base64url');
    this.grants.set(ticket, {
      ticket,
      createdAt: Date.now(),
      conversationId: request.conversationId,
      ...(profile ? { profile } : { connectionId: request.connectionId }),
      canWrite: true,
    });
    return { ticket };
  }

  /** Bind a capability to its first MCP process lease; a token alone proves access. */
  claim(ticket: string, leaseId: string): TerminalCapability {
    this.pruneGrants();
    const grant = this.grants.get(ticket);
    if (!grant || typeof leaseId !== 'string' || !leaseId || leaseId.length > 4096)
      throw new Error('Invalid terminal claim');
    if (grant.leaseId && grant.leaseId !== leaseId) throw new Error('Terminal capability belongs to another lease');
    grant.leaseId = leaseId;
    const { createdAt: _createdAt, leaseId: _leaseId, opening: _opening, ...capability } = grant;
    return { ...capability, ...(grant.profile ? { profile: cloneProfile(grant.profile) } : {}) };
  }

  private pruneGrants(): void {
    const now = Date.now();
    for (const grant of this.grants.values()) {
      if (!grant.leaseId && now - grant.createdAt >= TERMINAL_UNCLAIMED_GRANT_TTL_MS) this.revoke(grant.ticket);
    }
  }

  /** Revoke a ticket and cancel its in-flight work while keeping its connection available to the UI. */
  revoke(ticket: string): void {
    this.grants.delete(ticket);
    for (const state of this.connections.values()) {
      if (![...this.grants.values()].some((grant) => grant.connectionId === state.info.id && grant.canWrite)) {
        state.info.owner = 'manual';
      }
      for (const operation of state.pending) {
        if (operation.actor?.ticket === ticket) operation.cancel('cancelled');
      }
    }
  }

  /** Invalidate every capability used by an exiting MCP process. */
  revokeLease(leaseId: string): void {
    for (const grant of this.grants.values()) {
      if (grant.leaseId === leaseId) this.revoke(grant.ticket);
    }
  }

  /** Cancel all work, detach listeners, and close resources with bounded cleanup. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.grants.clear();
    const states = [...this.connections.values()];
    for (const state of states) this.disconnected(state);
    await Promise.allSettled(states.map((state) => this.safeClose(state.transport)));
    this.connections.clear();
  }
}
