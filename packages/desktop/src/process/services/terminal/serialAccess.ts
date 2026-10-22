import type {
  TerminalActor,
  TerminalConnection,
  TerminalProfile,
  TerminalSerialAccessMode,
} from '@/common/types/terminal';
import { deepEqual } from '@/common/utils/deepEqual';
import type { TerminalConnectionService } from './connectionService';

type SerialProfile = Extract<TerminalProfile, { kind: 'serial' }>;
type PolicyGrant = { actor: TerminalActor; write: boolean };
type AccessStore = {
  list(): Promise<TerminalProfile[]>;
  getSerialAccessMode(): Promise<TerminalSerialAccessMode>;
};
export type SerialAccessConfirmation = (profile: SerialProfile, signal: AbortSignal) => Promise<boolean>;

/** Global serial policy creates private, lease-scoped capabilities without chat tickets. */
export class TerminalSerialAccess {
  private readonly actors = new Map<string, Map<string, PolicyGrant>>();
  private readonly pending = new Set<AbortController>();
  private readonly openingPorts = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly service: TerminalConnectionService,
    private readonly store: AccessStore,
    private readonly confirm: SerialAccessConfirmation
  ) {}

  async profiles(): Promise<SerialProfile[]> {
    return (await this.store.list()).filter((profile): profile is SerialProfile => profile.kind === 'serial');
  }

  list(): TerminalConnection[] {
    return this.service.list().filter((connection) => connection.profile.kind === 'serial');
  }

  private current(id: string): TerminalConnection {
    const connection = this.list().find((entry) => entry.id === id);
    if (!connection || connection.status !== 'open') throw new Error('terminal.invalidConnection');
    if (connection.aiAccessBlocked)
      throw new Error(
        'terminal.aiAccessBlocked: the serial connection was manually taken over. Click Allow AI access in the terminal panel to restore access.'
      );
    return connection;
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('terminal.accessCancelled: no authorization was granted.');
  }

  /** Serialize acquisitions so two agents cannot open or take ownership of the same port. */
  private acquire<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    this.pending.add(controller);
    const timer = setTimeout(cancel, 60000);
    let stop!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error('terminal.accessCancelled: no authorization was granted.'));
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    const previous = this.tail;
    const work = previous.then(async () => {
      this.check(controller.signal);
      return operation(controller.signal);
    });
    const result = Promise.race([work, cancelled]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', stop);
      this.pending.delete(controller);
    });
    this.tail = previous.then(() => result).catch((): void => undefined);
    return result;
  }

  private async approve(profile: SerialProfile, signal: AbortSignal): Promise<void> {
    const mode = await this.store.getSerialAccessMode();
    this.check(signal);
    if (mode === 'ask') {
      const approved = await new Promise<boolean>((resolve, reject) => {
        const cancel = () => resolve(false);
        signal.addEventListener('abort', cancel, { once: true });
        void this.confirm(profile, signal)
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', cancel));
      });
      if (!approved)
        throw new Error(
          'terminal.accessDeclined: the request was declined or expired. Ask the user to allow it in Woody; do not ask for a ticket.'
        );
    }
    this.check(signal);
  }

  /** Read grants leave manual input usable; only a write grant moves control of the connection to the AI. */
  private grant(
    leaseId: string,
    scope: { connectionId: string } | { profile: SerialProfile },
    write: boolean
  ): TerminalActor {
    const { ticket } = this.service.grant({
      ...scope,
      conversationId: `serial-policy:${leaseId}`,
      ...(write ? {} : { readOnly: true }),
    });
    const actor = { ticket, leaseId };
    this.service.claim(ticket, leaseId);
    let grants = this.actors.get(leaseId);
    if (!grants) this.actors.set(leaseId, (grants = new Map()));
    const key = 'connectionId' in scope ? scope.connectionId : `profile:${scope.profile.id}`;
    const previous = grants.get(key);
    grants.set(key, { actor, write });
    // Retire an upgraded read grant only after its replacement exists, so reads never lose scope.
    if (previous) this.service.revoke(previous.actor.ticket);
    return actor;
  }

  /** A cached read grant serves reads only; a write must upgrade it through authorize. */
  private cachedActor(leaseId: string, id: string, write: boolean): TerminalActor | undefined {
    const grant = this.actors.get(leaseId)?.get(id);
    if (!grant || (write && !grant.write)) return undefined;
    if (!this.service.claim(grant.actor.ticket, leaseId).canWrite && write)
      throw new Error(
        'terminal.accessRevoked: serial write permission was revoked. Click Allow AI access in the terminal panel to restore access.'
      );
    return grant.actor;
  }

  private async authorize(leaseId: string, id: string, signal: AbortSignal, write: boolean): Promise<TerminalActor> {
    const cached = this.cachedActor(leaseId, id, write);
    if (cached) return cached;
    const connection = this.current(id);
    if (write && connection.owner === 'ai')
      throw new Error(
        'terminal.accessBusy: the serial connection is controlled by another AI. Wait for it to release the connection or take over manually.'
      );
    // A lease that already reads this connection was approved for it; taking control needs no second prompt.
    if (!this.actors.get(leaseId)?.has(id)) await this.approve(connection.profile as SerialProfile, signal);
    // A human may take over or change baud while the approval dialog is open.
    const latest = this.current(id);
    if ((write && latest.owner === 'ai') || !deepEqual(latest.profile, connection.profile)) {
      throw new Error(
        'terminal.accessChanged: the serial connection changed during authorization. Request access again.'
      );
    }
    return this.grant(leaseId, { connectionId: id }, write);
  }

  async actor(leaseId: string, id: string, signal: AbortSignal, write = true): Promise<TerminalActor> {
    this.check(signal);
    const cached = this.cachedActor(leaseId, id, write);
    if (cached) return cached;
    return this.acquire(signal, (active) => this.authorize(leaseId, id, active, write));
  }

  resume(id: string): void {
    this.service.resumeAiAccess(id);
    for (const grants of this.actors.values()) {
      const grant = grants.get(id);
      if (grant) this.service.revoke(grant.actor.ticket);
      grants.delete(id);
    }
  }

  open(leaseId: string, profileId: string, signal: AbortSignal): Promise<TerminalConnection> {
    return this.acquire(signal, async (active) => {
      const profile = (await this.profiles()).find((entry) => entry.id === profileId);
      this.check(active);
      if (!profile)
        throw new Error(
          'terminal.profileMissing: saved serial profile not found. Use terminal_profiles; shell profiles require an explicit Hand to AI grant.'
        );
      const portKey = profile.path.toLowerCase();
      if (this.openingPorts.has(portKey))
        throw new Error('terminal.portOpening: the serial port is still opening. Wait before retrying.');
      const existing = this.list().find(
        (entry) =>
          entry.status === 'open' &&
          entry.profile.kind === 'serial' &&
          entry.profile.path.toLowerCase() === profile.path.toLowerCase()
      );
      if (existing) {
        this.current(existing.id);
        if (!deepEqual(existing.profile, profile))
          throw new Error(
            'terminal.profileConflict: the serial port is already open with different settings. Close it manually before opening this profile.'
          );
        // Attaching only observes; manual input keeps working until the AI actually writes.
        await this.authorize(leaseId, existing.id, active, false);
        return this.current(existing.id);
      }
      await this.approve(profile, active);
      const latest = (await this.profiles()).find((entry) => entry.id === profileId);
      this.check(active);
      if (
        !deepEqual(latest, profile) ||
        this.openingPorts.has(portKey) ||
        this.list().some(
          (entry) =>
            entry.status === 'open' &&
            entry.profile.kind === 'serial' &&
            entry.profile.path.toLowerCase() === profile.path.toLowerCase()
        )
      ) {
        throw new Error(
          'terminal.accessChanged: the serial profile or connection changed during authorization. Request access again.'
        );
      }
      const actor = this.grant(leaseId, { profile }, true);
      this.openingPorts.add(portKey);
      const cancel = () => this.service.revoke(actor.ticket);
      active.addEventListener('abort', cancel, { once: true });
      try {
        const connection = await this.service.open(profile, actor);
        this.check(active);
        this.actors.get(leaseId)?.set(connection.id, { actor, write: true });
        return connection;
      } catch (error) {
        this.service.revoke(actor.ticket);
        throw error;
      } finally {
        this.openingPorts.delete(portKey);
        active.removeEventListener('abort', cancel);
        this.actors.get(leaseId)?.delete(`profile:${profile.id}`);
      }
    });
  }

  release(leaseId: string): void {
    for (const grant of this.actors.get(leaseId)?.values() ?? []) this.service.revoke(grant.actor.ticket);
    this.actors.delete(leaseId);
  }

  /** Switching the global mode cancels prompts and invalidates prior policy grants immediately. */
  invalidate(): void {
    for (const controller of this.pending) controller.abort();
    for (const leaseId of this.actors.keys()) this.release(leaseId);
  }
}
