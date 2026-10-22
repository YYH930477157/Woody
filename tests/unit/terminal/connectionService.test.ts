import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProfile } from '@/common/types/terminal';
import { TerminalConnectionService, type TerminalTransport } from '@/process/services/terminal/connectionService';

const profile: TerminalProfile = { id: 'shell', name: 'Shell', kind: 'shell', args: [] };
const text = (data: string) => ({ data, encoding: 'utf8' as const, ending: 'none' as const });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

class MemoryTransport implements TerminalTransport {
  writes: Buffer[] = [];
  dataListeners = new Set<(data: Buffer) => void>();
  closeListeners = new Set<(error?: string) => void>();
  writeImpl: (data: Buffer) => Promise<number> = async (data) => data.length;
  closed = false;
  interrupts = 0;
  async write(data: Buffer) {
    this.writes.push(Buffer.from(data));
    return this.writeImpl(data);
  }
  async close() {
    this.closed = true;
    this.disconnect();
  }
  async interrupt() {
    this.interrupts++;
  }
  onData(listener: (data: Buffer) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onClose(listener: (error?: string) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  receive(data: string | Buffer) {
    for (const listener of this.dataListeners) listener(Buffer.from(data));
  }
  disconnect(error?: string) {
    for (const listener of this.closeListeners) listener(error);
  }
}

const services: TerminalConnectionService[] = [];
const setup = async (options = {}) => {
  const transport = new MemoryTransport();
  const service = new TerminalConnectionService(async () => transport, options);
  services.push(service);
  const connection = await service.open(profile);
  return { transport, service, id: connection.id };
};
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

describe('shared terminal connections', () => {
  it('observes synchronous replies before writing and matches across split chunks', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async (data) => {
      transport.receive(Buffer.from([0, 255]));
      transport.receive(Buffer.from([161, 2]));
      return data.length;
    };
    const result = await service.send(id, {
      ...text('go'),
      wait: { mode: 'pattern', pattern: 'ff a1', patternEncoding: 'hex', timeoutMs: 100 },
    });
    expect(result).toMatchObject({ writtenBytes: 2, status: 'completed', wait: { status: 'matched', byteLength: 4 } });
    expect(Buffer.from(result.wait!.data, 'base64')).toEqual(Buffer.from([0, 255, 161, 2]));
  });

  it('serializes writes while the first transport write is in flight', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const one = service.send(id, text('first'));
    const two = service.send(id, text('second'));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    blocked.resolve(5);
    await one;
    await two;
    expect(transport.writes.map((bytes) => bytes.toString())).toEqual(['first', 'second']);
  });

  it('times out with partial received bytes and never treats chunks as frames', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async (data) => {
      transport.receive('abc');
      return data.length;
    };
    const result = await service.send(id, { ...text('go'), wait: { mode: 'count', count: 5, timeoutMs: 15 } });
    expect(result).toMatchObject({ status: 'timeout', wait: { status: 'timeout', byteLength: 3 } });
    expect(Buffer.from(result.wait!.data, 'base64').toString()).toBe('abc');
  });

  it('starts idle detection only after receiving at least one byte', async () => {
    const { service, id } = await setup();
    const result = await service.send(id, { ...text('go'), wait: { mode: 'idle', idleMs: 1, timeoutMs: 15 } });
    expect(result.wait).toMatchObject({ status: 'timeout', byteLength: 0 });
  });

  it('resets idle detection for subsequent bytes', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async (data) => {
      transport.receive('a');
      setTimeout(() => transport.receive('b'), 5);
      return data.length;
    };
    const result = await service.send(id, { ...text('go'), wait: { mode: 'idle', idleMs: 10, timeoutMs: 100 } });
    expect(Buffer.from(result.wait!.data, 'base64').toString()).toBe('ab');
    expect(result.wait!.status).toBe('matched');
  });

  it.each(['cancelled', 'disconnected'] as const)('returns partial bytes when %s', async (reason) => {
    const { service, transport, id } = await setup();
    const pending = service.send(id, { ...text('go'), wait: { mode: 'count', count: 10, timeoutMs: 500 } });
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.receive('partial');
    if (reason === 'cancelled') service.cancel(id);
    else transport.disconnect('unplugged');
    expect(await pending).toMatchObject({ status: reason, wait: { status: reason, byteLength: 7 } });
  });

  it('records a partial failed transport write with actual byte count', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async () => {
      throw Object.assign(new Error('broken'), { bytesWritten: 2 });
    };
    expect(await service.send(id, text('four'))).toMatchObject({ status: 'failed', writtenBytes: 2 });
    expect(service.read(id).events.filter((event) => event.direction === 'outgoing')).toMatchObject([
      { byteLength: 2, status: 'failed', error: 'broken' },
    ]);
  });

  it('bounds a hung adapter write while preserving serialization', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const pending = service.send(id, { ...text('go'), wait: { mode: 'count', count: 1, timeoutMs: 10 } });
    expect(await pending).toMatchObject({ status: 'timeout', writtenBytes: 0, writePending: true });
    const next = service.send(id, text('next'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(transport.writes).toHaveLength(1);
    blocked.resolve(2);
    await next;
  });

  it('validates wait inputs before touching a transport', async () => {
    const { service, transport, id } = await setup();
    await expect(
      service.send(id, { ...text('go'), wait: { mode: 'count', count: 0, timeoutMs: 10 } })
    ).rejects.toThrow();
    await expect(
      service.send(id, { ...text('go'), wait: { mode: 'idle', idleMs: Infinity, timeoutMs: 10 } })
    ).rejects.toThrow();
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects invalid UTF-8 shell bytes before a string-only PTY can corrupt them', async () => {
    const { service, transport, id } = await setup();
    await expect(service.send(id, { data: 'ff 00', encoding: 'hex', ending: 'none' })).rejects.toThrow();
    expect(transport.writes).toHaveLength(0);
    expect(await service.send(id, { data: 'e4 bd a0 00', encoding: 'hex', ending: 'none' })).toMatchObject({
      status: 'completed',
      writtenBytes: 4,
    });
  });

  it('preserves arbitrary HEX bytes on a serial connection', async () => {
    const transport = new MemoryTransport();
    const service = new TerminalConnectionService(async () => transport);
    services.push(service);
    const connection = await service.open({
      id: 'serial',
      name: 'Serial',
      kind: 'serial',
      path: 'COM1',
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      xon: false,
      xoff: false,
    });
    await service.send(connection.id, { data: 'ff 00', encoding: 'hex', ending: 'none' });
    expect(transport.writes[0]).toEqual(Buffer.from([255, 0]));
  });

  it('writes serial bytes one at a time and can change baud without reopening', async () => {
    const transport = new MemoryTransport();
    const rates: number[] = [];
    transport.setBaud = async (baudRate) => {
      rates.push(baudRate);
    };
    const service = new TerminalConnectionService(async () => transport);
    services.push(service);
    const connection = await service.open({
      id: 'serial',
      name: 'Serial',
      kind: 'serial',
      path: 'COM1',
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      rtscts: false,
      xon: false,
      xoff: false,
    });
    await service.send(connection.id, { data: '010203', encoding: 'hex', ending: 'none', slow: true });
    expect(transport.writes).toEqual([Buffer.from([1]), Buffer.from([2]), Buffer.from([3])]);
    await expect(service.setBaud(connection.id, 115200)).resolves.toMatchObject({
      profile: { baudRate: 115200 },
    });
    expect(rates).toEqual([115200]);
    await expect(
      service.send(connection.id, { data: 'A', encoding: 'utf8', ending: 'none', slow: false })
    ).resolves.toMatchObject({
      writtenBytes: 1,
    });
  });

  it('detaches listeners if a transport fails during setup', async () => {
    const transport = new MemoryTransport();
    transport.onClose = () => {
      throw new Error('registration failed');
    };
    const service = new TerminalConnectionService(async () => transport);
    services.push(service);
    await expect(service.open(profile)).rejects.toThrow('registration failed');
    expect([transport.closed, transport.dataListeners.size]).toEqual([true, 0]);
  });

  it('detaches listeners when an adapter reports closure during registration', async () => {
    const transport = new MemoryTransport();
    transport.onClose = (listener) => {
      listener('already disconnected');
      transport.closeListeners.add(listener);
      return () => transport.closeListeners.delete(listener);
    };
    const service = new TerminalConnectionService(async () => transport);
    services.push(service);
    const connection = await service.open(profile);
    expect(connection.status).toBe('closed');
    expect([transport.dataListeners.size, transport.closeListeners.size]).toEqual([0, 0]);
  });

  it('caps queued operations while a device is not accepting writes', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const queued = Array.from({ length: 64 }, () => service.send(id, text('x')));
    await expect(service.send(id, text('overflow'))).rejects.toThrow();
    service.cancel(id);
    blocked.resolve(1);
    await Promise.all(queued);
  });

  it('counts cancelled operations until native writes actually finish', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const queued = Array.from({ length: 64 }, () => service.send(id, text('x')));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    service.cancel(id);
    const overflow = service.send(id, text('overflow'));
    const outcome = await Promise.race([
      overflow.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still queued'), 10)),
    ]);
    expect(outcome).toBe('rejected');
    blocked.resolve(1);
    await Promise.all(queued);
  });

  it('rejects invalid byte counts from a broken transport', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async () => Infinity;
    expect(await service.send(id, text('x'))).toMatchObject({ status: 'failed', writtenBytes: 0 });
    expect(service.read(id).events[0]).toMatchObject({ status: 'failed', byteLength: 0 });
  });

  it('bounds retained receive data even when the target pattern never arrives', async () => {
    const { service, transport, id } = await setup();
    transport.writeImpl = async (data) => {
      transport.receive(Buffer.alloc(100_000, 65));
      return data.length;
    };
    const result = await service.send(id, {
      ...text('go'),
      wait: { mode: 'pattern', pattern: 'missing', timeoutMs: 10 },
    });
    expect(result.wait).toMatchObject({ status: 'timeout', byteLength: 65_536, truncated: true });
    expect(Buffer.from(result.wait!.data, 'base64')).toHaveLength(65_536);
  });
});

describe('temporary terminal capabilities', () => {
  it('requires an explicit takeover before manual send and interrupt while AI owns a connection', async () => {
    const { service, transport, id } = await setup();
    service.grant({ connectionId: id, conversationId: 'chat' });
    await expect(service.send(id, text('stale UI write'))).rejects.toThrow();
    await expect(service.interrupt(id)).rejects.toThrow();
    expect([transport.writes.length, transport.interrupts]).toEqual([0, 0]);
    service.takeover(id);
    await service.send(id, text('manual'));
    await service.interrupt(id);
    expect([transport.writes.length, transport.interrupts]).toEqual([1, 1]);
  });

  it('lets a read-only grant observe without taking control or writing', async () => {
    const { service, transport, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat', readOnly: true });
    const actor = { ticket, leaseId: 'lease' };
    service.claim(ticket, 'lease');
    expect(service.read(id, 0, 1024, actor).events).toBeDefined();
    await expect(service.send(id, text('ai'), actor)).rejects.toThrow();
    await service.send(id, text('manual'));
    expect([service.list()[0].owner, transport.writes.map((bytes) => bytes.toString())]).toEqual([
      'manual',
      ['manual'],
    ]);
  });

  it('rejects a read-only grant for a profile that has not been opened', async () => {
    const { service } = await setup();
    const profile = service.list()[0].profile;
    expect(() => service.grant({ profile, conversationId: 'chat', readOnly: true })).toThrow();
  });

  it('rechecks ownership before a previously queued manual write reaches the adapter', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const active = service.send(id, text('active'));
    const queued = service.send(id, text('stale'));
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    service.grant({ connectionId: id, conversationId: 'chat' });
    blocked.resolve(6);
    await active;
    expect(await queued).toMatchObject({ status: 'failed', writtenBytes: 0 });
    expect(transport.writes.map((bytes) => bytes.toString())).toEqual(['active']);
  });

  it('refuses an unclaimed ticket after five minutes and restores manual ownership', async () => {
    vi.useFakeTimers();
    const { service, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat' });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(() => service.claim(ticket, 'lease')).toThrow();
    expect(service.list()[0].owner).toBe('manual');
  });

  it('recovers grant capacity after unused tickets expire', async () => {
    vi.useFakeTimers();
    const { service, id } = await setup();
    for (let index = 0; index < 256; index++) {
      service.grant({ connectionId: id, conversationId: `chat-${index}` });
    }
    expect(() => service.grant({ connectionId: id, conversationId: 'overflow' })).toThrow();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const { ticket } = service.grant({ connectionId: id, conversationId: 'recovered' });
    expect(service.claim(ticket, 'lease').conversationId).toBe('recovered');
  });

  it('keeps a claimed ticket alive beyond the unused-grant expiry', async () => {
    vi.useFakeTimers();
    const { service, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat' });
    service.claim(ticket, 'lease');
    vi.advanceTimersByTime(10 * 60_000);
    expect(service.claim(ticket, 'lease').canWrite).toBe(true);
    expect(await service.send(id, text('live'), { ticket, leaseId: 'lease' })).toMatchObject({
      status: 'completed',
      writtenBytes: 4,
    });
  });

  it('replaces unused grants for the same chat and resource without revoking claimed grants', async () => {
    const { service, id } = await setup();
    const unused = service.grant({ connectionId: id, conversationId: 'chat' });
    const claimed = service.grant({ connectionId: id, conversationId: 'chat' });
    expect(() => service.claim(unused.ticket, 'old')).toThrow();
    service.claim(claimed.ticket, 'live');
    const replacement = service.grant({ connectionId: id, conversationId: 'chat' });
    expect(service.claim(claimed.ticket, 'live').canWrite).toBe(true);
    expect(service.claim(replacement.ticket, 'next').canWrite).toBe(true);
  });

  it('binds a random grant to its first lease and scopes listing and reads', async () => {
    const { service, id } = await setup();
    const other = await service.open({ ...profile, id: 'other' });
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat-a' });
    const actor = { ticket, leaseId: 'lease-a' };
    service.claim(ticket, actor.leaseId);
    expect(service.list(actor).map((connection) => connection.id)).toEqual([id]);
    expect(() => service.claim(ticket, 'lease-b')).toThrow();
    expect(() => service.read(other.id, 0, 10, actor)).toThrow();
    expect(() => service.claim('forged-chat-a', 'lease-a')).toThrow();
  });

  it('atomically revokes AI actions on manual takeover but preserves read access', async () => {
    const { service, transport, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat-a' });
    const actor = { ticket, leaseId: 'lease-a' };
    service.claim(ticket, actor.leaseId);
    const first = service.send(id, { ...text('go'), wait: { mode: 'count', count: 10, timeoutMs: 500 } }, actor);
    const queued = service.send(id, text('never'), actor);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    transport.receive('seen');
    service.takeover(id);
    expect(await first).toMatchObject({ status: 'taken-over', wait: { byteLength: 4 } });
    expect(await queued).toMatchObject({ status: 'taken-over', writtenBytes: 0 });
    await expect(service.interrupt(id, actor)).rejects.toThrow();
    await expect(service.close(id, actor)).rejects.toThrow();
    expect(service.read(id, 0, 100, actor).events.some((event) => event.direction === 'incoming')).toBe(true);
    expect(transport.writes).toHaveLength(1);
  });

  it('accepts a fresh user grant after takeover while the old grant remains read-only', async () => {
    const { service, transport, id } = await setup();
    const previous = service.grant({ connectionId: id, conversationId: 'chat-a' });
    service.claim(previous.ticket, 'lease-a');
    service.takeover(id);
    const next = service.grant({ connectionId: id, conversationId: 'chat-b' });
    service.claim(next.ticket, 'lease-b');
    await expect(service.send(id, text('old'), { ticket: previous.ticket, leaseId: 'lease-a' })).rejects.toThrow();
    expect(await service.send(id, text('new'), { ticket: next.ticket, leaseId: 'lease-b' })).toMatchObject({
      status: 'completed',
      writtenBytes: 3,
    });
    expect(transport.writes.map((bytes) => bytes.toString())).toEqual(['new']);
  });

  it('keeps actual in-flight bytes in history after takeover', async () => {
    const { service, transport, id } = await setup();
    const blocked = deferred<number>();
    transport.writeImpl = () => blocked.promise;
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat' });
    const actor = { ticket, leaseId: 'lease' };
    service.claim(ticket, actor.leaseId);
    const sending = service.send(id, text('sent'), actor);
    await vi.waitFor(() => expect(transport.writes).toHaveLength(1));
    service.takeover(id);
    expect(await sending).toMatchObject({ status: 'taken-over', writePending: true });
    blocked.resolve(4);
    await vi.waitFor(() => expect(service.read(id).events.some((event) => event.byteLength === 4)).toBe(true));
  });

  it('uses the immutable profile snapshot and permits only one creation per grant', async () => {
    const opened: TerminalProfile[] = [];
    const service = new TerminalConnectionService(async (value) => {
      opened.push(value);
      return new MemoryTransport();
    });
    services.push(service);
    const original = { ...profile, args: ['original'] };
    const { ticket } = service.grant({ profile: original, conversationId: 'chat-a' });
    original.args[0] = 'changed';
    const actor = { ticket, leaseId: 'lease-a' };
    service.claim(ticket, actor.leaseId);
    expect(service.list(actor)).toEqual([]);
    await expect(service.open(original, actor)).rejects.toThrow();
    const connection = await service.open({ ...profile, args: ['original'] }, actor);
    expect(opened[0].args).toEqual(['original']);
    await expect(service.open(profile, actor)).rejects.toThrow();
    expect(service.list(actor)[0].id).toBe(connection.id);
  });

  it('revokes a lease without closing manual connections', async () => {
    const { service, transport, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat' });
    service.claim(ticket, 'lease');
    service.revokeLease('lease');
    expect(() => service.read(id, 0, 10, { ticket, leaseId: 'lease' })).toThrow();
    expect(transport.closed).toBe(false);
    const second = service.grant({ connectionId: id, conversationId: 'chat' });
    service.revoke(second.ticket);
    expect(() => service.claim(second.ticket, 'another')).toThrow();
  });

  it('restores manual ownership after the final writable grant is revoked', async () => {
    const { service, id } = await setup();
    const first = service.grant({ connectionId: id, conversationId: 'one' });
    const second = service.grant({ connectionId: id, conversationId: 'two' });
    service.revoke(first.ticket);
    expect(service.list()[0].owner).toBe('ai');
    service.revoke(second.ticket);
    expect(service.list()[0].owner).toBe('manual');
  });

  it('revokes write authority on connection closure while keeping partial history readable', async () => {
    const { service, transport, id } = await setup();
    const { ticket } = service.grant({ connectionId: id, conversationId: 'chat' });
    const actor = { ticket, leaseId: 'lease' };
    service.claim(ticket, actor.leaseId);
    transport.receive('before close');
    await service.close(id);
    expect(service.claim(ticket, actor.leaseId).canWrite).toBe(false);
    expect(service.read(id, 0, 100, actor).events[0].byteLength).toBe(12);
  });

  it('limits live connections and disposes transport listeners', async () => {
    const { service, transport } = await setup({ maxConnections: 1 });
    await expect(service.open(profile)).rejects.toThrow();
    await service.dispose();
    expect([transport.closed, transport.dataListeners.size, transport.closeListeners.size]).toEqual([true, 0, 0]);
  });

  it('reserves a creation slot before awaiting the adapter', async () => {
    const ready = deferred<TerminalTransport>();
    const service = new TerminalConnectionService(() => ready.promise, { maxConnections: 1 });
    services.push(service);
    const first = service.open(profile);
    await expect(service.open(profile)).rejects.toThrow('limit');
    ready.resolve(new MemoryTransport());
    await first;
  });

  it('revokes a profile creation while its transport is opening', async () => {
    const ready = deferred<TerminalTransport>();
    const transport = new MemoryTransport();
    const service = new TerminalConnectionService(() => ready.promise);
    services.push(service);
    const { ticket } = service.grant({ profile, conversationId: 'chat' });
    service.claim(ticket, 'lease');
    const opening = service.open(profile, { ticket, leaseId: 'lease' });
    service.revokeLease('lease');
    ready.resolve(transport);
    await expect(opening).rejects.toThrow();
    expect([transport.closed, service.list().length]).toEqual([true, 0]);
  });
});
