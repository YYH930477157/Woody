'use strict';
/**
 * Modules of a C project and a brief per module expert, built without a model.
 *
 * `classify` finds modules from the dispatch tables of the architecture analysis and from
 * function name prefixes. `brief` collects, for the files one expert owns, where the module
 * is scheduled, who calls it from outside, what it calls, its globals and who touches them,
 * its address macros and build switches, and what the index missed or may have shifted.
 *
 * Pure functions like architecture.cjs: the runtime supplies the index rows, a source reader
 * and the index coverage, and writes the result.
 */

const architecture = require('./architecture.cjs');

const { lineOf, matchClose, splitTopLevel, fill, KEYWORDS, FOREIGN_SEGMENTS, MARK } = architecture;

const C_SOURCE = /\.(c|cc|cpp|cxx)$/i;
const C_HEADER = /\.(h|hh|hpp|hxx)$/i;
/** A prefix shared by more files than this outside the dispatch tables names a layer, not a module. */
const LAYER_PREFIX_FILES = 3;
const LIMITS = {
  provides: 20,
  provideNames: 80,
  callers: 8,
  uses: 60,
  globals: 25,
  globalNames: 60,
  externalGlobals: 25,
  externalGlobalNames: 60,
  sites: 5,
  statics: 50,
  addresses: 25,
  addressNames: 60,
  addressSites: 3,
  structTables: 4,
  fileFunctions: 80,
  fileTables: 16,
  types: 25,
  switches: 30,
  missing: 30,
  internalCallees: 6,
  digestProvides: 8,
  digestGlobals: 8,
  digestEntries: 10,
};
const ADDRESS_MACRO = /\b[A-Z][A-Z0-9_]*ADDR[A-Z0-9_]*\b/g;
const STORAGE_ID = /\b(?:NVM|EEP|EEPROM|FRAM|FLASH|PARA_ID|DATA_ID|STORAGE)_[A-Z0-9_]+\b/g;
const DIRECTIVE_IF = /^\s*#\s*(?:if|ifdef|ifndef|elif)\b(.*)$/;
const NOT_SWITCHES = new Set([
  'defined',
  'if',
  'ifdef',
  'ifndef',
  'elif',
  'ENABLE',
  'DISABLE',
  'ENABLED',
  'DISABLED',
  'ON',
  'OFF',
  'TRUE',
  'FALSE',
  'YES',
  'NO',
  'STD_ON',
  'STD_OFF',
  'NULL',
  'nullptr',
  '__cplusplus',
]);
const COMMON_LOCAL_NAMES = new Set([
  'ch',
  'id',
  'len',
  'cnt',
  'idx',
  'tmp',
  'val',
  'buf',
  'ptr',
  'ret',
  'err',
  'res',
  'bit',
  'pos',
  'sum',
  'max',
  'min',
  'num',
  'cmd',
  'key',
  'msg',
  'src',
  'dst',
  'arg',
  'ctx',
  'cfg',
  'obj',
  'dev',
  'tag',
  'row',
  'col',
  'data',
  'size',
  'type',
  'mode',
  'flag',
  'code',
  'mask',
  'addr',
  'time',
  'date',
  'year',
  'hour',
  'step',
  'rate',
  'tick',
  'line',
  'name',
  'text',
  'list',
  'item',
  'node',
  'head',
  'tail',
  'next',
  'prev',
  'last',
  'curr',
  'temp',
  'page',
  'slot',
  'port',
  'task',
  'func',
  'count',
  'state',
  'value',
  'index',
  'error',
  'level',
  'limit',
  'check',
  'start',
  'length',
  'offset',
  'status',
  'result',
  'buffer',
  'header',
  'config',
  'handle',
  'target',
  'source',
  'output',
  'number',
]);
const TIMER_CREATE_PATTERN = /\b(xTimerCreate|xTimerCreateStatic|osTimerNew)\s*\(/g;
const ISR_NAME_PATTERN = /(?:_IRQHandler|_ISR|_Isr|IRQ_Handler)$|^HAL_[A-Za-z0-9_]+Callback$/;
const ARRAY_WRITE_FIRST_ARG = /^(?:memcpy|memmove|memset|strcpy|strncpy|strcat|strncat|sprintf|snprintf|bzero)$/i;
const ARRAY_READ_LATER_ARG = /^(?:memcpy|memmove|memcmp|strcpy|strncpy|strcat|strncat|strcmp|strncmp|strlen)$/i;
const CONFIG_HEADER_NAME = /(?:cfg|conf|config|opt|option|def|proj|feature|board)/i;
const DECLARATION_WORDS = new Set([
  ...KEYWORDS,
  'const',
  'static',
  'volatile',
  'extern',
  'struct',
  'union',
  'enum',
  'unsigned',
  'signed',
  'register',
  'inline',
  'restrict',
]);

const code = (name) => `\`${name}\``;
const at = (file, line) => `${file}:${line}`;
const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stemOf = (file) =>
  file
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '');
const dirOf = (file) => file.slice(0, Math.max(0, file.lastIndexOf('/')));
const foreign = (file) => file.split('/').some((segment) => FOREIGN_SEGMENTS.has(segment.toLowerCase()));

// ---------------------------------------------------------------------------
// Ownership: the same rule the team role text states.
// ---------------------------------------------------------------------------

/** Length of the entry when it covers the file, else -1. */
function entryMatch(entry, file) {
  if (entry === file) return entry.length;
  if (entry.endsWith('/')) return file.startsWith(entry) ? entry.length : -1;
  if (!entry.includes('*')) return -1;
  const pattern = entry
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${pattern}$`).test(file) ? entry.length : -1;
}

/**
 * Owner of a project-relative file: an expert id, `shared`, or undefined (unowned). The
 * longest matching entry wins; a tie goes to the expert listed first, before shared.
 */
function ownerOf(file, experts, shared = []) {
  let best = -1;
  let owner;
  for (const expert of experts)
    for (const entry of expert.paths) {
      const length = entryMatch(entry, file);
      if (length > best) {
        best = length;
        owner = expert.id;
      }
    }
  for (const entry of shared) {
    const length = entryMatch(entry, file);
    if (length > best) {
      best = length;
      owner = 'shared';
    }
  }
  return owner;
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/** Lazily prepared source files for one run: the text with comments, strings and directives blanked. */
function sourceCache(readSource) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      const text = readSource(file);
      cache.set(file, typeof text === 'string' ? architecture.prepare(file, text) : null);
    }
    return cache.get(file);
  };
}

/** Name of the function a top-level statement defines, from `... name(args)` before its body. */
function functionName(statement) {
  const match = /\b([A-Za-z_]\w*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:__attribute__\s*\(\(.*\)\)\s*)?$/.exec(
    statement
  );
  return match && !KEYWORDS.has(match[1]) ? match[1] : undefined;
}

/**
 * Closing `}` for `open`, falling back to indentation matching when `#if`/`#else` branches
 * leave unbalanced opening braces inside a top-level block.
 */
function matchCloseTolerant(plain, starts, open, beginOffset) {
  const exact = matchClose(plain, open);
  if (exact >= 0) return exact;
  const beginLine = lineOf(starts, beginOffset);
  const beginSlice = plain.slice(starts[beginLine - 1], starts[beginLine] ?? plain.length);
  const indent = (beginSlice.match(/^[ \t]*/) || [''])[0].length;
  const startLine = lineOf(starts, open);
  for (let line = startLine + 1; line <= starts.length; line++) {
    const from = starts[line - 1];
    const to = starts[line] ?? plain.length;
    const raw = plain.slice(from, to).replace(/\r?\n$/, '');
    const match = /^([ \t]*)\}\s*;?\s*$/.exec(raw);
    if (match && match[1].length <= indent) return from + match[1].length;
  }
  return -1;
}

/**
 * Top-level statements of a file: function definitions and declarations, with the brace
 * bodies of initializers and struct definitions collapsed to `{}`. Unwraps `extern "C"` and
 * C++ `namespace` blocks, and recovers from `#if`/`#else` unbalanced braces. Offsets point
 * into the prepared `plain` text.
 */
function topLevel(source) {
  const { plain, starts } = source;
  const result = [];
  // `begin` is where the statement started; `start` where its not yet copied text starts.
  let begin = 0;
  let start = 0;
  let text = '';
  let i = 0;
  const restart = (at) => {
    i = begin = start = at;
    text = '';
  };
  while (i < plain.length) {
    const c = plain[i];
    if (c === '{') {
      const before = text + plain.slice(start, i);
      const beforeTrim = collapse(before);
      if (
        /^extern\s+"[^"]*"\s*$/.test(beforeTrim) ||
        /^namespace(?:\s+[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?\s*$/.test(beforeTrim)
      ) {
        restart(i + 1);
        continue;
      }
      const close = matchCloseTolerant(plain, starts, i, begin);
      if (close < 0) break;
      if (!before.includes('=') && functionName(beforeTrim)) {
        result.push({ kind: 'function', text: beforeTrim, offset: begin });
        restart(close + 1);
        continue;
      }
      text = `${before}{}`;
      i = start = close + 1;
      continue;
    }
    if (c === ';') {
      result.push({ kind: 'statement', text: collapse(text + plain.slice(start, i)), offset: begin });
      restart(i + 1);
      continue;
    }
    if (c === '}') {
      // A stray closing brace (unbalanced #if branches or end of extern "C" / namespace): start over after it.
      restart(i + 1);
      continue;
    }
    i++;
  }
  return result;
}

/** Offset in `plain` of the first whole-word `name` at or after `from`, or -1. */
function wordOffset(plain, name, from) {
  const pattern = new RegExp(`\\b${name}\\b`, 'g');
  pattern.lastIndex = from;
  const match = pattern.exec(plain);
  return match ? match.index : -1;
}

/** Global variables a file defines, read from the source because the index misses many. */
function globalsOf(source) {
  const { file, plain, starts, guards } = source;
  const found = new Map();
  for (const item of topLevel(source)) {
    if (item.kind !== 'statement') continue;
    let text = item.text
      .replace(/__attribute__\s*\(\(.*?\)\)/g, ' ')
      .replace(/\b__declspec\s*\([^)]*\)/g, ' ')
      .replace(/\b(?:__?ALIGN\w*|ALIGN|__?SECTION|SECTION|AT_SECTION|__?PACKED|PACKED|DATA_ALIGN)\s*\([^)]*\)/g, ' ')
      .replace(/@\s*[^,;=]+/g, ' ');
    if (!text || /^(typedef|extern)\b/.test(text)) continue;
    // A struct, union or enum definition without a variable.
    if (/\{\}\s*$/.test(text) && !text.includes('=')) continue;
    const pointerFunction = /\(\s*\*\s*(?:const\s+|volatile\s+)*([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)\)\s*\(/.exec(
      text
    );
    const names = [];
    let pointerArray = false;
    if (pointerFunction) {
      names.push(pointerFunction[1]);
      pointerArray = Boolean(pointerFunction[2].trim());
    } else {
      // Prototypes and macro calls; array sizes may call macros.
      if (
        text
          .split('=')[0]
          .replace(/\[[^\]]*\]/g, ' ')
          .includes('(')
      )
        continue;
      const parts = splitTopLevel(text, 0, text.length).map((part) => text.slice(part.start, part.end));
      for (const part of parts) {
        const declarator = part
          .split('=')[0]
          .replace(/\[[^\]]*\]/g, ' ')
          .replace(/\{\}/g, ' ');
        const words = declarator.match(/[A-Za-z_]\w*/g) || [];
        const name = words.at(-1);
        if (name && !DECLARATION_WORDS.has(name)) names.push(name);
      }
    }
    const isStatic = /\bstatic\b/.test(text);
    const isConst = /\bconst\b/.test(text.split('=')[0]);
    for (const name of names) {
      const offset = wordOffset(plain, name, item.offset);
      if (offset < 0) continue;
      const line = lineOf(starts, offset);
      const guard = guards[line - 1];
      if (guard?.dead) continue;
      if (!found.has(name))
        found.set(name, {
          name,
          file,
          line,
          isStatic,
          isConst,
          conditions: guard?.conditions || [],
          array: pointerArray,
        });
      if (new RegExp(`\\b${name}\\s*\\[`).test(text)) found.get(name).array = true;
    }
  }
  return [...found.values()];
}

/** Function definitions in the source, as `name -> line`, outside `#if 0`. */
function definitionsOf(source) {
  const { plain, starts, guards } = source;
  const found = new Map();
  for (const item of topLevel(source)) {
    if (item.kind !== 'function') continue;
    const name = functionName(item.text);
    if (!name) continue;
    const offset = wordOffset(plain, name, item.offset);
    if (offset < 0) continue;
    const line = lineOf(starts, offset);
    if (guards[line - 1]?.dead || found.has(name)) continue;
    found.set(name, { name, line, conditions: guards[line - 1]?.conditions || [] });
  }
  return [...found.values()];
}

/** Struct, union and enum type definitions in a file, outside `#if 0`. */
function typesOf(source) {
  const { file, plain, starts, guards } = source;
  const structs = [];
  const enums = [];
  const seenStruct = new Set();
  const seenEnum = new Set();
  const addStruct = (name, kind, line, body) => {
    if (!name || seenStruct.has(name)) return;
    seenStruct.add(name);
    const fieldCount = body
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean).length;
    structs.push({ name, kind, file, line, fieldCount });
  };
  const addEnum = (name, line, body) => {
    if (!name || seenEnum.has(name)) return;
    seenEnum.add(name);
    const count = splitTopLevel(body, 0, body.length)
      .map((part) => body.slice(part.start, part.end).trim())
      .filter(Boolean).length;
    enums.push({ name, file, line, count });
  };
  for (const match of plain.matchAll(/\btypedef\s+(struct|union|enum)(?:\s+([A-Za-z_]\w*))?\s*\{/g)) {
    const line = lineOf(starts, match.index);
    if (guards[line - 1]?.dead) continue;
    const open = match.index + match[0].length - 1;
    const close = matchCloseTolerant(plain, starts, open, match.index);
    if (close < 0) continue;
    const semi = plain.indexOf(';', close + 1);
    const tail = semi < 0 ? '' : plain.slice(close + 1, semi);
    const alias = splitTopLevel(tail, 0, tail.length)
      .map((part) => tail.slice(part.start, part.end).trim())
      .filter((piece) => piece && !piece.startsWith('*'))
      .map((piece) => /^([A-Za-z_]\w*)/.exec(piece)?.[1])
      .find(Boolean);
    const name = alias || match[2];
    const body = plain.slice(open + 1, close);
    if (match[1] === 'enum') addEnum(name, line, body);
    else addStruct(name, match[1], line, body);
  }
  for (const match of plain.matchAll(/\b(struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/g)) {
    const line = lineOf(starts, match.index);
    if (guards[line - 1]?.dead) continue;
    const before = plain.slice(Math.max(0, match.index - 16), match.index);
    if (/\btypedef\s*$/.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchCloseTolerant(plain, starts, open, match.index);
    if (close < 0) continue;
    const body = plain.slice(open + 1, close);
    if (match[1] === 'enum') addEnum(match[2], line, body);
    else addStruct(match[2], match[1], line, body);
  }
  return { structs, enums };
}

/** Top-level initialized arrays and structs with their start/end lines. */
function fileTablesOf(source) {
  const { plain, starts, guards } = source;
  const items = [];
  const pattern = /\b([A-Za-z_]\w*)\s*(?:\[[^\];{}]*\]\s*(?:\)\s*\([^;{}]*\)\s*)?)?=\s*\{/g;
  // Walk top-level brace blocks (unwrapping extern "C" and namespace blocks) so an unbalanced #if brace
  // inside an earlier function never masks later tables.
  const ranges = [];
  let cursor = 0;
  let stmtStart = 0;
  while (cursor < plain.length) {
    const ch = plain[cursor];
    if (ch === ';') {
      stmtStart = cursor + 1;
      cursor++;
      continue;
    }
    if (ch === '{') {
      const beforeTrim = collapse(plain.slice(stmtStart, cursor));
      if (
        /^extern\s+"[^"]*"\s*$/.test(beforeTrim) ||
        /^namespace(?:\s+[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)?\s*$/.test(beforeTrim)
      ) {
        stmtStart = cursor + 1;
        cursor++;
        continue;
      }
      const close = matchCloseTolerant(plain, starts, cursor, stmtStart);
      if (close < 0) break;
      ranges.push([cursor, close]);
      cursor = stmtStart = close + 1;
      continue;
    }
    if (ch === '}') stmtStart = cursor + 1;
    cursor++;
  }
  let rangeIndex = 0;
  for (const match of plain.matchAll(pattern)) {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] < match.index) rangeIndex++;
    const inside =
      rangeIndex < ranges.length && ranges[rangeIndex][0] < match.index && match.index < ranges[rangeIndex][1];
    if (inside) continue;
    const start = lineOf(starts, match.index);
    if (guards[start - 1]?.dead || DECLARATION_WORDS.has(match[1])) continue;
    const open = match.index + match[0].length - 1;
    const close = matchCloseTolerant(plain, starts, open, match.index);
    if (close < 0) continue;
    items.push({ name: match[1], start, end: lineOf(starts, close) });
  }
  return items;
}

/** Unwrapped `#define ...` text starting at 1-based `line`, with CRLF and `\` continuations joined. */
function macroLine(prepared, line) {
  let raw = '';
  for (let index = line - 1; index < prepared.starts.length; index++) {
    const from = prepared.starts[index];
    const next = prepared.starts[index + 1];
    const segment = prepared.literals
      .slice(from, next === undefined ? prepared.literals.length : next - 1)
      .replace(/\r$/, '');
    const continued = /\\\s*$/.test(segment);
    raw += (raw ? ' ' : '') + (continued ? segment.replace(/\\\s*$/, '') : segment);
    if (!continued) break;
  }
  return raw;
}

/**
 * How `plain` uses the variable whose name starts at `offset`: write, address or read.
 * When `isArray` is true and `!isConst`, bare array arguments decaying to a pointer are
 * classified as `write` (first arg of memcpy/memset/...) or `address` (passed to other calls),
 * while `sizeof(arr)` stays `read`.
 */
function accessKind(plain, offset, name, isArray = false, isConst = false) {
  const before = plain.slice(Math.max(0, offset - 3), offset);
  if (/(\+\+|--)\s*$/.test(before)) return 'write';
  if (/(?:^|[^&])&\s*$/.test(before)) return 'address';
  let i = offset + name.length;
  // Step over indexes and member chains: name[i].field->other.
  for (;;) {
    while (/\s/.test(plain[i] || '')) i++;
    if (plain[i] === '[') {
      const close = matchClose(plain, i);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    const member = /^(?:\.|->)\s*[A-Za-z_]\w*/.exec(plain.slice(i, i + 80));
    if (member) {
      i += member[0].length;
      continue;
    }
    break;
  }
  const after = plain.slice(i, i + 3);
  if (/^(?:=(?!=)|[-+*/%&|^]=|<<=|>>=|\+\+|--)/.test(after)) return 'write';
  if (isArray && !isConst && i === offset + name.length) {
    // Check whether a bare array name decays to a pointer inside a call argument list.
    const trail = plain.slice(i, i + 20).trimStart();
    if (trail.startsWith(',') || trail.startsWith(')')) {
      const lookback = plain.slice(Math.max(0, offset - 120), offset);
      // Find the innermost unmatched `(` before `offset`.
      let depth = 0;
      let paren = -1;
      let commas = 0;
      for (let j = lookback.length - 1; j >= 0; j--) {
        const ch = lookback[j];
        if (ch === ')' || ch === ']' || ch === '}') depth++;
        else if (ch === '(' || ch === '[' || ch === '{') {
          if (depth === 0 && ch === '(') {
            paren = j;
            break;
          }
          depth--;
        } else if (ch === ',' && depth === 0) commas++;
      }
      if (paren >= 0) {
        const callee = /([A-Za-z_]\w*)\s*$/.exec(lookback.slice(0, paren))?.[1];
        if (callee) {
          if (callee === 'sizeof') return 'read';
          if (commas === 0 && ARRAY_WRITE_FIRST_ARG.test(callee)) return 'write';
          if (commas > 0 && ARRAY_READ_LATER_ARG.test(callee)) return 'read';
          if (!KEYWORDS.has(callee)) return 'address';
        }
      }
    }
  }
  return 'read';
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const prefixOf = (name) => /^([A-Za-z][A-Za-z0-9]*)_/.exec(name)?.[1].toUpperCase();
const splitBase = (stem) => {
  const index = stem.indexOf('_');
  return index >= 2 ? stem.slice(0, index) : undefined;
};

/** The prefix most of a file's functions share, when at least half of them share it. */
function dominantPrefix(names) {
  const counts = new Map();
  for (const name of names) {
    const prefix = prefixOf(name);
    if (prefix && prefix.length >= 2) counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  const [best] = [...counts].sort((a, b) => b[1] - a[1]);
  return best && best[1] * 2 >= names.length ? best[0] : undefined;
}

/** `alarm`, or `routine-alarm` when two modules share a stem. */
function groupIds(groups) {
  const slug = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'module';
  const byStem = new Map();
  for (const group of groups) {
    const id = slug(group.stem);
    if (!byStem.has(id)) byStem.set(id, []);
    byStem.get(id).push(group);
  }
  const ids = new Map();
  for (const [id, items] of byStem)
    for (const group of items)
      ids.set(group, items.length === 1 ? id : slug(`${group.dir.split('/').pop() || 'root'}-${id}`));
  return ids;
}

/**
 * Modules of the project: each source file (or `<base>_*.c` split-file family in one folder,
 * such as `display_*.c` after `display.c` is split) that registers functions in a dispatch
 * table, standalone RTOS task or called struct interface table leads one, with its headers
 * and the other source files whose functions mostly share its prefix. Files in library and
 * demo folders are left out.
 *
 * @param {object} input
 * @param {object} input.model result of architecture.analyze
 * @param {Array<[string, string, unknown, unknown]>} input.functions name and file of each indexed function
 * @param {string[]} input.files every indexed file
 * @param {Array<{id: string, paths: string[]}>} [input.experts]
 * @param {string[]} [input.shared]
 */
function classify({ model, functions, files, experts = [], shared = [] }) {
  const registered = new Map();
  const register = (file, tableName, fnName) => {
    if (!C_SOURCE.test(file) || foreign(file)) return;
    if (!registered.has(file)) registered.set(file, new Map());
    const tables = registered.get(file);
    if (!tables.has(tableName)) tables.set(tableName, []);
    if (!tables.get(tableName).includes(fnName)) tables.get(tableName).push(fnName);
  };
  // Central scheduler files define or run tables whose entries belong to other files (e.g. mtask.c).
  const schedulerFiles = new Set();
  const centralSchedulers = new Set();
  for (const table of model.tables || []) {
    const externalFiles = new Set(
      table.variants.flatMap((variant) =>
        variant.entries.flatMap((entry) => entry.defs.map((def) => def.file).filter((file) => file !== variant.file))
      )
    );
    if (!externalFiles.size) continue;
    for (const variant of table.variants) {
      schedulerFiles.add(variant.file);
      if (externalFiles.size >= 3) centralSchedulers.add(variant.file);
    }
    for (const dispatcher of table.dispatchers || []) {
      if (dispatcher.def?.file) schedulerFiles.add(dispatcher.def.file);
      for (const path of dispatcher.paths || []) if (path[0]?.file) schedulerFiles.add(path[0].file);
    }
  }
  for (const table of model.tables || [])
    for (const variant of table.variants)
      for (const entry of variant.entries)
        for (const def of entry.defs)
          if (!centralSchedulers.has(def.file) && ownerOf(def.file, experts, shared) !== 'shared')
            register(def.file, table.name, def.name);
  for (const table of model.otherTables || [])
    for (const variant of table.variants)
      for (const entry of variant.entries)
        for (const def of entry.defs) if (!schedulerFiles.has(def.file)) register(def.file, table.name, def.name);
  for (const table of model.structTables || [])
    for (const field of table.fields || []) {
      if (!field.calls?.length) continue;
      for (const def of field.defs || [])
        if (!schedulerFiles.has(def.file)) register(def.file, `${table.type}.${field.field}`, def.name);
    }
  for (const task of model.tasks || []) {
    const file = task.entry?.file;
    if (file && !schedulerFiles.has(file) && !registered.has(file)) register(file, 'RTOS task', task.entry.name);
  }
  const namesByFile = new Map();
  for (const [name, file] of functions) {
    if (typeof name !== 'string' || typeof file !== 'string') continue;
    if (!namesByFile.has(file)) namesByFile.set(file, []);
    namesByFile.get(file).push(name);
  }
  const validPath = (file) => typeof file === 'string' && /^[^<:/\\][^:]*$/.test(file) && !foreign(file);
  const allSources = [...new Set([...files, ...namesByFile.keys()])]
    .filter((file) => validPath(file) && C_SOURCE.test(file))
    .sort();
  const allHeaders = files.filter((file) => validPath(file) && C_HEADER.test(file)).sort();
  const headers = new Map();
  for (const file of allHeaders) {
    const stem = stemOf(file).toLowerCase();
    if (!headers.has(stem)) headers.set(stem, []);
    headers.get(stem).push(file);
  }
  const headerOfStem = (dir, stem) => {
    const candidates = headers.get(stem) || [];
    return candidates.find((file) => dirOf(file) === dir) || (candidates.length === 1 ? candidates[0] : undefined);
  };
  const headerOf = (source) => headerOfStem(dirOf(source), stemOf(source).toLowerCase());
  const matchesBase = (file, base) => {
    const stem = stemOf(file).toLowerCase();
    return stem === base || stem.startsWith(`${base}_`);
  };

  const seeds = [...registered.keys()].sort();
  const groups = [];
  const consumed = new Set();
  for (const seed of seeds) {
    if (consumed.has(seed)) continue;
    const dir = dirOf(seed);
    const stem = stemOf(seed).toLowerCase();
    const base = stem.includes('_') ? splitBase(stem) : stem.length >= 2 ? stem : undefined;
    const familySources = base ? allSources.filter((file) => dirOf(file) === dir && matchesBase(file, base)) : [];
    const familySeeds = familySources.filter((file) => registered.has(file));
    const hasExactSource = Boolean(base) && familySources.some((file) => stemOf(file).toLowerCase() === base);
    const hasBaseHeader = Boolean(base && headerOfStem(dir, base));
    const otherDirHasSeed = Boolean(base) && seeds.some((file) => dirOf(file) !== dir && matchesBase(file, base));
    const seedPrefixes = new Set(
      familySeeds.map((file) => dominantPrefix([...registered.get(file).values()].flat())).filter(Boolean)
    );
    const isSplit =
      Boolean(base) &&
      familySeeds.length >= 1 &&
      seedPrefixes.size <= 1 &&
      ((hasExactSource && familySources.length >= 2) ||
        (!hasExactSource && (familySources.length >= 2 || hasBaseHeader) && (hasBaseHeader || !otherDirHasSeed)));
    if (isSplit) {
      for (const item of familySeeds) consumed.add(item);
      const ordered = [
        ...familySources.filter((file) => stemOf(file).toLowerCase() === base),
        ...familySources.filter((file) => stemOf(file).toLowerCase() !== base),
      ];
      groups.push({ dir, stem: base, base, seeds: familySeeds, sources: ordered });
    } else {
      consumed.add(seed);
      groups.push({ dir, stem: stemOf(seed), base: undefined, seeds: [seed], sources: [seed] });
    }
  }

  const ids = groupIds(groups);
  const ownedByGroup = new Set(groups.flatMap((group) => group.sources));
  const prefixes = new Map(
    groups.map((group) => {
      const seedFunctions = group.seeds.flatMap((file) => namesByFile.get(file) || []);
      const tableFunctions = group.seeds.flatMap((file) => [...registered.get(file).values()].flat());
      return [group, dominantPrefix(seedFunctions) || dominantPrefix(tableFunctions)];
    })
  );
  const groupsByPrefix = new Map();
  for (const [group, prefix] of prefixes)
    if (prefix) groupsByPrefix.set(prefix, [...(groupsByPrefix.get(prefix) || []), group]);
  // Other source files that join a module by prefix; a prefix in many of them names a layer.
  const followers = new Map();
  for (const [file, names] of namesByFile) {
    if (ownedByGroup.has(file) || !validPath(file) || !C_SOURCE.test(file)) continue;
    const prefix = dominantPrefix(names);
    if (!prefix || groupsByPrefix.get(prefix)?.length !== 1) continue;
    if (!followers.has(prefix)) followers.set(prefix, []);
    followers.get(prefix).push(file);
  }

  return groups.map((group) => {
    const prefix = prefixes.get(group);
    const joined =
      prefix && (followers.get(prefix) || []).length <= LAYER_PREFIX_FILES ? followers.get(prefix) || [] : [];
    const sources = [...group.sources, ...joined.sort()];
    const splitHeaders = group.base
      ? [
          headerOfStem(group.dir, group.base),
          ...allHeaders.filter((file) => dirOf(file) === group.dir && matchesBase(file, group.base)),
        ]
      : [];
    const moduleFiles = [
      ...new Set([...sources.flatMap((file) => [file, headerOf(file)]), ...splitHeaders].filter(Boolean)),
    ];
    const tables = new Map();
    const orderedTableNames = [
      ...(model.tables || []).map((table) => table.name),
      ...new Set(group.seeds.flatMap((seed) => [...(registered.get(seed)?.keys() || [])])),
    ];
    for (const tableName of orderedTableNames)
      for (const seed of group.seeds)
        for (const name of registered.get(seed)?.get(tableName) || []) {
          if (!tables.has(tableName)) tables.set(tableName, []);
          if (!tables.get(tableName).includes(name)) tables.get(tableName).push(name);
        }
    const owners = [...new Set(moduleFiles.map((file) => ownerOf(file, experts, shared)).filter(Boolean))];
    return {
      id: ids.get(group),
      files: moduleFiles,
      // A split-file family: experts may own it as `<dir>/<base>_*.c` so new split files stay theirs.
      ...(group.base ? { split: { dir: group.dir, base: group.base } } : {}),
      prefix,
      tables: [...tables].map(([table, names]) => ({ table, functions: names })),
      experts: owners.filter((owner) => owner !== 'shared'),
    };
  });
}

/**
 * Unowned central infrastructure files (task schedulers, multi-module struct registries,
 * X-Macro tables and cross-image API headers) that are good candidates for `shared`.
 */
function suggestShared({ model, experts = [], shared = [] }) {
  const candidates = new Set();
  const add = (file) => {
    if (typeof file !== 'string' || !/^[^<:/\\][^:]*$/.test(file) || foreign(file)) return;
    if (ownerOf(file, experts, shared) === undefined) candidates.add(file);
  };
  for (const table of model.tables || [])
    for (const variant of table.variants) {
      const external = new Set(variant.entries.flatMap((entry) => entry.defs.map((def) => def.file)));
      if (external.size >= 3) add(variant.file);
    }
  const structHolders = new Map();
  for (const table of model.structTables || []) {
    if (!table.fields?.some((field) => field.calls?.length)) continue;
    if (!structHolders.has(table.file)) structHolders.set(table.file, new Set());
    for (const field of table.fields) for (const def of field.defs || []) structHolders.get(table.file).add(def.file);
  }
  for (const [file, targets] of structHolders) if (targets.size >= 3) add(file);
  for (const item of model.xmacroTables || []) {
    add(item.file);
    for (const site of item.sites || []) add(site.file);
  }
  for (const api of model.vectorApis || []) {
    add(api.header);
    if (api.table?.file) add(api.table.file);
  }
  return [...candidates].sort();
}

/** The modules section of the architecture file. */
function renderModules(list, labels, options = {}) {
  const t = labels;
  const out = [`## ${t.modulesTitle}`, '', t.modulesIntro, ''];
  if (!list.length) return [...out, t.modulesNone, ''].join('\n');
  out.push(`| ${t.module} | ${t.modulesFiles} | ${t.modulesTables} | ${t.modulesExpert} |`, '|---|---|---|---|');
  for (const item of list)
    out.push(
      `| ${code(item.id)} | ${item.files.join(', ')} | ${item.tables
        .map((entry) => `${code(entry.table)}: ${entry.functions.map(code).join(', ')}`)
        .join('; ')} | ${item.experts.length ? item.experts.map(code).join(', ') : t.none} |`
    );
  out.push('');
  const suggested = options.suggestedShared || [];
  if (suggested.length && t.modulesShared) {
    out.push(fill(t.modulesShared, { files: suggested.map(code).join(', ') }), '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

const more = (list, max, t) => (list.length > max ? ` ${fill(t.more, { count: list.length - max })}` : '');

/**
 * Facts about the files one expert owns.
 *
 * @param {object} input
 * @param {{id: string, name: string, paths: string[]}} input.expert
 * @param {Array<{id: string, name: string, paths: string[]}>} input.experts every expert of the project
 * @param {string[]} input.shared
 * @param {object} input.model result of architecture.analyze
 * @param {Array<[string, string, unknown, unknown]>} input.functions name, file, start and end line of each indexed function
 * @param {string[]} input.files every indexed file
 * @param {Array<[string, string, unknown, string, string]>} input.calls caller name, caller file, caller start line, callee name, callee file
 * @param {Array<[string, string]>} input.variables name and file of each Variable node
 * @param {Map<string, {status: string, freshness: string, ranges: Array<{start: number, end: number}>}>} input.coverage per owned file
 * @param {(file: string) => object | null} input.source prepared source of a project file (see sourceCache)
 * @param {Array<{id: string, files: string[]}>} [input.modules] result of classify, to name the module of an unowned file
 */
function collect(input) {
  const { expert, experts, shared, model, functions, files, calls, variables, coverage, source } = input;
  const moduleOf = new Map();
  for (const item of input.modules || []) for (const file of item.files) moduleOf.set(file, item.id);
  const owner = (file) => ownerOf(file, experts, shared);
  const mine = (file) => owner(file) === expert.id;
  // The index also holds virtual files such as <python-builtins>.
  const indexed = [...new Set([...files, ...functions.map((row) => row[1])])].filter(
    (file) => typeof file === 'string' && /^[^<:/\\][^:]*$/.test(file)
  );
  const owned = indexed.filter(mine).sort();
  const ownedSet = new Set(owned);
  const unmatched = expert.paths.filter((entry) => !indexed.some((file) => entryMatch(entry, file) >= 0));
  const unindexedFiles = (input.diskFiles || []).filter((file) => mine(file) && !ownedSet.has(file)).sort();
  const cache = input.cache || {};
  const defsByFile = new Map();
  for (const [name, file, start, end] of functions) {
    if (typeof file !== 'string') continue;
    if (!defsByFile.has(file)) defsByFile.set(file, []);
    defsByFile.get(file).push({ name, start: Number(start), end: Number(end) });
  }
  const enclosing = (file, line) =>
    (defsByFile.get(file) || [])
      .filter((def) => def.start <= line && line <= def.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];

  // Files and index state.
  const fileStates = owned.map((file) => {
    const info = coverage.get(file) || {};
    const names = (defsByFile.get(file) || []).sort((a, b) => a.start - b.start).map((def) => def.name);
    const scanAllTables = info.status === 'unusable' || !names.length;
    const prepared = (scanAllTables || C_SOURCE.test(file)) && source ? source(file) : null;
    const rawTables = prepared && (C_SOURCE.test(file) || info.status === 'unusable') ? fileTablesOf(prepared) : [];
    // Normal C files with functions only list multi-line initialized tables (configs, defaults, lookup tables).
    const tables = scanAllTables ? rawTables : rawTables.filter((item) => item.end - item.start >= 2);
    return {
      file,
      functions: names.length,
      // Names, so an expert compares the index with the source name by name, not by count.
      names,
      tables,
      status: info.status,
      changed: info.freshness === 'metadata_changed' || info.freshness === 'missing',
      ranges: info.ranges || [],
    };
  });

  // Unowned sibling/replacement files in a module whose id matches this expert or whose files mostly belong to it.
  const driftFiles = [
    ...new Set(
      (input.modules || [])
        .filter((item) => {
          if (item.id === expert.id) return true;
          if ((item.experts || []).length !== 1 || item.experts[0] !== expert.id) return false;
          const ownedCount = item.files.filter(mine).length;
          return ownedCount * 2 >= item.files.length;
        })
        .flatMap((item) => item.files)
        .filter((file) => owner(file) === undefined)
    ),
  ].sort();

  // Scheduling.
  const entries = [];
  for (const table of model.tables || [])
    for (const variant of table.variants)
      for (const entry of variant.entries) {
        const defs = entry.defs.filter((def) => ownedSet.has(def.file));
        if (!defs.length) continue;
        const dispatcher = table.dispatchers[0];
        entries.push({
          table: table.name,
          site: at(variant.file, variant.line),
          position: entry.position,
          names: defs.map((def) => def.name),
          conditions: [...variant.conditions, ...entry.conditions],
          comment: entry.comment || '',
          dispatcher: dispatcher ? dispatcher.def.name : undefined,
          task: dispatcher?.paths?.[0]?.[0]?.name,
        });
      }
  const tasks = (model.tasks || [])
    .filter((task) => ownedSet.has(task.entry.file))
    .map((task) => ({ name: task.entry.name, site: task.site }));
  // One line per struct type, field and functions: tables that repeat the same entries share it.
  const structGroups = new Map();
  for (const table of model.structTables || [])
    for (const field of table.fields) {
      const defs = field.defs.filter((def) => ownedSet.has(def.file));
      if (!defs.length) continue;
      const functionNames = defs.map((def) => def.name);
      const key = `${table.type}|${field.field}|${functionNames.join(',')}`;
      if (!structGroups.has(key))
        structGroups.set(key, {
          tables: [],
          type: table.type,
          field: field.field,
          functions: functionNames,
          calls: [],
        });
      const group = structGroups.get(key);
      group.tables.push({ name: table.name, site: at(table.file, table.line) });
      for (const call of field.calls) {
        const site = at(call.def.file, call.line);
        if (!group.calls.some((known) => known.site === site)) group.calls.push({ name: call.def.name, site });
      }
    }
  const structs = [...structGroups.values()];
  for (const table of [...(model.otherTables || []), ...(model.smallTables || [])])
    for (const variant of table.variants)
      for (const entry of variant.entries) {
        const defs = entry.defs.filter((def) => ownedSet.has(def.file));
        if (defs.length)
          entries.push({
            table: table.name,
            site: at(variant.file, variant.line),
            position: entry.position,
            names: defs.map((def) => def.name),
            conditions: [...variant.conditions, ...entry.conditions],
            comment: entry.comment || '',
            dispatcher: table.dispatcher.name,
          });
      }

  // Inter-image vector API entries owned by this expert.
  const vectorEntries = [];
  for (const api of model.vectorApis || []) {
    const matched = (api.entries || []).filter(
      (entry) =>
        (entry.def && ownedSet.has(entry.def.file)) ||
        ownedSet.has(api.header) ||
        (api.table && ownedSet.has(api.table.file))
    );
    if (!matched.length) continue;
    vectorEntries.push({
      base: api.base,
      header: api.header,
      items: matched.map((entry) => ({
        macro: entry.macro,
        field: entry.field,
        target: entry.def?.name || entry.field,
      })),
    });
  }

  // RTOS software timer callbacks pointing into this module (cached once per project scan).
  if (!cache.timerSites) {
    cache.timerSites = [];
    for (const file of indexed) {
      if (!C_SOURCE.test(file) || foreign(file)) continue;
      const prepared = source(file);
      if (!prepared) continue;
      const { plain, starts, guards } = prepared;
      for (const match of plain.matchAll(TIMER_CREATE_PATTERN)) {
        const line = lineOf(starts, match.index);
        if (guards[line - 1]?.dead) continue;
        const open = match.index + match[0].length - 1;
        const close = matchClose(plain, open);
        if (close < 0) continue;
        const args = splitTopLevel(plain, open + 1, close).map((part) => collapse(plain.slice(part.start, part.end)));
        const raw = match[1] === 'osTimerNew' ? args[0] : args[4];
        if (!raw) continue;
        const bare = raw.replace(/^(\(\s*[A-Za-z_][\w\s*]*\)\s*)+/, '').replace(/^&\s*/, '');
        if (/^[A-Za-z_]\w*$/.test(bare)) cache.timerSites.push({ name: bare, site: at(file, line) });
      }
    }
  }
  const ownedFnNames = new Set(owned.flatMap((file) => (defsByFile.get(file) || []).map((def) => def.name)));
  const timers = cache.timerSites.filter((item) => ownedFnNames.has(item.name));

  // Interrupt and HAL callback handlers defined inside this module.
  const scheduledNames = new Set([...tasks.map((task) => task.name), ...entries.flatMap((entry) => entry.names)]);
  const isrs = [];
  for (const file of owned) {
    for (const def of defsByFile.get(file) || []) {
      if (ISR_NAME_PATTERN.test(def.name) && !scheduledNames.has(def.name)) {
        isrs.push({ name: def.name, site: at(file, def.start) });
      }
    }
  }

  // Calls across the module boundary, plus a 1-level internal call map for entry points.
  const callSite = (file, start, name) => {
    const prepared = source(file);
    const def = (defsByFile.get(file) || []).find((item) => item.start === start);
    if (!prepared || !def || typeof name !== 'string' || !name) return at(file, start);
    const from = prepared.starts[def.start - 1] ?? 0;
    const to = prepared.starts[def.end] ?? prepared.plain.length;
    const lead = /^\w/.test(name) ? '\\b' : '';
    const trail = /\w$/.test(name) ? '\\b' : '';
    const pattern = new RegExp(`${lead}${escapeRegex(name)}${trail}`, 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(prepared.plain);
    return at(file, match && match.index < to ? lineOf(prepared.starts, match.index) : start);
  };
  const provided = new Map();
  const used = new Map();
  const internalCalls = new Map();
  for (const [callerName, callerFile, callerStart, calleeName, calleeFile] of calls) {
    if (typeof callerFile !== 'string' || typeof calleeFile !== 'string') continue;
    const inCaller = ownedSet.has(callerFile);
    const inCallee = ownedSet.has(calleeFile);
    if (inCallee && !inCaller) {
      const key = `${calleeName}|${calleeFile}`;
      if (!provided.has(key)) provided.set(key, { name: calleeName, file: calleeFile, callers: [] });
      const list = provided.get(key).callers;
      if (!list.some((item) => item.name === callerName && item.file === callerFile))
        list.push({
          name: callerName,
          file: callerFile,
          site: callSite(callerFile, Number(callerStart), calleeName),
          owner: owner(callerFile),
          module: moduleOf.get(callerFile),
        });
    } else if (inCaller && !inCallee) {
      const target = owner(calleeFile);
      const module = target === undefined ? moduleOf.get(calleeFile) : undefined;
      const group = `${target ?? ''}|${module ?? ''}`;
      if (!used.has(group)) used.set(group, { owner: target, module, functions: new Map() });
      used.get(group).functions.set(`${calleeName}|${calleeFile}`, { name: calleeName, file: calleeFile });
    } else if (inCaller && inCallee && callerName !== calleeName) {
      if (!internalCalls.has(callerName)) internalCalls.set(callerName, []);
      const callees = internalCalls.get(callerName);
      if (!callees.includes(calleeName)) callees.push(calleeName);
    }
  }
  const startOf = (name, file) => (defsByFile.get(file) || []).find((def) => def.name === name)?.start;
  // Callers in other experts' files first: those are the interfaces between experts.
  const callerRank = (caller) =>
    caller.owner !== undefined && caller.owner !== 'shared' ? 0 : caller.owner === 'shared' ? 1 : caller.module ? 2 : 3;
  // Functions other experts call come first, so a long list never hides a handoff behind
  // functions only unowned code calls.
  const provides = [...provided.values()]
    .map((item) => ({
      ...item,
      site: at(item.file, startOf(item.name, item.file) ?? 0),
      callers: item.callers.sort(
        (a, b) => callerRank(a) - callerRank(b) || a.site.localeCompare(b.site, 'en', { numeric: true })
      ),
    }))
    .sort(
      (a, b) =>
        callerRank(a.callers[0]) - callerRank(b.callers[0]) ||
        b.callers.length - a.callers.length ||
        a.name.localeCompare(b.name)
    );
  // Experts first, then detected modules without an expert, then everything else.
  const rank = (group) => (group.owner !== undefined ? 0 : group.module ? 1 : 2);
  const uses = [...used.values()]
    .map((group) => ({
      ...group,
      functions: [...group.functions.values()].sort(
        (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)
      ),
    }))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.functions.length - a.functions.length ||
        (a.owner ?? a.module ?? '').localeCompare(b.owner ?? b.module ?? '')
    );

  // Own globals, function definitions, and module types / header inlines.
  const graphVariables = new Set(variables.filter((row) => ownedSet.has(row[1])).map((row) => `${row[0]}|${row[1]}`));
  const globals = [];
  const definitions = [];
  const typeStructs = [];
  const typeEnums = [];
  const headerInlines = [];
  for (const file of owned) {
    const prepared = source(file);
    if (!prepared) continue;
    const { structs: fileStructs, enums: fileEnums } = typesOf(prepared);
    typeStructs.push(...fileStructs);
    typeEnums.push(...fileEnums);
    if (C_SOURCE.test(file)) {
      for (const item of globalsOf(prepared))
        globals.push({ ...item, inGraph: graphVariables.has(`${item.name}|${file}`), users: [] });
      for (const item of definitionsOf(prepared)) definitions.push({ ...item, file });
    } else if (C_HEADER.test(file)) {
      for (const item of definitionsOf(prepared)) headerInlines.push({ ...item, file });
    }
  }
  const external = globals.filter((item) => !item.isStatic);
  if (external.length) {
    const byName = new Map();
    for (const item of external) {
      if (!byName.has(item.name)) byName.set(item.name, []);
      byName.get(item.name).push(item);
    }
    const pattern = new RegExp(`\\b(${[...byName.keys()].join('|')})\\b`, 'g');
    for (const file of indexed) {
      if (ownedSet.has(file) || (!C_SOURCE.test(file) && !C_HEADER.test(file))) continue;
      const prepared = source(file);
      if (!prepared) continue;
      const { plain, starts } = prepared;
      for (const match of plain.matchAll(pattern)) {
        const previous = plain.slice(Math.max(0, match.index - 8), match.index);
        if (/(?:\.|->)\s*$/.test(previous)) continue;
        const line = lineOf(starts, match.index);
        if (prepared.guards[line - 1]?.dead) continue;
        const lineText = plain.slice(starts[line - 1], starts[line] ?? plain.length);
        if (/\bextern\b/.test(lineText)) continue;
        const items = byName.get(match[1]);
        const def = enclosing(file, line);
        const siteOwner = owner(file);
        const siteModule = moduleOf.get(file);
        for (const item of items) {
          item.users.push({
            file,
            line,
            function: def?.name,
            owner: siteOwner,
            module: siteModule,
            kind: accessKind(plain, match.index, match[1], item.array, item.isConst),
          });
        }
      }
    }
  }
  for (const item of globals) item.users.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // External globals defined outside this module that this module reads or writes (data sources & side effects).
  if (!cache.projectGlobals) {
    cache.projectGlobals = new Map();
    for (const file of indexed) {
      if (!C_SOURCE.test(file) || foreign(file)) continue;
      const prepared = source(file);
      if (!prepared) continue;
      for (const item of globalsOf(prepared)) {
        if (item.isStatic) continue;
        if (!cache.projectGlobals.has(item.name)) cache.projectGlobals.set(item.name, []);
        cache.projectGlobals.get(item.name).push(item);
      }
    }
  }
  const ownGlobalNames = new Set(globals.map((item) => item.name));
  const externalCandidates = new Map();
  for (const [name, defs] of cache.projectGlobals) {
    if (ownGlobalNames.has(name) || name.length < 3 || COMMON_LOCAL_NAMES.has(name.toLowerCase())) continue;
    const outside = defs.filter((item) => !ownedSet.has(item.file));
    if (!outside.length) continue;
    externalCandidates.set(name, outside[0]);
  }
  const externalGlobalsMap = new Map();
  if (externalCandidates.size) {
    const extPattern = new RegExp(`\\b(${[...externalCandidates.keys()].join('|')})\\b`, 'g');
    const fnParamCache = new Map();
    const isFnParam = (prepared, def, name) => {
      if (!def) return false;
      const key = `${prepared.file}:${def.start}`;
      if (!fnParamCache.has(key)) {
        const from = prepared.starts[def.start - 1] ?? 0;
        const brace = prepared.plain.indexOf('{', from);
        fnParamCache.set(key, brace > from ? prepared.plain.slice(from, brace) : '');
      }
      const sig = fnParamCache.get(key);
      return Boolean(sig) && new RegExp(`\\b${name}\\b`).test(sig);
    };
    for (const file of owned) {
      if (!C_SOURCE.test(file) && !C_HEADER.test(file)) continue;
      const prepared = source(file);
      if (!prepared) continue;
      const { plain, starts } = prepared;
      for (const match of plain.matchAll(extPattern)) {
        const name = match[1];
        const previous = plain.slice(Math.max(0, match.index - 8), match.index);
        if (/(?:\.|->)\s*$/.test(previous)) continue;
        const line = lineOf(starts, match.index);
        if (prepared.guards[line - 1]?.dead) continue;
        const lineText = plain.slice(starts[line - 1], starts[line] ?? plain.length);
        if (/\bextern\b/.test(lineText)) continue;
        const def = enclosing(file, line);
        if (!def && C_HEADER.test(file)) continue;
        if (isFnParam(prepared, def, name)) continue;
        const target = externalCandidates.get(name);
        const key = `${name}|${target.file}`;
        if (!externalGlobalsMap.has(key))
          externalGlobalsMap.set(key, {
            name,
            file: target.file,
            line: target.line,
            owner: owner(target.file),
            module: moduleOf.get(target.file),
            sites: [],
          });
        const entry = externalGlobalsMap.get(key);
        const kind = accessKind(plain, match.index, name, target.array, target.isConst);
        if (!entry.sites.some((site) => site.file === file && site.line === line && site.kind === kind))
          entry.sites.push({ file, line, function: def?.name, kind });
      }
    }
  }
  const externalGlobals = [...externalGlobalsMap.values()]
    .map((item) => ({
      ...item,
      sites: item.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    }))
    .sort((a, b) => {
      const score = (entry) => entry.sites.filter((site) => site.kind !== 'read').length * 1000 + entry.sites.length;
      return score(b) - score(a) || a.name.localeCompare(b.name);
    });

  // X-Macro tables owned by or expanded in this module.
  const xmacros = (model.xmacroTables || []).filter(
    (item) => ownedSet.has(item.file) || (item.sites || []).some((site) => ownedSet.has(site.file))
  );

  // Storage & address macros / IDs used or defined by the module, with all active #if definitions.
  const addressUses = new Map();
  const addAddressToken = (name, site, isDefine) => {
    if (!addressUses.has(name)) addressUses.set(name, { sites: [], definedInOwned: false });
    const record = addressUses.get(name);
    if (isDefine) {
      record.definedInOwned = true;
      return;
    }
    if (site && !record.sites.some((item) => item.file === site.file && item.line === site.line))
      record.sites.push(site);
  };
  for (const file of owned) {
    const prepared = source(file);
    if (!prepared) continue;
    for (const tokenPattern of [ADDRESS_MACRO, STORAGE_ID]) {
      for (const match of prepared.code.matchAll(tokenPattern)) {
        const line = lineOf(prepared.starts, match.index);
        if (prepared.guards[line - 1]?.dead) continue;
        const lineText = prepared.code.slice(prepared.starts[line - 1], prepared.starts[line] ?? prepared.code.length);
        if (new RegExp(`^\\s*#\\s*define\\s+${match[0]}\\b`).test(lineText)) {
          addAddressToken(match[0], null, true);
          continue;
        }
        addAddressToken(match[0], { file, line }, false);
      }
    }
  }
  const functionNames = new Set(functions.map(([name]) => name).filter((name) => typeof name === 'string'));
  const addressCandidates = [...addressUses]
    .map(([name, info]) => ({
      name,
      sites: info.sites,
      definedInOwned: info.definedInOwned,
      definitions: [],
      enumDef: undefined,
    }))
    .sort((a, b) => b.sites.length - a.sites.length || a.name.localeCompare(b.name))
    .slice(0, LIMITS.addresses * 4);
  if (addressCandidates.length) {
    const wanted = new Map(addressCandidates.map((item) => [item.name, item]));
    const define = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+(${[...wanted.keys()].join('|')})\\b(.*)$`, 'gm');
    // The module's own files first, then the rest of the project.
    const searchOrder = [...owned, ...indexed.filter((item) => !ownedSet.has(item))];
    for (const file of searchOrder) {
      const prepared = source(file);
      if (!prepared) continue;
      for (const match of prepared.code.matchAll(define)) {
        const item = wanted.get(match[1]);
        const line = lineOf(prepared.starts, match.index);
        if (prepared.guards[line - 1]?.dead) continue;
        if (item.definitions.some((known) => known.file === file && known.line === line)) continue;
        const raw = macroLine(prepared, line);
        // A function-like macro keeps its parameters with its name: NVM_ADDR(block) = (block).
        const parts = /^\s*#\s*define\s+\w+(\([^)]*\))?(.*)$/.exec(raw) || [];
        item.definitions.push({
          file,
          line,
          params: parts[1] || '',
          value: collapse(parts[2] || '').slice(0, 120),
          conditions: prepared.guards[line - 1]?.conditions || [],
        });
      }
    }
    // For storage IDs defined via enum or X-Macro (not #define), locate their header definition.
    const unresolved = addressCandidates.filter((item) => !item.definitions.length && !functionNames.has(item.name));
    if (unresolved.length) {
      const enumMap = new Map(unresolved.map((item) => [item.name, item]));
      const enumPattern = new RegExp(`\\b(${[...enumMap.keys()].join('|')})\\b`, 'g');
      const headerOrder = searchOrder.filter((file) => C_HEADER.test(file) || ownedSet.has(file));
      for (const file of headerOrder) {
        if ([...enumMap.values()].every((item) => item.enumDef)) break;
        const prepared = source(file);
        if (!prepared) continue;
        for (const match of prepared.plain.matchAll(enumPattern)) {
          const item = enumMap.get(match[1]);
          if (!item || item.enumDef) continue;
          const line = lineOf(prepared.starts, match.index);
          if (prepared.guards[line - 1]?.dead) continue;
          const lineText = prepared.plain.slice(
            prepared.starts[line - 1],
            prepared.starts[line] ?? prepared.plain.length
          );
          // Match enumerator declarations (`NAME = ...`, `NAME,`) or X-Macro table rows (`ENTRY(NAME, ...)`).
          const isEnumOrXMacro =
            new RegExp(`^\\s*${match[1]}\\s*(?:=|,|$)`).test(lineText) ||
            new RegExp(`\\b[A-Z][A-Z0-9_]*\\s*\\(\\s*${match[1]}\\b`).test(lineText);
          if (isEnumOrXMacro) {
            item.enumDef = { file, line, conditions: prepared.guards[line - 1]?.conditions || [] };
          }
        }
      }
    }
  }
  // Uppercase functions such as LOG_ADDR(id) match ADDRESS_MACRO; keep them only when #defined or enum-defined.
  const allAddresses = addressCandidates
    .filter((item) => item.definitions.length || item.enumDef || !functionNames.has(item.name))
    .map((item) => ({ ...item, definition: item.definitions[0] }));

  // Build switches and their active #define values in project headers.
  const switches = new Map();
  for (const file of owned) {
    const prepared = source(file);
    if (!prepared) continue;
    for (const line of prepared.code.split('\n')) {
      const directive = DIRECTIVE_IF.exec(line.replace(/\r$/, ''));
      if (!directive) continue;
      for (const name of directive[1].match(/\b[A-Za-z_]\w*\b/g) || []) {
        // Include guards such as SENSOR_H or __SENSOR_H__ are not switches.
        if (NOT_SWITCHES.has(name) || /_H_*$/.test(name)) continue;
        switches.set(name, (switches.get(name) || 0) + 1);
      }
    }
  }
  const sortedSwitches = [...switches].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const switchDefs = new Map();
  if (sortedSwitches.length) {
    if (!cache.headerDefines) {
      cache.headerDefines = new Map();
      const headerFiles = indexed
        .filter((file) => C_HEADER.test(file) && !foreign(file))
        .sort((a, b) => Number(CONFIG_HEADER_NAME.test(b)) - Number(CONFIG_HEADER_NAME.test(a)) || a.localeCompare(b));
      for (const file of headerFiles) {
        const prepared = source(file);
        if (!prepared) continue;
        for (const match of prepared.code.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)\b(.*)$/gm)) {
          const name = match[1];
          if (NOT_SWITCHES.has(name) || /_H_*$/.test(name)) continue;
          const line = lineOf(prepared.starts, match.index);
          if (prepared.guards[line - 1]?.dead) continue;
          const value = collapse(match[2] || '').slice(0, 40) || 'defined';
          if (!cache.headerDefines.has(name)) cache.headerDefines.set(name, []);
          const list = cache.headerDefines.get(name);
          if (!list.some((known) => known.file === file && known.line === line)) list.push({ file, line, value });
        }
      }
    }
    for (const [name] of sortedSwitches.slice(0, LIMITS.switches)) {
      const defs = cache.headerDefines.get(name);
      if (defs?.length) switchDefs.set(name, defs);
    }
  }

  // What the index missed.
  // A function defined through a macro, such as HANDLER(name) { ... }, is indexed under the
  // expanded name: a graph function starting on the same line counts.
  const indexedNames = new Set();
  for (const [name, file, start] of functions)
    if (ownedSet.has(file)) indexedNames.add(`${name}|${file}`).add(`${file}:${Number(start)}`);
  const missingFunctions = definitions.filter(
    (item) => !indexedNames.has(`${item.name}|${item.file}`) && !indexedNames.has(`${item.file}:${item.line}`)
  );

  return {
    owned,
    unmatched,
    unindexedFiles,
    driftFiles,
    fileStates,
    tasks,
    entries,
    structs,
    vectorEntries,
    timers,
    isrs,
    internalCalls,
    provides,
    uses,
    globals,
    externalGlobals,
    types: { structs: typeStructs, enums: typeEnums, headerInlines },
    xmacros,
    addresses: allAddresses,
    switches: sortedSwitches,
    switchDefs,
    missingFunctions,
    expertNames: new Map(experts.map((item) => [item.id, item.name])),
  };
}

/** An expert's name, "shared", or the detected module of an unowned file. */
function ownerLabel(owner, data, t, module) {
  if (owner === 'shared') return t.ownerShared;
  if (owner === undefined) return module ? `${module} (${t.ownerUnowned})` : t.ownerUnowned;
  return data.expertNames.get(owner) || owner;
}

/** Pick up to `max` callers while guaranteeing at least one call site per distinct expert owner. */
function selectCallers(callers, max) {
  if (callers.length <= max) return callers;
  const picked = new Set();
  const seenOwners = new Set();
  for (let index = 0; index < callers.length && picked.size < max; index++) {
    const item = callers[index];
    if (item.owner !== undefined && item.owner !== 'shared' && !seenOwners.has(item.owner)) {
      seenOwners.add(item.owner);
      picked.add(index);
    }
  }
  for (let index = 0; index < callers.length && picked.size < max; index++) picked.add(index);
  return [...picked].sort((a, b) => a - b).map((index) => callers[index]);
}

function sitesText(list, max, t) {
  return (
    list
      .slice(0, max)
      .map((item) => `${item.function ? `${code(item.function)} ` : ''}(${at(item.file, item.line)})`)
      .join(', ') + more(list, max, t)
  );
}

/** The generated part of a feature card. */
function renderBrief(data, labels, { date, mode }) {
  const t = labels;
  const out = [fill(t.briefBasis, { date, mode }), ''];

  out.push(`## ${t.briefFiles}`, '');
  if (!data.fileStates.length) out.push(t.briefNoFiles);
  for (const item of data.fileStates) {
    const names =
      item.names.slice(0, LIMITS.fileFunctions).map(code).join(', ') + more(item.names, LIMITS.fileFunctions, t);
    const notes = [`${fill(t.fileFunctions, { count: item.functions })}${item.names.length ? ` (${names})` : ''}`];
    if (item.tables?.length && t.fileTables) {
      const items =
        item.tables
          .slice(0, LIMITS.fileTables)
          .map(
            (entry) =>
              `${code(entry.name)} (${entry.start === entry.end ? entry.start : `${entry.start}-${entry.end}`})`
          )
          .join(', ') + more(item.tables, LIMITS.fileTables, t);
      notes.push(fill(t.fileTables, { items }));
    }
    if (item.status === 'unusable') notes.push(t.fileUnusable);
    else if (item.status === 'partial')
      notes.push(
        fill(t.filePartial, {
          ranges: item.ranges
            .map((range) => (range.start === range.end ? range.start : `${range.start}-${range.end}`))
            .join(', '),
        })
      );
    if (item.changed) notes.push(t.fileChanged);
    out.push(`- ${item.file}: ${notes.join('; ')}`);
  }
  for (const entry of data.unmatched) out.push(`- ${fill(t.entryNoFile, { entry: code(entry) })}`);
  if (data.unindexedFiles?.length && t.unindexedFiles)
    out.push(`- ${fill(t.unindexedFiles, { files: data.unindexedFiles.map(code).join(', ') })}`);
  if (data.driftFiles?.length && t.driftFiles)
    out.push(`- ${fill(t.driftFiles, { files: data.driftFiles.map(code).join(', ') })}`);
  out.push('');

  const internalSuffix = (fnNames) => {
    if (!data.internalCalls || !t.entryInternalCalls) return '';
    const callees = [...new Set(fnNames.flatMap((name) => data.internalCalls.get(name) || []))];
    if (!callees.length) return '';
    return `; ${fill(t.entryInternalCalls, {
      callees: callees.slice(0, LIMITS.internalCallees).map(code).join(', ') + more(callees, LIMITS.internalCallees, t),
    })}`;
  };

  out.push(`## ${t.briefEntries}`, '');
  const scheduled = [];
  for (const task of data.tasks)
    scheduled.push(`- ${fill(t.taskLine, { name: code(task.name), site: task.site })}${internalSuffix([task.name])}`);
  for (const entry of data.entries) {
    const parts = [
      fill(t.entryLine, {
        table: code(entry.table),
        position: entry.position,
        names: entry.names.map(code).join(', '),
      }),
    ];
    if (entry.conditions.length) parts.push(fill(t.onlyWhen, { condition: code(entry.conditions.join(' && ')) }));
    if (entry.dispatcher)
      parts.push(
        entry.task && entry.task !== entry.dispatcher
          ? fill(t.entryRunByTask, { dispatcher: code(entry.dispatcher), task: code(entry.task) })
          : fill(t.entryRunBy, { dispatcher: code(entry.dispatcher) })
      );
    const note = entry.comment ? ` — ${collapse(entry.comment)}` : '';
    scheduled.push(`- ${parts.join('; ')} (${entry.site})${note}${internalSuffix(entry.names)}`);
  }
  for (const item of data.structs)
    scheduled.push(
      `- ${fill(t.structLine, {
        table:
          item.tables
            .slice(0, LIMITS.structTables)
            .map((table) => code(table.name))
            .join(', ') + more(item.tables, LIMITS.structTables, t),
        type: code(item.type),
        field: code(`.${item.field}`),
        functions: item.functions.map(code).join(', '),
      })} (${item.tables[0].site})${
        item.calls.length
          ? `; ${fill(t.calledThrough, {
              sites:
                item.calls
                  .slice(0, LIMITS.sites)
                  .map((call) => `${code(call.name)} (${call.site})`)
                  .join(', ') + more(item.calls, LIMITS.sites, t),
            })}`
          : ''
      }${internalSuffix(item.functions)}`
    );
  for (const vec of data.vectorEntries || []) {
    const items =
      vec.items
        .slice(0, LIMITS.structTables * 3)
        .map((entry) =>
          entry.macro !== entry.target ? `${code(entry.macro)} → ${code(entry.target)}` : code(entry.target)
        )
        .join(', ') + more(vec.items, LIMITS.structTables * 3, t);
    scheduled.push(`- ${fill(t.vectorEntryLine, { base: code(vec.base), header: vec.header, items })}`);
  }
  for (const timer of data.timers || [])
    scheduled.push(
      `- ${fill(t.timerLine, { name: code(timer.name), site: timer.site })}${internalSuffix([timer.name])}`
    );
  for (const isr of data.isrs || [])
    scheduled.push(`- ${fill(t.isrLine, { name: code(isr.name), site: isr.site })}${internalSuffix([isr.name])}`);
  out.push(...(scheduled.length ? scheduled : [t.entriesNone]), '');

  out.push(`## ${t.briefProvides}`, '');
  if (!data.provides.length) out.push(t.providesNone);
  for (const item of data.provides.slice(0, LIMITS.provides)) {
    const shownCallers = selectCallers(item.callers, LIMITS.callers);
    const callers = shownCallers
      .map((caller) => `${code(caller.name)} (${caller.site}, ${ownerLabel(caller.owner, data, t, caller.module)})`)
      .join(', ');
    out.push(`- ${code(item.name)} (${item.site}) ← ${callers}${more(item.callers, shownCallers.length, t)}`);
  }
  if (data.provides.length > LIMITS.provides) {
    // Name the rest: an expert tracing a path must still see that a function of theirs is called from outside.
    const rest = data.provides.slice(LIMITS.provides);
    const names = rest
      .slice(0, LIMITS.provideNames)
      .map((item) => code(item.name))
      .join(', ');
    out.push(
      `- ${fill(t.moreProvides, { count: rest.length, names: names + (rest.length > LIMITS.provideNames ? ', …' : '') })}`
    );
  }
  out.push('', t.providesGap, '');

  out.push(`## ${t.briefUses}`, '');
  if (!data.uses.length) out.push(t.none);
  let shown = 0;
  const hiddenUseGroups = [];
  for (const group of data.uses) {
    if (shown >= LIMITS.uses) {
      hiddenUseGroups.push(group);
      continue;
    }
    const list = group.functions.slice(0, LIMITS.uses - shown);
    shown += list.length;
    out.push(
      `- ${ownerLabel(group.owner, data, t, group.module)}: ${list.map((item) => `${code(item.name)} (${item.file})`).join(', ')}${more(group.functions, list.length, t)}`
    );
  }
  if (hiddenUseGroups.length && t.moreUses) {
    const groups = hiddenUseGroups
      .map((group) => `${ownerLabel(group.owner, data, t, group.module)} (${group.functions.length})`)
      .join(', ');
    out.push(`- ${fill(t.moreUses, { count: hiddenUseGroups.length, groups })}`);
  }
  out.push('');

  out.push(`## ${t.briefGlobals}`, '', t.globalsIntro, '');
  // Globals other files write come first; those no other file uses share one line.
  const touched = (item) => item.users.filter((user) => user.kind !== 'read').length * 1000 + item.users.length;
  const exported = data.globals
    .filter((item) => !item.isStatic && item.users.length)
    .sort((a, b) => touched(b) - touched(a));
  const unused = data.globals.filter((item) => !item.isStatic && !item.users.length);
  const statics = data.globals.filter((item) => item.isStatic);
  if (!data.globals.length) out.push(t.none);
  for (const item of exported.slice(0, LIMITS.globals)) {
    const tags = [];
    if (item.conditions.length) tags.push(fill(t.onlyWhen, { condition: code(item.conditions.join(' && ')) }));
    if (!item.inGraph) tags.push(t.notInGraph);
    const kinds = ['write', 'address', 'read']
      .map((kind) => [kind, item.users.filter((user) => user.kind === kind)])
      .filter(([, list]) => list.length)
      .map(([kind, list]) => fill(t[`global_${kind}`], { sites: sitesText(list, LIMITS.sites, t) }));
    out.push(
      `- ${code(item.name)} (${at(item.file, item.line)})${tags.length ? ` [${tags.join('; ')}]` : ''}: ${kinds.length ? kinds.join('; ') : t.globalUnused}`
    );
  }
  if (exported.length > LIMITS.globals) {
    const rest = exported.slice(LIMITS.globals);
    const restNames = rest
      .slice(0, LIMITS.globalNames)
      .map((item) => code(item.name))
      .join(', ');
    out.push(
      `- ${fill(t.moreGlobals, { count: rest.length, names: restNames + (rest.length > LIMITS.globalNames ? ', …' : '') })}`
    );
  }
  const names = (list) =>
    list
      .slice(0, LIMITS.statics)
      .map((item) => `${code(item.name)}${item.inGraph ? '' : '*'}`)
      .join(', ') + more(list, LIMITS.statics, t);
  if (unused.length) out.push(`- ${t.globalUnused}: ${names(unused)}`);
  if (statics.length) out.push(`- ${fill(t.globalStatics, { names: names(statics) })}`);
  out.push('');

  if (data.externalGlobals?.length && t.briefExternalGlobals) {
    out.push(`## ${t.briefExternalGlobals}`, '', t.externalGlobalsIntro, '');
    for (const item of data.externalGlobals.slice(0, LIMITS.externalGlobals)) {
      const kinds = ['write', 'address', 'read']
        .map((kind) => [kind, item.sites.filter((site) => site.kind === kind)])
        .filter(([, list]) => list.length)
        .map(([kind, list]) => fill(t[`global_${kind}`], { sites: sitesText(list, LIMITS.sites, t) }));
      out.push(
        `- ${code(item.name)} (${at(item.file, item.line)}, ${ownerLabel(item.owner, data, t, item.module)}): ${kinds.join('; ')}`
      );
    }
    if (data.externalGlobals.length > LIMITS.externalGlobals && t.moreExternalGlobals) {
      const rest = data.externalGlobals.slice(LIMITS.externalGlobals);
      const restNames = rest
        .slice(0, LIMITS.externalGlobalNames)
        .map((item) => code(item.name))
        .join(', ');
      out.push(
        `- ${fill(t.moreExternalGlobals, { count: rest.length, names: restNames + (rest.length > LIMITS.externalGlobalNames ? ', …' : '') })}`
      );
    }
    out.push('');
  }

  const hasTypes =
    data.types?.structs.length || data.types?.enums.length || data.types?.headerInlines.length || data.xmacros?.length;
  if (hasTypes && t.briefTypes) {
    out.push(`## ${t.briefTypes}`, '');
    if (data.types.structs.length) {
      const items =
        data.types.structs
          .slice(0, LIMITS.types)
          .map((item) => `${code(item.name)} (${at(item.file, item.line)})`)
          .join(', ') + more(data.types.structs, LIMITS.types, t);
      out.push(`- ${fill(t.typesStructs, { items })}`);
    }
    if (data.types.enums.length) {
      const items =
        data.types.enums
          .slice(0, LIMITS.types)
          .map((item) => `${code(item.name)} (${at(item.file, item.line)})`)
          .join(', ') + more(data.types.enums, LIMITS.types, t);
      out.push(`- ${fill(t.typesEnums, { items })}`);
    }
    if (data.types.headerInlines.length) {
      const items =
        data.types.headerInlines
          .slice(0, LIMITS.types)
          .map((item) => `${code(item.name)} (${at(item.file, item.line)})`)
          .join(', ') + more(data.types.headerInlines, LIMITS.types, t);
      out.push(`- ${fill(t.typesHeaderInlines, { items })}`);
    }
    for (const xm of data.xmacros || []) {
      const sites = (xm.sites || [])
        .slice(0, LIMITS.sites)
        .map((site) => at(site.file, site.line))
        .join(', ');
      out.push(
        `- ${fill(t.xmacroLine, {
          file: xm.file,
          macro: code(xm.macro),
          count: xm.count,
          sites: sites + more(xm.sites || [], LIMITS.sites, t),
        })}`
      );
    }
    out.push('');
  }

  out.push(`## ${t.briefAddresses}`, '');
  if (!data.addresses.length) out.push(t.none);
  for (const item of data.addresses.slice(0, LIMITS.addresses)) {
    const defs = item.definitions?.length ? item.definitions : item.definition ? [item.definition] : [];
    const formatDef = (def) => {
      const base = fill(t.addressDefined, {
        value: code(def.value || '—'),
        site: at(def.file, def.line),
      });
      return def.conditions?.length
        ? `${base} [${fill(t.onlyWhen, { condition: code(def.conditions.join(' && ')) })}]`
        : base;
    };
    const definition = defs.length
      ? defs.slice(0, 3).map(formatDef).join(' / ') + more(defs, 3, t)
      : item.enumDef
        ? fill(t.addressEnumDefined, { site: at(item.enumDef.file, item.enumDef.line) }) +
          (item.enumDef.conditions?.length
            ? ` [${fill(t.onlyWhen, { condition: code(item.enumDef.conditions.join(' && ')) })}]`
            : '')
        : t.addressUndefined;
    const usage = item.sites.length
      ? fill(t.addressUsed, {
          sites:
            item.sites
              .slice(0, LIMITS.addressSites)
              .map((site) => at(site.file, site.line))
              .join(', ') + more(item.sites, LIMITS.addressSites, t),
        })
      : t.addressDefinedOnly;
    out.push(`- ${code(item.name + (defs[0]?.params ?? ''))}: ${definition}; ${usage}`);
  }
  if (data.addresses.length > LIMITS.addresses && t.moreAddresses) {
    const rest = data.addresses.slice(LIMITS.addresses);
    const restNames = rest
      .slice(0, LIMITS.addressNames)
      .map((item) => code(item.name))
      .join(', ');
    out.push(
      `- ${fill(t.moreAddresses, { count: rest.length, names: restNames + (rest.length > LIMITS.addressNames ? ', …' : '') })}`
    );
  }
  out.push('');

  out.push(`## ${t.briefSwitches}`, '');
  const formatSwitch = ([name, count]) => {
    const defs = data.switchDefs?.get(name);
    if (!defs?.length) return `${code(name)} ×${count}`;
    const note =
      defs.length === 1
        ? fill(t.switchActive, { value: code(defs[0].value), site: at(defs[0].file, defs[0].line) })
        : fill(t.switchMultiDef, {
            count: defs.length,
            value: code(defs[0].value),
            site: at(defs[0].file, defs[0].line),
          });
    return `${code(name)} ×${count} (${note})`;
  };
  out.push(
    data.switches.length
      ? data.switches.slice(0, LIMITS.switches).map(formatSwitch).join(', ') + more(data.switches, LIMITS.switches, t)
      : t.none,
    ''
  );

  out.push(`## ${t.briefCheck}`, '', t.checkIntro, '');
  const checks = checkLines(data, t);
  out.push(...(checks.length ? checks : [t.checkNone]), '');
  return out.join('\n');
}

function checkLines(data, t) {
  const lines = [];
  for (const item of data.fileStates) {
    if (item.status === 'unusable') lines.push(`- ${fill(t.checkUnusable, { file: item.file })}`);
    else if (item.status === 'partial')
      lines.push(
        `- ${fill(t.checkPartial, { file: item.file, ranges: item.ranges.map((range) => (range.start === range.end ? range.start : `${range.start}-${range.end}`)).join(', ') })}`
      );
    if (item.changed) lines.push(`- ${fill(t.checkChanged, { file: item.file })}`);
  }
  if (data.missingFunctions.length)
    lines.push(
      `- ${fill(t.checkMissingFunctions, {
        names:
          data.missingFunctions
            .slice(0, LIMITS.missing)
            .map((item) => `${code(item.name)} (${at(item.file, item.line)})`)
            .join(', ') + more(data.missingFunctions, LIMITS.missing, t),
      })}`
    );
  const missingGlobals = data.globals.filter((item) => !item.inGraph);
  if (missingGlobals.length)
    lines.push(
      `- ${fill(t.checkMissingGlobals, {
        count: missingGlobals.length,
        names:
          missingGlobals
            .slice(0, LIMITS.missing)
            .map((item) => code(item.name))
            .join(', ') + more(missingGlobals, LIMITS.missing, t),
      })}`
    );
  for (const entry of data.unmatched) lines.push(`- ${fill(t.entryNoFile, { entry: code(entry) })}`);
  if (data.unindexedFiles?.length && t.unindexedFiles)
    lines.push(`- ${fill(t.unindexedFiles, { files: data.unindexedFiles.map(code).join(', ') })}`);
  if (data.driftFiles?.length && t.driftFiles)
    lines.push(`- ${fill(t.driftFiles, { files: data.driftFiles.map(code).join(', ') })}`);
  return lines;
}

/** Structural fingerprint of the expert's boundaries and schedule, so architecture shifts mark ready cards stale. */
const DRIFT_SIGNATURE_VERSION = 'v3';
const sortedUnique = (items) => [...new Set(items)].sort();

/**
 * What makes a ready card stale besides the expert's own files: paths that match nothing,
 * unowned or unindexed files in the module, and where the module is scheduled (tasks,
 * dispatch tables, struct function tables and inter-image vector APIs). Names only: line
 * numbers and table positions move whenever other files or other modules' entries change.
 */
function driftSignature(data) {
  return [
    DRIFT_SIGNATURE_VERSION,
    `u:${sortedUnique(data.unmatched || []).join(',')}`,
    `d:${sortedUnique(data.driftFiles || []).join(',')}`,
    `x:${sortedUnique(data.unindexedFiles || []).join(',')}`,
    `t:${sortedUnique((data.tasks || []).map((task) => task.name)).join(',')}`,
    `e:${sortedUnique(
      (data.entries || []).map(
        (entry) =>
          `${entry.table}:${entry.names.join(',')}${entry.conditions.length ? `?${entry.conditions.join('&&')}` : ''}`
      )
    ).join(',')}`,
    `s:${sortedUnique(
      (data.structs || []).map((item) => `${item.type}.${item.field}:${sortedUnique(item.functions || []).join(',')}`)
    ).join(',')}`,
    `v:${sortedUnique(
      (data.vectorEntries || []).map(
        (vec) =>
          `${vec.base}:${sortedUnique((vec.items || []).map((entry) => `${entry.macro}->${entry.target}`)).join(',')}`
      )
    ).join(',')}`,
  ].join('\n');
}

/** Whether a stored signature was made by this version of `driftSignature`. */
const isCurrentDriftSignature = (signature) =>
  typeof signature === 'string' && signature.startsWith(`${DRIFT_SIGNATURE_VERSION}\n`);

/** The short form the expert's role rules carry, in English like the rest of the rules. */
function digest(data) {
  const missingGlobals = data.globals.filter((item) => !item.inGraph).length;
  const drift = data.driftFiles?.length || 0;
  const unindexed = data.unindexedFiles?.length || 0;
  const writesExternal = (data.externalGlobals || [])
    .filter((item) => item.sites.some((site) => site.kind !== 'read'))
    .slice(0, LIMITS.digestGlobals)
    .map((item) => item.name);
  return {
    files: data.owned.length,
    entries: [
      ...data.tasks.map((task) => `task ${task.name}`),
      ...data.entries.map(
        (entry) =>
          `${entry.table} #${entry.position} ${entry.names.join(', ')}${entry.conditions.length ? ` (if ${entry.conditions.join(' && ')})` : ''}`
      ),
      ...data.structs.map(
        (item) =>
          `${item.tables[0].name}${item.tables.length > 1 ? ` (+${item.tables.length - 1})` : ''}.${item.field} = ${item.functions.join(', ')}`
      ),
      ...(data.vectorEntries || []).map(
        (vec) =>
          `vector ${vec.base}: ${vec.items
            .slice(0, 4)
            .map((item) => item.macro)
            .join(', ')}`
      ),
      ...(data.timers || []).map((timer) => `timer ${timer.name}`),
      ...(data.isrs || []).map((isr) => `isr ${isr.name}`),
    ].slice(0, LIMITS.digestEntries),
    provides: data.provides.slice(0, LIMITS.digestProvides).map((item) => ({
      name: item.name,
      callers: [...new Set(item.callers.map((caller) => ownerLabelPlain(caller.owner, data, caller.module)))],
    })),
    writtenOutside: data.globals
      .filter((item) => item.users.some((user) => user.kind !== 'read'))
      .slice(0, LIMITS.digestGlobals)
      .map((item) => item.name),
    ...(writesExternal.length ? { writesExternal } : {}),
    issues: {
      partial: data.fileStates.filter((item) => item.status === 'partial').length,
      unusable: data.fileStates.filter((item) => item.status === 'unusable').length,
      changed: data.fileStates.filter((item) => item.changed).length,
      missingFunctions: data.missingFunctions.length,
      missingGlobals,
      unmatched: data.unmatched.length,
      ...(unindexed ? { unindexed } : {}),
      ...(drift ? { drift } : {}),
    },
  };
}

function ownerLabelPlain(owner, data, module) {
  if (owner === 'shared') return 'shared';
  if (owner === undefined) return module ? `${module} (unowned)` : 'unowned';
  return data.expertNames.get(owner) || owner;
}

// ---------------------------------------------------------------------------
// Feature card file
// ---------------------------------------------------------------------------

const CARD_HEADER = (id, language) => `<!-- woody:module id=${id} version=1 language=${language} -->`;
const USER_CORRECTIONS_HEADING =
  /^(#{2,3})\s+(?:corrections from the user|user corrections|用户更正)(?=$|[\s:：(（—-])/i;

/** Remove the user-owned corrections section so user notes never count as an expert review. */
function stripUserCorrections(lines) {
  const kept = [];
  let skipLevel = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = /^(#{1,6})\s+/.exec(trimmed);
    if (skipLevel > 0) {
      if (heading && heading[1].length <= skipLevel) {
        skipLevel = 0;
      } else {
        continue;
      }
    }
    const corrections = USER_CORRECTIONS_HEADING.exec(trimmed);
    if (corrections) {
      skipLevel = corrections[1].length;
      continue;
    }
    kept.push(line);
  }
  return kept;
}

/** Lines outside the woody:generated block, minus the leading H1 title and user corrections. */
function ownLines(text, expert) {
  if (text === undefined) return [];
  const start = text.indexOf(MARK.start);
  const end = text.indexOf(MARK.end, start);
  let lines;
  if (start < 0 || end < 0) {
    lines = text.split(/\r?\n/).filter((line) => line.trim() !== `# ${expert.name}`);
  } else {
    const beforeLines = text.slice(0, start).split(/\r?\n/);
    // Ignore the card's leading H1 title even if the expert was later renamed.
    const firstContent = beforeLines.findIndex((line) => line.trim().length > 0);
    if (firstContent >= 0 && /^#\s+\S/.test(beforeLines[firstContent].trim())) beforeLines.splice(firstContent, 1);
    lines = [...beforeLines, ...text.slice(end + MARK.end.length).split(/\r?\n/)];
  }
  return stripUserCorrections(lines);
}

/**
 * The whole card. The intro sits inside the generated block, so a new card holds nothing
 * of its own but its title; an existing card keeps everything outside the markers, and one
 * without markers gets the block at its end.
 */
function mergeCard(existing, generated, expert, labels, language) {
  const block = [
    MARK.start,
    CARD_HEADER(expert.id, language),
    '',
    labels.cardIntro,
    '',
    generated.trimEnd(),
    MARK.end,
  ].join('\n');
  if (existing === undefined) return `# ${expert.name}\n\n${block}\n`;
  const start = existing.indexOf(MARK.start);
  const end = existing.indexOf(MARK.end, start);
  if (start < 0 || end < 0) return `${existing.trimEnd()}\n\n${block}\n`;
  return existing.slice(0, start) + block + existing.slice(end + MARK.end.length);
}

/**
 * What the expert wrote: everything outside the markers except the leading H1 title and the
 * user's corrections section, with whitespace collapsed. Empty while the expert has written
 * nothing (even if the user left notes in "Corrections from the user").
 */
function ownPart(text, expert) {
  return ownLines(text, expert).join(' ').replace(/\s+/g, ' ').trim();
}

const REQUIRED_CARD_SECTIONS = [
  ['files', /file|文件/i],
  ['entry', /entry|schedul|lifecycle|入口|调度|生命周期/i],
  ['flow', /flow|流程/i],
  ['parameters', /param|storage|default|nvm|eeprom|参数|存储|默认/i],
  ['dataSources', /data\s*source|dependenc|数据来源|外部依赖/i],
  ['outputs', /output|interface|api|输出|接口/i],
  ['switches', /switch|variant|build|开关|宏|编译/i],
  ['gaps', /gap|index\s*check|盲区|索引核对|核对/i],
];

/** Key module-card sections missing from the expert-authored portion of a card. */
function missingCardSections(text, expert) {
  const headings = ownLines(text, expert)
    .map((line) => /^#{2,3}\s+(.+)$/.exec(line.trim())?.[1])
    .filter(Boolean);
  return REQUIRED_CARD_SECTIONS.filter(([, pattern]) => !headings.some((title) => pattern.test(title))).map(
    ([id]) => id
  );
}

/** Language of an existing card, from its generated header. */
function cardLanguage(text) {
  return /<!-- woody:module id=[\w-]+ version=\d+ language=([A-Za-z-]+) -->/.exec(text || '')?.[1];
}

/**
 * Card state after a generation: `missing` while the expert has written nothing, `stale` when
 * the module's files changed after the expert last updated the card, otherwise `ready`.
 * `previous` is the stored record; the returned record replaces it.
 */
function cardState(previous, { filesHash, ownHash, hasOwn }) {
  const record = { filesHash, ownHash, reviewedFilesHash: previous?.reviewedFilesHash };
  if (!hasOwn) return { state: 'missing', record: { ...record, reviewedFilesHash: undefined } };
  // The expert changed the card since the last look: it reflects the current files.
  if (!previous || previous.ownHash !== ownHash || !previous.reviewedFilesHash) record.reviewedFilesHash = filesHash;
  return { state: record.reviewedFilesHash === filesHash ? 'ready' : 'stale', record };
}

module.exports = {
  classify,
  suggestShared,
  renderModules,
  collect,
  renderBrief,
  digest,
  driftSignature,
  isCurrentDriftSignature,
  mergeCard,
  ownPart,
  missingCardSections,
  cardLanguage,
  cardState,
  ownerOf,
  entryMatch,
  sourceCache,
  globalsOf,
  definitionsOf,
  typesOf,
  fileTablesOf,
  accessKind,
};
