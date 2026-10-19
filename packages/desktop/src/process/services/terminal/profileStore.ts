import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TerminalProfile } from '@/common/types/terminal';
import { validateTerminalProfile } from './serialData';

type ProfileDocument = { version: 1; profiles: TerminalProfile[]; [key: string]: unknown };

/** Configuration-only store: loading profiles never opens or replays connections. */
export class TerminalProfileStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<ProfileDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, profiles: [] };
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid terminal profile document');
    const document = value as Record<string, unknown>;
    if (document.version !== 1 || !Array.isArray(document.profiles) || document.profiles.length > 256) {
      throw new Error('Unsupported terminal profile document');
    }
    const profiles = document.profiles.map(validateTerminalProfile);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
      throw new Error('Duplicate profile ids');
    return { ...document, version: 1, profiles };
  }

  /** List validated, independently copied configuration records. */
  async list(): Promise<TerminalProfile[]> {
    await this.tail;
    return (await this.load()).profiles;
  }

  private mutate(change: (document: ProfileDocument) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      const document = await this.load();
      change(document);
      if (document.profiles.length > 256) throw new Error('Too many terminal profiles');
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, this.filePath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.tail = operation.catch((): void => undefined);
    return operation;
  }

  /** Add or replace one profile while preserving unrelated document fields. */
  async upsert(profile: TerminalProfile): Promise<TerminalProfile> {
    const normalized = validateTerminalProfile(profile);
    await this.mutate((document) => {
      const index = document.profiles.findIndex((value) => value.id === normalized.id);
      if (index === -1) document.profiles.push(normalized);
      else document.profiles[index] = normalized;
    });
    return validateTerminalProfile(normalized);
  }

  /** Remove configuration only; an already open connection is unaffected. */
  async remove(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Invalid terminal profile id');
    await this.mutate((document) => {
      document.profiles = document.profiles.filter((profile) => profile.id !== id);
    });
  }
}
