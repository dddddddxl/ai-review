import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { CI_INSTRUCTIONS, PR_INSTRUCTIONS, PR_RISK_CHECKLIST, PR_VERIFICATION_INSTRUCTIONS } from '../src/review-templates.mjs';

const files = [{ filename: 'a.py', status: 'added', patch: '@@ -0,0 +1 @@\n+a = 1', additions: 1, deletions: 0 }];
const finding = { priority: 'P2', file: 'a.py', line: 1, title: 'Incorrect result', trigger: 'input zero',
  evidence: 'a = 1', impact: 'wrong output', suggestion: 'check input' };
const args = { files, repository: 'synthetic/repo', pullNumber: 1, title: 'test', log: () => {} };
const recorder = calls => ({ model: 'mock', format: 'mock', async generateReview(options) {
  calls.push(options);
  return options.instructions === PR_VERIFICATION_INSTRUCTIONS
    ? JSON.stringify({ verdicts: [{ index: 0, verdict: 'confirmed', reason: 'proved' }] })
    : JSON.stringify({ overview: [], findings: [finding] });
} });

test('generation and verification reason by default; thinking=false restores the old calls', async () => {
  const enabled = [];
  await reviewPrBatches({ ...args, client: recorder(enabled) });
  assert.deepEqual(enabled.map(call => call.disableThinking), [false, false]);
  const disabled = [];
  await reviewPrBatches({ ...args, client: recorder(disabled), thinking: false });
  assert.deepEqual(disabled.map(call => call.disableThinking), [true, true]);
});

test('uncertain P3 candidates are not published; uncertain P1/P2 stay for manual follow-up', async () => {
  const candidates = [{ ...finding, priority: 'P2', title: 'serious' }, { ...finding, priority: 'P3', title: 'minor' }];
  const client = { model: 'mock', format: 'mock', async generateReview(options) {
    return options.instructions === PR_VERIFICATION_INSTRUCTIONS
      ? JSON.stringify({ verdicts: [0, 1].map(index => ({ index, verdict: 'uncertain', reason: 'unverified' })) })
      : JSON.stringify({ overview: [], findings: candidates });
  } };
  const judged = [];
  const result = await reviewPrBatches({ ...args, client, onCandidates: record => judged.push(...record.candidates) });
  assert.deepEqual(result.reviewUncertain.map(f => f.title), ['serious']);
  assert.equal(judged.length, 2);
});

test('generation prompt favours recall; verification and CI prompts keep the strict rules', () => {
  assert(PR_INSTRUCTIONS.includes(PR_RISK_CHECKLIST));
  assert(PR_INSTRUCTIONS.includes('漏报的代价高于误报'));
  assert(!PR_INSTRUCTIONS.includes('缺少上下文不等于存在缺陷'));
  assert(!PR_INSTRUCTIONS.includes('不凑问题数量'));
  for (const strict of [PR_VERIFICATION_INSTRUCTIONS, CI_INSTRUCTIONS]) {
    assert(strict.includes('缺少上下文不等于存在缺陷'));
    assert(!strict.includes(PR_RISK_CHECKLIST));
  }
});

const manyFiles = count => Array.from({ length: count }, (_, i) => ({ filename: `f${i}.py`, status: 'added',
  patch: `@@ -0,0 +1 @@\n+v${i} = ${'x'.repeat(4000)}`, additions: 1, deletions: 0 }));

test('batches run through a worker pool bounded by batchParallelism', async () => {
  let active = 0, peak = 0;
  const client = { model: 'mock', format: 'mock', async generateReview() {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return JSON.stringify({ overview: [], findings: [] });
  } };
  const result = await reviewPrBatches({ ...args, files: manyFiles(6), client, batchChars: 5000, batchParallelism: 3 });
  assert.equal(result.completed, 6);
  assert.equal(peak, 3);
});

test('a slow batch does not hold back the next ones', async () => {
  const finished = [];
  const client = { model: 'mock', format: 'mock', async generateReview(options) {
    const slow = options.input.includes('f0.py');
    await new Promise(resolve => setTimeout(resolve, slow ? 60 : 5));
    finished.push(slow ? 'slow' : 'fast');
    return JSON.stringify({ overview: [], findings: [] });
  } };
  await reviewPrBatches({ ...args, files: manyFiles(4), client, batchChars: 5000, batchParallelism: 2 });
  assert.equal(finished.at(-1), 'slow');
});

test('diff lines carry new-side line numbers, also in fragments that start mid-hunk', async () => {
  const { numberPatch, makeBatches } = await import('../src/pr-review.mjs');
  const patch = '@@ -1,3 +10,4 @@ def f():\n ctx\n-old\n+new1\n+new2\n ctx2';
  assert.equal(numberPatch(patch), '@@ -1,3 +10,4 @@ def f():\n   10  ctx\n      -old\n   11 +new1\n   12 +new2\n   13  ctx2');
  assert.equal(numberPatch(patch, patch.indexOf('+new2')), '   12 +new2\n   13  ctx2');
  const long = `@@ -0,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+line ${i + 1} ${'y'.repeat(40)}`).join('\n')}`;
  const plan = makeBatches([{ filename: 'doc.md', status: 'added', patch: long }], { batchChars: 5000 });
  assert.ok(plan.batches.length > 1);
  for (const batch of plan.batches) {
    for (const match of batch.text.matchAll(/^\s*(\d+) \+line (\d+) /gm)) assert.equal(match[1], match[2]);
  }
});
