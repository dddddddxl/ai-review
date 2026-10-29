import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrReviewPublication } from '../src/pr-publication.mjs';

const files = [{ filename: 'a.py', patch: '@@ -0,0 +1 @@\n+x=1', status: 'added' }];
const candidate = (title, priority = 'P3') => ({ priority, title, file: 'a.py', line: 1,
  trigger: 'input zero', evidence: 'x=1', impact: 'wrong result', suggestion: 'check input', verifierReason: 'not enough evidence' });
const publish = result => buildPrReviewPublication({ pr: { number: 1, head: { sha: 'a'.repeat(40) } }, files,
  result: { partial: false, totalFiles: 1, reviewedFiles: 1, reviewFindings: [], ...result } });

test('P3 uncertain candidates appear only in a closed summary section capped at three', () => {
  const p3 = Array.from({ length: 5 }, (_, i) => candidate(`minor-${i}`));
  const result = publish({ reviewUncertain: [candidate('serious', 'P1'), ...p3] });
  assert.equal(result.comments.length, 0);
  assert.equal(result.status, '待人工确认');
  assert.match(result.body, /低优先级待核实线索（P3，最多展示 3 条）/);
  assert.match(result.body, /需人工确认的候选（1）/);
  for (const name of ['serious', 'minor-0', 'minor-1', 'minor-2']) assert.ok(result.body.includes(name));
  for (const name of ['minor-3', 'minor-4']) assert.ok(!result.body.includes(name));
  assert.match(result.body, /其余 2 项未展开/);
  assert.ok(!result.body.includes('<details open'));
});

test('unsafe P3 candidates are removed before selecting the three visible items', () => {
  const result = publish({ reviewUncertain: [candidate('unsafe example@example.invalid'),
    ...Array.from({ length: 4 }, (_, i) => candidate(`safe-${i}`))] });
  assert.ok(!result.body.includes('example@example.invalid'));
  for (const name of ['safe-0', 'safe-1', 'safe-2']) assert.ok(result.body.includes(name));
  assert.ok(!result.body.includes('safe-3'));
  assert.equal(result.comments.length, 0);
});

test('confirmed findings still get inline comments, uncertain P3 items never do', () => {
  const result = publish({ reviewFindings: [candidate('confirmed', 'P2')], reviewUncertain: [candidate('minor')] });
  assert.equal(result.comments.length, 1);
  assert.match(result.comments[0].body, /confirmed/);
  assert.ok(!result.comments[0].body.includes('minor'));
  assert.ok(result.body.includes('minor'));
});
