import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { resolveReviewProfile, repositoryReviewRules, PROFILES } from '../src/repo-profile.mjs';
import { extractSources, extractSourcesStreaming } from '../src/repository-snapshot.mjs';
import { buildPrRepositoryContext, enclosingDefinition, extractRepositoryContextSignals } from '../src/pr-context.mjs';
import { buildPrInstructions } from '../src/review-templates.mjs';

const tar = entries => gzipSync(Buffer.concat(entries.flatMap(([name, text]) => {
  const data = Buffer.from(text), header = Buffer.alloc(512);
  header.write('root/' + name); header.write(data.length.toString(8).padStart(11, '0'), 124); header.write('0', 156);
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)];
}).concat([Buffer.alloc(1024)])));
const patch = lines => `@@ -1,1 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`;
const env = {};

test('known repositories map to their profile; unknown ones follow the changed languages', () => {
  const py = [{ filename: 'a.py', patch: patch(['x = 1']) }];
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/vllm-plugin-das', files: py, environment: env }).key, 'inference');
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/Megatron-LM-das', files: py, environment: env }).key, 'training');
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/hcu-exporter', files: py, environment: env }).key, 'go');
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/brand-new', files: [{ filename: 'k.cu', patch: 'x' }], environment: env }).key, 'kernel');
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/brand-new', files: [{ filename: 'main.go', patch: 'x' }], environment: env }).key, 'go');
  assert.equal(resolveReviewProfile({ repository: 'HYGON-AI/brand-new', files: py, environment: env }).key, 'generic');
});

test('documentation-only PRs use the docs profile in any repository', () => {
  const profile = resolveReviewProfile({ repository: 'HYGON-AI/lightop', environment: env,
    files: [{ filename: 'README.md', patch: 'x' }, { filename: 'docs/install.rst', patch: 'y' }] });
  assert.equal(profile.key, 'docs');
  assert.ok(buildPrInstructions(profile).includes('以文档为交付物'));
  assert.ok(!buildPrInstructions(PROFILES.kernel).includes('以文档为交付物'));
});

test('CI add-on is appended when workflow or build files change; overrides come from AI_REPO_PROFILES', () => {
  const files = [{ filename: '.github/workflows/ci.yml', patch: 'x' }, { filename: 'src/a.cpp', patch: 'y' }];
  assert.match(resolveReviewProfile({ repository: 'HYGON-AI/lightop', files, environment: env }).checklist, /CI 与构建附加检查/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, JSON.stringify([{ repository: 'HYGON-AI/lightop', profile: 'training', extraChecklist: '必须检查 X' }]));
  const resolved = resolveReviewProfile({ repository: 'HYGON-AI/lightop', files, environment: { AI_REPO_PROFILES: file } });
  assert.equal(resolved.key, 'training');
  assert.match(resolved.checklist, /【仓库附加检查】必须检查 X/);
});

test('review rules come from base-branch AGENTS.md sections near the change', () => {
  const snapshot = { files: new Map([
    ['AGENTS.md', '# Intro\nignored\n## Code Review Rules\n- root rule\n## Other\nnot this'],
    ['ops/AGENTS.md', 'whole file rule'],
    ['other/AGENTS.md', 'unrelated rule'],
  ]) };
  const rules = repositoryReviewRules(snapshot, [{ filename: 'ops/kernel/a.cu' }]);
  assert.match(rules, /root rule/);
  assert.match(rules, /whole file rule/);
  assert.doesNotMatch(rules, /not this|unrelated rule|ignored/);
  assert.equal(repositoryReviewRules(null, []), '');
});

test('streaming extraction matches the buffered reader and keeps preferred files past the budget', async () => {
  const archive = tar([['a.py', 'x = 1\n'], ['lib/k.cu', '__global__ void k() {}\n'], ['CMakeLists.txt', 'add_library(k)\n'],
    ['img.png', 'binary'], ['far/big.py', 'y'.repeat(3000)], ['near/big.py', 'z'.repeat(3000)]]);
  const streamed = await extractSourcesStreaming(archive, 's', { maxTextBytes: 2000 });
  assert.deepEqual([...streamed.files.keys()].sort(), ['CMakeLists.txt', 'a.py', 'lib/k.cu']);
  const preferred = await extractSourcesStreaming(archive, 's', { maxTextBytes: 2000, prefer: p => p.startsWith('near/') });
  assert.ok(preferred.files.has('near/big.py'));
  assert.ok(!preferred.files.has('far/big.py'));
  const buffered = extractSources(tar([['a.py', 'x = 1\n'], ['lib/k.cu', 'k']]), 's');
  assert.deepEqual([...buffered.files.keys()].sort(), ['a.py', 'lib/k.cu']);
});

test('hunk headers name the enclosing Go, C++ and Python definitions', () => {
  assert.equal(enclosingDefinition('@@ -10,3 +10,4 @@ func (p *Plugin) Allocate(ctx context.Context) error {'), 'Allocate');
  assert.equal(enclosingDefinition('@@ -1 +1 @@ static void launch_kernel(const float* x, int n)'), 'launch_kernel');
  assert.equal(enclosingDefinition('@@ -1 +1 @@ class MoERunner(Base):'), 'MoERunner');
  assert.equal(enclosingDefinition('@@ -1 +1 @@'), null);
});

test('C++ includes and Go calls become repository context signals', async () => {
  const files = [
    { filename: 'csrc/ops/attn.cu', status: 'modified', patch: patch(['#include "common/dispatch.h"', 'launch(MAX_BLOCK_SIZE);']) },
    { filename: 'pkg/server/alloc.go', status: 'modified', patch: patch(['ids := device.ListVisibleDevices()']) },
  ];
  const { includes, signals } = extractRepositoryContextSignals(files);
  assert.deepEqual(includes.map(item => item.include), ['common/dispatch.h']);
  assert.ok(signals.some(s => s.name === 'ListVisibleDevices'));
  assert.ok(signals.some(s => s.name === 'MAX_BLOCK_SIZE' && s.kind === 'config'));
  const snapshot = { files: new Map([
    ['csrc/common/dispatch.h', '#define MAX_BLOCK_SIZE 1024\n'],
    ['pkg/device/list.go', 'package device\n\nfunc ListVisibleDevices() []int {\n\treturn nil\n}\n'],
  ]) };
  const entries = await buildPrRepositoryContext({ octokit: {}, owner: 'o', repo: 'r', baseSha: 'd'.repeat(40), files, snapshot, useBaseSnapshot: false });
  const names = entries.map(entry => entry.filename);
  assert.ok(names.includes('csrc/common/dispatch.h'));
  assert.ok(names.includes('pkg/device/list.go'));
  assert.match(entries.find(entry => entry.filename === 'pkg/device/list.go').excerpt, /3: func ListVisibleDevices/);
});

test('sanitizing long lines of %, . and digits stays linear', async () => {
  const { cleanText } = await import('../src/review-agent.mjs');
  const started = Date.now();
  cleanText(`${'%arg0.'.repeat(40000)}@`);
  assert.ok(Date.now() - started < 2000);
  assert.equal(cleanText('mail robert.459@gmail.com now'), 'mail [REDACTED_EMAIL] now');
});

test('submodules are fetched at their pinned commit and external imports resolve inside them', async () => {
  const { prepareRepositoryReview } = await import('../src/pr-context.mjs');
  const requests = [];
  const octokit = {
    request: async (route, args) => {
      requests.push(`${args.owner}/${args.repo}@${args.ref}`);
      if (args.repo === 'Megatron-LM') return { data: tar([['megatron/core/parallel_state.py', 'x = 1\n\ndef get_tensor_model_parallel_rank():\n    return 0\n']]) };
      return { data: tar([['.gitmodules', '[submodule "mlm"]\n\tpath = 3rdparty/Megatron-LM\n\turl = https://github.com/NVIDIA/Megatron-LM.git\n'],
        ['hcu_megatron/__init__.py', '']]) };
    },
    rest: { repos: { getContent: async ({ path }) => ({ data: { type: 'submodule', sha: 'f'.repeat(40), path } }) } },
  };
  const files = [{ filename: 'hcu_megatron/patch.py', status: 'modified',
    patch: patch(['from megatron.core.parallel_state import get_tensor_model_parallel_rank']) }];
  const { repositoryContext } = await prepareRepositoryReview({ octokit, owner: 'HYGON-AI', repo: 'Megatron-LM-das', baseSha: 'e'.repeat(40), files });
  assert.deepEqual(requests, [`HYGON-AI/Megatron-LM-das@${'e'.repeat(40)}`, `NVIDIA/Megatron-LM@${'f'.repeat(40)}`]);
  const entry = repositoryContext.find(item => item.filename === '3rdparty/Megatron-LM/megatron/core/parallel_state.py');
  assert.ok(entry);
  assert.match(entry.excerpt, /3: def get_tensor_model_parallel_rank/);
});

test('imports missing from the snapshot fall back to configured upstream sources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-'));
  fs.mkdirSync(path.join(dir, 'vllm', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vllm', '__init__.py'), '');
  fs.writeFileSync(path.join(dir, 'vllm', 'config', 'parallel.py'), 'class ParallelConfig:\n    data_parallel_size: int = 1\n');
  const files = [{ filename: 'vllm_hcu/worker.py', status: 'modified', patch: patch(['from vllm.config.parallel import ParallelConfig']) }];
  const entries = await buildPrRepositoryContext({ octokit: {}, owner: 'o', repo: 'r', baseSha: '1'.repeat(40), files,
    snapshot: { files: new Map() }, useBaseSnapshot: false, upstreamRoots: new Map([['vllm', path.join(dir, 'vllm')]]) });
  const upstream = entries.find(entry => entry.kinds.includes('upstream'));
  assert.equal(upstream.filename, 'upstream:vllm/config/parallel.py');
  assert.match(upstream.excerpt, /class ParallelConfig/);
});
