const ignored = /(?:^|\/)(?:node_modules|vendor|dist|build)\/|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|lock)$/i;
const textSource = /\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|java|go|rs|c|cc|cpp|cxx|h|hh|hpp|yaml|yml|json|toml|ini|cfg|md|rst|sh)$/i;
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

const normalizePatchLine = line => {
  if (/^(?:@@|\+\+\+|---|diff |index )/.test(line)) return '';
  return /^[ +\-]/.test(line) ? line.slice(1) : line;
};

function addSignal(map, name, kind, score, origin) {
  if (!name || name.length < 4 || genericSymbols.has(name.toLowerCase())) return;
  const key = `${kind}:${name}`;
  const current = map.get(key) || { name, kind, score: 0, origins: new Set() };
  current.score = Math.max(current.score, score);
  current.origins.add(origin);
  map.set(key, current);
}

function importPaths(moduleName, filename, roots) {
  if (!moduleName) return [];
  let parts;
  if (moduleName.startsWith('.')) {
    const dots = moduleName.match(/^\.+/)[0].length;
    const rest = moduleName.slice(dots).split('.').filter(Boolean);
    const base = filename.split('/').slice(0, -dots);
    parts = [...base, ...rest];
  } else {
    parts = moduleName.split('.');
    if (!roots.has(parts[0])) return [];
  }
  if (!parts.length) return [];
  const stem = parts.join('/');
  return [`${stem}.py`, `${stem}/__init__.py`];
}

export function extractRepositoryContextSignals(files, { maxSearchSignals = 6, maxImports = 6 } = {}) {
  const roots = new Set(files.map(file => file.filename?.split('/')[0]).filter(Boolean));
  const imports = new Map();
  const signals = new Map();
  for (const file of files) {
    if (!file?.patch || !file.filename) continue;
    for (const raw of file.patch.split('\n')) {
      const line = normalizePatchLine(raw);
      if (!line) continue;
      const imported = /^\s*(?:from\s+([A-Za-z_][\w.]*|\.+[\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/.exec(line);
      const moduleName = imported?.[1] || imported?.[2];
      for (const path of importPaths(moduleName, file.filename, roots)) {
        const current = imports.get(path) || { path, origins: new Set(), terms: new Set() };
        current.origins.add(file.filename);
        current.terms.add(moduleName);
        imports.set(path, current);
      }
      for (const match of line.matchAll(/\b(?:class|def|function|interface|type|enum)\s+([A-Za-z_]\w{4,})/g)) {
        addSignal(signals, match[1], 'symbol', 100, file.filename);
      }
      for (const match of line.matchAll(/\b(?:config|cfg|settings|options?)\.([A-Za-z_]\w{3,})/gi)) {
        addSignal(signals, match[1], 'config', 90, file.filename);
      }
      for (const match of line.matchAll(/["']([A-Z][A-Z0-9_]{5,})["']/g)) {
        addSignal(signals, match[1], 'config', 85, file.filename);
      }
      if (/^[+\-]/.test(raw) || /^\s*(?:class|def)\s+/.test(line)) {
        for (const match of line.matchAll(/\b(_?[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+)\b/g)) {
          addSignal(signals, match[1], 'symbol', 55, file.filename);
        }
      }
    }
  }
  const ordered = [...signals.values()].sort((a, b) => b.score - a.score || b.name.length - a.name.length);
  const configLimit = Math.min(2, ordered.filter(value => value.kind === 'config').length);
  const symbolLimit = Math.max(0, maxSearchSignals - configLimit);
  const selected = [
    ...ordered.filter(value => value.kind === 'symbol').slice(0, symbolLimit),
    ...ordered.filter(value => value.kind === 'config').slice(0, configLimit),
  ].sort((a, b) => b.score - a.score || b.name.length - a.name.length).slice(0, maxSearchSignals);
  return {
    imports: [...imports.values()].slice(0, maxImports)
      .map(value => ({ ...value, origins: [...value.origins], terms: [...value.terms] })),
    signals: selected.map(value => ({ ...value, origins: [...value.origins] })),
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
    const found = lines.findIndex(line => line.includes(term));
    if (found >= 0) { target = found; break; }
  }
  let start = Math.max(0, target - 18), end = Math.min(lines.length, target + 35);
  let rendered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
  while (rendered.length > maxChars && end - start > 8) {
    if (target - start > end - target) start++; else end--;
    rendered = lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
  }
  return rendered.slice(0, maxChars);
}

const errorCode = error => Number.isInteger(error?.status) ? `http_${error.status}` : 'unavailable';

export async function buildPrRepositoryContext({ octokit, owner, repo, baseSha, files, maxFiles = 5,
  maxChars = 12000, maxSearchSignals = 3, searchIntervalMs = DEFAULT_SEARCH_INTERVAL_MS, log = () => {} }) {
  const changed = new Set(files.map(file => file.filename));
  const { imports, signals } = extractRepositoryContextSignals(files, { maxSearchSignals });
  const candidates = new Map();
  let failures = 0;
  const addCandidate = ({ path, kind, terms, origins, score }) => {
    if (!path || changed.has(path) || ignored.test(path) || !textSource.test(path)) return;
    const current = candidates.get(path) || { path, kinds: new Set(), terms: new Set(), origins: new Set(), score: 0 };
    current.kinds.add(kind);
    for (const term of terms || []) current.terms.add(term);
    for (const origin of origins || []) current.origins.add(origin);
    current.score = Math.max(current.score, score);
    candidates.set(path, current);
  };

  for (const imported of imports) addCandidate({ ...imported, kind: 'import', score: 120 });
  for (const signal of signals) {
    try {
      const { data } = await rateLimitedCodeSearch(octokit, { q: `${signal.name} repo:${owner}/${repo}`, per_page: 10 }, searchIntervalMs);
      for (const item of data.items || []) {
        const testBonus = /(?:^|\/)tests?\//i.test(item.path) ? 25 : 0;
        const configBonus = signal.kind === 'config' && /config|setting|option/i.test(item.path) ? 30 : 0;
        addCandidate({ path: item.path, kind: signal.kind, terms: [signal.name], origins: signal.origins,
          score: signal.score + testBonus + configBonus });
      }
    } catch (error) {
      failures++;
      log(`[Review context] code-search failed code=${errorCode(error)}`);
      if (error?.cooldown || error?.status === 403 || error?.status === 429) break;
    }
  }

  const entries = [];
  let usedChars = 0;
  for (const candidate of [...candidates.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))) {
    if (entries.length >= maxFiles || usedChars >= maxChars) break;
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: candidate.path, ref: baseSha });
      const content = decodeContent(data);
      if (!content) continue;
      const excerpt = excerptAround(content, [...candidate.terms], Math.min(2600, maxChars - usedChars));
      if (!excerpt.trim()) continue;
      entries.push({ filename: candidate.path, kinds: [...candidate.kinds], terms: [...candidate.terms],
        origins: [...candidate.origins], score: candidate.score, excerpt });
      usedChars += excerpt.length;
    } catch (error) {
      failures++;
      log(`[Review context] content-fetch failed code=${errorCode(error)}`);
    }
  }
  log(`[Review context] repository=${owner}/${repo} imports=${imports.length} signals=${signals.length} selected=${entries.length} chars=${usedChars} failures=${failures}`);
  return entries;
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
