import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@/common/types/memory';
import { parseDistilled } from '@process/services/memory/distill';
import { rank, recallBlock, selectRecall, tokenize } from '@process/services/memory/search';
import { parseMemoryBlock } from '@/renderer/pages/conversation/Messages/components/sessionMarkers';

const entry = (file: string, name: string, body: string, description = ''): MemoryEntry => ({
  file,
  name,
  description,
  type: 'project',
  body,
  updatedAt: 0,
});
const memories = [
  entry(
    'alarm.md',
    '报警参数存放',
    '过流报警阈值 AlarmPara 存在 EEPROM，ALARM_PARA_ADDR 定义在 alarm.c。',
    '报警阈值在哪'
  ),
  entry('build.md', 'CMake 构建', '用 ninja 构建，MinGW 不认中文路径。'),
  entry('style.md', '回复风格', '用户希望回答简短，先给结论。', '用户偏好'),
];

describe('memory search', () => {
  it('splits Chinese into character pairs and code identifiers into words', () => {
    expect(tokenize('报警阈值')).toEqual(['报警', '警阈', '阈值']);
    expect(tokenize('ALARM_SecondProc')).toEqual(['alarm', 'second', 'proc', 'alarm_secondproc']);
    expect(tokenize('getHTTPServer')).toEqual(['get', 'http', 'server', 'gethttpserver']);
    // Common words carry no meaning on their own.
    expect(tokenize('我们可以这个')).toEqual(['们可', '以这']);
  });

  it('finds the memory a Chinese question is about', () => {
    expect(rank(memories, '过流报警的阈值存在哪里？')[0].entry.file).toBe('alarm.md');
    expect(rank(memories, 'ALARM_PARA_ADDR')[0].entry.file).toBe('alarm.md');
    expect(rank(memories, '中文路径编译失败')[0].entry.file).toBe('build.md');
    expect(rank(memories, 'unrelated words')).toEqual([]);
  });

  it('recalls at most three related memories, once per conversation', () => {
    expect(selectRecall(memories, '报警阈值怎么改', new Set()).map((item) => item.file)).toEqual(['alarm.md']);
    expect(selectRecall(memories, '报警阈值怎么改', new Set(['alarm.md']))).toEqual([]);
    // One shared term is not enough for a longer message.
    expect(selectRecall(memories, '今天天气报警', new Set())).toEqual([]);
  });

  it('formats a bounded block that the chat view can remove and name', () => {
    const long = entry('long.md', 'Long', 'x'.repeat(5000));
    const block = recallBlock([memories[0], long]);
    expect(block.startsWith('[[WOODY_MEMORY]]\n')).toBe(true);
    expect(block.endsWith('[[/WOODY_MEMORY]]')).toBe(true);
    expect(block.length).toBeLessThan(2600);
    expect(recallBlock([])).toBe('');
    expect(parseMemoryBlock(`改一下阈值\n\n${block}`)).toEqual({
      text: '改一下阈值',
      memories: ['报警参数存放', 'Long'],
    });
  });
});

const added = (index: number) =>
  `{"action":"add","file":"m-${index}","type":"user","name":"n${index}","description":"d","body":"b"}`;

describe('distilled answers', () => {
  const existing = new Set(['alarm.md']);
  it('accept fenced JSON, turn an update of an unknown file into an add, and cap new ones at five', () => {
    const answer = `\`\`\`json\n{"memories":[${[1, 2, 3, 4, 5, 6].map(added).join(',')},
      {"action":"update","file":"alarm.md","type":"project","name":"报警","description":"d","body":"新内容"},
      {"action":"update","file":"missing.md","type":"project","name":"x","description":"","body":"y"},
      {"action":"add","type":"opinion","name":"bad type","body":"z"},
      {"action":"add","type":"user","name":"","body":"no name"}]}\n\`\`\``;
    const parsed = parseDistilled(answer, existing);
    expect(parsed.filter((memory) => memory.action === 'add')).toHaveLength(5);
    expect(parsed.find((memory) => memory.action === 'update')).toMatchObject({ file: 'alarm.md', body: '新内容' });
    expect(parsed.some((memory) => memory.name === 'x')).toBe(false);
  });

  it('reject anything that is not the JSON asked for', () => {
    expect(() => parseDistilled('I could not find anything.', existing)).toThrow(/not JSON/);
    expect(() => parseDistilled('{"items":[]}', existing)).toThrow(/no memories list/);
    expect(parseDistilled('Here you go: {"memories":[]}', existing)).toEqual([]);
  });
});
