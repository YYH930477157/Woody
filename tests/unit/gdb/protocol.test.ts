import { describe, expect, it } from 'vitest';
import { parseRecord, quoteMi, readPath } from '@/process/services/cmake/gdb/protocol';

describe('GDB MI protocol', () => {
  it('parses tokenized results and nested breakpoint records', () => {
    const record = parseRecord('42^done,bkpt={number="1",addr="0x123",fullname="C:\\\\src\\\\main.c",line="12"}');
    expect(record?.token).toBe(42);
    expect(record?.data.bkpt).toEqual({ number: '1', addr: '0x123', fullname: 'C:\\src\\main.c', line: '12' });
  });
  it('preserves stream whitespace and escaped backslashes', () => {
    expect(parseRecord('~"  C:\\\\new\\n"')?.text).toBe('  C:\\new\n');
    expect(parseRecord('~"\\344\\270\\255"')?.text).toBe('中');
  });
  it('handles async stop and repeated list labels', () => {
    expect(parseRecord('*stopped,reason="breakpoint-hit",frame={func="main"}')?.kind).toBe('*');
    expect(parseRecord('1^done,stack=[frame={level="0"},frame={level="1"}]')?.data.stack).toEqual([
      { level: '0' },
      { level: '1' },
    ]);
  });
  it('rejects oversized and malformed records without hanging', () => {
    expect(() => parseRecord('1^done,value="unfinished')).toThrow();
    expect(() => parseRecord('~"' + 'a'.repeat(262144) + '"')).toThrow();
    expect(parseRecord('(gdb)')).toBeUndefined();
  });
  it('quotes arguments without permitting MI command injection', () => {
    expect(quoteMi('C:\\folder name\\x.exe')).toBe('"C:\\\\folder name\\\\x.exe"');
    expect(() => quoteMi('x\n-exec-run')).toThrow();
  });
  it('limits inspection to variable paths without function calls or assignments', () => {
    expect(readPath('meter.state[2].value')).toBe('meter.state[2].value');
    expect(readPath('meter->status')).toBe('meter->status');
    for (const value of ['foo()', 'x=2', 'x++', 'foo[bar()]', '$_shell("cmd")', 'a;quit'])
      expect(() => readPath(value)).toThrow();
  });
});
