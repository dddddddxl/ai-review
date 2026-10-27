// Replay an evaluation set and score recall against its expected defects.
//
//   node scripts/eval-recall.mjs run   eval/vllm-plugin-das.json LABEL [--engine legacy]
//   node scripts/eval-recall.mjs score eval/vllm-plugin-das.json LABEL [--all-labels]
//
// `run` calls scripts/replay-pr.mjs once per (PR, reviewed commit), so it needs
// the same GitHub App and model environment, and is equally read-only on GitHub.
// Existing replay directories are never overwritten; use a new LABEL per experiment.
//
// `score` matches expected defects to replay output by file and new-side line.
// A location match is evidence, not proof, that the same defect was found: the
// generated review sheet (score.md) lists both texts for a human to confirm.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LINE_WINDOW = Number(process.env.EVAL_LINE_WINDOW) || 15;
const argv = process.argv.slice(2);
const [command, evalFile, label] = argv;
if (!['run', 'score'].includes(command) || !evalFile || !/^[\w.-]+$/.test(label || '')) {
  throw new Error('Usage: eval-recall.mjs run|score EVAL_JSON LABEL [--engine NAME] [--all-labels]');
}
const { cases } = JSON.parse(fs.readFileSync(evalFile, 'utf8'));
const outRoot = path.join(process.env.REPLAY_OUT_DIR || '/app-runs', label);
const groups = new Map();
for (const item of cases) {
  const key = `${item.repository}#${item.pullNumber}@${item.headSha}`;
  groups.set(key, [...(groups.get(key) || []), item]);
}
const replayDir = item => path.join(outRoot, `${item.repository.replace('/', '__')}__${item.pullNumber}__${item.headSha.slice(0, 10)}`);

if (command === 'run') {
  const engine = argv[argv.indexOf('--engine') + 1];
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'replay-pr.mjs');
  for (const [key, [item]] of groups) {
    if (fs.existsSync(path.join(replayDir(item), 'done'))) { console.log(`[eval] skip ${key} (done)`); continue; }
    if (fs.existsSync(replayDir(item))) { console.log(`[eval] skip ${key} (unfinished run exists; inspect it, do not overwrite)`); continue; }
    console.log(`[eval] replay ${key}`);
    const result = spawnSync(process.execPath, [script, item.repository, String(item.pullNumber), '--head', item.headSha,
      '--base-ref', item.baseRef, '--label', label, ...(argv.includes('--engine') ? ['--engine', engine] : [])], { stdio: 'inherit' });
    if (result.status !== 0) console.log(`[eval] replay failed ${key} status=${result.status}`);
  }
  process.exit(0);
}

const counted = argv.includes('--all-labels') ? cases : cases.filter(item => item.label !== 'unconfirmed');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const match = (expected, found) => {
  if (found.file !== expected.file) return null;
  if (!Number.isInteger(expected.line) || !Number.isInteger(found.line)) return 'file';
  return Math.abs(found.line - expected.line) <= LINE_WINDOW ? 'location' : 'file';
};
const best = (expected, list) => {
  const scored = list.map(found => ({ found, kind: match(expected, found) })).filter(entry => entry.kind);
  return scored.find(entry => entry.kind === 'location') || scored[0] || null;
};
const stages = ['generated', 'published', 'confirmed'];
const totals = Object.fromEntries(stages.map(stage => [stage, { location: 0, file: 0 }]));
let missingRuns = 0, scored = 0;
const sheet = [`# Recall review sheet: ${label}`, '', `Line window ±${LINE_WINDOW}. Confirm each location match by reading both texts.`, ''];
for (const [key, items] of groups) {
  const dir = replayDir(items[0]);
  const result = read(path.join(dir, 'result.json'));
  const expected = items.filter(item => counted.includes(item));
  if (!expected.length) continue;
  if (!result) { missingRuns += expected.length; sheet.push(`## ${key}`, '', '_no replay result_', ''); continue; }
  const judged = (read(path.join(dir, 'candidates.json')) || []).flatMap(record => record.candidates || []);
  const confirmed = result.reviewFindings || [];
  const published = [...confirmed, ...(result.reviewUncertain || [])];
  // Candidates that never reached verification (failure/pending) still count as
  // generated; they are only checkpointed in the replay's private state.
  const stateDir = path.join(dir, 'state');
  const leaves = r => r?.children ? r.children.flatMap(leaves) : [r];
  const pending = (fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter(file => /^[a-f0-9]{64}\.json$/.test(file)) : [])
    .flatMap(file => read(path.join(stateDir, file))?.results || []).flatMap(leaves)
    .flatMap(r => r?.pendingVerification?.findings || []);
  const generated = [...judged, ...published, ...pending];
  sheet.push(`## ${key}`, '', `candidates=${result.candidateCount ?? '?'} confirmed=${confirmed.length} uncertain=${(result.reviewUncertain || []).length} partial=${result.partial}`, '');
  for (const item of expected) {
    scored++;
    const hits = { generated: best(item, generated), published: best(item, published), confirmed: best(item, confirmed) };
    for (const stage of stages) if (hits[stage]) totals[stage][hits[stage].kind]++;
    const hit = hits.generated;
    sheet.push(`- [${item.label}] ${item.priority || ''} \`${item.file}:${item.line ?? '?'}\` ${item.issue}`,
      hit ? `  - ${hit.kind} match${hit.found.verdict ? ` (${hit.found.verdict})` : ''}: \`${hit.found.file}:${hit.found.line ?? '?'}\` ${hit.found.title}` : '  - **missed**');
  }
  sheet.push('');
}
const percent = n => scored ? `${Math.round(100 * n / scored)}%` : '-';
const summary = { label, expected: counted.length, scored, missingRuns, lineWindow: LINE_WINDOW,
  recall: Object.fromEntries(stages.map(stage => [stage, { location: totals[stage].location, sameFile: totals[stage].location + totals[stage].file,
    locationRate: percent(totals[stage].location) }])) };
fs.mkdirSync(outRoot, { recursive: true });
fs.writeFileSync(path.join(outRoot, 'score.md'), sheet.join('\n'));
fs.writeFileSync(path.join(outRoot, 'score.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`[eval] review sheet: ${path.join(outRoot, 'score.md')}`);
