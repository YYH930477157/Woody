import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LABELLED_SELECT = /<label\b(?:(?!<\/label>)[\s\S])*?<Select\b/;

const sources = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith('.tsx') ? [file] : [];
  });

// Chromium forwards a click inside a <label> to the Select's hidden input. That second click
// closes the popup it just opened, so the Select can never be changed. jsdom cannot show this:
// it happened to the index mode and the default workspace folder while every DOM test passed.
describe('Select controls', () => {
  it('never sit inside a <label>', () => {
    const wrapped = sources(path.resolve('packages/desktop/src/renderer')).filter((file) =>
      LABELLED_SELECT.test(fs.readFileSync(file, 'utf8'))
    );
    expect(wrapped).toEqual([]);
  });

  it('recognizes the pattern across lines', () => {
    expect(`<label>\n  <span>Mode</span>\n  <Select value='a' />\n</label>`).toMatch(LABELLED_SELECT);
    expect(`<label>Mode</label>\n<Select value='a' />`).not.toMatch(LABELLED_SELECT);
  });
});
