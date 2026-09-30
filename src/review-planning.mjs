import { sha256, secretPath, sensitiveText, safePath } from './review-evidence.mjs';

function globRegex(glob) {
  if (!safePath(glob) || glob.length > 200) throw new Error('invalid_rule_path');
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    if (glob.slice(i, i + 3) === '**/') { out += '(?:.*/)?'; i += 2; }
    else if (glob.slice(i, i + 2) === '**') { out += '.*'; i++; }
    else if (glob[i] === '*') out += '[^/]*';
    else out += glob[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
export async function loadRules(provider) {
  let raw;
  try { raw = await provider.rawFile(provider.baseSha, '.ai-review/rules.json'); }
  catch (error) {
    if (error.message === 'not_regular_git_file') return { version: 1, rules: [], hash: sha256('no_rules'), source: provider.baseSha };
    throw error;
  }
  if (raw.length > 32000 || sensitiveText(raw)) throw new Error('invalid_rules');
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || !Array.isArray(parsed.rules) || parsed.rules.length > 50) throw new Error('invalid_rules');
  const ids = new Set();
  const rules = parsed.rules.map(r => {
    if (!r.id || typeof r.id !== 'string' || ids.has(r.id) || typeof r.instruction !== 'string' || !r.instruction.trim() || r.instruction.length > 2000) throw new Error('invalid_rule');
    ids.add(r.id); globRegex(r.path); return { id: r.id, path: r.path, instruction: r.instruction };
  });
  return { version: 1, rules, hash: sha256(raw), source: provider.baseSha };
}
export const rulesFor = (rules, path) => rules.rules.filter(r => globRegex(r.path).test(path));

export function relatedGroups(files, proposal, maxFiles = 10) {
  const paths = files.map(f => f.filename), allowed = new Set(paths);
  if (proposal !== undefined) {
    if (!Array.isArray(proposal)) throw new Error('invalid_groups');
    const flat = proposal.flat();
    if (proposal.some(g => !Array.isArray(g) || !g.length || g.length > maxFiles) || flat.some(p => !allowed.has(p)) || new Set(flat).size !== flat.length) throw new Error('invalid_groups');
    return [...proposal, ...paths.filter(p => !flat.includes(p)).map(p => [p])];
  }
  const groups = [];
  for (const file of files) {
    const stem = file.filename.split('/').pop().replace(/^test_/, '').replace(/\.[^.]+$/, '');
    const directory = file.filename.split('/').slice(0, -1).join('/');
    const group = groups.find(g => g.length < maxFiles && g.some(p => {
      const peer = files.find(f => f.filename === p);
      const peerStem = p.split('/').pop().replace(/^test_/, '').replace(/\.[^.]+$/, '');
      return directory === p.split('/').slice(0, -1).join('/') || (stem.length > 3 &&
        (stem === peerStem || (peer.patch || '').includes(stem) || (file.patch || '').includes(peerStem) && peerStem.length > 3));
    }));
    if (group) group.push(file.filename); else groups.push([file.filename]);
  }
  return groups;
}

export function sealManifest({ repository, pullNumber, baseSha, headSha, diffBase, files, plan, groups, rulesHash, rules, skillHash = null, evidenceHash, totalFiles = files.length }) {
  return { manifest_version: 1, repository, pull_number: pullNumber, base_sha: baseSha, head_sha: headSha, diff_base: diffBase,
    rules_hash: rulesHash, skill_hash: skillHash, evidence_hash: evidenceHash, groups, total_files: totalFiles,
    files: files.map(f => {
      const omitted = plan.omitted.find(o => o.filename === f.filename);
      return { path: f.filename, previous_path: f.previous_filename || null, change: f.status,
        rule_source: rules?.source || null, rule_ids: rules ? rulesFor(rules, f.filename).map(r => r.id) : [],
        state: omitted ? omitted.reason === 'missing_patch' ? 'deferred' : 'excluded' : 'pending', reason: omitted?.reason || null,
        fragments: plan.batches.flatMap((b, i) => b.fragments.filter(x => x.filename === f.filename).map(x => ({ batch: i, start: x.start, end: x.end, state: 'pending' }))),
        truncated: plan.incompletePatches.includes(f.filename) };
    }), limitations: [], coverage: { code: 'not_measured', functionality: 'separate_test_review', review: 'pending' } };
}
export function finalizeManifest(sealed, results, limitations = []) {
  const manifest = structuredClone(sealed); manifest.limitations.push(...limitations);
  for (const f of manifest.files) {
    for (const frag of f.fragments) frag.state = results[frag.batch]?.complete ? 'reviewed' : results[frag.batch] ? 'failed' : 'pending';
    if (f.fragments.length) {
      f.state = !f.truncated && f.fragments.every(x => x.state === 'reviewed') ? 'reviewed' : 'deferred';
      f.reason = f.state === 'reviewed' ? null : f.truncated ? 'incomplete_patch' : 'incomplete_fragments';
    }
  }
  manifest.complete = manifest.files.length === manifest.total_files && manifest.files.every(f => ['reviewed', 'excluded'].includes(f.state)) && !manifest.limitations.length;
  manifest.coverage.review = manifest.complete ? 'complete_within_selected_scope' : 'partial';
  return manifest;
}

export function filterReviewFiles(files) {
  return files.map(f => secretPath(f.filename) || sensitiveText(f.patch || '')
    ? { ...f, patch: undefined, evidenceDenied: true } : f);
}
export function locateFinding(finding, files) {
  const file = files.find(f => f.filename === finding.file);
  const snippet = finding.existing_code;
  if (!file || typeof snippet !== 'string' || !snippet.trim()) return { ...finding, line: null, location_status: 'missing_snippet' };
  const expected = snippet.replace(/\r\n/g, '\n').split('\n'); const segments = []; let current = [], line = 0;
  for (const raw of (file.patch || '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { if (current.length) segments.push(current); current = []; line = Number(hunk[1]); }
    else if (line && /^[ +]/.test(raw)) current.push({ text: raw.slice(1), line: line++, added: raw.startsWith('+') });
    else if (!raw.startsWith('-') && !raw.startsWith('\\')) { if (current.length) segments.push(current); current = []; line = 0; }
  }
  if (current.length) segments.push(current);
  const hits = [];
  for (const s of segments) for (let i = 0; i <= s.length - expected.length; i++) {
    const range = s.slice(i, i + expected.length);
    if (range.some(x => x.added) && expected.every((v, n) => v === range[n].text)) hits.push(range.find(x => x.added).line);
  }
  return { ...finding, line: hits.length === 1 ? hits[0] : null, location_status: hits.length === 1 ? 'anchored' : hits.length ? 'ambiguous' : 'not_in_added_diff' };
}
