import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fixture, finalClient } from './helpers.mjs';
import { dryRunPr, fileBridge } from '../scripts/dry-run-pr-lib.mjs';
import { capturePr, readOnlyApi } from '../scripts/capture-pr-lib.mjs';
import { parseArgs, validateBundle, frozenCheckout } from '../scripts/pr-cli-common.mjs';
import { gitRead } from '../src/review-evidence.mjs';

const exec = promisify(execFile);
const skillRepo = process.env.AI_REVIEW_SKILL_REPO;
const integration = { skip: !skillRepo && 'Set AI_REVIEW_SKILL_REPO to the pinned skill; no fake validator.' };
async function setup(t, { snapshot, analysis } = {}) {
  const f = await fixture(t), fixturePath = path.join(f.directory, 'fixture.json');
  const writeFixture = async (changes = {}) => fs.writeFile(fixturePath, JSON.stringify({ snapshot: snapshot || f.snapshot,
    artifacts: {}, analysis: analysis || { secret_answer: 'UNSEEN_HISTORICAL_ANSWER' }, ...changes }));
  await writeFixture();
  return { ...f, fixturePath, writeFixture, args: { repo: f.repo, fixture: fixturePath, output: path.join(f.directory, 'out') } };
}
function ghMock(f, { pages = [f.files], changedFiles = pages.flat().length, moving = false, fileFailure = false } = {}) {
  let prReads = 0; const calls = [];
  const pr = { html_url: f.snapshot.pr.url, title: 'Synthetic', state: 'open', changed_files: changedFiles,
    base: { sha: f.base, ref: 'main' }, head: { sha: f.head, repo: { full_name: 'fixture/repo' } }, merge_commit_sha: null };
  return { calls, async request(route, options) {
    calls.push({ route, options }); assert.match(route, /^GET \/repos\/fixture\/repo\//);
    assert.ok(options.request.signal); assert.ok(options.request.timeout <= 15000);
    if (route.endsWith('/pulls/1')) { prReads++; return { data: { ...pr, head: { ...pr.head, sha: moving && prReads > 1 ? f.base : f.head } } }; }
    if (route.endsWith('/files')) {
      if (fileFailure) throw new Error('private authorization failure');
      const page = options.page; return { data: pages[page - 1] || [], headers: { link: page < pages.length ? '<next>; rel="next"' : '' } };
    }
    if (route.includes('/check-runs')) return { data: { check_runs: [] } };
    if (route.includes('/actions/runs?')) return { data: { workflow_runs: [] } };
    if (route.includes('/protection/')) throw new Error('not authorized');
    return { data: [] };
  } };
}
function analyzingClient(f) {
  let testRound = 0;
  return { model: 'offline-synthetic', format: 'text-json', async generateReview(options) {
    assert.doesNotMatch(options.input, /UNSEEN_HISTORICAL_ANSWER/);
    if (options.instructions.includes('返回 analysis.json 对象')) {
      if (!testRound++) return JSON.stringify({ action: 'tools', requests: f.analysis.evidence.map(e => ({ tool: 'read_file', path: e.path, revision: e.revision, start: e.start, end: e.end })) });
      return JSON.stringify({ action: 'final', result: f.analysis });
    }
    return JSON.stringify({ action: 'final', result: { overview: [], findings: [] } });
  } };
}

test('generic CLI validates arguments and discards historical answers', async t => {
  const f = await setup(t);
  assert.throws(() => parseArgs(['--mode', 'code', '--mode', 'both'], ['mode']), /invalid_arguments/);
  assert.throws(() => parseArgs(['--unknown', 'x'], ['mode']), /invalid_arguments/);
  const parsed = validateBundle({ snapshot: f.snapshot, artifacts: {}, analysis: { password: 'not-for-model' }, provenance: { blind: true } });
  assert.equal(parsed.repository, 'fixture/repo'); assert.equal(parsed.analysis, undefined); assert.equal(parsed.provenance, undefined);
  assert.throws(() => validateBundle({ snapshot: { ...f.snapshot, pr: { ...f.snapshot.pr, head_sha: 'main' } } }), /invalid_revision/);
  assert.throws(() => validateBundle({ snapshot: { ...f.snapshot, capture_consistent: false } }), /inconsistent_snapshot/);
  assert.throws(() => validateBundle({ snapshot: f.snapshot, artifacts: { '../evil': 'x' } }), /invalid_artifacts/);
});
test('code mode requires no skill, never sees fixture answers, emits all audit artifacts', async t => {
  const f = await setup(t); let calls = 0;
  const client = { ...finalClient(), async generateReview(options) { calls++; assert.doesNotMatch(JSON.stringify(options), /UNSEEN_HISTORICAL_ANSWER/); return finalClient().generateReview(); } };
  const r = await dryRunPr({ ...f.args, mode: 'code' }, { client });
  assert.equal(r.exitCode, 0); assert.equal(r.status.code, 'complete'); assert.equal(r.status.tests, 'not_requested'); assert.equal(calls, 1);
  assert.equal(r.provenance.blind, false); assert.equal(r.provenance.skill_commit, null); assert.equal(r.provenance.max_tools, 24); assert.equal(r.provenance.model_window_ms, 180000);
  for (const name of ['provenance.json', 'status.json', 'manifest.json', 'code-review.json', 'test-review.json', 'evidence-index.json', 'pipeline-result.json', 'report.md']) {
    const text = await fs.readFile(path.join(r.run, name), 'utf8'); assert.doesNotMatch(text, /UNSEEN_HISTORICAL_ANSWER/);
  }
  assert.match(await fs.readFile(path.join(r.run, 'report.md'), 'utf8'), /不是独立盲测/);
});
for (const mode of ['tests', 'both']) test(`${mode} mode preserves incomplete when skill missing`, async t => {
  const f = await setup(t); let calls = 0;
  const client = { ...finalClient(), async generateReview() { calls++; return finalClient().generateReview(); } };
  const r = await dryRunPr({ ...f.args, ...(mode === 'tests' ? { mode } : {}) }, { client });
  assert.equal(r.exitCode, 1); assert.equal(r.status.tests, 'incomplete'); assert.equal(r.status.code, mode === 'tests' ? 'not_requested' : 'complete');
  assert.equal(calls, mode === 'tests' ? 0 : 1); assert.equal(r.provenance.mode, mode);
});
for (const mode of ['tests', 'both']) test(`${mode} mode uses actual pinned validator and reports separate states`, integration, async t => {
  const f = await setup(t), r = await dryRunPr({ ...f.args, mode, skill: skillRepo }, { client: analyzingClient(f) });
  assert.equal(r.exitCode, 0); assert.equal(r.status.tests, 'validated'); assert.equal(r.status.code, mode === 'tests' ? 'not_requested' : 'complete');
  assert.match(r.provenance.skill_commit, /^[a-f0-9]{40}$/); assert.equal(r.result.testReview.handoff, 'validated_not_executed');
  assert.ok(await fs.stat(path.join(r.run, 'generation-plan.json')));
});
test('dry run rejects wrong source SHA, dirty tree, invalid mode and output in checkout', async t => {
  const f = await setup(t);
  await assert.rejects(dryRunPr({ ...f.args, mode: 'other' }), /invalid_mode/);
  await assert.rejects(dryRunPr({ ...f.args, mode: 'code', output: path.join(f.repo, 'out') }), /output_inside_checkout/);
  await f.writeFixture({ snapshot: { ...f.snapshot, pr: { ...f.snapshot.pr, head_sha: f.base } } });
  await assert.rejects(dryRunPr({ ...f.args, mode: 'code' }), /checkout_not_clean_or_pinned/);
  await f.writeFixture(); await f.write('untracked.txt', 'do not execute');
  await assert.rejects(dryRunPr({ ...f.args, mode: 'code' }), /checkout_not_clean_or_pinned/);
});
test('shallow checkout is accepted only when the supplied base is provably reachable', async t => {
  const f = await setup(t), shallow = path.join(f.directory, 'shallow'), uncertain = path.join(f.directory, 'uncertain');
  const origin = pathToFileURL(f.repo).href;
  await gitRead(f.directory, ['clone', '--quiet', '--depth', '2', origin, shallow]);
  const frozen = await frozenCheckout(shallow, f.snapshot);
  assert.equal(frozen.historyShallow, true); assert.equal(frozen.ancestryVerified, true); assert.equal(frozen.diffBase, f.base);
  const r = await dryRunPr({ ...f.args, repo: shallow, mode: 'code' }, { client: finalClient() });
  assert.equal(r.exitCode, 0); assert.equal(r.provenance.history_shallow, true); assert.equal(r.provenance.ancestry_verified, true);
  await gitRead(f.directory, ['clone', '--quiet', '--depth', '1', origin, uncertain]);
  await gitRead(uncertain, ['fetch', '--quiet', '--depth', '1', origin, f.base]);
  await assert.rejects(frozenCheckout(uncertain, f.snapshot), /shallow_comparison_unverified/);
  assert.equal((await gitRead(uncertain, ['rev-parse', '--is-shallow-repository'])).trim(), 'true');
});
test('only explicit file-bridge window widens grouping and remains within shared time', async t => {
  const f = await setup(t);
  for (const n of [1, 2, 3]) await f.write(`extra${n}.py`, `value = ${n}\n`);
  await f.commit(); const head = (await f.git('rev-parse', 'HEAD')).trim();
  const files = [...f.files, ...[1, 2, 3].map(n => ({ filename: `extra${n}.py`, status: 'added', additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+value = ${n}` }))];
  await f.writeFixture({ snapshot: { ...f.snapshot, files, pr: { ...f.snapshot.pr, head_sha: head } } });
  for (const explicit of [false, true]) {
    let groupingTimeout, evidenceTimeout;
    const client = { ...finalClient(), async generateReview(options) {
      if (options.instructions.startsWith('按功能关联')) { groupingTimeout = options.timeoutMs; return JSON.stringify({ groups: [files.map(f => f.filename)] }); }
      evidenceTimeout = options.timeoutMs; return finalClient().generateReview();
    } };
    const r = await dryRunPr({ ...f.args, mode: 'code', ...(explicit ? { 'model-window-ms': '1800000' } : {}) }, { client });
    assert.equal(r.exitCode, 0); assert.ok(groupingTimeout <= (explicit ? 1800000 : 10000));
    assert.ok(groupingTimeout > (explicit ? 1790000 : 9000)); assert.ok(evidenceTimeout <= (explicit ? 1800000 : 180000));
  }
});
test('legacy entry rejects a different PR and reports safe process exit code', async t => {
  const f = await setup(t);
  await assert.rejects(dryRunPr({ ...f.args }, { legacy: true }), /legacy_fixture_mismatch/);
  try {
    await exec(process.execPath, ['scripts/dry-run-codex.mjs', '--repo', f.repo, '--fixture', f.fixturePath, '--output', f.args.output], { windowsHide: true });
    assert.fail('Expected nonzero');
  } catch (error) { assert.equal(error.code, 2); assert.match(error.stderr, /legacy_fixture_mismatch/); assert.doesNotMatch(error.stderr, /UNSEEN_HISTORICAL_ANSWER/); }
});
test('truncated patches and incomplete file lists cannot finish code review', async t => {
  const f = await setup(t);
  for (const snapshot of [{ ...f.snapshot, files: [{ ...f.files[0], additions: 2 }] }, { ...f.snapshot, files_complete: false, files_total: 2 }]) {
    await f.writeFixture({ snapshot }); const r = await dryRunPr({ ...f.args, mode: 'code' }, { client: finalClient() });
    assert.equal(r.exitCode, 1); assert.equal(r.status.code, 'partial'); assert.equal(r.result.manifest.complete, false);
  }
});
test('shared 24 tool budget exhaustion remains partial with evidence', async t => {
  const f = await setup(t);
  const client = { ...finalClient(), async generateReview() { return JSON.stringify({ action: 'tools', requests: Array.from({ length: 8 }, () => ({ tool: 'read_file', path: 'api.py', start: 1, end: 2 })) }); } };
  const r = await dryRunPr({ ...f.args, mode: 'code' }, { client });
  assert.equal(r.exitCode, 1); assert.equal(r.status.code, 'partial'); assert.equal(r.result.evidence.length, 24);
});
test('truncated model response cannot become successful code review', async t => {
  const f = await setup(t);
  const client = { ...finalClient(), async generateReview() { throw Object.assign(new Error('private provider output'), { code: 'incomplete_response', reason: 'output_truncated' }); } };
  const r = await dryRunPr({ ...f.args, mode: 'code' }, { client });
  assert.equal(r.exitCode, 1); assert.equal(r.status.code, 'partial');
  assert.doesNotMatch(await fs.readFile(path.join(r.run, 'pipeline-result.json'), 'utf8'), /private provider output/);
});
test('truncated tool evidence remains partial even after a valid model final', async t => {
  const f = await setup(t); await f.writeFixture({ artifacts: { 'artifacts/large.txt': 'x'.repeat(17000) } }); let round = 0;
  const client = { ...finalClient(), async generateReview() {
    return round++ ? finalClient().generateReview() : JSON.stringify({ action: 'tools', requests: [{ tool: 'read_artifact', path: 'artifacts/large.txt' }] });
  } };
  const r = await dryRunPr({ ...f.args, mode: 'code' }, { client });
  assert.equal(r.exitCode, 1); assert.equal(r.status.evidence_partial, true); assert.equal(r.result.evidence[0].truncated, true);
});
test('file bridge writes bounded request and consumes only JSON reply', async t => {
  const f = await setup(t), directory = path.join(f.directory, 'bridge'); await fs.mkdir(directory);
  const notices = []; const bridge = fileBridge({ directory, modelWindowMs: 1000, notify: notice => { notices.push(notice); } });
  await fs.writeFile(path.join(directory, 'reply-001.json'), '{"action":"final","result":{}}');
  assert.equal(await bridge.generateReview({ instructions: 'fixed', input: 'data', maxOutputTokens: 100 }), '{"action":"final","result":{}}');
  assert.equal(bridge.calls, 1); assert.equal(notices.length, 1); assert.match(notices[0].request, /request-001\.json$/);
});
test('capture paginates files, uses only GET and saves private fixture without answers', async t => {
  const f = await setup(t), pages = [f.files, [{ ...f.files[0], filename: 'other.py' }]], octokit = ghMock(f, { pages });
  const r = await capturePr({ repository: 'fixture/repo', pr: '1', output: f.args.output }, { octokit });
  assert.equal(r.exitCode, 0); assert.equal(r.snapshot.files_complete, true); assert.equal(r.snapshot.files_total, 2);
  assert.equal(octokit.calls.filter(c => c.route.endsWith('/files')).length, 2);
  const saved = JSON.parse(await fs.readFile(path.join(r.run, 'fixture.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['artifacts', 'provenance', 'snapshot']); assert.equal(saved.provenance.max_run_details, 8);
  assert.ok(saved.provenance.requests.every(r => Number.isInteger(r.elapsed_ms) && r.started_at));
  assert.equal(validateBundle(saved).repository, 'fixture/repo');
});
for (const kind of ['page_limit', 'files_unavailable', 'moving']) test(`capture ${kind} is incomplete, not all-clear`, async t => {
  const f = await setup(t), octokit = ghMock(f, { pages: [f.files, [{ ...f.files[0], filename: 'other.py' }]], moving: kind === 'moving', fileFailure: kind === 'files_unavailable' });
  const r = await capturePr({ repository: 'fixture/repo', pr: '1', output: f.args.output, 'max-file-pages': kind === 'page_limit' ? '1' : '30' }, { octokit });
  assert.equal(r.exitCode, 1);
  if (kind === 'moving') assert.equal(r.snapshot.capture_consistent, false); else assert.equal(r.snapshot.files_complete, false);
});
test('capture transport rejects writes and aborts hung request without exposing credentials', async () => {
  let signal; const api = readOnlyApi({ request(route, options) { signal = options.request.signal; return new Promise(() => {}); } }, { requestTimeoutMs: 5, timeoutMs: 50 });
  await assert.rejects(api.request('POST /repos/x/y/pulls'), /read_only_route_required/);
  await assert.rejects(api.request('GET /repos/x/y/pulls', { method: 'POST' }), /read_only_route_required/);
  await assert.rejects(api.request('GET /repos/x/y/pulls'), /request_timeout/);
  assert.equal(signal.aborted, true); assert.equal(api.requests[0].status, 'timeout');
});
