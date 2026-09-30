import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../src/review-evidence.mjs';

export async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-review-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo'); await fs.mkdir(repo);
  const git = (...args) => gitRead(repo, args);
  const write = async (name, content) => { await fs.mkdir(path.dirname(path.join(repo, name)), { recursive: true }); await fs.writeFile(path.join(repo, name), content); };
  const commit = async () => { await git('add', '.'); await git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'synthetic fixture'); };
  await git('init', '-q'); await git('config', 'core.autocrlf', 'false');
  await write('api.py', 'def f(x):\n    return x\n');
  await write('test_api.py', '# Synthetic fixture, MUST NOT import/execute\nassert f(1) == 1\n');
  await write('ci.yml', 'tests: test_api.py\n');
  await write('.ai-review/rules.json', JSON.stringify({ version: 1, rules: [{ id: 'py', path: '**/*.py', instruction: '核查边界输入。' }] }));
  await commit(); const base = (await git('rev-parse', 'HEAD')).trim();
  await write('api.py', 'def f(x):\n    return abs(x)\n'); await commit(); const head = (await git('rev-parse', 'HEAD')).trim();
  const files = [{ filename: 'api.py', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@\n def f(x):\n-    return x\n+    return abs(x)' }];
  const snapshot = { snapshot_version: 1, repository: 'https://github.com/fixture/repo', captured_at: '2026-09-30T00:00:00Z',
    capture_consistent: true, files_complete: true, files, endpoints: { files: { status: 'available', truncated: false } }, checks: [], statuses: [],
    runs: [{ id: 1, run_attempt: 2, name: 'Synthetic', event: 'pull_request', relation: 'pr_head', status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/repo/actions/runs/1', jobs: [{ id: 3, name: 'test', status: 'completed', conclusion: 'success' }] }],
    pr: { number: 1, url: 'https://github.com/fixture/repo/pull/1', title: 'Synthetic', base_branch: 'main', base_sha: base, head_sha: head, merge_sha: null } };
  const analysis = { review_version: 1, head_sha: head, platform: 'CPU', summary: '合成夹具：负数路径缺少断言。', limitations: ['合成数据，不是真实模型或硬件结果。'],
    files: [{ path: 'api.py', status: 'reviewed', reason: '读取行为变化' }],
    evidence: [['S', 'api.py'], ['T', 'test_api.py'], ['CI', 'ci.yml']].map(([id, p]) => ({ id, kind: 'source', path: p, revision: head, start: 1, end: 1, claim: '合成源码证据' })),
    behaviors: [{ id: 'B1', name: '绝对值负数路径', changed_paths: ['api.py'], before: '原值', after: '绝对值', trigger: '负数', risk: '符号错误', oracle: '固定数学结果', counterevidence: '现有断言仅正数', evidence: ['S'], lane: 'pr', platform: 'CPU', design: 'partial', selection: 'included', selection_reason: '合成选择链', selection_evidence: ['CI'], tests: [{ path: 'test_api.py', id: 'test_f', assertion: '正数结果', evidence: ['T'] }] }],
    findings: [{ id: 'F1', kind: 'coverage_gap', severity: 'P1', confidence: 'high', title: '负数断言缺失', impact: '符号回归无法识别', recommendation: '补负数断言', behavior_ids: ['B1'], evidence: ['S', 'T'] }],
    tasks: [{ id: 'G1', feature_id: 'B1', route: 'write', priority: 'P1', reason: '补负数路径', evidence: ['S'], prerequisites: ['CPU'], acceptance: ['负控失败'], cases: [{ id: 'G1-negative', name: '负数', inputs: '-1', expected: '1', oracle: '绝对值数学定义', negative_control: '返回原值时断言失败' }] }] };
  return { directory, repo, base, head, files, snapshot, analysis, write, commit, git };
}
export function finalClient(value = { overview: [], findings: [] }) {
  return { model: 'offline-fixture', format: 'openai-chat', async generateReview() { return JSON.stringify({ action: 'final', result: value }); } };
}
