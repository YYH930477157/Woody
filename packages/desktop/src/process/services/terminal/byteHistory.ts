import type { TerminalEvent, TerminalReadResult } from '@/common/types/terminal';
import { TERMINAL_MAX_IO_BYTES } from './serialData';

type EventMetadata = Omit<TerminalEvent, 'cursor' | 'data' | 'byteLength' | 'timestamp'> & { timestamp?: number };
type Entry = {
  start: number;
  end: number;
  rawStart: number;
  rawEnd: number;
  empty: boolean;
  removed?: boolean;
  metadata: EventMetadata;
};
export const TERMINAL_HISTORY_BYTES = 4 * 1024 * 1024;
export const TERMINAL_EMPTY_EVENT_LIMIT = 4096;
export const TERMINAL_RAW_EVENT_LIMIT = 8192;

/** Validate limits without allocating a connection's backing ring. */
export function validateHistoryCapacity(capacity = TERMINAL_HISTORY_BYTES): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64 * 1024 * 1024) {
    throw new Error('Invalid terminal history capacity');
  }
  return capacity;
}

/** A bounded raw byte/event history. Cursors belong to readers, not to the buffer. */
export class ByteHistory {
  private entries: Entry[] = [];
  private rawEntries: Entry[] = [];
  private emptyEntries: Entry[] = [];
  private first = 0;
  private rawFirst = 0;
  private emptyFirst = 0;
  private removed = 0;
  private position = 0;
  private rawPosition = 0;
  private lostBefore = 0;
  private readonly bytes: Buffer;

  constructor(private readonly capacity = TERMINAL_HISTORY_BYTES) {
    this.bytes = Buffer.alloc(validateHistoryCapacity(capacity));
  }

  /** Append a copied raw event. Empty events consume one cursor position. */
  append(data: Buffer, metadata: EventMetadata): void {
    const start = this.position;
    this.position += Math.max(1, data.length);
    this.rawPosition += data.length;
    const retained = data.subarray(Math.max(0, data.length - this.capacity));
    const rawStart = this.rawPosition - retained.length;
    if (retained.length) {
      const offset = rawStart % this.capacity;
      const firstLength = Math.min(retained.length, this.capacity - offset);
      retained.copy(this.bytes, offset, 0, firstLength);
      retained.copy(this.bytes, 0, firstLength);
    }
    const entry: Entry = {
      start: start + data.length - retained.length,
      end: this.position,
      rawStart,
      rawEnd: this.rawPosition,
      empty: !data.length,
      metadata: {
        ...metadata,
        ...(metadata.error ? { error: metadata.error.slice(0, 1024) } : {}),
        timestamp: metadata.timestamp ?? Date.now(),
      },
    };
    const last = this.entries[this.entries.length - 1];
    if (
      last &&
      !last.removed &&
      !last.empty &&
      !entry.empty &&
      entry.metadata.direction === 'incoming' &&
      last.metadata.direction === entry.metadata.direction &&
      last.metadata.source === entry.metadata.source &&
      last.metadata.timestamp === entry.metadata.timestamp &&
      last.metadata.error === entry.metadata.error &&
      last.metadata.status === entry.metadata.status
    ) {
      last.end = entry.end;
      last.rawEnd = entry.rawEnd;
    } else {
      this.entries.push(entry);
      if (entry.empty) this.emptyEntries.push(entry);
      else this.rawEntries.push(entry);
    }
    if (data.length > retained.length) this.lostBefore = Math.max(this.lostBefore, entry.start);
    this.prune();
  }

  private remove(entry: Entry): void {
    entry.removed = true;
    this.removed++;
    this.lostBefore = Math.max(this.lostBefore, entry.end);
  }

  private prune(): void {
    // Detailed packet metadata has its own hard limit; highly fragmented
    // streams may lose old events before filling the raw-byte ring.
    while (this.rawEntries.length - this.rawFirst > TERMINAL_RAW_EVENT_LIMIT) {
      this.remove(this.rawEntries[this.rawFirst++]);
    }
    const oldestRaw = Math.max(0, this.rawPosition - this.capacity);
    while (this.rawFirst < this.rawEntries.length) {
      const entry = this.rawEntries[this.rawFirst];
      if (entry.rawEnd > oldestRaw) {
        const trim = Math.max(0, oldestRaw - entry.rawStart);
        entry.rawStart += trim;
        entry.start += trim;
        if (trim) this.lostBefore = Math.max(this.lostBefore, entry.start);
        break;
      }
      this.remove(entry);
      this.rawFirst++;
    }
    while (this.emptyEntries.length - this.emptyFirst > TERMINAL_EMPTY_EVENT_LIMIT) {
      this.remove(this.emptyEntries[this.emptyFirst++]);
    }
    // Raw and empty queues can expire independently, including empty events
    // between two still-retained byte ranges.
    while (this.first < this.entries.length && this.entries[this.first].removed) this.first++;
    if (this.removed > 1024 && this.removed * 2 >= this.entries.length) {
      this.entries = this.entries.filter((entry) => !entry.removed);
      this.first = 0;
      this.removed = 0;
    }
    if (this.rawFirst > 1024 && this.rawFirst * 2 >= this.rawEntries.length) {
      this.rawEntries.splice(0, this.rawFirst);
      this.rawFirst = 0;
    }
    if (this.emptyFirst > 1024 && this.emptyFirst * 2 >= this.emptyEntries.length) {
      this.emptyEntries.splice(0, this.emptyFirst);
      this.emptyFirst = 0;
    }
  }

  /** Read at most 64 KiB without moving any other reader's cursor. */
  read(cursor = 0, maxBytes = TERMINAL_MAX_IO_BYTES): TerminalReadResult {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.position)
      throw new Error('Invalid terminal cursor');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TERMINAL_MAX_IO_BYTES) {
      throw new Error('Invalid terminal read size');
    }
    const oldest = this.entries[this.first]?.start ?? this.position;
    const lost = cursor < this.lostBefore;
    let position = Math.max(cursor, oldest);
    let remaining = maxBytes;
    const events: TerminalEvent[] = [];
    let first = this.first;
    let end = this.entries.length;
    while (first < end) {
      const middle = Math.floor((first + end) / 2);
      if (this.entries[middle].end <= position) first = middle + 1;
      else end = middle;
    }
    for (let index = first; index < this.entries.length; index++) {
      const entry = this.entries[index];
      if (entry.removed || entry.end <= position) continue;
      if (!remaining || events.length === 256) break;
      const start = Math.max(position, entry.start);
      const length = entry.empty ? 0 : Math.min(entry.end - start, remaining);
      const offset = (entry.rawStart + start - entry.start) % this.capacity;
      const firstLength = Math.min(length, this.capacity - offset);
      const data = Buffer.concat([
        this.bytes.subarray(offset, offset + firstLength),
        this.bytes.subarray(0, length - firstLength),
      ]);
      position = entry.empty ? entry.end : start + length;
      remaining -= Math.max(1, data.length);
      events.push({
        ...entry.metadata,
        timestamp: entry.metadata.timestamp!,
        cursor: position,
        data: data.toString('base64'),
        byteLength: data.length,
      });
      if (position < entry.end) break;
    }
    return { events, cursor: position, lost, more: position < this.position };
  }
}
