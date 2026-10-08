import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { fileBridge } from '../scripts/dry-run-pr-lib.mjs';
import { sensitiveText, sensitiveData, createGitEvidence, createEvidenceBudget, evidenceLoop, TOOL_PROTOCOL } from '../src/review-evidence.mjs';

test('JSON escaped newlines before decorators are not email addresses', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const content = `import triton${newline}@triton.jit${newline}def kernel(): pass`;
    assert.equal(sensitiveText(content), false);
    assert.equal(sensitiveData({ content }), false);
    assert.equal(sensitiveText(JSON.stringify({ content })), false);
    assert.equal(sensitiveText(JSON.stringify({ input: JSON.stringify({ content }) })), false);
  }
});
test('real emails and secrets remain blocked in raw and serialized evidence', () => {
  for (const email of ['n@example.com', 'r@example.com', 'person.name+tag@example.org']) {
    for (const content of [email, '\n' + email, '\r\n' + email, 'before\\n' + email]) {
      assert.equal(sensitiveText(content), true, content);
      assert.equal(sensitiveData({ content }), true);
      assert.equal(sensitiveText(JSON.stringify({ content })), true);
      assert.equal(sensitiveText(JSON.stringify({ input: JSON.stringify({ content }) })), true);
    }
  }
  for (const content of ['ghp_synthetic1234567890', 'sk-synthetic1234567890', 'api_key=synthetic-private-value', 'authorization=synthetic-private-value', '-----BEGIN PRIVATE KEY-----']) {
    assert.equal(sensitiveText(content), true);
    assert.equal(sensitiveText(JSON.stringify({ content: '\n' + content })), true);
  }
});
test('two-round file bridge preserves actual Git decorator evidence without privacy false positive', async t => {
  const f = await fixture(t);
  await f.write('kernel.py', 'import triton\n\n@triton.jit\ndef kernel():\n    pass\n'); await f.commit();
  const head = (await f.git('rev-parse', 'HEAD')).trim();
  const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: head, files: [] });
  const directory = path.join(f.directory, 'bridge'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'reply-001.json'), JSON.stringify({ action: 'tools', requests: [{ tool: 'read_file', path: 'kernel.py' }] }));
  await fs.writeFile(path.join(directory, 'reply-002.json'), JSON.stringify({ action: 'final', result: { findings: [] } }));
  const client = fileBridge({ directory, modelWindowMs: 5000, notify() {} }), budget = createEvidenceBudget();
  const result = await evidenceLoop({ client, provider, budget, instructions: 'fixed', input: '{}' });
  assert.deepEqual(result, { findings: [] }); assert.equal(client.calls, 2); assert.equal(budget.records.length, 1);
  const request = JSON.parse(await fs.readFile(path.join(directory, 'request-002.json'), 'utf8'));
  assert.ok(request.input.includes('\\n@triton.jit')); assert.equal(sensitiveData(request), false);
  assert.equal(budget.records[0].status, 'available'); assert.equal(budget.records[0].truncated, false);
});
test('tool protocol explains existing line and literal-search limits; execution limits unchanged', async t => {
  assert.match(TOOL_PROTOCOL, /end-start\+1 <= 200/); assert.match(TOOL_PROTOCOL, /省略end/);
  assert.match(TOOL_PROTOCOL, /end <= 文件实际总行数/); assert.match(TOOL_PROTOCOL, /不是正则或glob/);
  const f = await fixture(t), provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
  const read = await provider.execute({ tool: 'read_file', path: 'api.py' });
  assert.equal(read.start, 1); assert.equal(read.end, 2);
  await assert.rejects(provider.execute({ tool: 'read_file', path: 'api.py', start: 1, end: 200 }), /line_range_invalid/);
  const search = await provider.execute({ tool: 'search_code', query: 'abs', prefix: '^api' });
  assert.deepEqual(search.matches, []);
  const budget = createEvidenceBudget(); assert.equal(budget.maxTools, 24); assert.equal(budget.maxDurationMs, 180000);
});
