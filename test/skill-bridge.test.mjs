import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, finalClient } from './helpers.mjs';
import { loadTestSkill, validateTestAnalysis, reviewTests } from '../src/test-review-skill.mjs';
import { createGitEvidence, createEvidenceBudget } from '../src/review-evidence.mjs';
import { collectTestSnapshot, refreshCandidates } from '../src/test-review-snapshot.mjs';

const skillRepo = process.env.AI_REVIEW_SKILL_REPO;
const integration = { skip: !skillRepo && 'Set AI_REVIEW_SKILL_REPO to the pinned external skill checkout; no fake validator fallback.' };
async function setup(t) {
  const f = await fixture(t), skill = await loadTestSkill(skillRepo);
  return { ...f, skill, validate: async (analysis = f.analysis, snapshot = f.snapshot, artifacts = {}) => validateTestAnalysis({ skill,
    repo: f.repo, analysis, snapshot, artifacts, outputRoot: path.join(f.directory, 'out'), python: process.env.AI_REVIEW_PYTHON || 'python' }) };
}
function observation(f, { outcome = 'passed', attempt = 2, sha = f.head } = {}) {
  f.analysis.evidence.push({ id: 'R', kind: 'artifact', path: 'artifacts/result.json', claim: '合成逐测例证据' });
  f.analysis.observations = [{ id: 'O1', run_id: 1, attempt, job_id: 3, tested_sha: sha, identity: 'verified', identity_reason: '合成 checkout 和产物身份',
    lane: 'pr', platform: 'CPU', evidence: ['R'], cases: [{ path: 'test_api.py', id: 'test_f', outcome }] }];
  f.analysis.behaviors[0].observations = ['O1'];
  return { 'artifacts/result.json': JSON.stringify({ synthetic: true, sha, test_f: outcome }) };
}

test('skill: real validator and handoff preserve scenario identity', integration, async t => {
  const f = await setup(t), r = await f.validate();
  assert.equal(r.status, 'validated'); assert.equal(r.handoff, 'validated_not_executed');
  assert.equal(r.backlog.tasks[0].cases[0].id, 'G1-negative'); assert.equal(r.backlog.pr_context.head_sha, f.head);
  assert.equal(r.review.behaviors[0].execution, 'not_verified'); assert.match(r.report, /代码行.*未测量/);
});
test('skill: supported assertions + matching synthetic observation', integration, async t => {
  const f = await setup(t); const artifacts = observation(f); f.analysis.behaviors[0].design = 'supported'; f.analysis.findings = []; f.analysis.tasks = [];
  const r = await f.validate(f.analysis, f.snapshot, artifacts); assert.equal(r.review.verdict, 'no_material_gaps_found');
  assert.equal(r.review.behaviors[0].execution, 'passed'); assert.equal(r.handoff, 'no_tasks');
});
test('skill: selection gap is not a request for duplicate test code', integration, async t => {
  const f = await setup(t); const b = f.analysis.behaviors[0]; b.design = 'supported'; b.selection = 'excluded';
  f.analysis.findings[0].kind = 'selection_gap'; f.analysis.tasks[0].route = 'repair_selection';
  const r = await f.validate(); assert.equal(r.backlog.tasks[0].route, 'repair_selection'); assert.equal(r.review.behaviors[0].execution, 'not_verified');
});
test('skill: unknown evidence stays unknown, not coverage gap', integration, async t => {
  const f = await setup(t); f.analysis.behaviors[0].design = 'unknown'; f.analysis.behaviors[0].selection = 'unknown';
  await assert.rejects(f.validate());
  f.analysis.findings[0].kind = 'evidence_gap'; f.analysis.tasks[0].route = 'validate_existing';
  const r = await f.validate(); assert.equal(r.review.verdict, 'needs_evidence');
});
for (const kind of ['stale_head', 'moving_snapshot', 'missing_file', 'missing_oracle', 'missing_negative_control', 'unknown_selection', 'forged_execution', 'dirty_checkout', 'missing_artifact']) {
  test(`skill rejects ${kind}`, integration, async t => {
    const f = await setup(t);
    if (kind === 'stale_head') f.analysis.head_sha = f.base;
    if (kind === 'moving_snapshot') f.snapshot.capture_consistent = false;
    if (kind === 'missing_file') f.analysis.files = [];
    if (kind === 'missing_oracle') delete f.analysis.tasks[0].cases[0].oracle;
    if (kind === 'missing_negative_control') delete f.analysis.tasks[0].cases[0].negative_control;
    if (kind === 'unknown_selection') { f.analysis.behaviors[0].selection = 'unknown'; f.analysis.findings[0].kind = 'selection_gap'; }
    if (kind === 'forged_execution') f.analysis.behaviors[0].execution = 'passed';
    if (kind === 'dirty_checkout') await f.write('untracked.py', 'not executable\n');
    if (kind === 'missing_artifact') observation(f);
    await assert.rejects(f.validate());
  });
}
for (const kind of ['merge_sha', 'wrong_attempt', 'mixed_attempts', 'mixed_runs']) {
  test(`skill rejects execution identity ${kind}`, integration, async t => {
    const f = await setup(t); const artifacts = observation(f, { sha: kind === 'merge_sha' ? f.base : f.head, attempt: kind === 'wrong_attempt' ? 1 : 2 });
    if (kind.startsWith('mixed')) {
      const next = { ...f.analysis.observations[0], id: 'O2', ...(kind === 'mixed_runs' ? { run_id: 2 } : { attempt: 3 }) };
      f.analysis.observations.push(next); f.analysis.behaviors[0].observations.push('O2');
      f.snapshot.runs.push({ ...f.snapshot.runs[0], id: next.run_id, run_attempt: next.attempt });
    }
    await assert.rejects(f.validate(f.analysis, f.snapshot, artifacts));
  });
}
test('skill bridge checks source was actually read, not model asserted', integration, async t => {
  const f = await setup(t); const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
  const budget = createEvidenceBudget(); const common = { client: finalClient(f.analysis), provider, budget, skill: f.skill, snapshot: f.snapshot,
    artifacts: {}, repo: f.repo, outputRoot: path.join(f.directory, 'out'), isCurrent: async () => true };
  const unread = await reviewTests(common);
  assert.equal(unread.status, 'incomplete'); assert.equal(unread.diagnostic.code, 'source_not_read');
  for (const e of f.analysis.evidence) budget.records.push({ id: e.id, status: 'available', ...await provider.execute({ tool: 'read_file', revision: e.revision, path: e.path, start: e.start, end: e.end }) });
  assert.equal((await reviewTests(common)).status, 'validated');
});
test('skill pin rejects another repository', async t => {
  const f = await fixture(t); await assert.rejects(loadTestSkill(f.repo), /pin_mismatch/);
});
test('snapshot mock preserves all terminal conclusions and rechecks identity', async t => {
  const f = await fixture(t); let prReads = 0;
  const pr = { number: 1, html_url: f.snapshot.pr.url, title: 'fixture', state: 'open', changed_files: 1,
    base: { sha: f.base, ref: 'main' }, head: { sha: f.head, repo: { full_name: 'fixture/repo' } }, merge_commit_sha: null };
  const runs = ['success', 'failure', 'skipped', 'cancelled'].map((conclusion, i) => ({ id: i + 1, run_attempt: 1, status: 'completed', conclusion, head_sha: f.head, jobs: [] }));
  const octokit = { async request(route) {
    assert.ok(route.startsWith('GET /repos/fixture/repo/'));
    if (route.endsWith('/pulls/1')) { prReads++; return { data: pr }; }
    if (route.includes('/check-runs')) return { data: { check_runs: [] } };
    if (route.includes('/actions/runs?')) return { data: { workflow_runs: runs } };
    if (route.includes('/jobs')) return { data: { jobs: [] } };
    if (route.includes('/protection/')) throw new Error('not authorized');
    return { data: [] };
  } };
  const r = await collectTestSnapshot({ octokit, owner: 'fixture', repo: 'repo', pullNumber: 1, files: f.files });
  assert.equal(prReads, 2); assert.equal(r.snapshot.capture_consistent, true); assert.equal(r.snapshot.runs.length, 4);
  assert.equal(r.snapshot.endpoints.legacy_protection.status, 'unavailable');
  for (const run of runs) assert.deepEqual(refreshCandidates({ ...run, pull_requests: [{ number: 1 }, { number: 1 }] }), [1]);
});
