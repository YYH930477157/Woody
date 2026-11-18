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
  callers: 5,
  uses: 30,
  globals: 20,
  sites: 5,
  statics: 30,
  addresses: 10,
  addressSites: 3,
  structTables: 4,
  fileFunctions: 40,
  switches: 25,
  missing: 30,
  digestProvides: 8,
  digestGlobals: 8,
  digestEntries: 10,
};
const ADDRESS_MACRO = /\b[A-Z][A-Z0-9_]*ADDR[A-Z0-9_]*\b/g;
const DIRECTIVE_IF = /^\s*#\s*(?:if|ifdef|ifndef|elif)\b(.*)$/;
const NOT_SWITCHES = new Set(['defined', 'if', 'ifdef', 'ifndef', 'elif']);
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
 * Top-level statements of a file: function definitions and declarations, with the brace
 * bodies of initializers and struct definitions collapsed to `{}`. Offsets point into the
 * prepared `plain` text.
 */
function topLevel(source) {
  const { plain } = source;
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
      const close = matchClose(plain, i);
      if (close < 0) break;
      const before = text + plain.slice(start, i);
      if (!before.includes('=') && functionName(collapse(before))) {
        result.push({ kind: 'function', text: collapse(before), offset: begin });
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
      // A stray closing brace (unbalanced #if branches): start over after it.
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
      .replace(/@\s*[^,;=]+/g, ' ');
    if (!text || /^(typedef|extern)\b/.test(text)) continue;
    // A struct, union or enum definition without a variable.
    if (/\{\}\s*$/.test(text) && !text.includes('=')) continue;
    const pointerFunction = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/.exec(text);
    const names = [];
    if (pointerFunction) names.push(pointerFunction[1]);
    else {
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
    for (const name of names) {
      const offset = wordOffset(plain, name, item.offset);
      if (offset < 0) continue;
      const line = lineOf(starts, offset);
      const guard = guards[line - 1];
      if (guard?.dead) continue;
      if (!found.has(name))
        found.set(name, { name, file, line, isStatic, conditions: guard?.conditions || [], array: false });
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

/** How `plain` uses the variable whose name starts at `offset`: write, address or read. */
function accessKind(plain, offset, name) {
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
  return 'read';
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const prefixOf = (name) => /^([A-Za-z][A-Za-z0-9]*)_/.exec(name)?.[1].toUpperCase();

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

/** `alarm`, or `routine-alarm` when two modules share a file name. */
function moduleIds(seeds) {
  const slug = (text) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'module';
  const byStem = new Map();
  for (const file of seeds) {
    const id = slug(stemOf(file));
    if (!byStem.has(id)) byStem.set(id, []);
    byStem.get(id).push(file);
  }
  const ids = new Map();
  for (const [id, files] of byStem)
    for (const file of files)
      ids.set(file, files.length === 1 ? id : slug(`${dirOf(file).split('/').pop() || 'root'}-${id}`));
  return ids;
}

/**
 * Modules of the project: each source file that registers functions in a dispatch table
 * leads one, with its header and the other source files whose functions mostly share its
 * prefix. Files in library and demo folders are left out.
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
  for (const table of model.tables)
    for (const variant of table.variants)
      for (const entry of variant.entries)
        for (const def of entry.defs) {
          if (!C_SOURCE.test(def.file) || foreign(def.file)) continue;
          if (!registered.has(def.file)) registered.set(def.file, new Map());
          const tables = registered.get(def.file);
          if (!tables.has(table.name)) tables.set(table.name, []);
          if (!tables.get(table.name).includes(def.name)) tables.get(table.name).push(def.name);
        }
  const namesByFile = new Map();
  for (const [name, file] of functions) {
    if (typeof name !== 'string' || typeof file !== 'string') continue;
    if (!namesByFile.has(file)) namesByFile.set(file, []);
    namesByFile.get(file).push(name);
  }
  const seeds = [...registered.keys()].sort();
  const ids = moduleIds(seeds);
  const prefixes = new Map(seeds.map((file) => [file, dominantPrefix(namesByFile.get(file) || [])]));
  const seedsByPrefix = new Map();
  for (const [file, prefix] of prefixes)
    if (prefix) seedsByPrefix.set(prefix, [...(seedsByPrefix.get(prefix) || []), file]);
  // Other source files that join a module by prefix; a prefix in many of them names a layer.
  const followers = new Map();
  for (const [file, names] of namesByFile) {
    if (registered.has(file) || !C_SOURCE.test(file) || foreign(file)) continue;
    const prefix = dominantPrefix(names);
    if (!prefix || seedsByPrefix.get(prefix)?.length !== 1) continue;
    if (!followers.has(prefix)) followers.set(prefix, []);
    followers.get(prefix).push(file);
  }
  const headers = new Map();
  for (const file of files)
    if (C_HEADER.test(file) && !foreign(file)) {
      const stem = stemOf(file).toLowerCase();
      if (!headers.has(stem)) headers.set(stem, []);
      headers.get(stem).push(file);
    }
  const headerOf = (source) => {
    const candidates = headers.get(stemOf(source).toLowerCase()) || [];
    return (
      candidates.find((file) => dirOf(file) === dirOf(source)) || (candidates.length === 1 ? candidates[0] : undefined)
    );
  };
  return seeds.map((seed) => {
    const prefix = prefixes.get(seed);
    const joined =
      prefix && (followers.get(prefix) || []).length <= LAYER_PREFIX_FILES ? followers.get(prefix) || [] : [];
    const sources = [seed, ...joined.sort()];
    const moduleFiles = [...new Set(sources.flatMap((file) => [file, headerOf(file)].filter(Boolean)))];
    const owners = [...new Set(moduleFiles.map((file) => ownerOf(file, experts, shared)).filter(Boolean))];
    return {
      id: ids.get(seed),
      files: moduleFiles,
      prefix,
      tables: [...registered.get(seed)].map(([table, names]) => ({ table, functions: names })),
      experts: owners.filter((owner) => owner !== 'shared'),
    };
  });
}

/** The modules section of the architecture file. */
function renderModules(list, labels) {
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
    return {
      file,
      functions: (defsByFile.get(file) || []).length,
      // Names, so an expert compares the index with the source name by name, not by count.
      names: (defsByFile.get(file) || []).sort((a, b) => a.start - b.start).map((def) => def.name),
      status: info.status,
      changed: info.freshness === 'metadata_changed' || info.freshness === 'missing',
      ranges: info.ranges || [],
    };
  });

  // Scheduling.
  const entries = [];
  for (const table of model.tables)
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
          dispatcher: dispatcher ? dispatcher.def.name : undefined,
          task: dispatcher?.paths?.[0]?.[0]?.name,
        });
      }
  const tasks = model.tasks
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
            dispatcher: table.dispatcher.name,
          });
      }

  // Calls across the module boundary.
  const callSite = (file, start, name) => {
    const prepared = source(file);
    const def = (defsByFile.get(file) || []).find((item) => item.start === start);
    if (!prepared || !def) return at(file, start);
    const from = prepared.starts[def.start - 1] ?? 0;
    const to = prepared.starts[def.end] ?? prepared.plain.length;
    const pattern = new RegExp(`\\b${name}\\b`, 'g');
    pattern.lastIndex = from;
    const match = pattern.exec(prepared.plain);
    return at(file, match && match.index < to ? lineOf(prepared.starts, match.index) : start);
  };
  const provided = new Map();
  const used = new Map();
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
    }
  }
  const startOf = (name, file) => (defsByFile.get(file) || []).find((def) => def.name === name)?.start;
  // Callers in other experts' files first: those are the interfaces between experts.
  const callerRank = (caller) =>
    caller.owner !== undefined && caller.owner !== 'shared' ? 0 : caller.owner === 'shared' ? 1 : caller.module ? 2 : 3;
  const provides = [...provided.values()]
    .map((item) => ({
      ...item,
      site: at(item.file, startOf(item.name, item.file) ?? 0),
      callers: item.callers.sort(
        (a, b) => callerRank(a) - callerRank(b) || a.site.localeCompare(b.site, 'en', { numeric: true })
      ),
    }))
    .sort((a, b) => b.callers.length - a.callers.length || a.name.localeCompare(b.name));
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

  // Globals, from the source.
  const graphVariables = new Set(variables.filter((row) => ownedSet.has(row[1])).map((row) => `${row[0]}|${row[1]}`));
  const globals = [];
  const definitions = [];
  for (const file of owned) {
    const prepared = source(file);
    if (!prepared) continue;
    if (C_SOURCE.test(file)) {
      for (const item of globalsOf(prepared))
        globals.push({ ...item, inGraph: graphVariables.has(`${item.name}|${file}`), users: [] });
      for (const item of definitionsOf(prepared)) definitions.push({ ...item, file });
    }
  }
  const external = globals.filter((item) => !item.isStatic);
  if (external.length) {
    const byName = new Map(external.map((item) => [item.name, item]));
    const pattern = new RegExp(`\\b(${[...byName.keys()].join('|')})\\b`, 'g');
    for (const file of indexed) {
      if (ownedSet.has(file) || !C_SOURCE.test(file)) continue;
      const prepared = source(file);
      if (!prepared) continue;
      const { plain, starts } = prepared;
      for (const match of plain.matchAll(pattern)) {
        const previous = plain.slice(Math.max(0, match.index - 2), match.index);
        if (/(\.|->)\s*$/.test(previous) || /\.\s?$/.test(previous)) continue;
        const line = lineOf(starts, match.index);
        const lineText = plain.slice(starts[line - 1], starts[line] ?? plain.length);
        if (/\bextern\b/.test(lineText)) continue;
        const item = byName.get(match[1]);
        const def = enclosing(file, line);
        item.users.push({ file, line, function: def?.name, kind: accessKind(plain, match.index, match[1]) });
      }
    }
  }

  for (const item of globals) item.users.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Address macros used by the module, with their definitions anywhere in the project.
  const addressUses = new Map();
  for (const file of owned) {
    const prepared = source(file);
    if (!prepared) continue;
    for (const match of prepared.code.matchAll(ADDRESS_MACRO)) {
      const line = lineOf(prepared.starts, match.index);
      const lineText = prepared.code.slice(prepared.starts[line - 1], prepared.starts[line] ?? prepared.code.length);
      if (new RegExp(`^\\s*#\\s*define\\s+${match[0]}\\b`).test(lineText)) continue;
      if (!addressUses.has(match[0])) addressUses.set(match[0], []);
      const sites = addressUses.get(match[0]);
      if (!sites.some((site) => site.file === file && site.line === line)) sites.push({ file, line });
    }
  }
  const addresses = [...addressUses]
    .map(([name, sites]) => ({ name, sites }))
    .sort((a, b) => b.sites.length - a.sites.length || a.name.localeCompare(b.name))
    .slice(0, LIMITS.addresses);
  if (addresses.length) {
    const wanted = new Map(addresses.map((item) => [item.name, item]));
    const define = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+(${[...wanted.keys()].join('|')})\\b(.*)$`, 'gm');
    // The module's own files first, then the rest of the project.
    for (const file of [...owned, ...indexed.filter((item) => !ownedSet.has(item))]) {
      if ([...wanted.values()].every((item) => item.definition)) break;
      const prepared = source(file);
      if (!prepared) continue;
      for (const match of prepared.code.matchAll(define)) {
        const item = wanted.get(match[1]);
        if (item.definition) continue;
        const line = lineOf(prepared.starts, match.index);
        const raw = prepared.literals.slice(match.index, prepared.literals.indexOf('\n', match.index) >>> 0);
        // A function-like macro keeps its parameters with its name: NVM_ADDR(block) = (block).
        const parts = /^\s*#\s*define\s+\w+(\([^)]*\))?(.*)$/.exec(raw) || [];
        item.definition = { file, line, params: parts[1] || '', value: collapse(parts[2] || '').slice(0, 120) };
      }
    }
  }

  // Build switches.
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
    fileStates,
    tasks,
    entries,
    structs,
    provides,
    uses,
    globals,
    addresses,
    switches: [...switches].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
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
  out.push('');

  out.push(`## ${t.briefEntries}`, '');
  const scheduled = [];
  for (const task of data.tasks) scheduled.push(`- ${fill(t.taskLine, { name: code(task.name), site: task.site })}`);
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
    scheduled.push(`- ${parts.join('; ')} (${entry.site})`);
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
      }`
    );
  out.push(...(scheduled.length ? scheduled : [t.entriesNone]), '');

  out.push(`## ${t.briefProvides}`, '');
  if (!data.provides.length) out.push(t.providesNone);
  for (const item of data.provides.slice(0, LIMITS.provides)) {
    const callers = item.callers
      .slice(0, LIMITS.callers)
      .map((caller) => `${code(caller.name)} (${caller.site}, ${ownerLabel(caller.owner, data, t, caller.module)})`)
      .join(', ');
    out.push(`- ${code(item.name)} (${item.site}) ← ${callers}${more(item.callers, LIMITS.callers, t)}`);
  }
  if (data.provides.length > LIMITS.provides)
    out.push(`- ${fill(t.more, { count: data.provides.length - LIMITS.provides })}`);
  out.push('', t.providesGap, '');

  out.push(`## ${t.briefUses}`, '');
  if (!data.uses.length) out.push(t.none);
  let shown = 0;
  for (const group of data.uses) {
    if (shown >= LIMITS.uses) break;
    const list = group.functions.slice(0, LIMITS.uses - shown);
    shown += list.length;
    out.push(
      `- ${ownerLabel(group.owner, data, t, group.module)}: ${list.map((item) => `${code(item.name)} (${item.file})`).join(', ')}${more(group.functions, list.length, t)}`
    );
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
  if (exported.length > LIMITS.globals) out.push(`- ${fill(t.more, { count: exported.length - LIMITS.globals })}`);
  const names = (list) =>
    list
      .slice(0, LIMITS.statics)
      .map((item) => `${code(item.name)}${item.inGraph ? '' : '*'}`)
      .join(', ') + more(list, LIMITS.statics, t);
  if (unused.length) out.push(`- ${t.globalUnused}: ${names(unused)}`);
  if (statics.length) out.push(`- ${fill(t.globalStatics, { names: names(statics) })}`);
  out.push('');

  out.push(`## ${t.briefAddresses}`, '');
  if (!data.addresses.length) out.push(t.none);
  for (const item of data.addresses) {
    const definition = item.definition
      ? fill(t.addressDefined, {
          value: code(item.definition.value || '—'),
          site: at(item.definition.file, item.definition.line),
        })
      : t.addressUndefined;
    const sites = item.sites
      .slice(0, LIMITS.addressSites)
      .map((site) => at(site.file, site.line))
      .join(', ');
    out.push(
      `- ${code(item.name + (item.definition?.params ?? ''))}: ${definition}; ${fill(t.addressUsed, { sites: sites + more(item.sites, LIMITS.addressSites, t) })}`
    );
  }
  out.push('');

  out.push(`## ${t.briefSwitches}`, '');
  out.push(
    data.switches.length
      ? data.switches
          .slice(0, LIMITS.switches)
          .map(([name, count]) => `${code(name)} ×${count}`)
          .join(', ') + more(data.switches, LIMITS.switches, t)
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
  return lines;
}

/** The short form the expert's role rules carry, in English like the rest of the rules. */
function digest(data) {
  const missingGlobals = data.globals.filter((item) => !item.inGraph).length;
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
    ].slice(0, LIMITS.digestEntries),
    provides: data.provides.slice(0, LIMITS.digestProvides).map((item) => ({
      name: item.name,
      callers: [...new Set(item.callers.map((caller) => ownerLabelPlain(caller.owner, data, caller.module)))],
    })),
    writtenOutside: data.globals
      .filter((item) => item.users.some((user) => user.kind !== 'read'))
      .slice(0, LIMITS.digestGlobals)
      .map((item) => item.name),
    issues: {
      partial: data.fileStates.filter((item) => item.status === 'partial').length,
      unusable: data.fileStates.filter((item) => item.status === 'unusable').length,
      changed: data.fileStates.filter((item) => item.changed).length,
      missingFunctions: data.missingFunctions.length,
      missingGlobals,
      unmatched: data.unmatched.length,
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
 * What the expert and the user wrote: everything outside the markers but the title Woody
 * gives a new card, with whitespace collapsed. Empty while nobody has written anything.
 */
function ownPart(text, expert) {
  if (text === undefined) return '';
  const start = text.indexOf(MARK.start);
  const end = text.indexOf(MARK.end, start);
  const rest = start < 0 || end < 0 ? text : text.slice(0, start) + text.slice(end + MARK.end.length);
  return rest
    .split(/\r?\n/)
    .filter((line) => line.trim() !== `# ${expert.name}`)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  renderModules,
  collect,
  renderBrief,
  digest,
  mergeCard,
  ownPart,
  cardLanguage,
  cardState,
  ownerOf,
  entryMatch,
  sourceCache,
  globalsOf,
  definitionsOf,
  accessKind,
};
