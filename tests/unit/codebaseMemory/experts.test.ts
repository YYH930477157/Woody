import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExpertsStore } from '@process/services/codebaseMemory/experts';

const file = {
  version: 1 as const,
  experts: [{ id: 'sensor', name: 'Sensor 专家', summary: 'Sensor sampling', paths: ['sensor.c'] }],
  shared: [],
};
const looksLikeText = (bytes: Buffer) => !bytes.includes(0);
let root: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'woody-experts-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('module experts store', () => {
  const store = createExpertsStore({ canonical: (repoPath) => fs.realpathSync.native(repoPath), looksLikeText });

  it('reports no saved experts and the feature cards a project already has', () => {
    fs.mkdirSync(path.join(root, '.woody', 'features'), { recursive: true });
    for (const name of ['sensor.md', 'power-save.md', 'Notes.md', 'readme.txt']) {
      fs.writeFileSync(path.join(root, '.woody', 'features', name), '# card\n');
    }
    expect(store.read(root)).toEqual({
      file: path.join(root, '.woody', 'experts.json'),
      saved: null,
      cards: ['power-save', 'sensor'],
      business: false,
    });
  });

  it('tells whether the project has a business overview', () => {
    fs.mkdirSync(path.join(root, '.woody', 'business.md'), { recursive: true });
    // A folder with the overview's name is not an overview.
    expect(store.read(root).business).toBe(false);
    fs.rmSync(path.join(root, '.woody', 'business.md'), { recursive: true });
    fs.writeFileSync(path.join(root, '.woody', 'business.md'), '# Business overview\n');
    expect(store.read(root).business).toBe(true);
    expect(store.save(root, file).business).toBe(true);
  });

  it('saves the list as formatted JSON in .woody and reads it back', () => {
    const state = store.save(root, file);
    expect(state.saved).toEqual(file);
    const written = fs.readFileSync(path.join(root, '.woody', 'experts.json'), 'utf8');
    expect(written).toBe(`${JSON.stringify(file, null, 2)}\n`);
    expect(fs.readdirSync(path.join(root, '.woody'))).toEqual(['experts.json']);
    expect(store.read(root).saved).toEqual(file);
  });

  it('never overwrites a file it cannot read', () => {
    fs.mkdirSync(path.join(root, '.woody'));
    fs.writeFileSync(path.join(root, '.woody', 'experts.json'), '{ broken');
    expect(() => store.read(root)).toThrow('not valid JSON');
    expect(() => store.save(root, file)).toThrow('not valid JSON');
    expect(fs.readFileSync(path.join(root, '.woody', 'experts.json'), 'utf8')).toBe('{ broken');
  });

  it('refuses invalid experts before writing anything', () => {
    expect(() => store.save(root, { ...file, experts: [{ ...file.experts[0], paths: ['../x.c'] }] })).toThrow(
      'invalid paths'
    );
    expect(fs.existsSync(path.join(root, '.woody'))).toBe(false);
  });

  it('reads a file this process sees as ciphertext through the plain reader', () => {
    fs.mkdirSync(path.join(root, '.woody'));
    fs.writeFileSync(path.join(root, '.woody', 'experts.json'), Buffer.from([1, 0, 2, 0]));
    expect(() => store.read(root)).toThrow('PowerShell 7 was not found');
    const plain = createExpertsStore({
      canonical: (repoPath) => repoPath,
      looksLikeText,
      plainReader: () => Buffer.from(JSON.stringify(file)),
    });
    expect(plain.read(root).saved).toEqual(file);
    const stillCipher = createExpertsStore({
      canonical: (repoPath) => repoPath,
      looksLikeText,
      plainReader: () => Buffer.from([0]),
    });
    expect(() => stillCipher.read(root)).toThrow('also reads it as ciphertext');
  });

  it('refuses an experts file larger than the plain reader returns', () => {
    fs.mkdirSync(path.join(root, '.woody'));
    fs.writeFileSync(path.join(root, '.woody', 'experts.json'), ' '.repeat(64 * 1024 + 1));
    expect(() => store.read(root)).toThrow('larger than 64 KB');
  });
});
