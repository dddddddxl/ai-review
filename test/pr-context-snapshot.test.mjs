import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildPrRepositoryContext } from '../src/pr-context.mjs';

const tar = entries => gzipSync(Buffer.concat(entries.flatMap(([name, text]) => {
  const data = Buffer.from(text), header = Buffer.alloc(512);
  header.write('root/' + name); header.write(data.length.toString(8).padStart(11, '0'), 124); header.write('0', 156);
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
}).concat([Buffer.alloc(1024)])));

const files = [{ filename: 'pkg/envs.py', status: 'modified',
  patch: '@@ -1,2 +1,2 @@\n-    "VLLM_HCU_VISIBLE_DEVICES": lambda: os.getenv("X"),\n+    "VLLM_HCU_VISIBLE_DEVICES": lambda: os.getenv("Y"),\n' }];

test('repository context searches the base snapshot instead of default-branch code search', async () => {
  const routes = [];
  const octokit = {
    request: async (route, args) => { routes.push([route, args.ref]); return { data: tar([
      ['pkg/envs.py', 'x = 1\n'],
      ['pkg/distributed/custom_all_reduce.py', 'import os\ndevices = list(map(int, os.environ["VLLM_HCU_VISIBLE_DEVICES"].split(",")))\n'],
      ['pkg/unrelated.py', 'VLLM_HCU_VISIBLE_DEVICES_EXTRA = 1\n'],
    ]) }; },
    rest: { search: { code: async () => assert.fail('code search must not run') },
      repos: { getContent: async () => assert.fail('content API must not run') } },
  };
  const entries = await buildPrRepositoryContext({ octokit, owner: 'o', repo: 'r', baseSha: 'b'.repeat(40), files });
  assert.deepEqual(routes, [['GET /repos/{owner}/{repo}/tarball/{ref}', 'b'.repeat(40)]]);
  assert.deepEqual(entries.map(entry => entry.filename), ['pkg/distributed/custom_all_reduce.py']);
  assert.match(entries[0].excerpt, /2: devices = list\(map\(int/);
});

test('a failed snapshot download falls back to code search', async () => {
  const logs = [], queries = [];
  const octokit = {
    request: async () => { throw Object.assign(new Error('nope'), { status: 404 }); },
    rest: { search: { code: async args => { queries.push(args.q); return { data: { items: [] } }; } },
      repos: { getContent: async () => ({ data: null }) } },
  };
  await buildPrRepositoryContext({ octokit, owner: 'o', repo: 'r', baseSha: 'b'.repeat(40), files, searchIntervalMs: 0, log: m => logs.push(m) });
  assert.ok(logs.some(m => m.includes('base-snapshot failed code=http_404')));
  assert.deepEqual(queries, ['VLLM_HCU_VISIBLE_DEVICES repo:o/r']);
});
