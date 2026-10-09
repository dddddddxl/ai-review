import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMeasurements, endpointFetch } from '../scripts/benchmark-pr-api.mjs';
import { createModelClient } from '../src/model-client.mjs';

test('live timing averages include incomplete/failed PRs and separate complete-only mean', () => {
  const rows = [
    { elapsed_seconds: 10, status: { overall: 'complete' }, calls: [{ metadata: { inputTokens: 3, outputTokens: 5 } }] },
    { elapsed_seconds: 20, status: { overall: 'partial' }, calls: [] },
    { elapsed_seconds: 30, status: { overall: 'failed' }, calls: [{ status: 'failed' }] },
  ];
  const result = summarizeMeasurements(rows);
  assert.equal(result.mean_pr_seconds, 20);
  assert.equal(result.mean_complete_pr_seconds, 10);
  assert.equal(result.completed_count, 1);
  assert.equal(result.partial_count, 1);
  assert.equal(result.failed_count, 1);
  assert.equal(result.tokens_complete, false);
  assert.equal(summarizeMeasurements([]).mean_pr_seconds, null);
});

test('live runner only allows POST to exact model endpoint and refuses redirects', async () => {
  const requests = [];
  const restricted = endpointFetch('http://fixture.invalid/v1/chat/completions', async (url, options) => { requests.push({ url, options }); return 'mock'; });
  await assert.rejects(() => restricted('https://api.github.com/repos/x/y/comments', { method: 'POST' }), /read_only_model_route_required/);
  await assert.rejects(() => restricted('http://fixture.invalid/v1/chat/completions', { method: 'GET' }), /read_only_model_route_required/);
  assert.equal(await restricted('http://fixture.invalid/v1/chat/completions', { method: 'POST', redirect: 'follow' }), 'mock');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.redirect, 'error');
});

test('Chat JSON mode is explicit opt-in and never accepts reasoning as final answer', async () => {
  for (const enabled of [false, true]) {
    let sent;
    const client = createModelClient({ AI_API_FORMAT: 'openai-chat', AI_API_KEY: 'synthetic-only', AI_MODEL: 'fixture',
      AI_BASE_URL: 'https://fixture.invalid/v1', AI_CHAT_JSON_MODE: enabled ? 'true' : 'false' },
    { fetchImpl: async (_url, request) => { sent = JSON.parse(request.body); return { ok: true,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"action":"final","result":{}}', reasoning_content: 'never return this' } }] }) }; } });
    assert.equal(await client.generateReview({ instructions: 'JSON task', input: 'synthetic', maxOutputTokens: 64 }), '{"action":"final","result":{}}');
    assert.deepEqual(sent.response_format, enabled ? { type: 'json_object' } : undefined);
    assert.equal(sent.messages[0].content.includes('JSON 接口约束'), enabled);
    assert.equal(sent.messages[1].content, 'synthetic');
  }
});
