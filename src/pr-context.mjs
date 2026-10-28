import { extractSourcesStreaming } from './repository-snapshot.mjs';
import { repositoryReviewRules } from './repo-profile.mjs';

const ignored = /(?:^|\/)(?:node_modules|vendor|dist|build)\/|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|lock)$/i;
const textSource = /\.(?:py|pyi|pyx|js|jsx|mjs|cjs|ts|tsx|java|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|inc|cu|cuh|hip|cl|mlir|td|proto|bzl|bazel|cmake|yaml|yml|json|toml|ini|cfg|md|rst|sh)$|(?:^|\/)(?:BUILD|WORKSPACE|CMakeLists\.txt|Makefile|Dockerfile[^/]*)$/i;
const genericSymbols = new Set([
  'return', 'import', 'config', 'self', 'value', 'values', 'result', 'results', 'input', 'output',
  'logger', 'logging', 'runtime', 'forward', 'enabled', 'expected', 'received', 'partial', 'hidden',
]);
const DEFAULT_SEARCH_INTERVAL_MS = 2100;
let searchTail = Promise.resolve();
let nextSearchAt = 0;
let searchDisabledUntil = 0;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rateLimitedCodeSearch(octokit, args, intervalMs) {
  const run = searchTail.then(async () => {
    const now = Date.now();
    if (now < searchDisabledUntil) throw Object.assign(new Error('code search cooldown'), { status: 403, cooldown: true });
    const delay = Math.max(0, nextSearchAt - now);
    if (delay) await wait(delay);
    try {
      return await octokit.rest.search.code(args);
    } catch (error) {
      if (error?.status === 403 || error?.status === 429) {
        const retryAfter = Number.parseInt(error?.response?.headers?.['retry-after'] || '', 10);
        const resetAt = Number.parseInt(error?.response?.headers?.['x-ratelimit-reset'] || '', 10) * 1000;
        const fallback = Date.now() + 60000;
        searchDisabledUntil = Math.max(searchDisabledUntil,
          Number.isFinite(retryAfter) ? Date.now() + retryAfter * 1000 : 0,
          Number.isFinite(resetAt) ? resetAt + 1000 : 0, fallback);
      }
      throw error;
    } finally {
      nextSearchAt = Date.now() + intervalMs;
    }
  });
  searchTail = run.catch(() => {});
  return run;
}


function addSignal(map, name, kind, score, origin) {
  if (!name || name.length < 4 || genericSymbols.has(name.toLowerCase())) return;
  const key = `${kind}:${name}`;
  const current = map.get(key) || { name, kind, score: 0, origins: new Set() };
  current.score = Math.max(current.score, score);
  current.origins.add(origin);
  map.set(key, current);
}

const NATIVE_SOURCE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inc|cu|cuh|hip|cl)$/i;
const BUILD_FILE = /(?:^|\/)(?:CMakeLists\.txt|BUILD(?:\.bazel)?|WORKSPACE|Makefile)$|\.(?:cmake|bzl)$/;
// Definitions in Python, Go, C/C++ (struct/class) and C macros.
const DEFINITION = /\b(?:class|def|struct|func(?:\s*\([^)]*\))?)\s+([A-Za-z_]\w*)|#\s*define\s+([A-Za-z_]\w*)/g;
// The function or class named in a hunk header: `@@ … @@ def f(`, `func (s *S) Run(`, `int foo::bar(`.
export function enclosingDefinition(header) {
  const context = (/^@@ [^@]*@@\s*(.*)$/.exec(header)?.[1] || '').trim();
  const name = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(context)?.[1]
    || /^func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(context)?.[1]
    || /^(?:template\s*<[^>]*>\s*)?(?:struct|class)\s+([A-Za-z_]\w*)/.exec(context)?.[1]
    || /([A-Za-z_]\w*)\s*\(/.exec(context)?.[1];
  return name && name.length > 4 && !/^(?:while|switch|return|sizeof|static_assert)$/.test(name) ? name : null;
}

const isTestPath = path => /(?:^|\/)tests?\//i.test(path) || /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/i.test(path);

// New-side source of a patch: context and added lines without diff markers.
function newSideLines(patch = '') {
  return String(patch).split('\n')
    .filter(line => !/^(?:@@|\+\+\+|---|diff |index |\\ No newline)/.test(line) && !line.startsWith('-'))
    .map(line => (line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line));
}

// Python imports on the new side of a patch, including parenthesized multi-line
// name lists. Aliases are reduced to the imported name.
export function parseImports(patch) {
  const text = newSideLines(patch).join('\n');
  const found = [];
  for (const match of text.matchAll(/^[ \t]*from[ \t]+(\.+[\w.]*|[A-Za-z_][\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm)) {
    const names = match[2].replace(/#[^\n]*/g, ' ').replace(/[()\\]/g, ' ').split(',')
      .map(item => item.trim().split(/\s+/)[0]).filter(name => /^[A-Za-z_]\w*$/.test(name));
    found.push({ module: match[1], names });
  }
  for (const match of text.matchAll(/^[ \t]*import[ \t]+([A-Za-z_][\w.]*)/gm)) found.push({ module: match[1], names: [] });
  return found;
}

// Absolute imports are anchored at every changed path segment naming the
// top-level package, so both vllm_hcu/... and python/sglang/... layouts resolve.
function importStems(module, filename, files) {
  if (module.startsWith('.')) {
    const dots = module.match(/^\.+/)[0].length;
    const rest = module.slice(dots).split('.').filter(Boolean);
    return [[...filename.split('/').slice(0, -dots), ...rest].join('/')];
  }
  const parts = module.split('.');
  const roots = new Set();
  for (const file of files) {
    const segments = file.filename.split('/');
    segments.forEach((segment, i) => {
      if (segment === parts[0] && i < segments.length - 1) roots.add(segments.slice(0, i).join('/'));
    });
  }
  return [...roots].map(root => [root, ...parts].filter(Boolean).join('/'));
}

// Changed file -> changed files it imports (directly or as a submodule).
export function changedImportGraph(files) {
  const changed = new Set(files.map(file => file.filename));
  const graph = new Map(files.map(file => [file.filename, new Set()]));
  for (const file of files) {
    for (const { module, names } of parseImports(file.patch || '')) {
      for (const stem of importStems(module, file.filename, files)) {
        for (const path of [`${stem}.py`, `${stem}/__init__.py`, ...names.map(name => `${stem}/${name}.py`)]) {
          if (path !== file.filename && changed.has(path)) graph.get(file.filename).add(path);
        }
      }
    }
  }
  return graph;
}

export function extractRepositoryContextSignals(files, { maxSearchSignals = 6, maxImports = 8 } = {}) {
  const changed = new Set(files.map(file => file.filename));
  // Symbols and settings introduced by this PR do not exist on the default
  // branch, so code search cannot find them.
  // A definition that also appears on a removed line is modified, not new: its
  // existing callers are exactly the context the review needs.
  const added = new Set(), removed = new Set();
  for (const file of files) {
    for (const raw of String(file.patch || '').split('\n')) {
      if (!/^[+-]/.test(raw) || /^(?:\+\+\+|---)/.test(raw)) continue;
      const target = raw.startsWith('+') ? added : removed;
      for (const match of raw.matchAll(DEFINITION)) target.add(match[1] || match[2]);
      const setting = /^[+-]\s*["']?([A-Z][A-Z0-9_]{5,})["']?\s*[:=]/.exec(raw);
      if (setting) target.add(setting[1]);
    }
  }
  const defined = new Set([...added].filter(name => !removed.has(name)));
  // Imported names are fetched through their module, or are in this diff; never search them.
  const imported = new Set(files.flatMap(file => parseImports(file.patch || '').flatMap(item => item.names)));
  const imports = new Map();
  const signals = new Map();
  const includes = new Map();
  for (const file of files) {
    if (!file?.patch || !file.filename) continue;
    const test = isTestPath(file.filename);
    const native = NATIVE_SOURCE.test(file.filename), build = BUILD_FILE.test(file.filename), go = /\.go$/.test(file.filename);
    if (native) for (const line of newSideLines(file.patch)) {
      const include = /^\s*#\s*include\s*"([^"]+)"/.exec(line);
      if (include && !includes.has(include[1])) includes.set(include[1], { include: include[1], origin: file.filename });
    }
    for (const { module, names } of parseImports(file.patch)) {
      for (const stem of importStems(module, file.filename, files)) {
        const alternatives = [`${stem}.py`, `${stem}/__init__.py`];
        if (alternatives.some(path => changed.has(path))) continue;
        // `from pkg import changed_module` is already in the diff.
        const symbols = names.filter(name => !changed.has(`${stem}/${name}.py`) && !changed.has(`${stem}/${name}/__init__.py`));
        if (names.length && !symbols.length) continue;
        const current = imports.get(stem) || { alternatives, symbols: new Set(), origins: new Set(), terms: new Set(), test: true };
        for (const name of symbols) current.symbols.add(name);
        current.terms.add(module);
        current.origins.add(file.filename);
        current.test &&= test;
        imports.set(stem, current);
      }
    }
    for (const raw of file.patch.split('\n')) {
      // Enclosing definitions of modified hunks: callers live elsewhere.
      const enclosing = raw.startsWith('@@') ? enclosingDefinition(raw) : null;
      if (enclosing && !defined.has(enclosing)) addSignal(signals, enclosing, 'symbol', 100, file.filename);
      // Only changed lines carry signals; context lines are unrelated to the change.
      if (!/^[+-]/.test(raw) || /^(?:\+\+\+|---)/.test(raw)) continue;
      const line = raw.slice(1);
      if (raw.startsWith('-')) {
        for (const match of line.matchAll(DEFINITION)) {
          const name = match[1] || match[2];
          if (name.length > 4) addSignal(signals, name, 'symbol', 100, file.filename);
        }
      }
      for (const match of line.matchAll(/\b(?:config|cfg|settings|options?)\.([A-Za-z_]\w{3,})/gi)) {
        if (!defined.has(match[1])) addSignal(signals, match[1], 'config', 90, file.filename);
      }
      for (const match of line.matchAll(/["']([A-Z][A-Z0-9_]{5,})["']/g)) {
        if (!defined.has(match[1])) addSignal(signals, match[1], 'config', 85, file.filename);
      }
      // C/C++ macros, CMake/Bazel options and Go constants are not quoted.
      if (native || build || go) {
        for (const match of line.matchAll(/(?<![\w"'])([A-Z][A-Z0-9]*_[A-Z0-9_]{3,})(?![\w"'])/g)) {
          if (!defined.has(match[1])) addSignal(signals, match[1], 'config', 80, file.filename);
        }
      }
      if (test) continue;
      // Go and C++ call sites: pkg.Func( / obj.Method( / ns::Func( / CamelCaseFunction(.
      if (native || go) {
        for (const match of line.matchAll(/(?:\b[a-z]\w*\.|::)([A-Z]\w{3,})\s*\(|\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\s*\(/g)) {
          const name = match[1] || match[2];
          if (!defined.has(name)) addSignal(signals, name, 'symbol', 60, file.filename);
        }
      }
      for (const match of line.matchAll(/\b(_?[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+)\b/g)) {
        if (!defined.has(match[1]) && !imported.has(match[1]) && !/^test_/.test(match[1])) addSignal(signals, match[1], 'symbol', 55, file.filename);
      }
    }
  }
  const rank = (a, b) => b.score - a.score || b.origins.size - a.origins.size || b.name.length - a.name.length;
  const ordered = [...signals.values()].sort(rank);
  const configLimit = Math.min(2, ordered.filter(value => value.kind === 'config').length);
  const symbolLimit = Math.max(0, maxSearchSignals - configLimit);
  const selected = [
    ...ordered.filter(value => value.kind === 'symbol').slice(0, symbolLimit),
    ...ordered.filter(value => value.kind === 'config').slice(0, configLimit),
  ].sort(rank).slice(0, maxSearchSignals);
  // Source files' imports before tests'; count modules, not candidate paths.
  return {
    imports: [...imports.values()].sort((a, b) => Number(a.test) - Number(b.test) || b.symbols.size - a.symbols.size)
      .slice(0, maxImports)
      .map(value => ({ ...value, path: value.alternatives[0], symbols: [...value.symbols], origins: [...value.origins], terms: [...value.terms] })),
    signals: selected.map(value => ({ ...value, origins: [...value.origins] })),
    includes: [...includes.values()].slice(0, maxImports),
  };
}

function decodeContent(data) {
  if (!data || Array.isArray(data) || data.type === 'dir' || typeof data.content !== 'string') return null;
  if (data.encoding === 'base64') return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
  return data.content;
}

function excerptAround(content, terms, maxChars = 2600) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let target = 0;
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definition = new RegExp(`(?:\\b(?:def|class|struct|func|type|enum|using)\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\b|#\\s*define\\s+${escaped}\\b|^\\s*${escaped}\\s*[:=]|^[\\w:<>,*&\\s]+\\b${escaped}\\s*\\()`);
    const found = lines.findIndex(line => definition.test(line));
    const any = found >= 0 ? found : lines.findIndex(line => line.includes(term));
    if (any >= 0) { target = any; break; }
  }
  let start = Math.max(0, target - 18), end = Math.min(lines.length, target + 35);
  let rendered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
  while (rendered.length > maxChars && end - start > 8) {
    if (target - start > end - target) start++; else end--;
    rendered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
  }
  return rendered.slice(0, maxChars);
}

// Definitions of the imported symbols (with decorators and body), so the model
// sees signatures and contracts instead of the module's import header.
function definitionExcerpt(content, symbols, maxChars) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const ranges = [];
  for (const symbol of symbols) {
    const pattern = new RegExp(`^\\s*(?:(?:async\\s+)?def|class)\\s+${symbol}\\b|^${symbol}\\s*(?::[^=]*)?=`);
    const at = lines.findIndex(line => pattern.test(line));
    if (at < 0) continue;
    const indent = lines[at].match(/^\s*/)[0].length;
    let start = at;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    let end = at + 1;
    while (end < lines.length && end - at < 60) {
      const line = lines[end];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent && !/^\s*[)\]}]/.test(line)) break;
      end++;
    }
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 2) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let rendered = '';
  for (const [start, end] of merged) {
    const block = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    if (rendered.length + block.length + 5 > maxChars) break;
    rendered += `${rendered ? '\n...\n' : ''}${block}`;
  }
  return rendered;
}

const errorCode = error => Number.isInteger(error?.status) ? `http_${error.status}` : 'unavailable';
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One snapshot per base commit, shared by the context builder, review rules and
// concurrent reviews of PRs against the same base. Only the latest few are kept.
const snapshotCache = new Map();
const SNAPSHOT_CACHE_SIZE = 3;
const parentDirs = files => {
  const dirs = new Set();
  for (const file of files) {
    const parts = file.filename.split('/').slice(0, -1);
    for (let i = 1; i <= Math.min(parts.length, 3); i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  return [...dirs];
};

export function loadBaseSnapshot({ octokit, owner, repo, baseSha, files = [], timeoutMs = 120000 }) {
  const key = `${owner}/${repo}@${baseSha}`;
  if (!snapshotCache.has(key)) {
    const near = parentDirs(files);
    const loading = (async () => {
      const response = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
        owner, repo, ref: baseSha, request: { timeout: timeoutMs } });
      if (typeof response.data === 'string') throw new Error('tarball_unavailable');
      return extractSourcesStreaming(Buffer.from(response.data), baseSha, { prefer: path => near.some(dir => path.startsWith(dir)) });
    })();
    snapshotCache.set(key, loading);
    loading.catch(() => snapshotCache.delete(key));
    while (snapshotCache.size > SNAPSHOT_CACHE_SIZE) snapshotCache.delete(snapshotCache.keys().next().value);
  }
  return snapshotCache.get(key);
}

// Code search only indexes the default branch, while these PRs target release
// branches; searching the base snapshot sees the code the PR will merge into.
function searchSnapshot(snapshot, name, limit = 20) {
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`);
  const hits = [];
  for (const [path, text] of snapshot.files) {
    if (pattern.test(text)) hits.push({ path });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function buildPrRepositoryContext({ octokit, owner, repo, baseSha, files, maxFiles = 8,
  maxChars = 16000, maxSearchSignals, searchIntervalMs = DEFAULT_SEARCH_INTERVAL_MS, log = () => {},
  useBaseSnapshot = true, snapshotTimeoutMs = 120000, snapshot: suppliedSnapshot }) {
  const changed = new Set(files.map(file => file.filename));
  let snapshot = suppliedSnapshot || null;
  if (!snapshot && useBaseSnapshot && /^[a-f0-9]{40}$/.test(baseSha || '')) {
    try { snapshot = await loadBaseSnapshot({ octokit, owner, repo, baseSha, files, timeoutMs: snapshotTimeoutMs }); }
    catch (error) { log(`[Review context] base-snapshot failed code=${errorCode(error)}; falling back to code search`); }
  }
  // Local search has no rate limit, so it can afford more signals and hits.
  const signalLimit = maxSearchSignals ?? (snapshot ? 8 : 3);
  const searchEntryLimit = snapshot ? 5 : 3, searchCharLimit = snapshot ? 9000 : 6000;
  const { imports, signals, includes } = extractRepositoryContextSignals(files, { maxSearchSignals: signalLimit });
  const candidates = new Map();
  let failures = 0;
  const addCandidate = ({ path, alternatives = [path], symbols = [], kind, terms, origins, score }) => {
    if (!path || changed.has(path) || ignored.test(path) || !textSource.test(path)) return;
    // Prose that merely mentions a symbol is not a contract the code must satisfy.
    if (kind !== 'import' && /\.(?:md|rst)$/i.test(path)) return;
    const current = candidates.get(path) || { path, alternatives, symbols: new Set(), kinds: new Set(), terms: new Set(), origins: new Set(), score: 0 };
    current.kinds.add(kind);
    for (const symbol of symbols) current.symbols.add(symbol);
    for (const term of terms || []) current.terms.add(term);
    for (const origin of origins || []) current.origins.add(origin);
    current.score = Math.max(current.score, score);
    candidates.set(path, current);
  };

  for (const imported of imports) {
    addCandidate({ ...imported, kind: 'import', terms: [...imported.symbols, ...imported.terms], score: imported.test ? 110 : 130 });
  }
  // Quoted #include paths resolve next to the including file, else by a unique
  // path suffix in the base snapshot (include roots are build-system specific).
  if (snapshot) for (const { include, origin } of includes) {
    const local = [...origin.split('/').slice(0, -1), include].join('/');
    let path = snapshot.files.has(local) ? local : null;
    if (!path) {
      const matches = [...snapshot.files.keys()].filter(name => name === include || name.endsWith(`/${include}`));
      if (matches.length === 1) path = matches[0];
    }
    if (path) addCandidate({ path, kind: 'import', terms: [], origins: [origin], score: 120 });
  }
  const searched = new Map();
  for (const signal of signals) {
    try {
      if (!searched.has(signal.name)) searched.set(signal.name, snapshot ? searchSnapshot(snapshot, signal.name)
        : (await rateLimitedCodeSearch(octokit, { q: `${signal.name} repo:${owner}/${repo}`, per_page: 20 }, searchIntervalMs)).data.items || []);
      const items = searched.get(signal.name);
      for (const item of items) {
        // Contracts and defaults live in source files; test hits are mostly
        // other features' fixtures that crowd out the definitions.
        const testPenalty = isTestPath(item.path) ? -30 : 0;
        const configBonus = signal.kind === 'config' && /config|setting|option/i.test(item.path) ? 30 : 0;
        addCandidate({ path: item.path, kind: signal.kind, terms: [signal.name], origins: signal.origins,
          score: signal.score + testPenalty + configBonus });
      }
    } catch (error) {
      failures++;
      log(`[Review context] code-search failed code=${errorCode(error)}`);
      if (error?.cooldown || error?.status === 403 || error?.status === 429) break;
    }
  }

  const entries = [];
  let usedChars = 0, searchEntries = 0, searchChars = 0;
  for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))) {
    if (entries.length >= maxFiles || usedChars >= maxChars) break;
    // Search hits are lexical matches; keep them from crowding out import definitions.
    const searchOnly = !candidate.kinds.has('import');
    if (searchOnly && (searchEntries >= searchEntryLimit || searchChars >= searchCharLimit)) continue;
    // A module is either NAME.py or NAME/__init__.py; only a miss on both is a failure.
    let content = null, path = null, lastError = null;
    for (const alternative of candidate.alternatives) {
      if (snapshot) {
        content = snapshot.files.get(alternative) || null;
        if (content) { path = alternative; break; }
        continue;
      }
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: alternative, ref: baseSha });
        content = decodeContent(data);
        path = alternative;
        if (content) break;
      } catch (error) { lastError = error; }
    }
    if (!content) {
      if (lastError) { failures++; log(`[Review context] content-fetch failed code=${errorCode(lastError)}`); }
      continue;
    }
    const budget = Math.min(candidate.symbols.size ? 4000 : 2600, maxChars - usedChars);
    // Imported names that are not defined here (re-exports, packages) would only
    // yield an unrelated header excerpt.
    const excerpt = candidate.symbols.size ? definitionExcerpt(content, [...candidate.symbols], budget)
      : excerptAround(content, [...candidate.terms], budget);
    if (!excerpt.trim()) continue;
    entries.push({ filename: path, kinds: [...candidate.kinds], terms: [...candidate.terms],
      origins: [...candidate.origins], score: candidate.score, excerpt });
    usedChars += excerpt.length;
    if (searchOnly) { searchEntries++; searchChars += excerpt.length; }
  }
  log(`[Review context] repository=${owner}/${repo} source=${snapshot ? 'base-snapshot' : 'code-search'} imports=${imports.length} signals=${signals.length} selected=${entries.length} chars=${usedChars} failures=${failures}`);
  return entries;
}

// Other changed files of this PR that import, or are imported by, the batch.
// Batches are cut by size, so a caller and its callee often land apart; this
// keeps the contract between them visible to both sides.
export function relatedChangedFilesForBatch(batch, files, { maxChars = 12000 } = {}) {
  const graph = changedImportGraph(files);
  const inBatch = new Set(batch.files.map(file => file.filename));
  const related = new Map();
  for (const name of inBatch) {
    for (const dependency of graph.get(name) || []) if (!inBatch.has(dependency)) related.set(dependency, 'imported by this batch');
  }
  for (const [importer, dependencies] of graph) {
    if (!inBatch.has(importer) && !related.has(importer) && [...dependencies].some(path => inBatch.has(path))) related.set(importer, 'imports this batch');
  }
  const ordered = [...related].sort(([a], [b]) => Number(isTestPath(a)) - Number(isTestPath(b)) || a.localeCompare(b));
  let rendered = '';
  for (const [path, relation] of ordered) {
    const room = maxChars - rendered.length;
    if (room < 400) break;
    const file = files.find(item => item.filename === path);
    const lines = newSideLines(file.patch);
    const added = file.status === 'added';
    const body = added ? lines.map((line, index) => `${index + 1}: ${line}`).join('\n') : lines.join('\n');
    let section = `FILE: ${path}\nRELATION: ${relation}\n${added ? 'FULL NEW FILE (line numbers are source lines)' : 'NEW-SIDE HUNKS ONLY (not full file)'}\n${body}\n`;
    if (section.length > room) section = `${section.slice(0, room - 40)}\n[related file truncated]\n`;
    rendered += section;
  }
  return rendered;
}

export function repositoryContextForBatch(batch, entries = [], { maxChars = 12000, focusText = '' } = {}) {
  if (!entries.length) return '';
  const batchFiles = new Set(batch.files.map(file => file.filename));
  const source = `${batch.text}\n${focusText}`;
  const ranked = entries.map(entry => ({ entry, relevance:
    entry.origins.some(file => batchFiles.has(file)) ? 100 : entry.terms.some(term => source.includes(term)) ? 50 : 0 }))
    .filter(value => value.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.entry.score - a.entry.score);
  let result = '';
  for (const { entry } of ranked) {
    const section = `FILE: ${entry.filename}\nUNCHANGED BASE FILE EXCERPT\nSELECTED_BY: ${entry.kinds.join(',')}\n${entry.excerpt}\n`;
    if (result.length + section.length > maxChars) continue;
    result += `${result ? '\n' : ''}${section}`;
  }
  return result;
}

export function prDescriptionContext(description, maxChars = 6000) {
  if (typeof description !== 'string' || !description.trim()) return '';
  const normalized = description.trim().replace(/\u0000/g, '');
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n[PR 描述已按长度截断]` : normalized;
}

// Everything the legacy engine needs from the base branch, from one snapshot:
// unchanged-code context and maintainer review rules (AGENTS.md / REVIEW.md).
export async function prepareRepositoryReview({ octokit, owner, repo, baseSha, files, log = () => {} }) {
  let snapshot = null;
  if (/^[a-f0-9]{40}$/.test(baseSha || '')) {
    try { snapshot = await loadBaseSnapshot({ octokit, owner, repo, baseSha, files }); }
    catch (error) { log(`[Review context] base-snapshot failed code=${errorCode(error)}; falling back to code search`); }
  }
  const repositoryContext = await buildPrRepositoryContext({ octokit, owner, repo, baseSha, files, log, snapshot, useBaseSnapshot: false });
  const reviewRules = repositoryReviewRules(snapshot, files);
  if (snapshot) log(`[Review context] snapshot files=${snapshot.files.size} omitted=${snapshot.omittedFiles} rules=${reviewRules.length}`);
  return { repositoryContext, reviewRules };
}
