import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const architecture = require(path.resolve('resources/bundled-mcp/codebase-memory/architecture.cjs'));
const labels = require(path.resolve('resources/bundled-mcp/codebase-memory/architecture-labels.json')) as Record<
  string,
  Record<string, string>
>;
const { supportedLanguages } = JSON.parse(
  readFileSync('packages/desktop/src/common/config/i18n-config.json', 'utf8')
) as { supportedLanguages: string[] };
const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].toSorted();

describe('architecture file headings', () => {
  it('exist for every interface language, with the same keys and placeholders as English', () => {
    expect(Object.keys(labels).toSorted()).toEqual([...supportedLanguages].toSorted());
    const reference = labels['en-US'];
    for (const language of supportedLanguages) {
      expect(Object.keys(labels[language]).toSorted(), language).toEqual(Object.keys(reference).toSorted());
      for (const [key, text] of Object.entries(reference))
        expect(placeholders(labels[language][key]), `${language}.${key}`).toEqual(placeholders(text));
    }
  });

  it('render a complete file in every language', () => {
    const model = {
      tasks: [],
      tables: [],
      otherTables: [],
      modules: { columns: [], rows: new Map(), common: [], differs: [] },
      gaps: {
        unreadable: ['a.c'],
        demo: 1,
        entryUnknown: [{ site: 'a.c:1', expression: 'x' }],
        entryNotIndexed: [{ site: 'a.c:2', expression: 'y' }],
        entryParameter: [{ site: 'a.c:3', expression: 'z', creator: 'w' }],
        tableUnknown: [{ site: 'a.c:4', table: 't', parameter: false }],
        unreferenced: [{ site: 'a.c:5', task: 'u', creator: 'v' }],
        entriesNotIndexed: ['n'],
      },
    };
    for (const language of supportedLanguages) {
      const { text } = architecture.labelsFor(labels, language);
      const file = architecture.merge(
        undefined,
        architecture.render(model, text, { language, date: '2026-11-07', mode: 'full' }),
        text
      );
      expect(file, language).not.toMatch(/\{[a-z]+\}/i);
      expect(file, language).toContain(`language=${language}`);
    }
  });
});
