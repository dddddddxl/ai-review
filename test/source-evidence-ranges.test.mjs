import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, finalClient } from './helpers.mjs';
import { sourceEvidenceWasRead, reviewTests, loadTestSkill } from '../src/test-review-skill.mjs';
import { createEvidenceBudget, createGitEvidence } from '../src/review-evidence.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), blob = 'c'.repeat(64);
const evidence = { kind: 'source', revision: head, path: 'src/dispatch.py', start: 848, end: 920 };
const read = (start, end, extra = {}) => ({ status: 'available', tool: 'read_file', revision: head, path: evidence.path, start, end, truncated: false, sha256: blob, ...extra });

test('source evidence merges overlapping, adjacent and out-of-order reads without changing records', () => {
  for (const records of [[read(825, 885), read(880, 975)], [read(886, 975), read(825, 885)],
    [read(848, 860), read(861, 890), read(891, 920)], [read(1, 200), read(800, 950)], [read(825, 975)]]) {
    const original = structuredClone(records);
    assert.equal(sourceEvidenceWasRead(evidence, records), true); assert.deepEqual(records, original);
  }
});
test('source evidence rejects gaps, wrong identity, denied/truncated and invalid intervals', () => {
  for (const second of [read(887, 975), read(880, 975, { revision: base }), read(880, 975, { path: 'src/other.py' }),
    read(880, 975, { truncated: true }), read(880, 975, { status: 'unavailable' }), read(880, 975, { tool: 'search_code' }),
    read(880, 975, { truncated: undefined }), read(880.5, 975), read(976, 975)]) {
    assert.equal(sourceEvidenceWasRead(evidence, [read(825, 885), second]), false);
  }
  for (const target of [{ ...evidence, start: 0 }, { ...evidence, end: 847 }, { ...evidence, start: '848' },
    { ...evidence, revision: 'head' }, { ...evidence, revision: 'base' }, { ...evidence, path: '../dispatch.py' }]) {
    assert.equal(sourceEvidenceWasRead(target, [read(1, 975)]), false);
  }
});
test('source evidence rejects conflicting blob hashes even if a single range covers the claim', () => {
  assert.equal(sourceEvidenceWasRead(evidence, [read(825, 885), read(880, 975, { sha256: 'd'.repeat(64) })]), false);
  assert.equal(sourceEvidenceWasRead(evidence, [read(825, 975), read(1, 100, { sha256: 'd'.repeat(64) })]), false);
  assert.equal(sourceEvidenceWasRead(evidence, [read(825, 975, { sha256: 'not-a-fingerprint' })]), false);
});
test('test review explicitly rejects source revision aliases and out-of-scope SHAs', async () => {
  for (const revision of ['head', 'base', 'HEAD', 'd'.repeat(40)]) {
    const budget = createEvidenceBudget(); budget.records.push(read(825, 975));
    const r = await reviewTests({ client: { ...finalClient(), async generateReview(options) {
      assert.match(options.instructions, /analysis\.json 中 source/); assert.match(options.instructions, /40位实际SHA/);
      return finalClient({ evidence: [{ ...evidence, revision }] }).generateReview();
    } }, provider: { headSha: head, baseSha: base, diffBase: base }, budget, skill: { instructions: '' },
    snapshot: { capture_consistent: true, pr: { head_sha: head, base_sha: base } }, artifacts: {}, isCurrent: async () => true });
    assert.equal(r.status, 'incomplete'); assert.deepEqual(r.diagnostic, { stage: 'evidence', code: 'source_revision_invalid' });
  }
});
test('test review keeps uncovered valid revision as source_not_read', async () => {
  const budget = createEvidenceBudget(); budget.records.push(read(825, 885), read(887, 975));
  const r = await reviewTests({ client: finalClient({ evidence: [evidence] }), provider: { headSha: head, baseSha: base, diffBase: base },
    budget, skill: { instructions: '' }, snapshot: { capture_consistent: true, pr: { head_sha: head, base_sha: base } }, artifacts: {}, isCurrent: async () => true });
  assert.deepEqual(r.diagnostic, { stage: 'evidence', code: 'source_not_read' });
});
test('real Git split reads pass the actual pinned validator only when the union is complete',
  { skip: !process.env.AI_REVIEW_SKILL_REPO && 'Set AI_REVIEW_SKILL_REPO for the actual pinned validator.' }, async t => {
    const f = await fixture(t), skill = await loadTestSkill(process.env.AI_REVIEW_SKILL_REPO);
    const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, diffBase: f.base, files: f.files });
    f.analysis.evidence[0].end = 2;
    const budget = createEvidenceBudget();
    for (const e of [...f.analysis.evidence.map(e => ({ ...e, end: 1 })), { ...f.analysis.evidence[0], start: 2, end: 2 }]) {
      budget.records.push({ id: `E${budget.records.length + 1}`, status: 'available', ...await provider.execute({ tool: 'read_file', ...e }) });
    }
    const common = { client: finalClient(f.analysis), provider, budget, skill, snapshot: f.snapshot, artifacts: {}, repo: f.repo,
      outputRoot: path.join(f.directory, 'out'), isCurrent: async () => true, python: process.env.AI_REVIEW_PYTHON || 'python' };
    assert.equal((await reviewTests(common)).status, 'validated');
    budget.records.pop();
    assert.equal((await reviewTests(common)).diagnostic.code, 'source_not_read');
  });
