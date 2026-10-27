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
