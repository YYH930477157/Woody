import path from 'node:path';

/**
 * The folder aionrs keeps a workspace's memories in. Woody must land on exactly the
 * same folder, so this mirrors aion-memory's `auto_memory_dir`:
 * `<base>/projects/<sanitized workspace>/memory`, where the base is AIONRS_MEMORY_DIR
 * or the platform config folder plus `aionrs`.
 */
export function memoryDirectory(workspace: string, appData: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.AIONRS_MEMORY_DIR ? env.AIONRS_MEMORY_DIR : path.join(appData, 'aionrs');
  return path.join(base, 'projects', sanitizeWorkspace(workspace), 'memory');
}

const MAX_SANITIZED_LENGTH = 200;

/** aion-memory's `sanitize_path`: every character but ASCII letters and digits becomes `-`. */
export function sanitizeWorkspace(workspace: string): string {
  const sanitized = Array.from(workspace, (char) => (/^[A-Za-z0-9]$/.test(char) ? char : '-')).join('');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${rustStrHash(workspace)}`;
}

// BigInt() calls, not literals: the project compiles for ES6.
const big = (value: number | string) => BigInt(value);
const MASK = (big(1) << big(64)) - big(1);
const rotl = (value: bigint, bits: number) => ((value << big(bits)) | (value >> big(64 - bits))) & MASK;

/**
 * `format!("{:x}", DefaultHasher::new() over str)`: SipHash-1-3 with zero keys over the
 * UTF-8 bytes followed by 0xff, which is how Rust hashes a `str`.
 */
export function rustStrHash(value: string): string {
  const bytes = [...Buffer.from(value, 'utf8'), 0xff];
  let v0 = big('0x736f6d6570736575');
  let v1 = big('0x646f72616e646f6d');
  let v2 = big('0x6c7967656e657261');
  let v3 = big('0x7465646279746573');
  const round = () => {
    v0 = (v0 + v1) & MASK;
    v1 = rotl(v1, 13) ^ v0;
    v0 = rotl(v0, 32);
    v2 = (v2 + v3) & MASK;
    v3 = rotl(v3, 16) ^ v2;
    v0 = (v0 + v3) & MASK;
    v3 = rotl(v3, 21) ^ v0;
    v2 = (v2 + v1) & MASK;
    v1 = rotl(v1, 17) ^ v2;
    v2 = rotl(v2, 32);
  };
  const word = (offset: number, count: number) => {
    let result = big(0);
    for (let index = 0; index < count; index++) result |= big(bytes[offset + index]) << big(8 * index);
    return result;
  };
  const whole = bytes.length - (bytes.length % 8);
  for (let offset = 0; offset < whole; offset += 8) {
    const m = word(offset, 8);
    v3 ^= m;
    round();
    v0 ^= m;
  }
  const last = (big(bytes.length & 0xff) << big(56)) | word(whole, bytes.length - whole);
  v3 ^= last;
  round();
  v0 ^= last;
  v2 ^= big(0xff);
  round();
  round();
  round();
  return (v0 ^ v1 ^ v2 ^ v3).toString(16);
}
