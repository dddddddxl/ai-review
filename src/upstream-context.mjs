// Upstream source for runtime-patch adapters.
//
// Plugin repositories (vllm-plugin-das and friends) change behaviour by patching
// an installed upstream package at import time. Each adapter declares what it
// replaces:
//
//   TARGET_MODULE = "vllm.model_executor.layers.fused_moe.experts.triton_moe"
//   TARGETS = (f"{TARGET_MODULE}.TritonExperts.apply",)
//
// Whether such a patch is correct depends on the semantics of the replaced
// upstream code, which is neither in the diff nor in the plugin repository.
// This module reads the replaced definitions from a local, read-only copy of the
// installed upstream package so the reviewer can compare both side by side.
import fs from 'node:fs';
import path from 'node:path';

// Upstream packages are only read from configured local directories. Paths are
// resolved from Python module names and must stay inside the configured root.
//
// AI_UPSTREAM_SOURCES="vllm=/upstream/vllm" applies to every repository.
// AI_UPSTREAM_CONFIG=/path/upstream.json selects sources per repository and base
// branch, since one plugin repository can target several upstream versions:
//   [{"repository": "HYGON-AI/vllm-plugin-das", "baseRef": "^v0\\.28\\.1",
//     "sources": {"vllm": "/upstream/vllm-0.28.1/vllm"}}]
// The first entry whose repository and baseRef pattern match wins.
export function upstreamRoots(environment = process.env, { repository = '', baseRef = '' } = {}) {
  const roots = new Map();
  const add = (name, root) => {
    if (/^[A-Za-z_]\w*$/.test(name) && typeof root === 'string' && root && fs.existsSync(root)) roots.set(name, path.resolve(root));
  };
  if (environment.AI_UPSTREAM_CONFIG) {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(environment.AI_UPSTREAM_CONFIG, 'utf8')); } catch { entries = []; }
    const match = (Array.isArray(entries) ? entries : []).find(entry =>
      String(entry?.repository || '').toLowerCase() === repository.toLowerCase() &&
      (() => { try { return new RegExp(entry.baseRef || '.*').test(baseRef); } catch { return false; } })());
    for (const [name, root] of Object.entries(match?.sources || {})) add(name, root);
    if (match) return roots;
  }
  for (const entry of String(environment.AI_UPSTREAM_SOURCES || '').split(',')) {
    const at = entry.indexOf('=');
    if (at > 0) add(entry.slice(0, at).trim(), entry.slice(at + 1).trim());
  }
  return roots;
}

function newSideText(patch = '') {
  return String(patch).split('\n')
    .filter(line => !/^(?:@@|\+\+\+|---|diff |index |\\ No newline)/.test(line) && !line.startsWith('-'))
    .map(line => (line.startsWith('+') || line.startsWith(' ') ? line.slice(1) : line)).join('\n');
}

// Resolve the TARGET_MODULE / TARGETS declarations an adapter makes.
export function adapterTargets(source) {
  const strings = new Map();
  // NAME = "a.b", NAME = ("a.b"), and parenthesized/implicitly concatenated literals over several lines.
  for (const match of source.matchAll(/^([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*(\(\s*)?((?:["'][\w.]+["']\s*)+)(?:\))?[ \t]*$/gm)) {
    if (match[2] === undefined && /\n/.test(match[3].trim())) continue;
    strings.set(match[1], [...match[3].matchAll(/["']([\w.]+)["']/g)].map(part => part[1]).join(''));
  }
  const module = strings.get('TARGET_MODULE');
  if (!module) return null;
  // TARGETS = (...) on one line or spread over several; stop at its closing paren.
  const start = /^TARGETS\s*=\s*\(/m.exec(source);
  let body = '';
  if (start) {
    let depth = 0, quote = null;
    for (let i = start.index + start[0].length - 1; i < source.length; i++) {
      const c = source[i];
      if (quote) { if (c === quote && source[i - 1] !== '\\') quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { body = source.slice(start.index + start[0].length, i); break; }
    }
  }
  const targets = [];
  for (const match of body.matchAll(/f?["']([^"']+)["']/g)) {
    const value = match[1].replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => strings.get(name) ?? `{${name}}`);
    if (/^[\w.]+$/.test(value)) targets.push(value);
  }
  return { module, targets: targets.length ? targets : [module] };
}

// AI_UPSTREAM_SOURCES maps a top-level package to its installed package
// directory, e.g. "vllm=/upstream/vllm".
function moduleFile(roots, moduleName) {
  const parts = moduleName.split('.');
  const root = roots.get(parts[0]);
  if (!root) return null;
  const inner = parts.slice(1);
  for (const candidate of [inner.length ? path.join(root, ...inner) + '.py' : null, path.join(root, ...inner, '__init__.py')]) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    if (resolved.startsWith(root + path.sep) && fs.existsSync(resolved)) {
      const canonicalRoot = fs.realpathSync(root), canonicalFile = fs.realpathSync(resolved);
      if (canonicalFile.startsWith(canonicalRoot + path.sep)) return canonicalFile;
    }
  }
  return null;
}

// Lines of a def/class (decorators included) found by its qualified name inside a module.
function definitionRange(lines, qualname) {
  let from = 0, to = lines.length, indent = -1, found = null;
  for (const name of qualname) {
    const pattern = new RegExp(`^(\\s*)(?:(?:async\\s+)?def|class)\\s+${name}\\b`);
    let at = -1;
    for (let i = from; i < to; i++) {
      const match = pattern.exec(lines[i]);
      if (match && match[1].length > indent) { at = i; indent = match[1].length; break; }
    }
    if (at < 0) return null;
    let end = at + 1;
    while (end < to) {
      const line = lines[end];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent && !/^\s*[)\]}]/.test(line)) break;
      end++;
    }
    let start = at;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    found = [start, end];
    from = at + 1; to = end;
  }
  return found;
}

export function upstreamDefinition(roots, target, { maxLines = 400, maxDepth = 6, seen = new Set() } = {}) {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(target) || seen.has(target) || maxDepth < 0) return null;
  seen = new Set([...seen, target]);
  const parts = target.split('.');
  // Longest module prefix that exists on disk; the rest is the qualified name.
  for (let split = parts.length; split > 0; split--) {
    const module = parts.slice(0, split).join('.');
    const file = moduleFile(roots, module);
    if (!file) continue;
    const qualname = parts.slice(split);
    const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const range = qualname.length ? definitionRange(lines, qualname) : [0, Math.min(lines.length, 120)];
    if (!range) {
      // Packages commonly re-export public classes from implementation modules.
      // Resolve imports as source text only; never import/execute the package.
      const importModule = path.basename(file) === '__init__.py' ? `${module}.__init__` : module;
      const exported = moduleImports(lines, importModule).get(qualname[0]);
      if (exported) {
        const resolvedTarget = [exported, ...qualname.slice(1)].join('.');
        const found = upstreamDefinition(roots, resolvedTarget, { maxLines, maxDepth: maxDepth - 1, seen });
        if (found && !found.missing) return { ...found, requestedTarget: target,
          resolution: [{ target, file }, ...(found.resolution || [])] };
      }
      return { target, module, file, lines, missing: true };
    }
    const [start, end] = range;
    const shown = lines.slice(start, Math.min(end, start + maxLines));
    return { target, module, qualname, file, lines, start: start + 1, end, clipped: end - start > maxLines,
      text: shown.map((line, i) => `${start + i + 1}: ${line}`).join('\n') };
  }
  return null;
}

// Local names a Python module imports, mapped to qualified targets:
// `import a.b as m` -> m: a.b; `from a.b import c as d` -> d: a.b.c
function moduleImports(lines, module) {
  const names = new Map();
  const text = lines.join('\n');
  for (const match of text.matchAll(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) {
    names.set(match[2] || match[1].split('.')[0], match[2] ? match[1] : match[1].split('.')[0]);
  }
  for (const match of text.matchAll(/^from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    let source = match[1];
    if (source.startsWith('.')) {
      const dots = source.match(/^\.+/)[0].length;
      source = [...module.split('.').slice(0, -dots), ...source.slice(dots).split('.').filter(Boolean)].join('.');
    }
    for (const item of match[2].replace(/#[^\n]*/g, ' ').replace(/[()\\]/g, ' ').split(',')) {
      const [name, , alias] = item.trim().split(/\s+/);
      if (/^[A-Za-z_]\w*$/.test(name || '')) names.set(alias || name, `${source}.${name}`);
    }
  }
  return names;
}

// Qualified names of a class's base classes, resolved through the module's imports.
function classBases(found, className) {
  const pattern = new RegExp(`^\\s*class\\s+${className}\\s*\\(([^)]*)\\)`, 'm');
  const match = pattern.exec(found.lines.join('\n'));
  if (!match) return [];
  const imports = moduleImports(found.lines, found.module);
  return match[1].split(',').map(base => base.trim()).filter(base => /^[\w.]+$/.test(base) && base !== 'object').map(base => {
    const [head, ...rest] = base.split('.');
    return imports.has(head) ? [imports.get(head), ...rest].join('.') : `${found.module}.${base}`;
  });
}

// Upstream originals for every adapter changed in this PR, keyed by adapter file.
// Besides each replaced definition this includes, budget permitting, what its
// behaviour and contract depend on: helpers it calls on self, the base-class
// definition it overrides (whose docstring states the contract), methods it
// reaches through super(), and package functions it calls directly.
export function upstreamContextForFiles(files, { roots = upstreamRoots(), maxChars = 36000 } = {}) {
  const sections = new Map();
  if (!roots.size) return sections;
  for (const file of files) {
    if (!/\.py$/.test(file.filename) || !file.patch) continue;
    const declared = adapterTargets(newSideText(file.patch));
    if (!declared || !roots.has(declared.module.split('.')[0])) continue;
    let rendered = '', used = 0;
    const seen = new Set();
    const add = (target, note = '') => {
      if (seen.has(target)) return null;
      seen.add(target);
      const found = upstreamDefinition(roots, target);
      // Helpers inherited from a base class are not in this module; say nothing
      // rather than claim the definition is missing.
      if (!found || (note && found.missing)) return null;
      const relative = path.relative(path.dirname(roots.get(target.split('.')[0])), found.file).split(path.sep).join('/');
      const section = found.missing
        ? `TARGET: ${target}${note}\nUPSTREAM FILE: ${relative}\n(definition not found in the installed upstream source)\n`
        : `TARGET: ${target}${note}\nUPSTREAM FILE: ${relative} lines ${found.start}-${found.end}${found.clipped ? ' (clipped)' : ''}\n${found.text}\n`;
      if (used + section.length > maxChars) {
        // Only a replaced definition itself is worth a note; dependencies are best effort.
        if (!note) rendered += `TARGET: ${target}\n(omitted: upstream context budget reached)\n`;
        return null;
      }
      rendered += section; used += section.length;
      return found;
    };
    // First the replaced definitions themselves, then their dependencies in order of value.
    const primary = declared.targets.map(target => ({ target, found: add(target) })).filter(item => item.found?.text);
    const included = [...primary];
    const method = item => item.found.qualname?.length >= 2 ? { cls: item.found.qualname.at(-2), name: item.found.qualname.at(-1),
      owner: item.target.split('.').slice(0, -1).join('.') } : null;
    const baseDefinition = (item, name) => {
      const info = method(item);
      if (!info) return null;
      for (const base of classBases(item.found, info.cls)) {
        const found = upstreamDefinition(roots, `${base}.${name}`);
        if (found?.text) return `${base}.${name}`;
      }
      return null;
    };
    for (const item of primary) {
      const info = method(item);
      if (!info) continue;
      const called = [...new Set([...item.found.text.matchAll(/\bself\.([A-Za-z_]\w*)\(/g)].map(match => match[1]))];
      let helpers = 0;
      for (const name of called) {
        if (helpers >= 4) break;
        const found = add(`${info.owner}.${name}`, ` (called by ${info.name})`);
        if (found) { helpers++; included.push({ target: `${info.owner}.${name}`, found }); }
      }
      const contract = baseDefinition(item, info.name);
      if (contract) {
        const found = add(contract, ` (base-class definition overridden by ${info.cls}.${info.name}; its docstring is the interface contract)`);
        if (found) included.push({ target: contract, found });
      }
    }
    for (const item of [...included]) {
      for (const name of new Set([...item.found.text.matchAll(/\bsuper\(\)\.([A-Za-z_]\w*)\(/g)].map(match => match[1]))) {
        const target = baseDefinition(item, name);
        const found = target && add(target, ` (reached via super() from ${item.target.split('.').at(-1)})`);
        if (found) included.push({ target, found });
      }
    }
    let functions = 0;
    for (const item of [...included]) {
      const imports = moduleImports(item.found.lines, item.found.module);
      let fromItem = 0;
      for (const match of item.found.text.matchAll(/(?<![.\w])([A-Za-z_]\w*)\(/g)) {
        if (functions >= 6 || fromItem >= 2) break;
        const target = imports.get(match[1]);
        if (!target || !roots.has(target.split('.')[0]) || /^[A-Z]/.test(match[1])) continue;
        if (add(target, ` (called by ${item.target.split('.').at(-1)})`)) { functions++; fromItem++; }
      }
    }
    if (rendered) sections.set(file.filename, rendered);
  }
  return sections;
}
