import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceTools, reviewWithEvidenceAgent, reviewWithNativeEvidenceAgent, cleanText, cleanPatch } from '../src/review-agent.mjs';
import { createModelClient } from '../src/model-client.mjs';
import { upstreamDefinition } from '../src/upstream-context.mjs';
import { readOnly, extractSources } from '../scripts/replay-agent.mjs';
import { gzipSync } from 'node:zlib';

const snapshot = (files = { 'a.py': 'def f():\n    return 1\n' }, sha = 'a'.repeat(40)) => ({ sha, files: new Map(Object.entries(files)) });
const toolsFor = options => createEvidenceTools({ snapshots: { head: snapshot(), base: snapshot({ 'a.py': 'return 0' }, 'b'.repeat(40)) },
  upstreamLookup: async () => ({ error: 'missing' }), ...options });

test('reads and literal searches stay pinned to requested head/base', async () => {
  const tools = toolsFor();
  const head = await tools.execute({ tool: 'file_read', path: 'a.py', start: 1, end: 2 });
  assert.equal(head.sha, 'a'.repeat(40)); assert.match(head.text, /return 1/);
  const base = await tools.execute({ tool: 'code_search', query: 'return', side: 'base' });
  assert.equal(base.sha, 'b'.repeat(40)); assert.match(base.hits[0].text, /return 0/);
});
test('rejects traversal, secrets paths, invalid side, commands and oversized ranges', async () => {
  const tools = toolsFor();
  for (const file of ['../x', '/etc/passwd', '.env', 'secrets/key.py', 'C:\\x', 'x/../a.py'])
    assert.equal((await tools.execute({ tool: 'file_read', path: file })).error, 'invalid_path');
  assert.equal((await tools.execute({ tool: 'shell', command: 'whoami' })).error, 'unknown_tool');
  assert.equal((await tools.execute({ tool: 'file_read', path: 'a.py', side: 'main' })).error, 'invalid_side');
  assert.equal((await tools.execute({ tool: 'file_read', path: 'a.py', start: -1 })).error, 'invalid_range');
});
test('budgets, duplicates and clipping are explicit; no silent full-scope claim', async () => {
  const tools = toolsFor({ maxCalls: 3, maxReadLines: 1 });
  const request = { tool: 'file_read', path: 'a.py', start: 1, end: 200 };
  assert.equal((await tools.execute(request)).truncated, true);
  assert.equal((await tools.execute(request)).error, 'duplicate_request');
  assert.equal((await tools.execute({ tool: 'file_read', path: 'missing.py' })).error, 'missing_file');
  assert.equal((await tools.execute({ tool: 'code_search', query: 'return' })).error, 'tool_budget');
});
test('tool output redacts contact data and supports safe evidence rejection', async () => {
  const tools = toolsFor({ snapshots: { head: snapshot({ 'a.py': '# user@example.invalid\n' }) } });
  const result = await tools.execute({ tool: 'file_read', path: 'a.py' });
  assert(!result.text.includes('user@example.invalid'));
  assert.equal(cleanText('token = capacity\napi_key = "synthetic-value"'), 'token = capacity\napi_key = "[REDACTED]"');
});
test('diff decorators survive sanitization and JSON serialization while actual emails are redacted', async () => {
  const patch = '@@ -0,0 +1,4 @@\n+@pytest.fixture\n+@pytest.mark.parametrize("x", [1])\n+# contact user@example.invalid\n+def f(): pass';
  const cleaned = cleanPatch(patch);
  assert.match(cleaned, /\+@pytest.fixture/); assert.match(cleaned, /\+@pytest.mark.parametrize/);
  assert(!cleaned.includes('user@example.invalid'));
  await reviewWithNativeEvidenceAgent({ tools: toolsFor(), input: { files: [{ filename: 'a.py', patch }] }, maxCalls: 2, client: {
    async generateToolTurn({ messages }) {
      const sent = JSON.parse(messages[0].content).files[0].patch;
      assert.match(sent, /\+@pytest.fixture/); assert(!sent.includes('user@example.invalid'));
      return { message: { role: 'assistant', tool_calls: [{ id: 'final', type: 'function', function: {
        name: 'submit_review', arguments: JSON.stringify({ overview: [], findings: [], limitations: [] }),
      } }] } };
    },
  } });
});
const archive = items => gzipSync(Buffer.concat(items.flatMap(({ name, text = '', type = '0' }) => {
  const data = Buffer.from(text), header = Buffer.alloc(512);
  header.write(name); header.write(data.length.toString(8).padStart(11, '0'), 124); header.write(type, 156);
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
}).concat([Buffer.alloc(1024)])));
test('snapshot reads text only, refuses traversal/duplicates and never follows links', () => {
  const safe = extractSources(archive([{ name: 'root/a.py', text: 'x=1' },
    { name: 'root/link.py', type: '2', text: '/etc/passwd' }, { name: 'root/key.pem', text: 'private' }]), 'a'.repeat(40));
  assert.equal(safe.files.size, 1); assert.equal(safe.files.get('a.py'), 'x=1');
  assert.throws(() => extractSources(archive([{ name: 'root/../escape.py' }]), 'a'.repeat(40)), /unsafe_archive_path/);
  assert.throws(() => extractSources(archive([{ name: 'root/a.py' }, { name: 'root/a.py' }]), 'a'.repeat(40)), /duplicate_archive_path/);
});
test('loop follows requested evidence and completes without executing repository code', async () => {
  const tools = toolsFor(); let calls = 0;
  const result = await reviewWithEvidenceAgent({ tools, input: { files: [{ filename: 'a.py', patch: '@@ -0,0 +1 @@\n+x=1' }] },
    client: { async generateReview({ input }) {
      calls++;
      if (calls === 1) return JSON.stringify({ action: 'tools', requests: [{ tool: 'file_read', path: 'a.py' }] });
      assert.match(input, /return 1/);
      return JSON.stringify({ action: 'final', overview: [], findings: [], limitations: ['not runtime tested'] });
    } } });
  assert.equal(result.complete, true); assert.equal(result.calls.length, 2); assert.equal(result.toolStats.calls, 1);
});
test('malformed action fails without corrective model retries', async () => {
  let calls = 0;
  const result = await reviewWithEvidenceAgent({ tools: toolsFor(), input: { files: [] }, client: {
    async generateReview() { calls++; return 'not json'; } } });
  assert.equal(calls, 1); assert.equal(result.complete, false);
});
test('missing priority retains unranked evidence, verifies once, never becomes complete or published', async () => {
  let calls = 0;
  const candidate = { file: 'a.py', line: 1, title: 'candidate', trigger: 'input zero', evidence: 'x=1', impact: 'wrong result', suggestion: 'check input' };
  const result = await reviewWithEvidenceAgent({ tools: toolsFor(), input: { files: [{ filename: 'a.py', patch: '@@ -0,0 +1 @@\n+x=1' }] },
    client: { async generateReview() {
      calls++;
      return calls === 1 ? JSON.stringify({ action: 'final', overview: [], findings: [candidate], limitations: ['not tested'] })
        : JSON.stringify({ verdicts: [{ index: 0, verdict: 'uncertain', reason: 'not enough evidence' }] });
    } } });
  assert.equal(calls, 2); assert.equal(result.complete, false); assert.equal(result.findings.length, 0);
  assert.equal(result.pendingCandidates.length, 1); assert.equal(result.rawFinal.findings.length, 1);
  assert(result.decodingReasons.includes('invalid_priority')); assert.equal(result.pendingCandidates[0].candidate.priority, undefined);
});
test('native agent uses actual tool calls; transient provider reasoning never enters artifacts', async () => {
  let calls = 0;
  const result = await reviewWithNativeEvidenceAgent({ tools: toolsFor(), input: { files: [{ filename: 'a.py' }] },
    client: { async generateToolTurn({ messages }) {
      calls++;
      if (calls === 2) {
        assert(messages.some(message => message.role === 'tool' && message.content.includes('return 1')));
        assert(messages.some(message => message.reasoning_content === 'PRIVATE_REASONING_TEST_MARKER'));
      }
      return { message: { role: 'assistant', content: '继续取证', reasoning_content: 'PRIVATE_REASONING_TEST_MARKER', tool_calls: [{
        id: `call_${calls}`, type: 'function', function: calls === 1
          ? { name: 'file_read', arguments: JSON.stringify({ path: 'a.py' }) }
          : { name: 'submit_review', arguments: JSON.stringify({ overview: [], findings: [], limitations: ['not executed'] }) },
      }] } };
    } } });
  assert.equal(result.complete, true); assert.equal(calls, 2); assert.equal(result.toolStats.calls, 1);
  assert(!JSON.stringify(result).includes('PRIVATE_REASONING_TEST_MARKER'));
});
test('native stream reassembles function argument fragments and ordinary review still rejects tool calls', async () => {
  let body;
  const wire = () => new Response([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.py"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n');
  const client = createModelClient({ AI_API_FORMAT: 'openai-chat', AI_MODEL: 'mock', AI_API_KEY: 'synthetic', AI_BASE_URL: 'https://mock.invalid', AI_STREAM: 'true' }, {
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return wire(); },
  });
  const response = await client.generateToolTurn({ instructions: 'readonly', messages: [{ role: 'user', content: 'test' }],
    tools: [{ type: 'function', function: { name: 'file_read' } }], maxOutputTokens: 100, timeoutMs: 1000 });
  assert.equal(body.tools[0].function.name, 'file_read'); assert.equal(body.tool_choice, 'auto');
  assert.equal(response.message.tool_calls[0].function.arguments, '{"path":"a.py"}');
  assert.equal(response.metadata.totalTokens, 30);
  await assert.rejects(client.generateReview({ instructions: 'readonly', input: 'test', timeoutMs: 1000 }));
});
test('native tool turns honour the thinking switch for GLM models', async () => {
  let body;
  const client = createModelClient({ AI_API_FORMAT: 'openai-chat', AI_MODEL: 'glm-5.3-flash', AI_API_KEY: 'synthetic', AI_BASE_URL: 'https://mock.invalid' }, {
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] } }] }),
      { headers: { 'content-type': 'application/json' } });
    },
  });
  const turn = { instructions: 'readonly', messages: [{ role: 'user', content: 'test' }],
    tools: [{ type: 'function', function: { name: 'file_read' } }], maxOutputTokens: 10, timeoutMs: 1000 };
  await client.generateToolTurn({ ...turn, disableThinking: true });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  await client.generateToolTurn(turn);
  assert.deepEqual(body.thinking, { type: 'enabled' });
});
test('native plain prose without actual tool calls remains incomplete, never a clean review', async () => {
  const result = await reviewWithNativeEvidenceAgent({ tools: toolsFor(), input: { files: [] }, client: {
    async generateToolTurn() { return { message: { role: 'assistant', content: 'Need more evidence.' } }; },
  } });
  assert.equal(result.complete, false); assert.equal(result.failure, 'no_bounded_tool_calls'); assert.equal(result.calls.length, 1);
});
test('at the deadline round only submit_review is exposed, rather than trusting tool_choice alone', async () => {
  const result = await reviewWithNativeEvidenceAgent({ tools: toolsFor(), input: { files: [] }, maxCalls: 2, client: {
    async generateToolTurn({ tools, toolChoice }) {
      assert.deepEqual(tools.map(tool => tool.function.name), ['submit_review']);
      assert.equal(toolChoice.function.name, 'submit_review');
      return { message: { role: 'assistant', tool_calls: [{ id: 'final', type: 'function', function: {
        name: 'submit_review', arguments: JSON.stringify({ overview: [], findings: [], limitations: ['budget reached'] }),
      } }] } };
    },
  } });
  assert.equal(result.complete, true); assert.equal(result.calls.length, 1);
});
test('call budget forces final; runaway tool use cannot become clean', async () => {
  const result = await reviewWithEvidenceAgent({ tools: toolsFor(), input: { files: [] }, maxCalls: 2,
    client: { async generateReview() { return JSON.stringify({ action: 'tools', requests: [{ tool: 'file_read', path: 'a.py' }] }); } } });
  assert.equal(result.complete, false); assert.equal(result.calls.length, 1); assert.equal(result.failure, 'missing_final');
});
test('deadline cancels active model call; no retry or late follow-up', async () => {
  const result = await reviewWithEvidenceAgent({ tools: toolsFor(), input: { files: [] }, maxDurationMs: 30,
    client: { generateReview: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } });
  assert.equal(result.complete, false); assert.equal(result.calls.length, 1);
});
test('GitHub writes are rejected, installation token and reads are allowed', async () => {
  let before;
  readOnly({ hook: { before(_name, fn) { before = fn; } } });
  before({ method: 'GET', url: '/repos/x/y' });
  before({ method: 'POST', url: '/app/installations/1/access_tokens' });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.throws(() => before({ method, url: '/repos/x/y/issues/1/comments' }));
});
test('upstream follows relative package re-exports and aliases, never executes imports', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-agent-upstream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', '__init__.py'), 'from .impl import Real as Public\nraise RuntimeError("must not execute")\n');
  fs.writeFileSync(path.join(root, 'public', 'impl.py'), 'class Real:\n    def apply(self):\n        return 1\n');
  const found = upstreamDefinition(new Map([['pkg', root]]), 'pkg.public.Public.apply');
  assert.equal(found.missing, undefined); assert.match(found.text, /def apply/); assert.equal(found.resolution.length, 1);
});
test('upstream cycles terminate and traversal is denied', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-agent-cycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '__init__.py'), 'from .a import X\n');
  fs.writeFileSync(path.join(root, 'a.py'), 'from pkg import X\n');
  assert(upstreamDefinition(new Map([['pkg', root]]), 'pkg.X').missing);
  assert.equal(upstreamDefinition(new Map([['pkg', root]]), '../passwd'), null);
});
