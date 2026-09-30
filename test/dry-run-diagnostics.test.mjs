import test from 'node:test';
import assert from 'node:assert/strict';
import { testReviewDiagnostic, reviewTests } from '../src/test-review-skill.mjs';
import { deniedToolResult, createEvidenceBudget, evidenceLoop } from '../src/review-evidence.mjs';

test('test-review diagnostics classify failure without copying secrets/stderr', () => {
  assert.deepEqual(testReviewDiagnostic(new Error('source_not_read'), 'evidence'), { stage: 'evidence', code: 'source_not_read' });
  assert.deepEqual(testReviewDiagnostic(new SyntaxError('private JSON payload'), 'model'), { stage: 'model', code: 'model_json_invalid' });
  assert.deepEqual(testReviewDiagnostic(Object.assign(new Error('command and stderr'), { reviewStage: 'handoff' }), 'validation'),
    { stage: 'handoff', code: 'review_dependency_unavailable' });
  const error = Object.assign(new Error('api_key=do-not-copy-this'), { status: 401, stdout: 'private', stderr: 'private' });
  const diagnostic = testReviewDiagnostic(error, 'model');
  assert.deepEqual(diagnostic, { stage: 'model', code: 'model_http_error', http_status: 401 });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|do-not-copy/);
});

test('test-review bridge returns protocol/budget failures as incomplete, not all-clear', async () => {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const common = { provider: { headSha: head, baseSha: base }, skill: { instructions: '' },
    snapshot: { capture_consistent: true, pr: { head_sha: head, base_sha: base } }, artifacts: {}, isCurrent: async () => true };
  const malformed = await reviewTests({ ...common, budget: createEvidenceBudget(), client: { async generateReview() { return 'not JSON'; } } });
  assert.equal(malformed.status, 'incomplete'); assert.equal(malformed.diagnostic.code, 'model_json_invalid');
  let called = false;
  const exhausted = await reviewTests({ ...common, budget: { ...createEvidenceBudget(), started: 0 },
    client: { async generateReview() { called = true; } } });
  assert.equal(called, false); assert.equal(exhausted.diagnostic.code, 'evidence_time_budget');
  assert.match(exhausted.report, /不能据此判断没有测试缺口/);
});

test('denied evidence preserves safe location/category but not sensitive request or error', () => {
  const r = deniedToolResult(new Error('content_denied'), { tool: 'read_file', path: 'workflow.yml', revision: 'a'.repeat(40) });
  assert.equal(r.reason, 'content_denied'); assert.equal(r.path, 'workflow.yml');
  const privateRequest = deniedToolResult(new Error('authorization=private-error'), { tool: 'shell', path: '.env', query: 'private-query' });
  assert.deepEqual(privateRequest, { status: 'unavailable', reason: 'tool_denied_or_unavailable' });
  assert.doesNotMatch(JSON.stringify(privateRequest), /private-error|private-query|\.env/);
});

test('evidence loop surfaces safe denied reason to next model round', async () => {
  let n = 0;
  const result = await evidenceLoop({ budget: createEvidenceBudget(), provider: { async execute() { throw new Error('line_range_invalid'); } },
    instructions: 'test', input: '{}', client: { async generateReview({ input }) {
      if (n++ === 0) return JSON.stringify({ action: 'tools', requests: [{ tool: 'read_file', path: 'test.py', start: 200 }] });
      assert.match(input, /line_range_invalid/); assert.match(input, /test.py/);
      return JSON.stringify({ action: 'final', result: { incomplete: true } });
    } } });
  assert.equal(result.incomplete, true);
});
