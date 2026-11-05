import { read, utils } from 'xlsx-republish';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_ACCOUNTS = 10_000;
export type ImportedCredential = { name: string; origin: string; username: string; password: string };

/** Credentials are scoped to the exact HTTP(S) origin, including scheme and port. */
export function websiteOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Parse Chrome CSV without interpreting numeric or formula-like password strings. */
export function parseChromeCsv(csv: string): { entries: ImportedCredential[]; skipped: number } {
  if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) throw new Error('WEBSITE_PASSWORDS_TOO_LARGE');
  let rows: string[][];
  try {
    const workbook = read(csv.replace(/^\uFEFF/, ''), { type: 'string', raw: true, FS: ',' });
    rows = utils.sheet_to_json<string[]>(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: false,
    });
  } catch {
    throw new Error('WEBSITE_PASSWORDS_INVALID_CSV');
  }
  const headers = (rows.shift() ?? []).map((value) => String(value).trim().toLowerCase());
  if (!['url', 'username', 'password'].every((header) => headers.includes(header))) {
    throw new Error('WEBSITE_PASSWORDS_INVALID_CSV');
  }
  if (rows.length > MAX_ACCOUNTS) throw new Error('WEBSITE_PASSWORDS_LIMIT');
  const entries: ImportedCredential[] = [];
  let skipped = 0;
  for (const row of rows) {
    const cell = (name: string): string => String(row[headers.indexOf(name)] ?? '');
    const origin = websiteOrigin(cell('url'));
    const username = cell('username');
    const password = cell('password');
    if (!origin || !username || !password) {
      skipped++;
      continue;
    }
    entries.push({ name: cell('name') || new URL(origin).hostname, origin, username, password });
  }
  return { entries, skipped };
}
