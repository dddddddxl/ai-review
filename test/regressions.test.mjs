import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelClient } from '../src/model-client.mjs';
import { createEvidenceBudget, evidenceLoop } from '../src/review-evidence.mjs';
import { ReviewQueue, ReviewState } from '../src/review-state.mjs';
import { shouldReviewRun, resolveRunPullRequests } from '../src/ci-review.mjs';
import { createGitEvidence } from '../src/review-evidence.mjs';
import { loadRules } from '../src/review-planning.mjs';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { fixture } from './helpers.mjs';
import path from 'node:path';
import { updateTestReviewSummary, updateReviewWithCiEvidence } from '../src/pr-publication.mjs';

for (const format of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`text-action protocol works with ${format} adapter, no real provider`, async () => {
    let calls = 0;
    const text = () => ++calls === 1 ? '{"action":"tools","requests":[{"tool":"read_ci"}]}' : '{"action":"final","result":{"findings":[]}}';
    const fetchImpl = async () => ({ ok: true, json: async () => format === 'openai-chat'
      ? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text() } }], usage: { total_tokens: 1 } }
      : { content: [{ type: 'text', text: text() }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
    class OpenAIImpl { responses = { create: async () => ({ output_text: text(), status: 'completed' }) }; }
    const client = createModelClient({ AI_API_FORMAT: format, AI_API_KEY: 'synthetic-not-a-secret', AI_MODEL: 'fixture', AI_BASE_URL: 'https://example.invalid/v1' }, { fetchImpl, OpenAIImpl });
    const result = await evidenceLoop({ client, provider: { execute: async () => ({ content: 'synthetic' }) }, budget: createEvidenceBudget(), instructions: 'fixture', input: '' });
    assert.deepEqual(result, { findings: [] }); assert.equal(calls, 2);
  });
}
test('concurrent loops allocate unique evidence IDs', async () => {
  const budget = createEvidenceBudget();
  const run = () => { let n = 0; return evidenceLoop({ client: { generateReview: async () => n++ ? '{"action":"final","result":{}}' : '{"action":"tools","requests":[{"tool":"read_ci"}]}' },
    provider: { execute: async () => { await new Promise(r => setTimeout(r, 10)); return { content: 'fixture' }; } }, budget }); };
  await Promise.all([run(), run()]); assert.equal(new Set(budget.records.map(e => e.id)).size, 2);
});
test('failed or truncated tools remain visible after model final', async () => {
  let n = 0; const budget = createEvidenceBudget();
  await evidenceLoop({ client: { generateReview: async () => n++ ? '{"action":"final","result":{}}' : '{"action":"tools","requests":[{"tool":"read_ci"}]}' },
    provider: { execute: async () => ({ content: 'partial', truncated: true }) }, budget });
  assert.equal(budget.limitations.length, 1);
});
test('resume retains evidence and requires all fragments', async t => {
  const f = await fixture(t); const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
  const rules = await loadRules(provider); const state = new ReviewState(path.join(f.directory, 'state'));
  let calls = 0; const client = { model: 'fixture', generateReview: async () => ++calls === 1
    ? JSON.stringify({ action: 'tools', requests: [{ tool: 'read_file', path: 'api.py' }] }) : '{"action":"final","result":{"overview":[],"findings":[]}}' };
  const args = { client, files: f.files, baseSha: f.base, headSha: f.head, repository: 'fixture/repo', pullNumber: 1, enhancement: { provider, rules }, state, log() {} };
  const first = await reviewPrBatches(args), second = await reviewPrBatches(args);
  assert.equal(calls, 2); assert.equal(first.evidence.length, 1); assert.deepEqual(first.evidence, second.evidence);
});
test('queue claims remain unique and old CI eligibility unchanged', async t => {
  const f = await fixture(t); const queue = new ReviewQueue(path.join(f.directory, 'queue'));
  await queue.enqueue({ repository: 'fixture/repo', pullNumber: 1 });
  const claims = await Promise.all([queue.claimNext(), queue.claimNext()]); assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(shouldReviewRun({ status: 'completed', conclusion: 'success' }), false);
  assert.equal(shouldReviewRun({ status: 'completed', conclusion: 'failure' }), true);
  assert.equal(shouldReviewRun({ status: 'completed', conclusion: 'cancelled' }, [{ conclusion: 'failure' }]), true);
});
test('CI association does not guess dispatch PR from branch', async () => {
  const result = await resolveRunPullRequests({}, { full_name: 'fixture/repo' }, { event: 'workflow_dispatch', head_sha: 'a'.repeat(40), head_branch: 'feature' });
  assert.deepEqual(result.linked, []);
});
test('CI backfeed and test refresh preserve each other under concurrent publication', async () => {
  const headSha = 'a'.repeat(40); let body = `<!-- github-ai-review:v1:1:${headSha}:fixture -->\nOriginal`;
  const staleBody = body;
  const octokit = { paginate: async () => { await new Promise(r => setTimeout(r, 5)); return [{ id: 1, user: { login: 'bot' }, body }]; },
    rest: { pulls: { listReviews() {}, updateReview: async args => { await new Promise(r => setTimeout(r, 5)); body = args.body; } } } };
  const common = { octokit, owner: 'fixture', repo: 'repo', pullNumber: 1, headSha, botLogin: 'bot', isCurrent: async () => true };
  await Promise.all([
    updateTestReviewSummary({ ...common, testReview: { status: 'incomplete' } }),
    updateReviewWithCiEvidence({ ...common, reviewId: 1, reviewBody: staleBody, run: { id: 1, run_attempt: 1 }, result: { ciEvidence: [] } }),
  ]);
  assert.match(body, /ai-test-review:start/); assert.match(body, /github-ai-ci-backfeed:1:1:start/);
});
