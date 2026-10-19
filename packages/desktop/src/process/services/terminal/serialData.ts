import type { TerminalProfile, TerminalSendOptions, TerminalWait } from '@/common/types/terminal';

export const TERMINAL_MAX_IO_BYTES = 65_536;
export const TERMINAL_MAX_TIMEOUT_MS = 120_000;

/** Encode exactly the supplied bytes, with an explicit optional line ending. */
export function encodeTerminalData(options: Pick<TerminalSendOptions, 'data' | 'encoding' | 'ending'>): Buffer {
  if (!options || typeof options.data !== 'string' || options.data.length > TERMINAL_MAX_IO_BYTES * 4) {
    throw new Error('Invalid or oversized terminal data');
  }
  const endings = { none: '', cr: '\r', lf: '\n', crlf: '\r\n' };
  if (!Object.hasOwn(endings, options.ending)) throw new Error('Invalid line ending');
  let data: Buffer;
  if (options.encoding === 'hex') {
    const hex = options.data.replace(/\s/g, '');
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error('HEX must contain complete hexadecimal byte pairs');
    data = Buffer.from(hex, 'hex');
  } else if (options.encoding === 'utf8') {
    data = Buffer.from(options.data, 'utf8');
  } else {
    throw new Error('Invalid terminal encoding');
  }
  const result = Buffer.concat([data, Buffer.from(endings[options.ending])]);
  if (result.length > TERMINAL_MAX_IO_BYTES) throw new Error('Terminal write exceeds 64 KiB');
  return result;
}

/** Validate bounded receive conditions before starting any transport operation. */
export function validateTerminalWait(wait?: TerminalWait): { wait: TerminalWait; pattern?: Buffer } | undefined {
  if (!wait) return undefined;
  if (!Number.isInteger(wait.timeoutMs) || wait.timeoutMs < 1 || wait.timeoutMs > TERMINAL_MAX_TIMEOUT_MS) {
    throw new Error('Invalid terminal wait timeout');
  }
  const copy = { ...wait };
  if (wait.mode === 'count') {
    if (!Number.isInteger(wait.count) || wait.count < 1 || wait.count > TERMINAL_MAX_IO_BYTES) {
      throw new Error('Invalid terminal wait byte count');
    }
  } else if (wait.mode === 'idle') {
    if (!Number.isInteger(wait.idleMs) || wait.idleMs < 1 || wait.idleMs > wait.timeoutMs) {
      throw new Error('Invalid terminal idle timeout');
    }
  } else if (wait.mode === 'pattern') {
    const pattern = encodeTerminalData({
      data: wait.pattern,
      encoding: wait.patternEncoding ?? 'utf8',
      ending: 'none',
    });
    if (!pattern.length) throw new Error('Terminal wait pattern must not be empty');
    return { wait: copy, pattern };
  } else {
    throw new Error('Invalid terminal wait mode');
  }
  return { wait: copy };
}

/** Return a normalized profile copy containing configuration only. */
export function validateTerminalProfile(input: unknown): TerminalProfile {
  if (!input || typeof input !== 'object') throw new Error('Invalid terminal profile');
  const value = input as Record<string, unknown>;
  const string = (key: string, optional = false): string | undefined => {
    const field = value[key];
    if (optional && field === undefined) return undefined;
    if (typeof field !== 'string' || !field.trim() || field.length > 4096 || field.includes('\0')) {
      throw new Error(`Invalid terminal profile ${key}`);
    }
    return field;
  };
  const id = string('id')!;
  const name = string('name')!;
  if (value.kind === 'shell') {
    const executable = string('executable', true);
    const cwd = string('cwd', true);
    const args = value.args;
    if (
      args !== undefined &&
      (!Array.isArray(args) ||
        args.length > 128 ||
        args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))
    ) {
      throw new Error('Invalid shell arguments');
    }
    return {
      id,
      name,
      kind: 'shell',
      ...(executable === undefined ? {} : { executable }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(args === undefined ? {} : { args: [...(args as string[])] }),
    };
  }
  if (value.kind !== 'serial') throw new Error('Invalid terminal profile kind');
  if (
    !Number.isInteger(value.baudRate) ||
    (value.baudRate as number) < 1 ||
    (value.baudRate as number) > 12_000_000 ||
    ![5, 6, 7, 8].includes(value.dataBits as number) ||
    !['none', 'even', 'odd', 'mark', 'space'].includes(value.parity as string) ||
    ![1, 1.5, 2].includes(value.stopBits as number) ||
    ['rtscts', 'xon', 'xoff'].some((key) => typeof value[key] !== 'boolean')
  ) {
    throw new Error('Invalid serial configuration');
  }
  return {
    id,
    name,
    kind: 'serial',
    path: string('path')!,
    baudRate: value.baudRate as number,
    dataBits: value.dataBits as 5 | 6 | 7 | 8,
    parity: value.parity as 'none' | 'even' | 'odd' | 'mark' | 'space',
    stopBits: value.stopBits as 1 | 1.5 | 2,
    rtscts: value.rtscts as boolean,
    xon: value.xon as boolean,
    xoff: value.xoff as boolean,
  };
}
