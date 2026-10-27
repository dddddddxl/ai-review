import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createModelClient } from '../src/model-client.mjs';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { buildPrReviewPublication } from '../src/pr-publication.mjs';
import { decodeVerification } from '../src/review-templates.mjs';
import { limitModelConcurrency } from '../src/review-state.mjs';

const files = [{ filename: 'a.py', status: 'added', patch: '@@ -0,0 +1 @@\n+a = 1', additions: 1, deletions: 0 }];
const finding = { priority: 'P2', file: 'a.py', line: 1, title: 'Incorrect result', trigger: 'input zero',
  evidence: 'a = 1', impact: 'wrong output', suggestion: 'check input' };
const empty = JSON.stringify({ overview: [], findings: [] });
const candidate = JSON.stringify({ overview: [], findings: [finding] });
const confirmed = JSON.stringify({ verdicts: [{ index: 0, verdict: 'confirmed', reason: 'The supplied code proves it.' }] });
const args = { files, repository: 'synthetic/repo', pullNumber: 1, title: 'test', log: () => {} };
const model = generateReview => ({ model: 'mock', format: 'mock', generateReview });
const blocked = signal => new Promise((_, reject) => {
  signal.throwIfAborted();
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const chatResponse = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content } }] }), { headers: { 'content-type': 'application/json' } });
const streamResponse = content => new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
  delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const environment = { AI_API_FORMAT: 'openai-chat', AI_MODEL: 'mock', AI_API_KEY: 'synthetic', AI_BASE_URL: 'https://mock.invalid' };

test('conflicting or repeated verdict indices cannot confirm a candidate', () => {
  for (const second of ['refuted', 'confirmed']) assert.throws(() => decodeVerification(JSON.stringify({ verdicts: [
    { index: 0, verdict: 'confirmed', reason: 'yes' }, { index: 0, verdict: second, reason: 'second answer' },
  ] }), 1), SyntaxError);
  assert.throws(() => decodeVerification('{"verdicts":[{"index":1,"verdict":"confirmed"}]}', 1), SyntaxError);
  assert.equal(decodeVerification('{"verdicts":[]}', 1)[0].verdict, 'uncertain');
});

test('uncertain candidates show amber; incomplete and P1 states retain priority', () => {
  const publish = result => buildPrReviewPublication({ pr: { number: 1, head: { sha: 'a'.repeat(40) } }, files,
    result: { partial: false, reviewedFiles: 1, totalFiles: 1, reviewFindings: [], ...result } });
  const pending = publish({ reviewUncertain: [finding] });
  assert.equal(pending.status, '待人工确认');
  assert.equal(pending.comments.length, 0);
  assert(!pending.body.includes('🟢'));
  assert.equal(publish({ partial: true, reviewUncertain: [finding] }).status, '审查未完成');
  assert.equal(publish({ reviewFindings: [{ ...finding, priority: 'P1' }], reviewUncertain: [finding] }).status, '需要修改');
  assert.equal(publish({ reviewUncertain: [] }).status, '未发现有明确证据的问题');
  const sensitive = publish({ reviewUncertain: [{ ...finding, evidence: 'contact example@example.invalid' }] });
  assert(!sensitive.body.includes('example@example.invalid'));
  assert(!sensitive.body.includes('🟢'));
});

test('streaming obeys explicit shorter request timeout', { timeout: 2000 }, async () => {
  const client = createModelClient({ ...environment, AI_STREAM: 'true', AI_STREAM_MAX_MS: '1000' }, {
    fetchImpl: async (_url, { signal }) => { await delay(200, null, { signal }); return streamResponse(empty); },
  });
  await assert.rejects(client.generateReview({ input: 'mock', instructions: 'mock', timeoutMs: 40 }),
    error => error.name === 'AbortError' || error.name === 'TimeoutError');
});

test('stream cap also bounds a longer caller timeout', { timeout: 2000 }, async () => {
  const client = createModelClient({ ...environment, AI_STREAM: 'true', AI_STREAM_MAX_MS: '40' }, {
    fetchImpl: async (_url, { signal }) => { await delay(200, null, { signal }); return streamResponse(empty); },
  });
  await assert.rejects(client.generateReview({ input: 'mock', instructions: 'mock', timeoutMs: 1000 }));
});

test('successful stream retains final-answer decoding', async () => {
  const client = createModelClient({ ...environment, AI_STREAM: 'true' }, { fetchImpl: async () => streamResponse(empty) });
  assert.equal(await client.generateReview({ input: 'mock', instructions: 'mock', timeoutMs: 1000 }), empty);
});

test('expired queued calls never contact the provider', { timeout: 2000 }, async () => {
  let release, providerCalls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const client = limitModelConcurrency(createModelClient(environment, { fetchImpl: async () => {
    providerCalls++;
    await hold;
    return chatResponse(empty);
  } }), 1);
  const first = client.generateReview({ input: 'hold', instructions: 'mock', timeoutMs: 1000 });
  const result = await reviewPrBatches({ ...args, client, maxDurationMs: 60 });
  assert(result.partial && result.budgetExceeded);
  assert.equal(providerCalls, 1);
  release();
  await first;
  await delay(10);
  assert.equal(providerCalls, 1, 'the expired semaphore waiter must not start a new provider request');
});

test('deadline aborts generation without retries or recursive splitting', { timeout: 2000 }, async () => {
  let calls = 0, wasAborted = false;
  const result = await reviewPrBatches({ ...args, maxDurationMs: 60, client: model(async ({ signal }) => {
    calls++;
    try { return await blocked(signal); } finally { wasAborted = signal.aborted; }
  }) });
  assert.equal(calls, 1);
  assert(wasAborted && result.partial && result.budgetExceeded);
  assert.equal(result.completed, 0);
  assert(result.failureSummary.some(item => item.label.includes('时间预算')));
});

test('a timed-out verifier saves candidates and continuation does not regenerate them', { timeout: 2000 }, async () => {
  let saved = null, generationCalls = 0, verifyCalls = 0;
  const state = { read: async () => saved, write: async (_key, value) => { saved = structuredClone(value); } };
  const client = model(async ({ input, signal }) => {
    if (!input.includes('<candidates>')) { generationCalls++; return candidate; }
    if (++verifyCalls === 1) return blocked(signal);
    return confirmed;
  });
  const first = await reviewPrBatches({ ...args, client, state, maxDurationMs: 60 });
  assert(first.partial && first.budgetExceeded);
  assert.equal(saved.results[0].pendingVerification.findings.length, 1);
  assert.equal(first.reviewFindings.length, 0);
  const second = await reviewPrBatches({ ...args, client, state, maxDurationMs: 1000 });
  assert(!second.partial);
  assert.equal(second.reviewFindings.length, 1);
  assert.equal(generationCalls, 1);
  assert.equal(verifyCalls, 2);
});

test('transient backoff cannot outlive the remaining review budget', { timeout: 2000 }, async () => {
  let calls = 0;
  const result = await reviewPrBatches({ ...args, maxDurationMs: 60, transientRetryDelayMs: 30000,
    client: model(async () => { calls++; throw new Error('synthetic connection failure'); }) });
  assert.equal(calls, 1);
  assert(result.partial && result.budgetExceeded);
});

test('ordinary request timeout still retries the identical batch with a longer call limit', async () => {
  const calls = [];
  const result = await reviewPrBatches({ ...args, maxDurationMs: 1000, client: model(async options => {
    calls.push(options);
    if (calls.length === 1) throw new DOMException('synthetic timeout', 'TimeoutError');
    return empty;
  }) });
  assert(!result.partial);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input, calls[1].input);
  assert.equal(calls[1].timeoutMs, 300000);
  assert.equal(calls[0].deadlineAt, calls[1].deadlineAt);
});

test('dedup shares the deadline and retains already confirmed findings on failure', { timeout: 2000 }, async () => {
  const result = await reviewPrBatches({ ...args, maxDurationMs: 60, client: model(async ({ input, signal }) => {
    if (input.startsWith('<findings>')) return blocked(signal);
    if (input.includes('<candidates>')) return JSON.stringify({ verdicts: [0, 1].map(index => ({ index, verdict: 'confirmed', reason: 'code evidence' })) });
    return JSON.stringify({ findings: [finding, { ...finding, title: 'Another root cause' }] });
  }) });
  assert(result.budgetExceeded);
  assert.equal(result.findings, 2);
  assert.equal(result.partial, false, 'optional dedup failure must not erase verified review coverage');
});

test('contradictory verification leaves candidates pending instead of publishing', async () => {
  let saved;
  const result = await reviewPrBatches({ ...args, maxDurationMs: 1000,
    state: { read: async () => null, write: async (_key, value) => { saved = structuredClone(value); } },
    client: model(async ({ input }) => input.includes('<candidates>') ? JSON.stringify({ verdicts: [
      { index: 0, verdict: 'confirmed', reason: 'yes' }, { index: 0, verdict: 'refuted', reason: 'no' },
    ] }) : candidate) });
  assert(result.partial);
  assert.equal(result.findings, 0);
  assert.equal(saved.results[0].pendingVerification.findings.length, 1);
});
