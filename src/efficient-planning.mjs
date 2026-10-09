import { makeBatches } from './pr-review.mjs';
import { filterReviewFiles } from './review-planning.mjs';
import { sha256 } from './review-evidence.mjs';

export const METHOD_VERSION = 'specialist-v1';
export function specialistMethods(paths) {
  const result = [];
  if (paths.some(p => p.endsWith('.py'))) result.push({ id: 'python', version: METHOD_VERSION, checks: '核对导入、异步/异常路径、空值和边界；识别断言是否观察真实返回值，mock 是否掩盖行为。' });
  if (paths.some(p => /(^|\/)(Dockerfile[^/]*|docker[^/]*)(\/|$)|\.dockerfile$/i.test(p))) result.push({ id: 'docker', version: METHOD_VERSION, checks: '检查构建上下文、COPY 路径、参数与阶段传递、镜像依赖兼容；不执行构建。' });
  if (paths.some(p => /(^|\/)(\.github|ci|scripts|test|tests)(\/|$)|ci\.ya?ml$/.test(p))) result.push({ id: 'ci', version: METHOD_VERSION, checks: '追踪 workflow→runner/suite→选择器→测试 ID→断言，区分设计、选入和执行；job 成功不是方法通过证据。' });
  if (paths.some(p => /\.(cu|cuh|hip)$/.test(p))) result.push({ id: 'gpu', version: METHOD_VERSION, checks: '核对 dtype、shape、索引边界、设备/后端条件、回退和同步；不运行硬件。' });
  return result;
}

// Deterministic hints, NOT a complete call graph. No model call or repository execution.
export function efficientPlan(input) {
  const files = filterReviewFiles(input), parent = files.map((_, i) => i), links = [];
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  const stem = p => p.split('/').at(-1).replace(/^test_/, '').replace(/\.[^.]+$/, '');
  for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
    const a = files[i], b = files[j], sa = stem(a.filename), sb = stem(b.filename);
    const referenced = [a.patch || '', b.patch || ''];
    const reasons = [];
    const modules = text => [...text.matchAll(/^[ +\-]*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map(m => (m[1] || m[2]).replace(/\./g, '/'));
    const importsA = modules(referenced[0]), importsB = modules(referenced[1]);
    if (importsA.some(m => b.filename.endsWith(`${m}.py`) || b.filename.endsWith(`/${m}/__init__.py`)) ||
        importsB.some(m => a.filename.endsWith(`${m}.py`) || a.filename.endsWith(`/${m}/__init__.py`))) reasons.push('static_import_reference');
    const defined = text => [...text.matchAll(/\b(?:def|class)\s+([A-Za-z_]\w*)/g)].slice(0, 100).map(m => m[1]);
    if (defined(referenced[0]).some(n => referenced[1].includes(`${n}(`)) || defined(referenced[1]).some(n => referenced[0].includes(`${n}(`))) reasons.push('static_call_or_interface_reference');
    if (sa === sb) reasons.push('implementation_test_stem');
    if (sa.length > 3 && referenced[1].includes(sa) || sb.length > 3 && referenced[0].includes(sb)) reasons.push('literal_interface_or_import_reference');
    if (referenced[0].includes(b.filename) || referenced[1].includes(a.filename)) reasons.push('test_or_ci_path_reference');
    if (reasons.length) { parent[root(j)] = root(i); links.push({ paths: [a.filename, b.filename], reasons }); }
  }
  const components = new Map();
  files.forEach((f, i) => { const key = root(i); if (!components.has(key)) components.set(key, []); components.get(key).push(f); });
  const groups = [], batches = [], omitted = [], selected = [], incompletePatches = [];
  for (const component of components.values()) for (let start = 0; start < component.length; start += 10) {
    const group = component.slice(start, start + 10), paths = group.map(f => f.filename), id = `group-${sha256(paths).slice(0, 12)}`;
    groups.push({ id, paths, component_paths: component.map(f => f.filename), links: links.filter(l => l.paths.some(p => paths.includes(p))) });
    const plan = makeBatches(group, { batchChars: 20000 });
    batches.push(...plan.batches.map((b, n) => ({ ...b, group: id, id: `${id}-${n}`, related_paths: component.map(f => f.filename) })));
    omitted.push(...plan.omitted); selected.push(...plan.selected); incompletePatches.push(...plan.incompletePatches);
  }
  return { files, groups, batches, omitted, selected, incompletePatches, truncated: incompletePatches.length > 0, fingerprint: sha256({ version: 1, groups, batches: batches.map(b => ({ id: b.id, text: b.text })), methods: specialistMethods(files.map(f => f.filename)) }) };
}
