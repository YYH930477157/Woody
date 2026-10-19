import { describe, expect, it } from 'vitest';
import { ByteHistory } from '@/process/services/terminal/byteHistory';
import { encodeTerminalData, validateTerminalProfile } from '@/process/services/terminal/serialData';

describe('ByteHistory', () => {
  it('keeps independent byte cursors when a single event exceeds a read', () => {
    const history = new ByteHistory(200_000);
    history.append(Buffer.alloc(100_000, 65), { direction: 'incoming', source: 'transport' });
    const first = history.read();
    const second = history.read(first.cursor);
    expect(Buffer.from(first.events[0].data, 'base64').length).toBe(65_536);
    expect([second.cursor, second.more, history.read().cursor]).toEqual([100_000, false, 65_536]);
  });

  it('retains the newest bytes and marks a stale cursor lost', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('abcdefgh'), { direction: 'incoming', source: 'transport' });
    expect(history.read(0)).toMatchObject({ cursor: 8, lost: true, more: false });
    expect(Buffer.from(history.read(0).events[0].data, 'base64').toString()).toBe('defgh');
  });

  it('preserves all retained raw bytes when transport output is highly fragmented', () => {
    const history = new ByteHistory(10_000);
    for (let index = 0; index < 5000; index++) {
      history.append(Buffer.from([index % 256]), {
        direction: 'incoming',
        source: 'transport',
        timestamp: index,
      });
    }
    let cursor = 0;
    const chunks: Buffer[] = [];
    let lost = false;
    do {
      const read = history.read(cursor);
      chunks.push(...read.events.map((event) => Buffer.from(event.data, 'base64')));
      cursor = read.cursor;
      lost ||= read.lost;
      if (!read.more) break;
    } while (cursor < 5000);
    expect([lost, Buffer.concat(chunks).length]).toEqual([false, 5000]);
    expect(Buffer.concat(chunks)[4999]).toBe(4999 % 256);
  });

  it('preserves timestamps across wrapped raw storage', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('abc'), { direction: 'incoming', source: 'transport', timestamp: 1 });
    history.append(Buffer.from('defg'), { direction: 'incoming', source: 'transport', timestamp: 2 });
    expect(
      history.read().events.map((event) => [event.timestamp, Buffer.from(event.data, 'base64').toString()])
    ).toEqual([
      [1, 'c'],
      [2, 'defg'],
    ]);
  });

  it('does not evict raw bytes when zero-byte events are recorded', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('abcde'), { direction: 'incoming', source: 'transport' });
    for (let index = 0; index < 10; index++) {
      history.append(Buffer.alloc(0), { direction: 'outgoing', source: 'ai', status: 'failed' });
    }
    const read = history.read();
    expect(Buffer.from(read.events[0].data, 'base64').toString()).toBe('abcde');
    expect([read.lost, read.cursor, read.events.length]).toEqual([false, 15, 11]);
  });

  it('paginates raw and empty events with distinct advancing cursors', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('abcde'), { direction: 'incoming', source: 'transport', timestamp: 1 });
    history.append(Buffer.alloc(0), { direction: 'system', source: 'transport', timestamp: 2 });
    history.append(Buffer.alloc(0), { direction: 'system', source: 'transport', timestamp: 3 });
    const first = history.read(0, 5);
    const second = history.read(first.cursor, 1);
    const third = history.read(second.cursor, 1);
    expect([first.cursor, second.cursor, third.cursor, third.more]).toEqual([5, 6, 7, false]);
    expect([first.lost, second.lost, third.lost]).toEqual([false, false, false]);
  });

  it('bounds empty metadata separately while preserving the full raw ring', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('abcde'), { direction: 'incoming', source: 'transport', timestamp: 1 });
    for (let index = 0; index < 5000; index++) {
      history.append(Buffer.alloc(0), { direction: 'system', source: 'transport', timestamp: index + 2 });
    }
    let cursor = 0;
    let emptyCount = 0;
    const raw: Buffer[] = [];
    do {
      const read = history.read(cursor);
      emptyCount += read.events.filter((event) => !event.byteLength).length;
      raw.push(...read.events.filter((event) => event.byteLength).map((event) => Buffer.from(event.data, 'base64')));
      expect(read.cursor).toBeGreaterThan(cursor);
      cursor = read.cursor;
      if (!read.more) break;
    } while (cursor < 5005);
    expect(Buffer.concat(raw).toString()).toBe('abcde');
    expect([emptyCount, cursor]).toEqual([4096, 5005]);
  });

  it('maps wrapped bytes correctly when empty events separate raw ranges', () => {
    const history = new ByteHistory(5);
    history.append(Buffer.from('ab'), { direction: 'incoming', source: 'transport' });
    history.append(Buffer.alloc(0), { direction: 'system', source: 'transport' });
    history.append(Buffer.from('cde'), { direction: 'incoming', source: 'transport' });
    history.append(Buffer.alloc(0), { direction: 'system', source: 'transport' });
    history.append(Buffer.from('f'), { direction: 'incoming', source: 'transport' });
    const read = history.read();
    expect(Buffer.concat(read.events.map((event) => Buffer.from(event.data, 'base64'))).toString()).toBe('bcdef');
    expect(read.events.map((event) => event.cursor)).toEqual([2, 3, 6, 7, 8]);
    expect(read.lost).toBe(true);
  });

  it('bounds detailed metadata for a long stream of distinct single-byte events', () => {
    const history = new ByteHistory();
    for (let index = 0; index < 100_000; index++) {
      history.append(Buffer.from([index % 256]), {
        direction: 'incoming',
        source: 'transport',
        timestamp: index,
      });
    }
    let cursor = 0;
    let retainedBytes = 0;
    let lost = false;
    do {
      const read = history.read(cursor);
      retainedBytes += read.events.reduce((total, event) => total + event.byteLength, 0);
      lost ||= read.lost;
      cursor = read.cursor;
      if (!read.more) break;
    } while (cursor < 100_000);
    expect(lost).toBe(true);
    expect(retainedBytes).toBe(8192);
    expect(cursor).toBe(100_000);
  });

  it('copies buffers and records failed zero-byte writes as events', () => {
    const history = new ByteHistory();
    const bytes = Buffer.from('hi');
    history.append(bytes, { direction: 'outgoing', source: 'ai', status: 'completed' });
    bytes.fill(0);
    history.append(Buffer.alloc(0), { direction: 'outgoing', source: 'ai', status: 'failed', error: 'lost' });
    expect(history.read().events.map((event) => [event.byteLength, event.status])).toEqual([
      [2, 'completed'],
      [0, 'failed'],
    ]);
    expect(Buffer.from(history.read().events[0].data, 'base64').toString()).toBe('hi');
  });

  it('rejects unsafe capacities, cursors, and read sizes', () => {
    expect(() => new ByteHistory(Infinity)).toThrow();
    expect(() => new ByteHistory(0)).toThrow();
    expect(() => new ByteHistory().read(-1)).toThrow();
    expect(() => new ByteHistory().read(0, 1e12)).toThrow();
  });
});

describe('terminal data validation', () => {
  it('accepts strict hex whitespace and explicit text endings', () => {
    expect(encodeTerminalData({ data: '00 ff\nA1', encoding: 'hex', ending: 'crlf' })).toEqual(
      Buffer.from([0, 255, 161, 13, 10])
    );
    expect(encodeTerminalData({ data: '你好', encoding: 'utf8', ending: 'lf' }).toString()).toBe('你好\n');
  });

  it.each(['f', '0xFF', 'ff:00', 'gg', '12-34'])('rejects malformed hex %s', (data) => {
    expect(() => encodeTerminalData({ data, encoding: 'hex', ending: 'none' })).toThrow();
  });

  it('rejects unknown endings, oversized writes, and invalid serial profiles', () => {
    expect(() => encodeTerminalData({ data: '', encoding: 'hex', ending: 'invalid' as 'none' })).toThrow();
    expect(() => encodeTerminalData({ data: 'x'.repeat(65_537), encoding: 'utf8', ending: 'none' })).toThrow();
    expect(() => validateTerminalProfile({ id: 'bad', name: 'bad', kind: 'serial', baudRate: 0 })).toThrow();
  });
});
