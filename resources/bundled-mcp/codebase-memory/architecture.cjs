'use strict';
/**
 * Architecture map of a FreeRTOS C project, built without a model: the tasks and what they
 * wait on and call, the function tables their loops call one by one (in order, with #if
 * conditions and comments), and which tables each module registers in.
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
 * @param {(file: string) => string | null} input.readSource text of a project file, or null when it cannot be read as text
 * @param {(names: string[]) => Promise<Map<string, string[]>>} input.callersOf functions that call or
 *   reference each name, keyed `name|file` so that same-named functions in other files do not count
 */
async function analyze({ functions, readSource, callersOf }) {
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
  const resolve = (name, preferFile) => {
    const defs = byName.get(name);
    if (!defs) return undefined;
    return defs.find((def) => def.file === preferFile) || defs[0];
  };

  const info = new Map();
  const sites = [];
  const arrayFiles = new Map();
  const unreadable = [];
  const createPattern = new RegExp(`\\b(${CREATE_APIS.join('|')})\\s*\\(`, 'g');
  const waitPattern = new RegExp(`\\b(${WAIT_APIS.join('|')})\\s*\\(`, 'g');
  const files = [...byFile.keys()].sort();
  for (const file of files) {
    const text = readSource(file);
    if (text === null || text === undefined) {
      unreadable.push(file);
      continue;
    }
    const source = prepare(file, text);
    const { plain, literals, starts, guards } = source;
    const offsetOfLine = (line) => (line - 1 < starts.length ? starts[line - 1] : plain.length);
    const defs = byFile
      .get(file)
      .slice()
      .sort((a, b) => a.start - b.start);
    const enclosing = (line) =>
      defs.filter((def) => def.start <= line && line <= def.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const live = (offset) => !guards[lineOf(starts, offset) - 1]?.dead;

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
      info.set(def.key, entry);
    }

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

    for (const match of plain.matchAll(ARRAY_DEFINITION)) {
      if (!arrayFiles.has(match[1])) arrayFiles.set(match[1], new Set());
      arrayFiles.get(match[1]).add(file);
    }
  }

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
      for (const variant of parseTables(source, name, resolve)) {
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
  const otherSeen = new Set();
  for (const item of others) {
    const variants = variantsOf(item).filter((variant) => variant.entries.length >= 2);
    if (!variants.length) continue;
    const id = `${variants[0].file}|${item.table}`;
    if (tableIndex.has(id) || otherSeen.has(id)) continue;
    otherSeen.add(id);
    otherTables.push({ name: item.table, variants, dispatcher: item.dispatcher, line: item.line });
  }
  otherTables.sort((a, b) => a.variants[0].file.localeCompare(b.variants[0].file) || a.name.localeCompare(b.name));
  for (const table of tables)
    for (const variant of table.variants)
      for (const entry of variant.entries)
        if (!entry.def && !gaps.entriesNotIndexed.includes(entry.names[0])) gaps.entriesNotIndexed.push(entry.names[0]);

  return { tasks, tables, otherTables, gaps, modules: modules(tables) };
}

/** Every definition of `name` in a file, with its entries in order. */
function parseTables(source, name, resolve) {
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
      // Every function the entry names: one for TASK_FUNC(f) or {f, "f"}, several for a
      // struct of handlers. Identifiers followed by "(" are macros such as TASK_FUNC.
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
        } else candidates.push(id[0]);
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

module.exports = { analyze, render, merge, languageOf, labelsFor, scan, guardLines, prepare, parseTables, MARK };
