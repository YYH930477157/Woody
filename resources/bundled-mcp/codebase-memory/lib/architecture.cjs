'use strict';
/**
 * Architecture map of a FreeRTOS C project, built without a model: the tasks and what they
 * wait on and call, the function tables their loops call one by one (in order, with #if
 * conditions and comments), which tables each module registers in, and the functions held
 * in struct fields with the places that call those fields through a pointer.
 *
 * Pure functions: the runtime supplies the index's function list, a source reader and a
 * callers lookup, and writes the result. Nothing here reads files or starts processes.
 */

const CREATE_APIS = ['xTaskCreate', 'xTaskCreateStatic', 'osThreadNew'];
const WAIT_APIS = [
  'vTaskDelay',
  'vTaskDelayUntil',
  'xTaskDelayUntil',
  'ulTaskNotifyTake',
  'ulTaskNotifyTakeIndexed',
  'xTaskNotifyWait',
  'xTaskNotifyWaitIndexed',
  'xQueueReceive',
  'xQueuePeek',
  'xSemaphoreTake',
  'xSemaphoreTakeRecursive',
  'xEventGroupWaitBits',
  'xStreamBufferReceive',
  'xMessageBufferReceive',
  'vTaskSuspend',
  'osDelay',
  'osDelayUntil',
  'osMessageQueueGet',
  'osSemaphoreAcquire',
  'osMutexAcquire',
  'osEventFlagsWait',
  'osThreadFlagsWait',
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'case', 'do', 'else', 'defined']);
/** Identifiers in a table entry that never name its function. */
const NOT_NAMES = new Set(['NULL', 'nullptr', 'TRUE', 'FALSE', 'true', 'false', 'sizeof', 'void', 'const', 'static']);
/** A table joins the module matrix when its functions come from at least this many files. */
const MATRIX_MIN_FILES = 3;
/**
 * `name[N] = {` for arrays of structs, and `name[N])(args) = {` for arrays of function
 * pointers such as `void (* const list[])(void) = {`.
 */
const ARRAY_DECLARATOR = String.raw`\s*\[[^\];{}]*\]\s*(?:\)\s*\([^;{}]*\)\s*)?=\s*\{`;
const ARRAY_DEFINITION = new RegExp(String.raw`\b([A-Za-z_]\w*)${ARRAY_DECLARATOR}`, 'g');
const ORDER_WORDS =
  /\b(before|after|first|last|must|order|prior)\b|之前|之后|以前|以后|最后|最先|首先|必须|顺序|放在|前面|后面/i;
/** Folders of demos and samples, whose tasks and `main` are not the product's. */
const DEMO_SEGMENTS = new Set(['demo', 'demos', 'example', 'examples', 'sample', 'samples']);
/** Folders whose `main` belongs to a library or a demo, not to the product. */
const FOREIGN_SEGMENTS = new Set([...DEMO_SEGMENTS, 'thirdparty', 'third_party', '3rdparty', 'vendor', 'external']);
const inFolders = (file, names) => file.split('/').some((segment) => names.has(segment.toLowerCase()));
const ROOT_DEPTH = 3;
const MAX_CALLS_SHOWN = 12;
const MAX_OTHER_TABLES = 40;
const MAX_STRUCT_TYPES = 20;
const MAX_TABLES_PER_TYPE = 12;
const MAX_FIELD_FUNCTIONS = 6;
const MAX_FIELD_SITES = 4;
const MAX_TABLE_FIELDS = 10;
const MAX_VECTOR_ITEMS = 8;
const MAX_DATA_FILE_ITEMS = 16;
const C_HEADER_EXT = /\.(h|hh|hpp|hxx)$/i;
const C_SOURCE_EXT = /\.(c|cc|cpp|cxx)$/i;
/** `Type name = {` or `Type name[N] = {`: a struct or an array of structs with an initializer. */
const STRUCT_DEFINITION = /\b([A-Za-z_]\w*)\s+(?:const\s+)?([A-Za-z_]\w*)\s*(?:\[[^\];{}]*\]\s*)?=\s*\{/g;
/** `.field = function`, also `.field = &function` and `.field = (cast)function`. */
const DESIGNATED_FUNCTION =
  /\.\s*([A-Za-z_]\w*)\s*=\s*(?:\(\s*[A-Za-z_][\w\s*]*\)\s*)?&?\s*([A-Za-z_]\w*)\b(?!\s*(?:[([.]|->))/g;
/** Calls through a struct field: `p->field(`, `s.field(`, `list[i].field(` and `(*p->field)(`. */
const FIELD_CALLS = [
  /\b([A-Za-z_]\w*)\s*(?:\[[^[\]]*\]\s*)?(?:->|\.)\s*([A-Za-z_]\w*)\s*\(/g,
  /\(\s*\*\s*([A-Za-z_]\w*)\s*(?:\[[^[\]]*\]\s*)?(?:->|\.)\s*([A-Za-z_]\w*)\s*\)\s*\(/g,
];
/** Words that can stand before a variable name but are not its type. */
const NOT_TYPES = new Set([...KEYWORDS, 'const', 'static', 'struct', 'union', 'enum', 'volatile', 'extern', 'goto']);
const MARK = {
  start: '<!-- woody:generated:start -->',
  end: '<!-- woody:generated:end -->',
  header: (language) => `<!-- woody:architecture version=1 language=${language} -->`,
};

// ---------------------------------------------------------------------------
// C source scanning: no preprocessor and no full parse, only what the map needs.
// ---------------------------------------------------------------------------

const blank = (text) => text.replace(/[^\n]/g, ' ');

/**
 * Comments and string or character literals replaced by spaces, so offsets and lines stay
 * the same; the comments are returned with their offsets.
 */
function scan(text) {
  const code = [];
  const literals = [];
  const comments = [];
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && (next === '/' || next === '*')) {
      let end;
      let body;
      if (next === '/') {
        end = text.indexOf('\n', i);
        if (end < 0) end = n;
        body = text.slice(i + 2, end);
      } else {
        const close = text.indexOf('*/', i + 2);
        end = close < 0 ? n : close + 2;
        body = text.slice(i + 2, close < 0 ? n : close);
      }
      code.push(text.slice(last, i), blank(text.slice(i, end)));
      literals.push(text.slice(last, i), blank(text.slice(i, end)));
      comments.push({ start: i, end, text: cleanComment(body) });
      i = last = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, n);
      const literal = text.slice(i, end);
      code.push(
        text.slice(last, i),
        literal.length > 1 ? literal[0] + blank(literal.slice(1, -1)) + literal[literal.length - 1] : literal
      );
      literals.push(text.slice(last, end));
      i = last = end;
      continue;
    }
    i++;
  }
  code.push(text.slice(last));
  literals.push(text.slice(last));
  // `code` has comments and literals blanked; `literals` keeps the literals, for display.
  return { code: code.join(''), literals: literals.join(''), comments };
}

function cleanComment(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of an offset. */
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * The #if conditions in force on each line, and whether the line is dead (`#if 0`).
 * `#elif` shows only its own condition; `#else` negates the branch it closes.
 */
function guardLines(code) {
  const lines = code.split('\n');
  const result = new Array(lines.length);
  const stack = [];
  let current = { dead: false, conditions: [] };
  const rebuild = () => {
    const conditions = [];
    let dead = false;
    for (const frame of stack) {
      const always = frame.negated ? frame.cond === '0' : frame.cond === '1';
      const never = frame.negated ? frame.cond === '1' : frame.cond === '0';
      if (never) dead = true;
      else if (!always)
        conditions.push(
          frame.negated ? (frame.cond.startsWith('defined(') ? `!${frame.cond}` : `!(${frame.cond})`) : frame.cond
        );
    }
    current = { dead, conditions };
  };
  for (let index = 0; index < lines.length; index++) {
    result[index] = current;
    // CRLF files leave a \r that `.` never matches.
    let line = lines[index].replace(/\r$/, '');
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (!directive) continue;
    let rest = directive[2];
    while (/\\\s*$/.test(line) && index + 1 < lines.length) {
      line = lines[++index].replace(/\r$/, '');
      result[index] = current;
      rest = rest.replace(/\\\s*$/, ' ') + line;
    }
    const cond = rest.replace(/\s+/g, ' ').trim();
    const kind = directive[1];
    if (kind === 'if') stack.push({ cond: cond || '0', negated: false });
    else if (kind === 'ifdef') stack.push({ cond: `defined(${cond})`, negated: false });
    else if (kind === 'ifndef') stack.push({ cond: `defined(${cond})`, negated: true });
    else if (kind === 'elif' && stack.length) stack[stack.length - 1] = { cond: cond || '0', negated: false };
    else if (kind === 'else' && stack.length) stack[stack.length - 1].negated = !stack[stack.length - 1].negated;
    else if (kind === 'endif') stack.pop();
    rebuild();
    // The directive line itself takes the state before it.
  }
  return result;
}

/** Preprocessor lines blanked too, so macro bodies never look like code. */
function blankDirectives(code) {
  const lines = code.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*#/.test(lines[index])) continue;
    let continued = /\\\s*$/.test(lines[index]);
    lines[index] = blank(lines[index]);
    while (continued && index + 1 < lines.length) {
      index++;
      continued = /\\\s*$/.test(lines[index]);
      lines[index] = blank(lines[index]);
    }
  }
  return lines.join('\n');
}

/** Index of the bracket that closes the one at `open`, or -1. */
function matchClose(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Ranges between top-level commas in code[start, end). */
function splitTopLevel(code, start, end) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  parts.push({ start: from, end });
  return parts;
}

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/** One source file, scanned once. */
function prepare(file, text) {
  const { code, literals, comments } = scan(text);
  return {
    file,
    text,
    literals,
    code,
    plain: blankDirectives(code),
    comments,
    starts: lineStarts(text),
    guards: guardLines(code),
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array<[string, string, string|number, string|number]>} input.functions name, file, start and end line from the index
 * @param {string[]} [input.sourceFiles] every indexed file; C and C++ files without functions, such
 *   as a file of parameter tables, are scanned for tables too
 * @param {(file: string) => string | null} input.readSource text of a project file, or null when it cannot be read as text
 * @param {(names: string[]) => Promise<Map<string, string[]>>} input.callersOf functions that call or
 *   reference each name, keyed `name|file` so that same-named functions in other files do not count
 */
async function analyze({ functions, sourceFiles = [], readSource, callersOf }) {
  const byName = new Map();
  const byFile = new Map();
  for (const [name, file, start, end] of functions) {
    // The index also holds virtual files such as <python-builtins>.
    if (typeof name !== 'string' || typeof file !== 'string' || !/^[^<:/\\][^:]*$/.test(file)) continue;
    const def = { name, file, start: Number(start), end: Number(end) };
    if (!Number.isFinite(def.start) || !Number.isFinite(def.end)) continue;
    def.key = `${file}:${def.start}`;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(def);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(def);
  }
  for (const defs of byName.values()) defs.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
  const vectorAliases = new Map();
  const resolveDirect = (name, preferFile) => {
    const defs = byName.get(name);
    if (!defs) return undefined;
    return defs.find((def) => def.file === preferFile) || defs[0];
  };
  const resolve = (name, preferFile) =>
    resolveDirect(name, preferFile) ||
    (vectorAliases.has(name) ? resolveDirect(vectorAliases.get(name), preferFile) : undefined);

  const info = new Map();
  const sites = [];
  const arrayFiles = new Map();
  const dataNames = new Set();
  const unreadable = [];
  // Struct tables whose fields hold functions, the calls through struct fields, and
  // `typedef struct tag {...} Name;` so that `struct tag *p` and `Name *p` compare equal.
  const pendingStructs = [];
  const structLayouts = new Map();
  const globalTypes = new Map();
  const fieldCalls = [];
  const tags = new Map();
  const apiBases = new Map();
  const apiMacros = [];
  const xmacroSites = [];
  const dataTables = [];
  const createPattern = new RegExp(`\\b(${CREATE_APIS.join('|')})\\s*\\(`, 'g');
  const waitPattern = new RegExp(`\\b(${WAIT_APIS.join('|')})\\s*\\(`, 'g');
  const dataFiles = sourceFiles.filter(
    (file) => typeof file === 'string' && /^[^<:/\\][^:]*\.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/i.test(file)
  );
  // Scan headers before sources so cross-image macro aliases and global types are ready when scanning .c bodies.
  const files = [...new Set([...byFile.keys(), ...dataFiles])].sort(
    (a, b) => Number(C_SOURCE_EXT.test(a)) - Number(C_SOURCE_EXT.test(b)) || a.localeCompare(b)
  );
  for (const file of files) {
    const text = readSource(file);
    if (text === null || text === undefined) {
      unreadable.push(file);
      continue;
    }
    const source = prepare(file, text);
    const { plain, literals, starts, guards } = source;
    const offsetOfLine = (line) => (line - 1 < starts.length ? starts[line - 1] : plain.length);
    const defs = (byFile.get(file) || []).slice().sort((a, b) => a.start - b.start);
    const enclosing = (line) =>
      defs.filter((def) => def.start <= line && line <= def.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const live = (offset) => !guards[lineOf(starts, offset) - 1]?.dead;
    const fileTypes = new Map();

    collectStructTypes(source, tags, structLayouts);
    collectGlobalTypes(source, globalTypes);
    collectVectorDirectives(source, byName, apiBases, apiMacros, vectorAliases);
    collectXMacroSites(source, xmacroSites);

    for (const def of defs) {
      const from = offsetOfLine(def.start);
      const to = offsetOfLine(def.end + 1);
      const body = plain.slice(from, to);
      const entry = { def, calls: [], waits: [], dispatches: [] };
      const seen = new Set();
      for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const name = match[1];
        if (KEYWORDS.has(name) || name === def.name || seen.has(name) || !live(from + match.index)) continue;
        if (WAIT_APIS.includes(name) || CREATE_APIS.includes(name)) continue;
        const callee = resolve(name, file);
        if (!callee) continue;
        seen.add(name);
        entry.calls.push(callee);
      }
      for (const match of body.matchAll(waitPattern)) {
        if (!live(from + match.index)) continue;
        const open = from + match.index + match[0].length - 1;
        const close = matchClose(plain, open);
        if (close < 0) continue;
        entry.waits.push(collapse(literals.slice(from + match.index, close + 1)).slice(0, 80));
      }
      const dispatchPatterns = [
        /\b([A-Za-z_]\w*)\s*\[[^[\]]*\]\s*(?:(?:\.|->)\s*[A-Za-z_]\w*\s*)?\(/g,
        /\(\s*\*\s*([A-Za-z_]\w*)\s*\[[^[\]]*\]\s*(?:(?:\.|->)\s*[A-Za-z_]\w*\s*)?\)\s*\(/g,
      ];
      for (const pattern of dispatchPatterns)
        for (const match of body.matchAll(pattern)) {
          if (!live(from + match.index)) continue;
          if (entry.dispatches.some((item) => item.table === match[1])) continue;
          entry.dispatches.push({ table: match[1], line: lineOf(starts, from + match.index) });
        }
      for (const pattern of FIELD_CALLS)
        for (const match of body.matchAll(pattern)) {
          if (!live(from + match.index)) continue;
          const [, base, field] = match;
          const line = lineOf(starts, from + match.index);
          if (fieldCalls.some((call) => call.def === def && call.field === field && call.base === base)) continue;
          if (!fileTypes.has(base)) fileTypes.set(base, declaredType(base, plain));
          fieldCalls.push({ def, field, base, line, type: declaredType(base, body) || fileTypes.get(base) });
        }
      info.set(def.key, entry);
    }

    for (const item of scanStructInitializers(source, dataNames)) pendingStructs.push(item);

    for (const match of plain.matchAll(createPattern)) {
      const line = lineOf(starts, match.index);
      if (guards[line - 1]?.dead) continue;
      const creator = enclosing(line);
      // Prototypes and the RTOS's own definitions are not creation sites.
      if (!creator || CREATE_APIS.includes(creator.name)) continue;
      const open = match.index + match[0].length - 1;
      const close = matchClose(plain, open);
      if (close < 0) continue;
      const args = splitTopLevel(plain, open + 1, close).map((part) => collapse(literals.slice(part.start, part.end)));
      const expression = collapse(plain.slice(open + 1, close).split(',')[0] || '');
      const bare = expression.replace(/^(\(\s*[A-Za-z_][\w\s*]*\)\s*)+/, '').replace(/^&\s*/, '');
      // A wrapper that creates whatever task its caller passes in.
      const signature = plain.slice(offsetOfLine(creator.start), plain.indexOf('{', offsetOfLine(creator.start)));
      const parameter = /^[A-Za-z_]\w*$/.test(bare) && new RegExp(`\\b${bare}\\b`).test(signature);
      sites.push({
        parameter,
        api: match[1],
        file,
        line,
        creator,
        condition: guards[line - 1]?.conditions || [],
        args,
        entryName: /^[A-Za-z_]\w*$/.test(bare) ? bare : undefined,
        expression: args[0] || expression,
      });
    }

    const fileAggregates = [];
    for (const match of plain.matchAll(ARRAY_DEFINITION)) {
      const line = lineOf(starts, match.index);
      if (!guards[line - 1]?.dead) {
        dataNames.add(match[1]);
        const open = match.index + match[0].length - 1;
        const close = matchClose(plain, open);
        if (close >= 0) fileAggregates.push({ name: match[1], start: line, end: lineOf(starts, close) });
      }
      if (!arrayFiles.has(match[1])) arrayFiles.set(match[1], new Set());
      arrayFiles.get(match[1]).add(file);
    }
    if (C_SOURCE_EXT.test(file) && !defs.length && !inFolders(file, FOREIGN_SEGMENTS)) {
      const structItems = pendingStructs
        .filter((item) => item.file === file && !fileAggregates.some((known) => known.name === item.name))
        .map((item) => ({ name: item.name, start: item.line, end: item.endLine }));
      const allItems = [...fileAggregates, ...structItems].sort((a, b) => a.start - b.start);
      const maxSpan = allItems.reduce((max, item) => Math.max(max, item.end - item.start), 0);
      if (allItems.length >= 5 || maxSpan >= 50) dataTables.push({ file, items: allItems });
    }
  }

  for (const call of fieldCalls) if (!call.type && globalTypes.get(call.base)) call.type = globalTypes.get(call.base);
  const found = resolveStructTables(pendingStructs, resolve, structLayouts, tags);
  const vectorApis = buildVectorApis(apiBases, apiMacros, pendingStructs, resolve, byName);
  const xmacroTables = resolveXMacroTables(xmacroSites, files, readSource);

  // Tasks.
  const gaps = {
    unreadable,
    demo: 0,
    entryUnknown: [],
    entryNotIndexed: [],
    entryParameter: [],
    tableUnknown: [],
    unreferenced: [],
    entriesNotIndexed: [],
  };
  const candidates = [];
  for (const site of sites) {
    if (inFolders(site.file, DEMO_SEGMENTS)) {
      gaps.demo++;
      continue;
    }
    const entry = site.entryName && resolve(site.entryName, site.file);
    if (!entry) {
      // The RTOS's own idle and timer tasks are created with prv* functions.
      if (site.entryName?.startsWith('prv')) continue;
      const item = {
        site: `${site.file}:${site.line}`,
        expression: site.entryName || site.expression,
        creator: site.creator.name,
      };
      (site.parameter ? gaps.entryParameter : site.entryName ? gaps.entryNotIndexed : gaps.entryUnknown).push(item);
      continue;
    }
    candidates.push({ ...site, entry });
  }
  const creators = [...new Set(candidates.map((site) => site.creator.name))].filter((name) => name !== 'main');
  const callers = creators.length ? await callersOf(creators) : new Map();
  const tasks = [];
  for (const site of candidates) {
    if (site.creator.name !== 'main' && !(callers.get(`${site.creator.name}|${site.creator.file}`) || []).length) {
      gaps.unreferenced.push({ site: `${site.file}:${site.line}`, task: site.entry.name, creator: site.creator.name });
      continue;
    }
    const detail = info.get(site.entry.key) || { calls: [], waits: [] };
    tasks.push({
      entry: site.entry,
      creator: site.creator,
      site: `${site.file}:${site.line}`,
      condition: site.condition,
      args:
        site.api === 'osThreadNew'
          ? [site.args[2]].filter(Boolean)
          : [site.args[1], site.args[2], site.args[4]].filter(Boolean),
      waits: detail.waits,
      calls: detail.calls.map((def) => def.name),
    });
  }

  // Tables reached from each task and from the product's main.
  const roots = tasks.map((task) => task.entry);
  for (const def of byName.get('main') || []) if (!inFolders(def.file, FOREIGN_SEGMENTS)) roots.push(def);
  const reached = new Map();
  const seenRoots = new Set();
  for (const root of roots) {
    if (seenRoots.has(root.key)) continue;
    seenRoots.add(root.key);
    const visited = new Map([[root.key, [root]]]);
    const queue = [root];
    while (queue.length) {
      const def = queue.shift();
      const path = visited.get(def.key);
      const detail = info.get(def.key);
      if (!detail) continue;
      for (const dispatch of detail.dispatches) {
        const key = `${def.key}:${dispatch.table}`;
        if (!reached.has(key))
          reached.set(key, { table: dispatch.table, dispatcher: def, line: dispatch.line, paths: [] });
        const record = reached.get(key);
        if (!record.paths.some((item) => item[0].key === root.key)) record.paths.push(path);
      }
      if (path.length > ROOT_DEPTH) continue;
      for (const callee of detail.calls)
        if (!visited.has(callee.key)) {
          visited.set(callee.key, [...path, callee]);
          queue.push(callee);
        }
    }
  }

  // Every other function that calls through a table, for the short list.
  const others = [];
  for (const detail of info.values())
    for (const dispatch of detail.dispatches)
      if (!reached.has(`${detail.def.key}:${dispatch.table}`))
        others.push({ table: dispatch.table, dispatcher: detail.def, line: dispatch.line });

  // Parse the definitions of every dispatched table, re-reading only the files that hold them.
  const wanted = new Map();
  for (const item of [...reached.values(), ...others]) {
    const files = arrayFiles.get(item.table);
    if (!files) continue;
    const local = files.has(item.dispatcher.file) ? [item.dispatcher.file] : [...files];
    for (const file of local) {
      if (!wanted.has(file)) wanted.set(file, new Set());
      wanted.get(file).add(item.table);
    }
  }
  const definitions = new Map();
  for (const [file, names] of wanted) {
    const text = readSource(file);
    if (text === null || text === undefined) continue;
    const source = prepare(file, text);
    for (const name of names)
      for (const variant of parseTables(source, name, resolve, dataNames)) {
        const key = `${file}|${name}`;
        if (!definitions.has(key)) definitions.set(key, []);
        definitions.get(key).push(variant);
      }
  }
  const variantsOf = (item) => {
    const own = definitions.get(`${item.dispatcher.file}|${item.table}`);
    if (own) return own;
    return [...definitions.entries()].filter(([key]) => key.endsWith(`|${item.table}`)).flatMap(([, value]) => value);
  };

  const tables = [];
  const tableIndex = new Map();
  for (const item of reached.values()) {
    const variants = variantsOf(item).filter((variant) => variant.entries.length > 0);
    if (!variants.length) {
      const parameter = !arrayFiles.has(item.table);
      gaps.tableUnknown.push({ site: `${item.dispatcher.file}:${item.line}`, table: item.table, parameter });
      continue;
    }
    const id = `${variants[0].file}|${item.table}`;
    if (tableIndex.has(id)) {
      const table = tableIndex.get(id);
      table.dispatchers.push({ def: item.dispatcher, line: item.line, paths: item.paths });
      continue;
    }
    const table = {
      name: item.table,
      variants,
      dispatchers: [{ def: item.dispatcher, line: item.line, paths: item.paths }],
    };
    tableIndex.set(id, table);
    tables.push(table);
  }
  const otherTables = [];
  // Tables of one entry run outside the tasks, such as a power-down list: too small for the
  // architecture file's list, but the module that registers there needs to know.
  const smallTables = [];
  const otherSeen = new Set();
  for (const item of others) {
    const all = variantsOf(item).filter((variant) => variant.entries.some((entry) => entry.def));
    if (!all.length) continue;
    const variants = all.filter((variant) => variant.entries.length >= 2);
    const id = `${all[0].file}|${item.table}`;
    if (tableIndex.has(id) || otherSeen.has(id)) continue;
    otherSeen.add(id);
    if (variants.length) otherTables.push({ name: item.table, variants, dispatcher: item.dispatcher, line: item.line });
    else smallTables.push({ name: item.table, variants: all, dispatcher: item.dispatcher, line: item.line });
  }
  otherTables.sort((a, b) => a.variants[0].file.localeCompare(b.variants[0].file) || a.name.localeCompare(b.name));
  for (const table of tables)
    for (const variant of table.variants)
      for (const entry of variant.entries)
        if (!entry.def && !gaps.entriesNotIndexed.includes(entry.names[0])) gaps.entriesNotIndexed.push(entry.names[0]);

  const listed = new Set([
    ...tables.flatMap((table) => table.variants.map((variant) => `${variant.file}|${table.name}`)),
    ...[...otherTables, ...smallTables].map((table) => `${table.variants[0].file}|${table.name}`),
    ...vectorApis.filter((api) => api.table).map((api) => `${api.table.file}|${api.table.name}`),
  ]);
  const linkedStructs = linkFieldCalls(
    found.filter((table) => !listed.has(`${table.file}|${table.name}`)),
    fieldCalls,
    (type) => tags.get(type) || type
  );
  const resolvedFieldCallSites = new Set();
  for (const table of linkedStructs)
    for (const field of table.fields)
      for (const call of field.calls) resolvedFieldCallSites.add(`${call.def.file}:${call.line}`);
  gaps.tableUnknown = gaps.tableUnknown.filter(
    (item) =>
      !resolvedFieldCallSites.has(item.site) ||
      !fieldCalls.some((call) => `${call.def.file}:${call.line}` === item.site && call.base === item.table)
  );
  return {
    tasks,
    tables,
    otherTables,
    smallTables,
    structTables: linkedStructs,
    vectorApis,
    dataTables,
    xmacroTables,
    gaps,
    modules: modules(tables),
    files: files.length,
  };
}

/**
 * Type of the variable `name` as declared in `text`: `tType *name`, `const tType *name`,
 * `struct tag name` or `tType name[N]`. Undefined when no declaration is found.
 */
function declaredType(name, text) {
  const pattern = new RegExp(
    String.raw`\b([A-Za-z_]\w*)\s*(?:const\s*)?\**\s*(?:const\s+)?\b${name}\s*(?:\[[^\]]*\]\s*)?[,;=)]`,
    'g'
  );
  for (const match of text.matchAll(pattern)) if (!NOT_TYPES.has(match[1])) return match[1];
  return undefined;
}

/** Collect unambiguous top-level variable/array types across headers and sources (e.g. `extern const tObjTable* const ObjectTable[];`). */
function collectGlobalTypes(source, globalTypes) {
  const { plain, starts, guards } = source;
  const pattern = /\b([A-Za-z_]\w*)\s*(?:const\s*)?\**\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:\[[^\];{}]*\]\s*)?[;=]/g;
  let depth = 0;
  let cursor = 0;
  for (const match of plain.matchAll(pattern)) {
    for (; cursor < match.index; cursor++)
      if (plain[cursor] === '{') depth++;
      else if (plain[cursor] === '}') depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    const [, type, name] = match;
    if (NOT_TYPES.has(type) || NOT_NAMES.has(name) || guards[lineOf(starts, match.index) - 1]?.dead) continue;
    if (!globalTypes.has(name)) globalTypes.set(name, type);
    else if (globalTypes.get(name) !== type) globalTypes.set(name, null);
  }
}

/**
 * Deterministic member order of a `struct { ... }` body, or `null` when `#if`, nested
 * aggregates or bitfields could shift positional initializer slots.
 */
function parseStructMembers(codeSlice, plainSlice) {
  if (/^\s*#/m.test(codeSlice)) return null;
  const decls = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < plainSlice.length; i++) {
    const c = plainSlice[i];
    if (c === '{' || c === '}') return null;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      if (--depth < 0) return null;
    } else if (c === ';' && depth === 0) {
      decls.push(plainSlice.slice(from, i));
      from = i + 1;
    }
  }
  if (depth !== 0 || plainSlice.slice(from).trim()) return null;
  const members = [];
  for (const rawDecl of decls) {
    const trimmed = rawDecl.trim();
    if (!trimmed) continue;
    let pDepth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === '(' || c === '[') pDepth++;
      else if (c === ')' || c === ']') pDepth--;
      else if (c === ':' && pDepth === 0) return null;
    }
    const pieces = splitTopLevel(trimmed, 0, trimmed.length);
    for (let index = 0; index < pieces.length; index++) {
      const piece = trimmed.slice(pieces[index].start, pieces[index].end).trim();
      if (!piece) return null;
      const fnPtr = /\(\s*\*\s*(?:const\s+|volatile\s+)*([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)\)\s*\([^;]*\)\s*$/.exec(
        piece
      );
      if (fnPtr) {
        if (index === 0 && !piece.slice(0, fnPtr.index).trim()) return null;
        members.push({ name: fnPtr[1], isArray: Boolean(fnPtr[2].trim()) });
        continue;
      }
      const normal = /([A-Za-z_]\w*)\s*((?:\[[^\]]*\]\s*)*)$/.exec(piece);
      if (!normal) return null;
      if (index === 0 && !piece.slice(0, normal.index).trim()) return null;
      members.push({ name: normal[1], isArray: Boolean(normal[2].trim()) });
    }
  }
  return members.length ? members : null;
}

/** Collect `typedef struct [tag] {...} Alias;` and `struct tag {...};` tags and field layouts. */
function collectStructTypes(source, tags, structLayouts) {
  const { code, plain, starts, guards } = source;
  const record = (name, layout) => {
    if (!name) return;
    if (!layout) {
      structLayouts.set(name, null);
      return;
    }
    if (!structLayouts.has(name)) {
      structLayouts.set(name, layout);
      return;
    }
    const existing = structLayouts.get(name);
    if (!existing) return;
    const key = (list) => list.map((item) => `${item.name}${item.isArray ? '[]' : ''}`).join(',');
    if (key(existing) !== key(layout)) structLayouts.set(name, null);
  };
  for (const match of plain.matchAll(/\btypedef\s+(struct|union)(?:\s+([A-Za-z_]\w*))?\s*\{/g)) {
    if (guards[lineOf(starts, match.index) - 1]?.dead) continue;
    const open = match.index + match[0].length - 1;
    const close = matchClose(plain, open);
    if (close < 0) continue;
    const semi = plain.indexOf(';', close + 1);
    const tail = semi < 0 ? '' : plain.slice(close + 1, semi);
    const aliases = splitTopLevel(tail, 0, tail.length)
      .map((part) => tail.slice(part.start, part.end).trim())
      .filter((piece) => piece && !piece.startsWith('*'))
      .map((piece) => /^([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?$/.exec(piece)?.[1])
      .filter(Boolean);
    if (match[2] && aliases[0]) tags.set(match[2], aliases[0]);
    if (match[1] === 'struct') {
      const layout = parseStructMembers(code.slice(open + 1, close), plain.slice(open + 1, close));
      if (match[2]) record(match[2], layout);
      for (const alias of aliases) record(alias, layout);
    }
  }
  for (const match of plain.matchAll(/\bstruct\s+([A-Za-z_]\w*)\s*\{/g)) {
    if (guards[lineOf(starts, match.index) - 1]?.dead) continue;
    const before = plain.slice(Math.max(0, match.index - 16), match.index);
    if (/\btypedef\s*$/.test(before)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchClose(plain, open);
    if (close < 0) continue;
    record(match[1], parseStructMembers(code.slice(open + 1, close), plain.slice(open + 1, close)));
  }
}

/** Capture struct and struct-array initializer blocks during the file scan. */
function scanStructInitializers(source, dataNames) {
  const { file, code, plain, starts, guards } = source;
  const items = [];
  for (const match of plain.matchAll(STRUCT_DEFINITION)) {
    const [, type, name] = match;
    if (NOT_TYPES.has(type)) continue;
    const line = lineOf(starts, match.index);
    if (guards[line - 1]?.dead) continue;
    if (dataNames) dataNames.add(name);
    const open = match.index + match[0].length - 1;
    const close = matchClose(plain, open);
    if (close < 0) continue;
    items.push({
      file,
      type,
      name,
      line,
      endLine: lineOf(starts, close),
      isArray: match[0].includes('['),
      open,
      bodyPlain: plain.slice(open, close + 1),
      bodyCode: code.slice(open, close + 1),
      starts,
      guards,
    });
  }
  return items;
}

/** Resolve both C99 designated (`.field = fn`) and deterministic positional struct function tables. */
function resolveStructTables(pendingStructs, resolve, structLayouts, tags) {
  const result = [];
  for (const item of pendingStructs) {
    const { file, type, name, line, isArray, open, bodyPlain, bodyCode, starts, guards } = item;
    // Fields of the declared type sit one brace deep in a struct, two in an array of them;
    // deeper ones belong to a nested struct whose type is not declared here.
    const own = isArray ? 2 : 1;
    const innerPlain = bodyPlain.slice(0, -1);
    const fields = new Map();
    const addDef = (field, def, isOwn) => {
      if (!fields.has(field)) fields.set(field, { defs: [], nested: true });
      const entry = fields.get(field);
      if (isOwn) entry.nested = false;
      if (!entry.defs.some((known) => known.key === def.key)) entry.defs.push(def);
    };
    let depth = 0;
    let scanned = 0;
    for (const desig of innerPlain.matchAll(DESIGNATED_FUNCTION)) {
      for (; scanned < desig.index; scanned++)
        if (innerPlain[scanned] === '{') depth++;
        else if (innerPlain[scanned] === '}') depth--;
      const [, field, target] = desig;
      if (NOT_NAMES.has(target) || guards[lineOf(starts, open + desig.index) - 1]?.dead) continue;
      const def = resolve(target, file);
      if (def) addDef(field, def, depth <= own);
    }

    const canonicalType = tags.get(type) || type;
    const layout = structLayouts.get(type) !== undefined ? structLayouts.get(type) : structLayouts.get(canonicalType);
    if (layout) {
      const elements = [];
      if (!isArray) elements.push({ start: 1, end: bodyPlain.length - 1 });
      else {
        for (const elem of splitTopLevel(bodyPlain, 1, bodyPlain.length - 1)) {
          const slice = bodyPlain.slice(elem.start, elem.end);
          if (!slice.trim()) continue;
          const stripped = slice.replace(/^\s*\[[^\]]*\]\s*=\s*/, (prefix) => blank(prefix));
          const relBrace = stripped.search(/\S/);
          if (relBrace < 0 || stripped[relBrace] !== '{') continue;
          const elemOpen = elem.start + relBrace;
          const elemClose = matchClose(bodyPlain, elemOpen);
          if (elemClose > elemOpen) elements.push({ start: elemOpen + 1, end: elemClose });
        }
      }
      for (const elem of elements) {
        if (guards[lineOf(starts, open + elem.start) - 1]?.dead) continue;
        if (/^\s*#/m.test(bodyCode.slice(elem.start, elem.end))) continue;
        const parts = splitTopLevel(bodyPlain, elem.start, elem.end);
        if (parts.length && !bodyPlain.slice(parts.at(-1).start, parts.at(-1).end).trim()) parts.pop();
        if (!parts.length || parts.length > layout.length) continue;
        let cursor = 0;
        for (const part of parts) {
          const raw = bodyPlain.slice(part.start, part.end).trim();
          const desig = /^\.\s*([A-Za-z_]\w*)\s*=/.exec(raw);
          if (desig) {
            const idx = layout.findIndex((member) => member.name === desig[1]);
            cursor = idx >= 0 ? idx + 1 : layout.length + 1;
            continue;
          }
          if (raw.startsWith('[')) {
            cursor = layout.length + 1;
            continue;
          }
          if (cursor >= layout.length) break;
          const member = layout[cursor++];
          if (member.isArray && !raw.startsWith('{')) {
            cursor = layout.length + 1;
            continue;
          }
          const target = /^(?:\(\s*[A-Za-z_][\w\s*]*\)\s*)*&?\s*([A-Za-z_]\w*)$/.exec(raw)?.[1];
          if (!target || NOT_NAMES.has(target) || guards[lineOf(starts, open + part.start) - 1]?.dead) continue;
          const def = resolve(target, file);
          if (def) addDef(member.name, def, true);
        }
      }
    }
    if (fields.size) result.push({ name, type, file, line, fields });
  }
  return result;
}

/** Collect cross-image pointer-struct macros (`#define api ((Type*)ADDR)` and `#define Fn api->field`). */
function collectVectorDirectives(source, byName, apiBases, apiMacros, vectorAliases) {
  const { file, code, guards } = source;
  if (inFolders(file, FOREIGN_SEGMENTS)) return;
  const lines = code.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (guards[index]?.dead) continue;
    let raw = lines[index].replace(/\r$/, '');
    if (!/^\s*#\s*define\b/.test(raw)) continue;
    while (/\\\s*$/.test(raw) && index + 1 < lines.length)
      raw = raw.replace(/\\\s*$/, ' ') + lines[++index].replace(/\r$/, '');
    const baseMatch =
      /^\s*#\s*define\s+([A-Za-z_]\w*)\s+\(\s*\(\s*(?:const\s+)?([A-Za-z_]\w*)\s*\*\s*\)\s*([^)]+)\)/.exec(raw);
    if (baseMatch && !NOT_TYPES.has(baseMatch[2])) {
      apiBases.set(baseMatch[1], {
        base: baseMatch[1],
        type: baseMatch[2],
        addr: collapse(baseMatch[3]),
        file,
        line: index + 1,
      });
      continue;
    }
    const fwd =
      /^\s*#\s*define\s+([A-Za-z_]\w*)(?:\([^)]*\))?\s+(?:\(\s*\*\s*)?([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)\s*\)?(?:\([^)]*\))?\s*$/.exec(
        raw
      );
    if (!fwd) continue;
    const [, macro, base, field] = fwd;
    if (KEYWORDS.has(macro) || NOT_NAMES.has(macro)) continue;
    apiMacros.push({ macro, base, field, file, line: index + 1 });
    if (macro !== field) {
      if (!byName.has(macro) && byName.has(field)) vectorAliases.set(macro, field);
      else if (!byName.has(field) && byName.has(macro)) vectorAliases.set(field, macro);
    }
  }
}

/** Group cross-image pointer-struct macro clusters and match their vector table instances. */
function buildVectorApis(apiBases, apiMacros, pendingStructs, resolve, byName) {
  const byBase = new Map();
  for (const item of apiMacros) {
    if (!byBase.has(item.base)) byBase.set(item.base, []);
    const list = byBase.get(item.base);
    if (!list.some((known) => known.macro === item.macro && known.field === item.field)) list.push(item);
  }
  const out = [];
  for (const [base, entries] of byBase) {
    const baseInfo = apiBases.get(base);
    const hasIndexedTarget = entries.some((entry) => byName.has(entry.macro) || byName.has(entry.field));
    if (!baseInfo && (entries.length < 4 || !hasIndexedTarget)) continue;
    if (baseInfo && entries.length < 2) continue;
    const header = baseInfo?.file || entries[0].file;
    const tableDef = baseInfo?.type ? pendingStructs.find((item) => item.type === baseInfo.type) : undefined;
    const mapped = entries.map((entry) => ({
      ...entry,
      def: resolve(entry.macro, tableDef?.file || header) || resolve(entry.field, tableDef?.file || header),
    }));
    out.push({
      base,
      header,
      type: baseInfo?.type,
      addr: baseInfo?.addr,
      table: tableDef ? { name: tableDef.name, file: tableDef.file, line: tableDef.line } : undefined,
      entries: mapped,
      aliases: mapped.filter((entry) => entry.macro !== entry.field),
      external: mapped.filter((entry) => !entry.def),
    });
  }
  return out.sort((a, b) => a.header.localeCompare(b.header) || a.base.localeCompare(b.base));
}

/** Record `#define MACRO(...) ...` followed shortly by `#include "table.h"` outside `#if 0`. */
function collectXMacroSites(source, xmacroSites) {
  const { file, literals, guards } = source;
  if (inFolders(file, FOREIGN_SEGMENTS)) return;
  const lines = literals.split('\n');
  const active = new Map();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    if (guards[index]?.dead) continue;
    const def = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\([^)]*\)/.exec(line);
    if (def) {
      active.set(def[1], index + 1);
      while (/\\\s*$/.test(lines[index]) && index + 1 < lines.length) index++;
      continue;
    }
    const undef = /^\s*#\s*undef\s+([A-Za-z_]\w*)\b/.exec(line);
    if (undef) {
      active.delete(undef[1]);
      continue;
    }
    const inc = /^\s*#\s*include\s*"([^"]+)"/.exec(line);
    if (!inc || !active.size) continue;
    for (const [macro, definedLine] of active)
      if (index + 1 - definedLine <= 12)
        xmacroSites.push({ expander: file, line: index + 1, macro, include: inc[1].replace(/\\/g, '/') });
  }
}

/** Match X-Macro `#include` headers against project files and count active entries. */
function resolveXMacroTables(xmacroSites, files, readSource) {
  if (!xmacroSites.length) return [];
  const groups = new Map();
  for (const site of xmacroSites) {
    const expDir = site.expander.slice(0, Math.max(0, site.expander.lastIndexOf('/')));
    const local = expDir ? `${expDir}/${site.include}` : site.include;
    const matches = files.filter(
      (file) => file === local || file === site.include || file.endsWith(`/${site.include}`)
    );
    const target = matches.find((file) => file === local) || (matches.length === 1 ? matches[0] : undefined);
    if (!target) continue;
    const key = `${target}|${site.macro}`;
    if (!groups.has(key)) groups.set(key, { file: target, macro: site.macro, sites: [] });
    const entry = groups.get(key);
    if (!entry.sites.some((known) => known.file === site.expander && known.line === site.line))
      entry.sites.push({ file: site.expander, line: site.line });
  }
  const out = [];
  for (const group of groups.values()) {
    const text = readSource(group.file);
    if (!text) continue;
    const prepared = prepare(group.file, text);
    const pattern = new RegExp(`\\b${group.macro}\\s*\\(`, 'g');
    let count = 0;
    for (const match of prepared.code.matchAll(pattern)) {
      const line = lineOf(prepared.starts, match.index);
      if (prepared.guards[line - 1]?.dead) continue;
      const lineText = prepared.code.slice(prepared.starts[line - 1], prepared.starts[line] ?? prepared.code.length);
      if (/^\s*#/.test(lineText)) continue;
      count++;
    }
    if (count >= 2) out.push({ ...group, count });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.macro.localeCompare(b.macro));
}

/**
 * Attach to each struct table field the functions that call through a field of that name.
 * A call whose pointer type is known links only to tables of that type; one whose type is
 * unknown links only when a single struct type has that field, so a common name such as
 * `read` never joins unrelated structs. A field of a nested struct takes the one type the
 * other tables give that field, and links to nothing when they give several.
 */
function linkFieldCalls(found, fieldCalls, canonical) {
  const typesByField = new Map();
  for (const table of found)
    for (const [field, entry] of table.fields) {
      if (entry.nested) continue;
      if (!typesByField.has(field)) typesByField.set(field, new Set());
      typesByField.get(field).add(canonical(table.type));
    }
  const ownerOf = (table, field, entry) => {
    if (!entry.nested) return canonical(table.type);
    const types = typesByField.get(field);
    return types?.size === 1 ? [...types][0] : undefined;
  };
  const tables = [];
  const seen = new Map();
  for (const table of found) {
    const id = `${table.file}|${table.name}`;
    // #if / #else variants of one table: merge their fields.
    const known = seen.get(id);
    const target = known || { name: table.name, type: table.type, file: table.file, line: table.line, fields: [] };
    for (const [field, entry] of table.fields) {
      let item = target.fields.find((known) => known.field === field);
      if (!item) {
        const type = ownerOf(table, field, entry);
        const calls = type
          ? fieldCalls.filter(
              (call) =>
                call.field === field &&
                (call.type ? canonical(call.type) === type : typesByField.get(field)?.size === 1)
            )
          : [];
        item = { field, defs: [], calls: calls.map(({ def, line }) => ({ def, line })) };
        target.fields.push(item);
      }
      for (const def of entry.defs) if (!item.defs.some((other) => other.key === def.key)) item.defs.push(def);
    }
    if (!known) {
      seen.set(id, target);
      tables.push(target);
    }
  }
  const called = (table) => table.fields.some((field) => field.calls.length);
  // Tables whose fields are called somewhere come first: those are the calls the index misses.
  return tables.sort(
    (a, b) => Number(called(b)) - Number(called(a)) || a.file.localeCompare(b.file) || a.line - b.line
  );
}

/** Every definition of `name` in a file, with its entries in order. */
function parseTables(source, name, resolve, dataNames) {
  const { file, plain, comments, starts, guards } = source;
  const variants = [];
  const pattern = new RegExp(`\\b${name}${ARRAY_DECLARATOR}`, 'g');
  for (const match of plain.matchAll(pattern)) {
    const line = lineOf(starts, match.index);
    const guard = guards[line - 1] || { dead: false, conditions: [] };
    if (guard.dead) continue;
    const open = match.index + match[0].length - 1;
    const close = matchClose(plain, open);
    if (close < 0) continue;
    const parts = splitTopLevel(plain, open + 1, close).filter((part) => plain.slice(part.start, part.end).trim());
    const inside = comments.filter((comment) => comment.start > open && comment.start < close);
    const entries = [];
    let previousEnd = lineOf(starts, open);
    for (const part of parts) {
      const raw = plain.slice(part.start, part.end);
      const first = part.start + raw.search(/\S/);
      const last = part.start + raw.trimEnd().length - 1;
      const firstLine = lineOf(starts, first);
      const lastLine = lineOf(starts, last);
      const own = guards[firstLine - 1] || guard;
      const entryPreviousEnd = previousEnd;
      previousEnd = lastLine;
      if (own.dead) continue;
      // Every function the entry names: one for TASK(f) or {f, "f"}, several for a
      // struct of handlers. Identifiers followed by "(" are macros such as TASK.
      const named = [];
      const candidates = [];
      const designators = raw
        .replace(/\[[^\]]*\]\s*=/g, (text) => blank(text))
        .replace(/\.\s*[A-Za-z_]\w*\s*=/g, (text) => blank(text));
      for (const id of designators.matchAll(/\b[A-Za-z_]\w*\b/g)) {
        if (/^\s*\(/.test(designators.slice(id.index + id[0].length)) || NOT_NAMES.has(id[0])) continue;
        const def = resolve(id[0], file);
        if (def) {
          if (!named.some((item) => item.def.key === def.key))
            named.push({ def, line: lineOf(starts, part.start + id.index) });
        } else if (!dataNames?.has(id[0])) candidates.push(id[0]);
      }
      // A function the index does not hold (its folder is skipped, or it sits under #if)
      // still takes a place in the order: keep it, by the name that looks like a function.
      const unknown = named.length ? undefined : candidates.find((name) => /[a-z]/.test(name)) || candidates[0];
      if (!named.length && !unknown) continue;
      const notes = inside.filter((comment) => {
        const commentLine = lineOf(starts, comment.start);
        const lineStart = starts[commentLine - 1];
        const trailing = plain.slice(lineStart, comment.start).trim() !== '';
        return trailing
          ? commentLine >= firstLine && commentLine <= lastLine
          : commentLine > entryPreviousEnd && commentLine < firstLine;
      });
      entries.push({
        names: named.length ? named.map((item) => item.def.name) : [unknown],
        def: named[0]?.def,
        defs: named.map((item) => item.def),
        line: named[0]?.line ?? firstLine,
        conditions: own.conditions.filter((condition) => !guard.conditions.includes(condition)),
        comment: notes
          .map((comment) => comment.text)
          .filter(Boolean)
          .join(' '),
      });
    }
    entries.forEach((entry, index) => (entry.position = index + 1));
    variants.push({ file, line, conditions: guard.conditions, entries });
  }
  return variants;
}

/**
 * Module (file) by table: which functions each module registers where. Only tables that
 * several modules register in are columns; a table private to one module is not.
 */
function modules(tables) {
  const columns = tables.filter((table) => {
    const files = new Set();
    for (const variant of table.variants)
      for (const entry of variant.entries) for (const def of entry.defs) files.add(def.file);
    return files.size >= MATRIX_MIN_FILES;
  });
  const rows = new Map();
  columns.forEach((table, column) => {
    for (const variant of table.variants)
      for (const entry of variant.entries)
        for (const def of entry.defs) {
          if (!rows.has(def.file)) rows.set(def.file, new Map());
          const cells = rows.get(def.file);
          if (!cells.has(column)) cells.set(column, []);
          if (!cells.get(column).includes(def.name)) cells.get(column).push(def.name);
        }
  });
  const multi = [...rows.values()].filter((cells) => cells.size >= 2);
  const common = columns
    .map((_, column) => column)
    .filter((column) => {
      const count = multi.filter((cells) => cells.has(column)).length;
      return count >= 2 && count * 2 >= multi.length;
    });
  const differs = [];
  for (const [file, cells] of rows) {
    if (cells.size < 2) continue;
    const missing = common.filter((column) => !cells.has(column));
    if (missing.length) differs.push({ file, missing });
  }
  return { columns, rows, common, differs };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function labelsFor(all, language) {
  const fallback = all['en-US'];
  const chosen = all[language] ? language : 'en-US';
  return { language: chosen, text: { ...fallback, ...all[chosen] } };
}

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, key) => (key in values ? values[key] : `{${key}}`));
const cell = (value, none) => {
  const text = collapse(String(value ?? '')).replace(/\|/g, '\\|');
  return text || none;
};
const code = (name) => `\`${name}\``;
const at = (file, line) => `${file}:${line}`;

function render(model, labels, { language, date, mode }) {
  const t = labels;
  const none = t.none;
  const out = [MARK.header(language), '', fill(t.basis, { date, mode }), ''];

  out.push(`## ${t.tasks}`, '');
  if (!model.tasks.length) out.push(t.tasksNone, '');
  else {
    out.push(`| ${t.task} | ${t.createdIn} | ${t.condition} | ${t.arguments} | ${t.waits} | ${t.calls} |`);
    out.push('|---|---|---|---|---|---|');
    for (const task of model.tasks) {
      const calls =
        task.calls.slice(0, MAX_CALLS_SHOWN).map(code).join(', ') + (task.calls.length > MAX_CALLS_SHOWN ? ', …' : '');
      out.push(
        `| ${code(task.entry.name)} (${at(task.entry.file, task.entry.start)}) | ${code(task.creator.name)} (${task.site}) | ${cell(task.condition.join(' && '), none)} | ${cell(task.args.join(', '), none)} | ${cell(task.waits.map(code).join(', '), none)} | ${cell(calls, none)} |`
      );
    }
    out.push('');
  }

  out.push(`## ${t.tables}`, '', t.tablesIntro, '');
  for (const table of model.tables) {
    for (const variant of table.variants) {
      out.push(`### ${code(table.name)} (${at(variant.file, variant.line)})`, '');
      for (const dispatcher of table.dispatchers) {
        const paths = dispatcher.paths.map((path) => path.map((def) => code(def.name)).join(' → ')).join('; ');
        out.push(
          fill(t.runBy, {
            dispatcher: `${code(dispatcher.def.name)} (${at(dispatcher.def.file, dispatcher.line)})`,
            path: paths,
          })
        );
      }
      if (variant.conditions.length)
        out.push('', fill(t.definedUnder, { condition: code(variant.conditions.join(' && ')) }));
      out.push(
        '',
        `| ${t.position} | ${t.function} | ${t.module} | ${t.condition} | ${t.comment} |`,
        '|---|---|---|---|---|'
      );
      for (const entry of variant.entries)
        out.push(
          `| ${entry.position} | ${entry.names.map(code).join(', ')} | ${entry.def ? at(entry.def.file, entry.def.start) : t.notIndexed} | ${cell(entry.conditions.join(' && '), none)} | ${cell(entry.comment, none)} |`
        );
      out.push('');
    }
  }
  if (model.otherTables.length) {
    out.push(`### ${t.otherTables}`, '');
    for (const table of model.otherTables.slice(0, MAX_OTHER_TABLES)) {
      const variant = table.variants[0];
      out.push(
        `- ${code(table.name)} (${at(variant.file, variant.line)}): ${fill(t.otherTableLine, { dispatcher: code(table.dispatcher.name), count: variant.entries.length })}`
      );
    }
    if (model.otherTables.length > MAX_OTHER_TABLES) out.push(`- … (${model.otherTables.length - MAX_OTHER_TABLES})`);
    out.push('');
  }

  const allStructs = model.structTables || [];
  if (allStructs.length) {
    out.push(`## ${t.structTables}`, '', t.structTablesIntro, '');
    const more = (list, max) => (list.length > max ? `, … (${list.length - max})` : '');
    // Group by struct type first so one large table family (e.g. 69 IC tables) never hides other types.
    const groups = new Map();
    for (const table of allStructs) {
      if (!groups.has(table.type)) groups.set(table.type, []);
      groups.get(table.type).push(table);
    }
    const entries = [...groups.entries()];
    for (const [type, members] of entries.slice(0, MAX_STRUCT_TYPES)) {
      out.push(`### ${code(type)}`, '');
      const calls = new Map();
      for (const table of members)
        for (const item of table.fields) {
          if (!calls.has(item.field)) calls.set(item.field, []);
          for (const call of item.calls)
            if (!calls.get(item.field).some((known) => known.def === call.def && known.line === call.line))
              calls.get(item.field).push(call);
        }
      const called = [...calls].filter(([, list]) => list.length);
      for (const [field, list] of called) {
        const sites = list
          .slice(0, MAX_FIELD_SITES)
          .map((call) => `${code(call.def.name)} (${at(call.def.file, call.line)})`)
          .join(', ');
        out.push(`- ${code(`.${field}`)}: ${fill(t.calledIn, { sites: sites + more(list, MAX_FIELD_SITES) })}`);
      }
      if (called.length) out.push('');
      for (const table of members.slice(0, MAX_TABLES_PER_TYPE)) {
        const fields = table.fields.slice(0, MAX_TABLE_FIELDS).map((item) => {
          const functions = item.defs.slice(0, MAX_FIELD_FUNCTIONS).map((def) => code(def.name));
          return `${code(`.${item.field}`)} → ${functions.join(', ')}${more(item.defs, MAX_FIELD_FUNCTIONS)}`;
        });
        const hidden = table.fields.length - MAX_TABLE_FIELDS;
        out.push(
          `- ${code(table.name)} (${at(table.file, table.line)}): ${fields.join('; ')}${hidden > 0 ? `; … (${hidden})` : ''}`
        );
      }
      if (members.length > MAX_TABLES_PER_TYPE) out.push(`- … (${members.length - MAX_TABLES_PER_TYPE})`);
      out.push('');
    }
    if (entries.length > MAX_STRUCT_TYPES) out.push(`- … (${entries.length - MAX_STRUCT_TYPES})`, '');
  }

  const vectorApis = model.vectorApis || [];
  if (vectorApis.length) {
    const more = (list, max) => (list.length > max ? `, … (${list.length - max})` : '');
    out.push(`## ${t.vectorApis}`, '', t.vectorApisIntro, '');
    for (const api of vectorApis) {
      const header = api.addr ? `${api.header}, ${code(api.addr)}` : api.header;
      const table = api.table
        ? fill(t.vectorApiTable, { name: code(api.table.name), site: at(api.table.file, api.table.line) })
        : '';
      const aliasItems = api.aliases
        .slice(0, MAX_VECTOR_ITEMS)
        .map((item) => `${code(item.macro)} → ${code(`.${item.field}`)}`)
        .join(', ');
      const aliases = api.aliases.length
        ? fill(t.vectorApiAliases, { items: aliasItems + more(api.aliases, MAX_VECTOR_ITEMS) })
        : '';
      const extItems = api.external
        .slice(0, MAX_VECTOR_ITEMS)
        .map((item) => code(item.macro))
        .join(', ');
      const external = api.external.length
        ? fill(t.vectorApiExternal, { items: extItems + more(api.external, MAX_VECTOR_ITEMS) })
        : '';
      out.push(
        `- ${fill(t.vectorApiLine, {
          base: code(api.base),
          header,
          count: api.entries.length,
          resolved: api.entries.length - api.external.length,
          table,
          aliases,
          external,
        })}`
      );
    }
    out.push('');
  }

  const dataTables = model.dataTables || [];
  const xmacroTables = model.xmacroTables || [];
  if (dataTables.length || xmacroTables.length) {
    const more = (list, max) => (list.length > max ? `, … (${list.length - max})` : '');
    out.push(`## ${t.dataTables}`, '', t.dataTablesIntro, '');
    for (const item of xmacroTables) {
      const sites = item.sites
        .slice(0, MAX_FIELD_SITES)
        .map((site) => at(site.file, site.line))
        .join(', ');
      out.push(
        `- ${fill(t.xmacroLine, {
          file: item.file,
          macro: code(item.macro),
          count: item.count,
          sites: sites + more(item.sites, MAX_FIELD_SITES),
        })}`
      );
    }
    for (const tableFile of dataTables) {
      // Show multi-line tables first when a file has dozens of 1-line descriptors alongside big object arrays.
      const prioritized = tableFile.items
        .slice()
        .sort((a, b) => Number(b.end - b.start >= 5) - Number(a.end - a.start >= 5) || a.start - b.start);
      const shown = prioritized
        .slice(0, MAX_DATA_FILE_ITEMS)
        .sort((a, b) => a.start - b.start)
        .map(
          (entry) => `${code(entry.name)} (${entry.start === entry.end ? entry.start : `${entry.start}-${entry.end}`})`
        )
        .join(', ');
      out.push(`- ${tableFile.file}: ${shown}${more(tableFile.items, MAX_DATA_FILE_ITEMS)}`);
    }
    out.push('');
  }

  const constraints = [];
  for (const table of model.tables)
    for (const variant of table.variants)
      for (const entry of variant.entries)
        if (entry.comment && ORDER_WORDS.test(entry.comment))
          constraints.push(
            `- ${code(table.name)} #${entry.position} ${code(entry.names[0])}: ${collapse(entry.comment)}`
          );
  out.push(`## ${t.order}`, '');
  if (constraints.length) out.push(t.orderIntro, '', ...new Set(constraints), '');
  else out.push(none, '');

  out.push(`## ${t.matrix}`, '');
  const { columns, rows, common, differs } = model.modules;
  if (columns.length) {
    const names = (list) => list.map((column) => code(columns[column].name)).join(', ');
    out.push(`| ${t.module} | ${columns.map((table) => code(table.name)).join(' | ')} |`);
    out.push(`|---|${columns.map(() => '---').join('|')}|`);
    for (const [file, cells] of rows)
      out.push(
        `| ${file} | ${columns.map((_, column) => cell((cells.get(column) || []).map(code).join(', '), none)).join(' | ')} |`
      );
    out.push('');
    if (common.length) {
      out.push(fill(t.usual, { tables: names(common) }));
      if (differs.length) {
        out.push('', t.differs, '');
        for (const item of differs) out.push(`- ${item.file}: ${fill(t.missing, { tables: names(item.missing) })}`);
      }
      out.push('');
    }
  } else out.push(none, '');

  const gaps = [];
  const unreadable = model.gaps.unreadable;
  if (unreadable.length)
    gaps.push(
      `- ${fill(t.unreadable, { count: unreadable.length, files: unreadable.slice(0, 5).join(', ') + (unreadable.length > 5 ? ', …' : '') })}`
    );
  if (model.gaps.entriesNotIndexed.length)
    gaps.push(`- ${fill(t.entriesNotIndexed, { names: model.gaps.entriesNotIndexed.map(code).join(', ') })}`);
  if (model.gaps.demo) gaps.push(`- ${fill(t.demoSkipped, { count: model.gaps.demo })}`);
  for (const item of model.gaps.entryNotIndexed)
    gaps.push(`- ${fill(t.entryNotIndexed, { site: item.site, expression: code(item.expression) })}`);
  for (const item of model.gaps.entryUnknown)
    gaps.push(`- ${fill(t.entryUnknown, { site: item.site, expression: code(item.expression) })}`);
  for (const item of model.gaps.entryParameter)
    gaps.push(
      `- ${fill(t.entryParameter, { site: item.site, expression: code(item.expression), creator: code(item.creator) })}`
    );
  for (const item of model.gaps.tableUnknown)
    gaps.push(
      `- ${fill(item.parameter ? t.tableParameter : t.tableUnknown, { site: item.site, table: code(item.table) })}`
    );
  for (const item of model.gaps.unreferenced)
    gaps.push(`- ${fill(t.unreferenced, { site: item.site, task: code(item.task), creator: code(item.creator) })}`);
  out.push(`## ${t.gaps}`, '', ...(gaps.length ? gaps : [none]), '');
  return out.join('\n');
}

/**
 * The whole file: a new one gets a title and an empty rules section; an existing one keeps
 * everything outside the generated markers. Throws when an existing file has no markers.
 */
function merge(existing, generated, labels) {
  const block = `${MARK.start}\n${generated.trimEnd()}\n${MARK.end}`;
  if (existing === undefined)
    return `# ${labels.title}\n\n${labels.intro}\n\n${block}\n\n## ${labels.rules}\n\n${labels.rulesPlaceholder}\n`;
  const start = existing.indexOf(MARK.start);
  const end = existing.indexOf(MARK.end, start);
  if (start < 0 || end < 0) throw new Error('The architecture file has no woody:generated markers');
  return existing.slice(0, start) + block + existing.slice(end + MARK.end.length);
}

/** Language of an existing file, from its generated header. */
function languageOf(existing) {
  return /<!-- woody:architecture version=\d+ language=([A-Za-z-]+) -->/.exec(existing || '')?.[1];
}

module.exports = {
  analyze,
  render,
  merge,
  languageOf,
  labelsFor,
  scan,
  guardLines,
  prepare,
  parseTables,
  lineOf,
  matchClose,
  splitTopLevel,
  fill,
  FOREIGN_SEGMENTS,
  KEYWORDS,
  MARK,
};
