import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '@/common/config/i18n-config.json';

const renderer = path.resolve('packages/desktop/src/renderer');
const locales = path.join(renderer, 'services/i18n/locales');
const featureDirectories = ['pages/conversation/SourceControl', 'components/workspace'];

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });

// Keys chosen by a ternary never reach the `t('...')` pattern scripts/check-i18n.js looks for.
const usedKeys = [
  ...new Set(
    featureDirectories
      .flatMap((directory) => sourceFiles(path.join(renderer, directory)))
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/['"`]((?:common|conversation)\.[\w.]+)['"`]/g)])
      .map((match) => match[1])
  ),
];

const lookup = (locale: string, key: string): unknown => {
  const [module, ...rest] = key.split('.');
  const messages: unknown = JSON.parse(readFileSync(path.join(locales, locale, `${module}.json`), 'utf8'));
  return rest.reduce<unknown>(
    (node, part) => (typeof node === 'object' && node ? (node as Record<string, unknown>)[part] : undefined),
    messages
  );
};

describe('translation keys of the Git workbench and workspace manager', () => {
  it('finds the keys it is meant to check', () => {
    expect(usedKeys.length).toBeGreaterThan(150);
  });

  it.each(config.supportedLanguages)('all exist in %s', (locale) => {
    expect(usedKeys.filter((key) => typeof lookup(locale, key) !== 'string')).toEqual([]);
  });
});
