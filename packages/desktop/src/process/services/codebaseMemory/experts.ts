import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isExpertId,
  MODULE_EXPERTS_FILE,
  MODULE_EXPERTS_MAX_BYTES,
  validateExpertsFile,
  type ModuleExpertsFile,
  type ModuleExpertsState,
} from '@/common/types/team/moduleExperts';

export type ExpertsStoreOptions = {
  /** Resolve the project folder the way codebase memory does (real path of an absolute directory). */
  canonical: (repoPath: string) => string;
  looksLikeText: (bytes: Buffer) => boolean;
  /** Reads a file as plain text on machines that encrypt files for processes off the whitelist. */
  plainReader?: (file: string) => Buffer;
};

/** A path inside `.woody` must stay inside the project even when a part of it is a link. */
function insideProject(root: string, target: string): string {
  for (const candidate of [path.dirname(target), target]) {
    try {
      const relative = path.relative(root, fs.realpathSync.native(candidate));
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('The experts file points outside the project');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

/**
 * The module experts of a project live in `<project>/.woody/experts.json`, next to the
 * codebase memory configuration and feature cards, so they travel with the project.
 */
export function createExpertsStore(options: ExpertsStoreOptions) {
  const fileOf = (root: string) => insideProject(root, path.join(root, '.woody', MODULE_EXPERTS_FILE));

  function readSaved(file: string): ModuleExpertsFile | null {
    let bytes: Buffer;
    try {
      if (fs.statSync(file).size > MODULE_EXPERTS_MAX_BYTES) throw new Error('The experts file is larger than 64 KB');
      bytes = fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!options.looksLikeText(bytes)) {
      if (!options.plainReader)
        throw new Error('The experts file is not readable as text, and PowerShell 7 was not found');
      bytes = options.plainReader(file);
      if (!options.looksLikeText(bytes)) {
        throw new Error('The experts file is not readable as text, and PowerShell 7 also reads it as ciphertext');
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`The experts file is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    return validateExpertsFile(parsed);
  }

  function cards(root: string): string[] {
    try {
      return fs
        .readdirSync(path.join(root, '.woody', 'features'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => entry.name.slice(0, -3))
        .filter(isExpertId)
        .toSorted();
    } catch {
      return [];
    }
  }

  return {
    read(repoPath: string): ModuleExpertsState {
      const root = options.canonical(repoPath);
      const file = fileOf(root);
      return { file, saved: readSaved(file), cards: cards(root) };
    },
    /** Replace the saved experts. A file that exists but cannot be read is never overwritten. */
    save(repoPath: string, next: ModuleExpertsFile): ModuleExpertsState {
      const root = options.canonical(repoPath);
      const file = fileOf(root);
      readSaved(file);
      const data = `${JSON.stringify(validateExpertsFile(next), null, 2)}\n`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, data, { flag: 'wx' });
        fs.renameSync(temp, file);
      } finally {
        fs.rmSync(temp, { force: true });
      }
      return { file, saved: readSaved(file), cards: cards(root) };
    },
  };
}
