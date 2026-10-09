import '../test/deny-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { reviewOptions, createReviewControl, efficientDiagnostic } from '../src/review-control.mjs';
import { createCiView } from '../src/review-ci-view.mjs';
import { createGitEvidence, deniedToolResult } from '../src/review-evidence.mjs';
import { efficientPlan, specialistMethods } from '../src/efficient-planning.mjs';
import { aggregateTestFragments } from '../src/efficient-review.mjs';
import { runReviewPipeline, enhancementConfig } from '../src/review-pipeline.mjs';
import { limitModelConcurrency } from '../src/review-state.mjs';
import { createModelClient } from '../src/model-client.mjs';

test('strategy/time parameters are explicit and production defaults legacy', () => {
  assert.equal(enhancementConfig({}).strategy, 'legacy');
  assert.equal(enhancementConfig({ AI_REVIEW_STRATEGY: 'efficient' }).deadlineMs, 180000);
  for (const args of [{ strategy: 'bad' }, { 'deadline-ms': 180000 }, { strategy: 'efficient', 'model-window-ms': 180000 },
    { strategy: 'efficient', 'deadline-ms': 180000, 'model-window-ms': 180000 }]) assert.throws(() => reviewOptions(args));
  assert.equal(reviewOptions({ strategy: 'efficient', 'deadline-ms': 3000 }).deadlineMs, 3000);
});

test('deadline has one origin; validators share remaining time and phases do not double quotas', async () => {
  let time = 0; const c = createReviewControl({ durationMs: 180, now: () => time });
  for (let i = 0; i < 20; i++) c.reserveCall('main', 'tool');
  assert.throws(() => c.reserveCall('main', 'tool'), /evidence_tool_budget/);
  for (let i = 0; i < 4; i++) c.reserveCall('incremental', 'tool');
  assert.throws(() => c.reserveCall('incremental', 'tool'), /evidence_tool_budget/);
  for (let i = 0; i < 8; i++) c.reserveCall('main', 'model');
  assert.throws(() => c.reserveCall('main', 'model'), /model_round_budget/);
  time = 120; assert.throws(() => c.assert('main'), /stage_time_budget/);
  assert.equal(c.remaining('incremental'), 30); time = 151;
  await c.run('validation', 'python', async (_signal, ms) => { assert.equal(ms, 29); time += 10; });
  assert.equal(c.remaining('validation'), 19);
  time = 180; assert.throws(() => c.assert('validation'), /global_time_budget/);
});

test('in-flight model is aborted and no continuation work starts after phase timeout', async () => {
  const c = createReviewControl({ durationMs: 60 }); let aborted = false;
  const keepAlive = setTimeout(() => {}, 120);
  try {
    await assert.rejects(c.run('main', 'model', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
    })), /stage_time_budget/);
    assert.ok(aborted); assert.throws(() => c.reserveCall('main', 'model'), /stage_time_budget/);
  } finally { clearTimeout(keepAlive); }
});

test('queued model requests are removed on abort, not executed later', async () => {
  let release, calls = 0;
  const client = limitModelConcurrency({ generateReview: () => { calls++; return new Promise(resolve => { release = resolve; }); } }, 1);
  const first = client.generateReview({}); const controller = new AbortController();
  const second = client.generateReview({ signal: controller.signal }); controller.abort();
  await assert.rejects(second); release('done'); await first; assert.equal(calls, 1);
});

test('CI view is paginated, bounded, preserves SHA/attempt and never calls a green job method proof', () => {
  const snapshot = { pr: { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), body: 'private body'.repeat(5000) }, checks: [],
    runs: Array.from({ length: 300 }, (_, n) => ({ id: n + 1, run_attempt: 2, head_sha: 'a'.repeat(40), jobs: [{ id: n + 1000, status: 'completed', conclusion: 'success' }] })) };
  const view = createCiView({ snapshot }); let cursor = 0, count = 0;
  do {
    const page = view.page({ cursor }); assert.ok(JSON.stringify(page).length <= 16000);
    assert.equal(page.pr.head_sha, snapshot.pr.head_sha); assert.equal(page.execution, 'not_verified');
    assert.equal(page.pr.body, undefined); count += page.items.length; cursor = page.next_cursor;
  } while (cursor !== null);
  assert.equal(count, 602); assert.equal(view.page({ section: 'jobs', run_id: 1, attempt: 2 }).items[0].data.run_head_sha, snapshot.pr.head_sha);
  assert.throws(() => view.page({ cursor: -1 }));
});

test('Git immutable cache coalesces repeated reads; guards and EOF metadata remain enforced', async t => {
  const f = await fixture(t), p = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files, cacheObjects: true });
  const initial = p.metrics.physical_executions;
  const [a, b] = await Promise.all([p.execute({ tool: 'read_file', path: 'api.py' }), p.execute({ tool: 'read_file', path: 'api.py' })]);
  assert.equal(a.total_lines, 2); assert.equal(a.next_start, null); assert.deepEqual(a, b);
  assert.equal(p.metrics.physical_executions - initial, 3); assert.ok(p.metrics.cache_hits >= 2);
  await assert.rejects(p.execute({ tool: 'read_file', path: '../api.py' }), /path_denied/);
  await assert.rejects(p.execute({ tool: 'read_file', path: 'api.py', revision: '0'.repeat(40) }), /revision_out_of_scope/);
  try { await p.execute({ tool: 'read_file', path: 'api.py', end: 201 }); assert.fail(); }
  catch (error) { assert.equal(deniedToolResult(error, { tool: 'read_file', path: 'api.py' }).legal_range.total_lines, 2); }
});

test('groups retain every fragment, test/GPU paths, <=10 files and <=20000 characters', () => {
  const files = Array.from({ length: 21 }, (_, n) => ({ filename: `tests/test_${n}.py`, status: 'modified', patch: '@@ -1 +1 @@\n-common_interface\n+common_interface(2)' }));
  files.push({ filename: 'kernel.cu', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'gone.hip', status: 'deleted' });
  const plan = efficientPlan(files);
  assert.ok(plan.groups.every(g => g.paths.length <= 10)); assert.ok(plan.batches.every(b => b.text.length <= 20000));
  assert.equal(plan.groups.flatMap(g => g.paths).length, files.length);
  assert.ok(plan.selected.some(f => f.filename === 'kernel.cu')); assert.ok(plan.omitted.some(f => f.filename === 'gone.hip'));
  assert.ok(specialistMethods(['Dockerfile', '.github/workflows/ci.yml', 'a.py', 'a.cuh']).length === 4);
});

test('fragment merge rejects changed SHA, un-read source, missing oracle, conflicting IDs and cross-attempt union', async t => {
  const f = await fixture(t), records = f.analysis.evidence.map(e => ({ ...e, tool: 'read_file', status: 'available', truncated: false }));
  const merge = fragments => aggregateTestFragments({ fragments, files: f.files, headSha: f.head, baseSha: f.base, diffBase: f.base, records });
  assert.equal(merge([f.analysis]).behaviors.length, 1);
  assert.throws(() => merge([{ ...f.analysis, head_sha: f.base }]), /fragment_identity_mismatch/);
  assert.throws(() => merge([{ ...f.analysis, behaviors: [{ ...f.analysis.behaviors[0], oracle: '' }] }]), /invalid_test_fragment/);
  assert.throws(() => merge([f.analysis, { ...f.analysis, behaviors: [{ ...f.analysis.behaviors[0], after: 'different' }] }]), /fragment_conflict/);
  assert.throws(() => merge([{ ...f.analysis, evidence: [{ ...f.analysis.evidence[0], end: 50 }] }]), /source_not_read/);
  const crossed = structuredClone(f.analysis); crossed.observations = [1, 2].map(n => ({ id: `O${n}`, run_id: 1, attempt: n, tested_sha: f.head })); crossed.behaviors[0].observations = ['O1', 'O2'];
  assert.throws(() => merge([crossed]), /fragment_conflict/);
});

for (const mode of ['code', 'tests', 'both']) test(`efficient ${mode} mode uses joint loop and actual pinned validators`, { skip: mode !== 'code' && !process.env.AI_REVIEW_SKILL_REPO }, async t => {
  const f = await fixture(t); let calls = 0;
  const client = { async generateReview(options) {
    calls++; assert.ok(options.signal); assert.ok(options.input.length < 30000);
    if (mode !== 'code' && calls === 1) return JSON.stringify({ action: 'tools', requests: [{ tool: 'read_file', path: 'test_api.py' }, { tool: 'read_file', path: 'ci.yml' }] });
    return JSON.stringify({ action: 'final', result: { code_review: { overview: ['返回绝对值'], findings: [] }, test_analysis: mode === 'code' ? null : f.analysis } });
  } };
  const result = await runReviewPipeline({ repository: 'fixture/repo', pullNumber: 1, baseSha: f.base, headSha: f.head, files: f.files, client },
    { config: { strategy: 'efficient', deadlineMs: 60000, enabled: mode !== 'tests', testEnabled: mode !== 'code', skillRepo: process.env.AI_REVIEW_SKILL_REPO,
      checkouts: { 'fixture/repo': f.repo }, maxTools: 24, outputRoot: path.join(f.directory, 'output') }, testsOnly: mode === 'tests', captured: { snapshot: f.snapshot, artifacts: {} } });
  assert.equal(result.partial, false, JSON.stringify(result.failureSummary));
  assert.equal(result.testReview?.status, mode === 'code' ? undefined : 'validated');
  assert.equal(result.manifest.scope_status.code, mode === 'tests' ? 'not_requested' : 'complete');
  assert.equal(result.evidenceBudget.model_calls.main, mode === 'code' ? 1 : 2);
});

test('missing pinned skill does not become no-gap and timeout diagnostic is accurate', async t => {
  const f = await fixture(t), client = { generateReview: async () => JSON.stringify({ action: 'final', result: { code_review: { overview: [], findings: [] }, test_analysis: null } }) };
  const result = await runReviewPipeline({ repository: 'fixture/repo', baseSha: f.base, headSha: f.head, files: f.files, client },
    { config: { strategy: 'efficient', enabled: true, testEnabled: true, checkouts: { 'fixture/repo': f.repo }, maxTools: 24 }, captured: { snapshot: f.snapshot, artifacts: {} } });
  assert.equal(result.testReview.status, 'incomplete'); assert.equal(result.partial, true);
  assert.equal(efficientDiagnostic({ name: 'TimeoutError' }).code, 'model_request_timeout');
});

test('adapter forwards external cancellation to all fetch protocols', async () => {
  for (const format of ['openai-chat', 'anthropic-messages']) {
    const controller = new AbortController(); let seen;
    const client = createModelClient({ AI_API_FORMAT: format, AI_API_KEY: 'synthetic', AI_MODEL: 'mock', AI_BASE_URL: 'https://fixture.invalid/v1' },
      { fetchImpl: async (_url, options) => { seen = options.signal; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
    const result = client.generateReview({ instructions: '', input: '', maxOutputTokens: 50, signal: controller.signal });
    controller.abort(); await assert.rejects(result); assert.ok(seen.aborted);
  }
});

test('scope mismatch and dirty checkout stop before any model request', async t => {
  const f = await fixture(t); let calls = 0;
  const run = files => runReviewPipeline({ repository: 'fixture/repo', baseSha: f.base, headSha: f.head, files, client: { generateReview() { calls++; assert.fail(); } } },
    { config: { strategy: 'efficient', enabled: true, testEnabled: false, checkouts: { 'fixture/repo': f.repo }, maxTools: 24 } });
  const missing = await run([]); assert.equal(missing.failureSummary[0].diagnostic.code, 'diff_scope_mismatch');
  await f.write('untracked.py', 'do_not_execute()');
  const dirty = await run(f.files); assert.equal(dirty.failureSummary[0].diagnostic.code, 'checkout_not_clean_or_pinned'); assert.equal(calls, 0);
});

test('old head after generation cannot produce complete status', async t => {
  const f = await fixture(t); let current = true;
  const result = await runReviewPipeline({ repository: 'fixture/repo', baseSha: f.base, headSha: f.head, files: f.files,
    isCurrent: async () => current, client: { async generateReview() { current = false; return JSON.stringify({ action: 'final', result: { code_review: { overview: [], findings: [] } } }); } } },
    { config: { strategy: 'efficient', enabled: true, testEnabled: false, checkouts: { 'fixture/repo': f.repo }, maxTools: 24 } });
  assert.equal(result.partial, true); assert.equal(result.manifest.complete, false);
});

test('failed fragments remain deferred rather than complete; model budget is not reset per batch', async t => {
  const f = await fixture(t); let calls = 0;
  const result = await runReviewPipeline({ repository: 'fixture/repo', baseSha: f.base, headSha: f.head, files: f.files,
    client: { async generateReview() { calls++; return JSON.stringify({ action: 'tools', requests: [{ tool: 'read_file', path: 'api.py' }] }); } } },
    { config: { strategy: 'efficient', enabled: true, testEnabled: false, checkouts: { 'fixture/repo': f.repo }, maxTools: 24 } });
  assert.equal(result.partial, true); assert.equal(result.manifest.files[0].state, 'deferred');
  assert.equal(result.evidenceBudget.model_calls.main, 8); assert.equal(result.evidenceBudget.model_calls.incremental, 8); assert.equal(calls, 16);
  assert.ok(result.manifest.attempts.every(a => a.status === 'failed')); assert.ok(result.metrics.cache.cache_hits > 0);
});
