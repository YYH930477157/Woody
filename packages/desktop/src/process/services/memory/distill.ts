import type { MemoryInput, MemoryType } from '@/common/types/memory';
import { MEMORY_TYPES } from './store';

/**
 * Distilling: Woody asks the agent, in a hidden message inside the conversation it just
 * had, which durable facts to keep. The answer must be JSON; anything else is ignored,
 * so a weak model that cannot follow the format writes nothing rather than noise.
 */

export const MAX_NEW_MEMORIES = 5;

export function distillPrompt(index: string): string {
  return [
    'Woody is updating the long-term memory of this project. This request is automatic and hidden from the user; do not answer it as a chat message.',
    'Read the conversation above and decide what is worth keeping for future conversations in this project.',
    '',
    'Keep only durable information:',
    '- user: who the user is, their role, expertise and preferences.',
    '- feedback: corrections the user made and ways of working they confirmed, with the reason.',
    '- project: decisions, constraints and context that the code and its history do not show.',
    '- reference: where to find things outside the code (documents, tools, people to ask).',
    'Do not keep: what the code, Git history or project documents already record; details of this one task; temporary state; passwords, keys or other secrets.',
    '',
    'Existing memories (MEMORY.md):',
    index.trim() || '(none yet)',
    '',
    'When a fact belongs to an existing memory, update that file instead of adding a new one, and keep what it already says that is still true.',
    'Write name, description and body in the language the user writes in. The body is a few short sentences or bullet points; for feedback and project, add why it matters.',
    '',
    `Reply with JSON only, no other text. At most ${MAX_NEW_MEMORIES} new memories:`,
    '{"memories":[{"action":"add","file":"short-ascii-words","type":"feedback","name":"…","description":"one line","body":"…"},{"action":"update","file":"existing-file.md","type":"project","name":"…","description":"…","body":"…"}]}',
    'Reply {"memories":[]} when nothing is worth keeping.',
  ].join('\n');
}

export type DistilledMemory = MemoryInput & { action: 'add' | 'update'; slug?: string };

/** The valid entries of the answer; throws when it is not the JSON object asked for. */
export function parseDistilled(answer: string, existingFiles: ReadonlySet<string>): DistilledMemory[] {
  const text = answer
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The memory answer is not JSON');
  const value = JSON.parse(text.slice(start, end + 1)) as { memories?: unknown };
  if (!value || !Array.isArray(value.memories)) throw new Error('The memory answer has no memories list');
  const result: DistilledMemory[] = [];
  let added = 0;
  for (const item of value.memories as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const body = typeof item.body === 'string' ? item.body.trim() : '';
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const type = MEMORY_TYPES.find((entry) => entry === item.type) as MemoryType | undefined;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    if (!name || !body || !type) continue;
    if (item.action === 'update' && existingFiles.has(file)) {
      result.push({ action: 'update', file, name, description, type, body });
    } else if (added < MAX_NEW_MEMORIES) {
      added++;
      result.push({ action: 'add', slug: file.replace(/\.md$/i, ''), name, description, type, body });
    }
  }
  return result;
}
