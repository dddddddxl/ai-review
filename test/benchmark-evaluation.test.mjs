import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scoreEvaluation, verifySources } from '../scripts/score-blind-review.mjs';
import { sha256 } from '../src/review-evidence.mjs';

const fixture = () => ({ evaluation_version: 1, annotation_source: 'independent_agents_with_root_adjudication', expected_samples: 6,
  samples: [{ id: 'synthetic-evaluation', repository: 'fixture/repo', head_sha: 'a'.repeat(40),
    sources: ['input', 'labels', 'first_run'].map(role => ({ role, path: role + '.json', sha256: '0'.repeat(64) })),
    code: { completed: true, findings: [], expected: [] }, tests: { completed: false, findings: [], expected: [] } }] });

test('benchmark: unknown and empty denominators never become a perfect score', () => {
  const data = fixture();
  data.samples[0].code.findings = [
    { id: 'C1', judgment: 'supported', location: 'correct', reason: 'Synthetic evidence supports the claim.' },
    { id: 'C2', judgment: 'incorrect', location: 'incorrect', reason: 'Synthetic evidence contradicts the claim.' },
    { id: 'C3', judgment: 'unknown', location: 'unknown', reason: 'Synthetic evidence is unavailable.' },
  ];
  data.samples[0].code.expected = [{ id: 'E1', outcome: 'detected' }, { id: 'E2', outcome: 'missed' }, { id: 'E3', outcome: 'unknown' }];
  const scored = scoreEvaluation(data);
  assert.equal(scored.sample_shortfall, 5);
  assert.equal(scored.tracks.code.precision, 0.5);
  assert.equal(scored.tracks.code.labeled_issue_recall, 0.5);
  assert.equal(scored.tracks.code.unknown, 1);
  assert.equal(scored.tracks.tests.precision, null);
  assert.equal(scored.tracks.tests.labeled_issue_recall, null);
  assert.equal(scored.human_certified, false);
});

test('benchmark: reject duplicate judgments, missing tracks and unbound identities', () => {
  const duplicate = fixture(); duplicate.samples.push(structuredClone(duplicate.samples[0]));
  assert.throws(() => scoreEvaluation(duplicate), /duplicate_or_missing_sample/);
  const missing = fixture(); delete missing.samples[0].tests;
  assert.throws(() => scoreEvaluation(missing), /track_result_missing/);
  const noIdentity = fixture(); noIdentity.samples[0].head_sha = 'main';
  assert.throws(() => scoreEvaluation(noIdentity), /sample_identity_missing/);
  const noLabels = fixture(); noLabels.samples[0].sources = [];
  assert.throws(() => scoreEvaluation(noLabels), /evaluation_sources_missing/);
});

test('benchmark: source evidence must remain present and hash-bound', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-review-evaluation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = fixture();
  for (const ref of data.samples[0].sources) { await fs.writeFile(path.join(root, ref.path), '{}\n'); ref.sha256 = sha256('{}\n'); }
  await verifySources(root, data);
  await fs.writeFile(path.join(root, 'labels.json'), '{"changed":true}\n');
  await assert.rejects(verifySources(root, data), /evaluation_source_hash_changed/);
  data.samples[0].sources[0].path = '../outside.json';
  await assert.rejects(verifySources(root, data), /invalid_source_reference/);
});
