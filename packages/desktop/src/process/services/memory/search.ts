import { WOODY_MEMORY_END_MARKER, WOODY_MEMORY_MARKER } from '@/common/config/constants';
import type { MemoryEntry } from '@/common/types/memory';

/**
 * Ranking for a few hundred small memory files, rebuilt per query: BM25 over tokens
 * that work for Chinese without a dictionary (pairs of adjacent Han characters) and
 * for code (identifiers split at `_` and camel case).
 */

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'are',
  'was',
  'not',
  'you',
  'can',
  'how',
  'what',
  'why',
  'from',
  'into',
  '我们',
  '你们',
  '这个',
  '那个',
  '一个',
  '可以',
  '什么',
  '怎么',
  '没有',
  '就是',
  '因为',
  '所以',
  '如果',
  '但是',
  '现在',
  '一下',
  '是不',
  '不是',
]);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const push = (token: string) => {
    if (token.length >= 2 && !STOP.has(token)) tokens.push(token);
  };
  for (const match of text.matchAll(/\p{Script=Han}+|[A-Za-z0-9_]+|[\p{L}\p{N}]+/gu)) {
    const run = match[0];
    if (/^\p{Script=Han}/u.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) tokens.push(run);
      for (let index = 0; index + 1 < chars.length; index++) push(chars[index] + chars[index + 1]);
    } else if (/^[A-Za-z0-9_]+$/.test(run)) {
      const parts = run
        .split('_')
        .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
        .map((part) => part.toLowerCase())
        .filter(Boolean);
      parts.forEach(push);
      if (parts.length > 1) push(run.toLowerCase());
    } else push(run.toLowerCase());
  }
  return tokens;
}

export type Ranked = { entry: MemoryEntry; score: number; matched: number };

const K1 = 1.2;
const B = 0.75;
/** Name and description describe the memory; their words count twice. */
const TITLE_WEIGHT = 2;

export function rank(entries: MemoryEntry[], query: string): Ranked[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !entries.length) return [];
  const documents = entries.map((entry) => {
    const counts = new Map<string, number>();
    for (const token of tokenize(`${entry.name} ${entry.description}`))
      counts.set(token, (counts.get(token) ?? 0) + TITLE_WEIGHT);
    for (const token of tokenize(entry.body)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let length = 0;
    for (const count of counts.values()) length += count;
    return { entry, counts, length };
  });
  const average = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const frequency = new Map(
    terms.map((term) => [term, documents.filter((document) => document.counts.has(term)).length])
  );
  const ranked: Ranked[] = [];
  for (const document of documents) {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const tf = document.counts.get(term);
      if (!tf) continue;
      matched++;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * document.length) / average));
    }
    if (matched) ranked.push({ entry: document.entry, score, matched });
  }
  return ranked.toSorted((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
}

const RECALL_LIMIT = 3;
const RECALL_BUDGET = 2000;

/**
 * The memories worth adding to a message: at most three, about 2,000 characters in all,
 * each sharing at least two terms with it (one when the message is that short), and
 * none the conversation has already been given.
 */
export function selectRecall(entries: MemoryEntry[], text: string, alreadyGiven: ReadonlySet<string>): MemoryEntry[] {
  const needed = tokenize(text).length <= 2 ? 1 : 2;
  return rank(entries, text)
    .filter((item) => item.matched >= needed && !alreadyGiven.has(item.entry.file))
    .slice(0, RECALL_LIMIT)
    .map((item) => item.entry);
}

export function recallBlock(entries: MemoryEntry[]): string {
  if (!entries.length) return '';
  const share = Math.floor(RECALL_BUDGET / entries.length);
  const sections = entries.map((entry) => {
    const heading = `### ${entry.name}${entry.type ? ` (${entry.type})` : ''} — ${entry.file}`;
    const room = Math.max(200, share - heading.length);
    const body = entry.body.length > room ? `${entry.body.slice(0, room).trimEnd()}…` : entry.body;
    return `${heading}\n${body}`;
  });
  return [
    WOODY_MEMORY_MARKER,
    'Saved notes from earlier conversations in this project that may be relevant. Use them only where they apply; the message above comes first. The full files are in the memory folder.',
    '',
    sections.join('\n\n'),
    WOODY_MEMORY_END_MARKER,
  ].join('\n');
}
