import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createEvidenceBudget, evidenceLoop, createGitEvidence, evidenceBudgetState, restoreEvidenceBudget } from '../src/review-evidence.mjs';
import { fixture } from './helpers.mjs';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { loadRules } from '../src/review-planning.mjs';
import { dryRunPr } from '../scripts/dry-run-pr-lib.mjs';

const tools = (count = 1) => JSON.stringify({ action: 'tools', requests: Array.from({ length: count }, () => ({ tool: 'read_file', path: 'api.py' })) });
const final = JSON.stringify({ action: 'final', result: { overview: [], findings: [] } });

test('tool exhaustion permits one final-only response within the same rounds and preserves partial manifest', async t => {
  const f = await fixture(t), provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
  const budget = createEvidenceBudget({ maxTools: 1, maxRounds: 2 }); let modelCalls = 0;
  const client = { model: 'synthetic', format: 'text-json', async generateReview(options) {
    modelCalls++;
    if (modelCalls === 1) return tools(2);
    assert.match(options.instructions, /FINAL_ONLY/); assert.match(options.input, /return abs/); return final;
  } };
  const result = await reviewPrBatches({ client, files: f.files, repository: 'fixture/repo', pullNumber: 1, baseSha: f.base,
    headSha: f.head, log() {}, enhancement: { provider, budget, rules: await loadRules(provider) } });
  assert.equal(modelCalls, 2); assert.equal(budget.calls, 1); assert.equal(budget.records.length, 1);
  assert.equal(result.completed, 1); assert.equal(result.partial, true); assert.equal(result.manifest.complete, false);
  assert.match(result.manifest.limitations.join('\n'), /evidence_tool_budget/);
});
test('final-only rejects further tools without executing them or adding another round', async () => {
  const budget = createEvidenceBudget({ maxTools: 1, maxRounds: 8 }); let modelCalls = 0, executions = 0;
  await assert.rejects(evidenceLoop({ budget, instructions: '', input: '', client: { async generateReview(options) {
    modelCalls++; if (modelCalls === 2) assert.match(options.instructions, /FINAL_ONLY/); return tools();
  } }, provider: { async execute() { executions++; return { content: 'kept' }; } } }), /evidence_tool_budget/);
  assert.equal(modelCalls, 2); assert.equal(executions, 1); assert.equal(budget.calls, 1); assert.equal(budget.records.length, 1);
});
test('character overflow keeps old records and withholds oversized evidence from final-only input', async () => {
  const budget = createEvidenceBudget({ maxCharacters: 160, maxRounds: 3 }); let modelCalls = 0, executions = 0;
  const result = await evidenceLoop({ budget, instructions: '', input: '', client: { async generateReview(options) {
    modelCalls++; if (modelCalls < 3) return tools();
    assert.match(options.instructions, /FINAL_ONLY.*evidence_character_budget/); assert.match(options.input, /retained evidence/);
    assert.doesNotMatch(options.input, /DO_NOT_FORWARD/); return final;
  } }, provider: { async execute() { return { content: executions++ ? 'DO_NOT_FORWARD'.repeat(100) : 'retained evidence' }; } } });
  assert.deepEqual(result.findings, []); assert.equal(modelCalls, 3); assert.equal(budget.calls, 2); assert.equal(budget.records.length, 1);
  assert.ok(budget.characters <= 160); assert.equal(budget.exhaustedReason, 'evidence_character_budget');
  assert.doesNotMatch(JSON.stringify(budget.records), /DO_NOT_FORWARD/);
});
test('no remaining round or time cannot obtain a final-only response', async () => {
  for (const scenario of ['rounds', 'time', 'final_time']) {
    const budget = createEvidenceBudget({ maxTools: 1, maxRounds: scenario === 'rounds' ? 1 : 8 }); let modelCalls = 0;
    await assert.rejects(evidenceLoop({ budget, instructions: '', input: '', client: { async generateReview() {
      modelCalls++; if (scenario === 'final_time' && modelCalls === 2) { budget.started = Date.now() - budget.maxDurationMs; return final; } return tools();
    } },
      provider: { async execute() { if (scenario === 'time') budget.started = Date.now() - budget.maxDurationMs; return { content: 'retained' }; } } }),
    scenario === 'rounds' ? /evidence_round_budget/ : /evidence_time_budget/);
    assert.equal(modelCalls, scenario === 'final_time' ? 2 : 1); assert.equal(budget.records.length, 1); assert.ok(budget.limitations.length);
  }
});
test('an already exhausted shared budget starts in final-only and does not reset limits', async () => {
  const budget = createEvidenceBudget(); budget.calls = 24; let executions = 0, modelCalls = 0;
  await evidenceLoop({ budget, instructions: '', input: '', client: { async generateReview(options) {
    modelCalls++; assert.match(options.instructions, /FINAL_ONLY/); assert.ok(options.timeoutMs <= 180000); return final;
  } }, provider: { async execute() { executions++; } } });
  assert.equal(modelCalls, 1); assert.equal(executions, 0); assert.equal(budget.calls, 24);
  assert.equal(budget.maxTools, 24); assert.equal(budget.maxCharacters, 120000); assert.equal(budget.maxRounds, 8); assert.equal(budget.maxDurationMs, 180000);
});
test('parallel loops reserve the final shared tool atomically and never exceed shared characters', async () => {
  const budget = createEvidenceBudget({ maxTools: 1, maxCharacters: 1000 }); let executions = 0;
  const run = () => evidenceLoop({ budget, instructions: '', input: '', isCurrent: async () => { await Promise.resolve(); return true; },
    client: { async generateReview(options) { return options.instructions.includes('FINAL_ONLY') ? final : tools(); } },
    provider: { async execute() { executions++; await Promise.resolve(); return { content: 'retained evidence' }; } } });
  await Promise.all([run(), run()]);
  assert.equal(executions, 1); assert.equal(budget.calls, 1); assert.equal(budget.records.length, 1); assert.ok(budget.characters <= 1000);
  const limited = createEvidenceBudget({ maxTools: 2, maxCharacters: 100 }); let completed = 0;
  const concurrent = () => evidenceLoop({ budget: limited, instructions: '', input: '', client: { async generateReview(options) {
    return options.instructions.includes('FINAL_ONLY') ? final : tools();
  } }, provider: { async execute() { completed++; await Promise.resolve(); return { content: 'x'.repeat(60) }; } } });
  await Promise.all([concurrent(), concurrent()]);
  assert.equal(completed, 2); assert.equal(limited.calls, 2); assert.equal(limited.records.length, 0); assert.ok(limited.characters <= 100);
});
test('cached budget restoration cannot lower consumption, clear exhaustion or expand configured limits', () => {
  const budget = createEvidenceBudget({ maxTools: 3, maxCharacters: 500 }); budget.calls = 2; budget.characters = 200; budget.exhaustedReason = 'evidence_tool_budget';
  const earlier = createEvidenceBudget({ maxTools: 100, maxCharacters: 50000 }); earlier.calls = 1; earlier.characters = 100;
  restoreEvidenceBudget(budget, evidenceBudgetState(earlier));
  assert.equal(budget.calls, 2); assert.equal(budget.characters, 200); assert.equal(budget.exhaustedReason, 'evidence_tool_budget');
  assert.equal(budget.maxTools, 3); assert.equal(budget.maxCharacters, 500);
  restoreEvidenceBudget(budget, { calls: 7, characters: 'invalid' });
  assert.equal(budget.calls, 7); assert.equal(budget.characters, 200); assert.equal(budget.exhaustedReason, 'evidence_tool_budget');
  assert.match(budget.limitations.join('\n'), /缓存取证预算状态无效/);
  const old = createEvidenceBudget(); restoreEvidenceBudget(old, undefined); assert.equal(old.exhaustedReason, null);
  const inconsistent = evidenceBudgetState(createEvidenceBudget({ maxTools: 1 })); inconsistent.calls = 1;
  restoreEvidenceBudget(old, inconsistent); assert.equal(old.exhaustedReason, 'evidence_tool_budget');
});
test('code cache persists and restores exhausted state; old caches remain compatible', async t => {
  const f = await fixture(t), provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
  const rules = await loadRules(provider), memory = new Map(); let calls = 0;
  const state = { read: async key => memory.get(key), write: async (key, value) => memory.set(key, structuredClone(value)) };
  const client = { model: 'cache-test', format: 'text-json', async generateReview(options) { calls++; return options.instructions.includes('FINAL_ONLY') ? final : tools(); } };
  const args = { client, files: f.files, repository: 'fixture/repo', pullNumber: 1, baseSha: f.base, headSha: f.head, state, log() {} };
  await reviewPrBatches({ ...args, enhancement: { provider, rules, budget: createEvidenceBudget({ maxTools: 1 }) } });
  assert.equal(calls, 2); assert.equal([...memory.values()][0].evidenceBudget.exhausted, true);
  const restored = createEvidenceBudget({ maxTools: 24 }); restored.calls = 5;
  const result = await reviewPrBatches({ ...args, enhancement: { provider, rules, budget: restored } });
  assert.equal(calls, 2); assert.equal(result.partial, true); assert.equal(restored.calls, 5); assert.equal(restored.exhaustedReason, 'evidence_tool_budget');
  for (const value of memory.values()) { delete value.evidenceBudget; value.evidence = []; value.manifest.limitations = []; }
  const legacy = await reviewPrBatches({ ...args, enhancement: { provider, rules, budget: createEvidenceBudget() } });
  assert.equal(calls, 2); assert.equal(legacy.partial, false);
  for (const value of memory.values()) value.evidenceBudget = { calls: 'corrupt' };
  const corrupt = await reviewPrBatches({ ...args, enhancement: { provider, rules, budget: createEvidenceBudget() } });
  assert.equal(corrupt.partial, true); assert.match(corrupt.manifest.limitations.join('\n'), /缓存取证预算状态无效/);
});
for (const mode of ['tests', 'both']) test(`${mode} final-only validated report stays overall partial without changing completed code`,
  { skip: !process.env.AI_REVIEW_SKILL_REPO && 'Set AI_REVIEW_SKILL_REPO for the actual pinned validator.' }, async t => {
    const f = await fixture(t), fixturePath = path.join(f.directory, 'snapshot.json');
    await fs.writeFile(fixturePath, JSON.stringify({ snapshot: f.snapshot, artifacts: {} }));
    let testRound = 0;
    const client = { model: 'synthetic', format: 'text-json', async generateReview(options) {
      if (!options.instructions.includes('返回 analysis.json 对象')) return final;
      if (options.instructions.includes('FINAL_ONLY')) return JSON.stringify({ action: 'final', result: f.analysis });
      const requests = testRound++ ? [] : f.analysis.evidence.map(e => ({ tool: 'read_file', path: e.path, revision: e.revision, start: e.start, end: e.end }));
      while (requests.length < 8) requests.push({ tool: 'read_ci' });
      return JSON.stringify({ action: 'tools', requests });
    } };
    const r = await dryRunPr({ repo: f.repo, fixture: fixturePath, output: path.join(f.directory, 'out'), skill: process.env.AI_REVIEW_SKILL_REPO, mode }, { client });
    assert.equal(r.exitCode, 1); assert.equal(r.status.overall, 'partial'); assert.equal(r.status.tests, 'incomplete');
    assert.equal(r.result.testReview.validation_status, 'validated'); assert.equal(r.result.testReview.evidence_complete, false);
    assert.equal(r.result.partial, true); assert.equal(r.result.codeReviewPartial, false);
    assert.equal(r.status.code, mode === 'both' ? 'complete' : 'not_requested');
    if (mode === 'both') assert.equal(r.result.manifest.complete, true);
    assert.equal(r.result.evidenceBudget.exhausted, true); assert.equal(r.result.evidenceBudget.calls, 24); assert.equal(r.result.evidence.length, 24);
    const saved = JSON.parse(await fs.readFile(path.join(r.run, 'evidence-budget.json'), 'utf8'));
    assert.equal(saved.exhausted, true); assert.equal(saved.limits.tools, 24); assert.match(saved.limitations.join('\n'), /预算耗尽/);
  });
