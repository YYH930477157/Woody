import parse from './vendor';

export type MiValue = string | MiValue[] | { [key: string]: MiValue };
export type MiFields = { [key: string]: MiValue };
export type MiRecord = { token?: number; kind: string; class: string; data: MiFields; text?: string };

/** Bound malformed debugger output before passing it to the upstream MI grammar. */
export function parseRecord(line: string): MiRecord | undefined {
  if (line.length > 262144) throw new Error('gdb.outputLimit');
  const header = /^(\d*)([\^*+=~@&])/.exec(line);
  if (!header) return undefined;
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];
  for (const char of line.slice(header[0].length)) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      stack.push(char);
      if (stack.length > 32) throw new Error('gdb.outputLimit');
    } else if (char === ']' || char === '}') {
      if (stack.pop() !== (char === ']' ? '[' : '{')) throw new Error('gdb.protocolError');
    }
  }
  if (quoted || stack.length) throw new Error('gdb.protocolError');
  const parsed = parse(line);
  const record = parsed.resultRecord ?? parsed.outOfBandRecords[0];
  if (!record) throw new Error('gdb.protocolError');
  return {
    token: header[1] ? Number(header[1]) : undefined,
    kind: header[2],
    class: record.class,
    data: typeof record.result === 'object' && record.result ? (record.result as MiFields) : {},
    ...(typeof record.result === 'string' ? { text: record.result } : {}),
  };
}

/** Quote one MI argument; never accept command delimiters from IPC or MCP. */
export function quoteMi(value: string): string {
  if (value.length > 8192 || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error('gdb.invalidInput');
  return JSON.stringify(value);
}

/** A read-only C/C++ variable path, deliberately excluding calls and operators. */
export function readPath(value: string): string {
  const text = value.trim();
  if (text.length > 512 || !/^[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.|->)[A-Za-z_][A-Za-z0-9_]*|\[\d{1,8}\])*$/.test(text))
    throw new Error('gdb.invalidExpression');
  return text;
}

export function fields(value: MiValue | undefined): MiFields {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function textField(value: MiValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
