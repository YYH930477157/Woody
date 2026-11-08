import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkFileName,
  listMemories,
  parseMemory,
  removeMemory,
  saveMemory,
  serializeMemory,
} from '@process/services/memory/store';

let directory: string;
beforeEach(() => {
  directory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'woody-memory-')), 'memory');
});
afterEach(() => {
  fs.rmSync(path.dirname(directory), { recursive: true, force: true });
});
const read = (file: string) => fs.readFileSync(path.join(directory, file), 'utf8');

describe('memory files', () => {
  it('read the frontmatter aionrs and agents write, leniently', () => {
    expect(
      parseMemory('---\nname: CMake 构建\ndescription: "how: it builds"\ntype: project\n---\n\nUse ninja.\n')
    ).toEqual({
      name: 'CMake 构建',
      description: 'how: it builds',
      type: 'project',
      body: 'Use ninja.',
    });
    // CRLF, single quotes, `type` nested under metadata, unknown type.
    expect(parseMemory("---\r\nname: 'It''s fine'\r\nmetadata:\r\n  type: feedback\r\n---\r\nBody\r\n")).toMatchObject({
      name: "It's fine",
      type: 'feedback',
      body: 'Body',
    });
    expect(parseMemory('---\nname: x\ntype: other\n---\nBody').type).toBeUndefined();
    expect(parseMemory('Just text')).toEqual({ body: 'Just text' });
  });

  it('write frontmatter that reads back the same', () => {
    const entry = { name: '报警参数: 存在 EEPROM', description: 'yes', type: 'project' as const, body: 'Body\n' };
    const text = serializeMemory(entry);
    expect(text).toBe('---\nname: "报警参数: 存在 EEPROM"\ndescription: "yes"\ntype: project\n---\n\nBody\n');
    expect(parseMemory(text)).toEqual({ ...entry, body: 'Body' });
    expect(serializeMemory({ name: '报警参数', description: '一句话', body: 'b' })).toContain('name: 报警参数\n');
  });

  it('add a memory with its MEMORY.md line, keeping the lines the agent wrote', async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'MEMORY.md'), '- [Old](old.md) — kept\r\n\r\n');
    const saved = await saveMemory(
      directory,
      { name: '报警阈值', description: '过流阈值存在 EEPROM', type: 'project', body: '在 parameter.c' },
      'alarm-threshold'
    );
    expect(saved).toMatchObject({ file: 'alarm-threshold.md', name: '报警阈值', type: 'project' });
    expect(read('MEMORY.md')).toBe(
      '- [Old](old.md) — kept\r\n- [报警阈值](alarm-threshold.md) — 过流阈值存在 EEPROM\r\n'
    );
    // The same slug again gets a new file, never overwriting the first.
    const second = await saveMemory(directory, { name: 'Other', description: '', body: 'x' }, 'alarm-threshold');
    expect(second.file).toBe('alarm-threshold-2.md');
    // A Chinese name without a slug still gets an ASCII file name.
    expect((await saveMemory(directory, { name: '中文名', description: '', body: 'y' })).file).toMatch(
      /^memory-.+\.md$/
    );
  });

  it('update a memory in place and replace its line', async () => {
    await saveMemory(directory, { name: 'A', description: 'one', type: 'user', body: 'first' }, 'a-memory');
    await saveMemory(directory, { file: 'a-memory.md', name: 'A2', description: 'two', type: 'user', body: 'second' });
    expect(parseMemory(read('a-memory.md'))).toMatchObject({ name: 'A2', body: 'second' });
    expect(read('MEMORY.md')).toBe('- [A2](a-memory.md) — two\n');
  });

  it('list memories without MEMORY.md, newest first', async () => {
    await saveMemory(directory, { name: 'First', description: '', body: 'one' }, 'first');
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not a memory');
    fs.writeFileSync(path.join(directory, 'second.md'), 'No frontmatter at all');
    fs.utimesSync(path.join(directory, 'second.md'), new Date(), new Date(Date.now() + 60_000));
    const entries = await listMemories(directory);
    expect(entries.map((entry) => [entry.file, entry.name])).toEqual([
      ['second.md', 'second'],
      ['first.md', 'First'],
    ]);
    expect(await listMemories(path.join(directory, 'missing'))).toEqual([]);
  });

  it('remove a memory through the recycle bin and drop its line', async () => {
    await saveMemory(directory, { name: 'Gone', description: '', body: 'x' }, 'gone');
    await saveMemory(directory, { name: 'Kept', description: '', body: 'y' }, 'kept');
    const trash = vi.fn(async (target: string) => fs.rmSync(target));
    await removeMemory(directory, 'gone.md', trash);
    expect(trash).toHaveBeenCalledWith(path.join(directory, 'gone.md'));
    expect(read('MEMORY.md')).toBe('- [Kept](kept.md)\n');
    for (const bad of ['../x.md', 'MEMORY.md', 'a/b.md', 'x.txt', 'C:\\x.md'])
      expect(() => checkFileName(bad), bad).toThrow(/Not a memory file/);
  });
});
