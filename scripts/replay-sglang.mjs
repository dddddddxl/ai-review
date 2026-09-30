// Offline replay: scripted model answers, real Git evidence and real skill validators.
import '../test/deny-network.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReviewPipeline } from '../src/review-pipeline.mjs';
import { sha256, sensitiveData } from '../src/review-evidence.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[i + 1]]] : pairs, []));
for (const name of ['repo', 'skill', 'output']) if (!args[name]) throw new Error(`Required --${name}`);
let snapshot, analysis, artifacts;
if (args.fixture) ({ snapshot, analysis, artifacts } = JSON.parse(await fs.readFile(args.fixture, 'utf8')));
else {
  if (!args.snapshot || !args.analysis) throw new Error('Supply --fixture, or --snapshot and --analysis');
  snapshot = JSON.parse(await fs.readFile(args.snapshot, 'utf8'));
  analysis = JSON.parse(await fs.readFile(args.analysis, 'utf8')); artifacts = {};
  for (const e of analysis.evidence.filter(e => e.kind === 'artifact')) {
    const content = await fs.readFile(path.resolve(path.dirname(args.analysis), e.path), 'utf8');
    e.path = 'artifacts/' + path.basename(e.path); artifacts[e.path] = content;
  }
}
if (snapshot.pr.head_sha !== '6f0f185a691c16b0134a26f2ff172c7e2af31edb' || snapshot.pr.number !== 436) throw new Error('Not the pinned PR #436 sample');
if (sensitiveData({ snapshot, analysis, artifacts })) throw new Error('Fixture requires privacy review');
const output = path.resolve(args.output); await fs.mkdir(output, { recursive: true });
let testRound = 0;
const requests = analysis.evidence.map(e => e.kind === 'source'
  ? { tool: 'read_file', revision: e.revision, path: e.path, start: e.start, end: e.end }
  : { tool: 'read_artifact', path: e.path });
const client = { model: 'scripted-historical-replay-NOT-a-real-model', format: 'openai-chat', async generateReview(options) {
  if (options.instructions.includes('返回 analysis.json 对象')) {
    const batch = requests.slice(testRound * 8, (testRound + 1) * 8); testRound++;
    if (batch.length) return JSON.stringify({ action: 'tools', requests: batch });
    return JSON.stringify({ action: 'final', result: analysis });
  }
  // Empty findings here test plumbing ONLY; they are not a real defect review.
  return JSON.stringify({ action: 'final', result: { overview: ['离线脚本响应，不代表模型完成了缺陷审查。'], findings: [] } });
} };
const result = await runReviewPipeline({ client, repository: 'HYGON-AI/sglang-das', pullNumber: 436, title: snapshot.pr.title,
  baseSha: snapshot.pr.base_sha, headSha: snapshot.pr.head_sha, files: snapshot.files, totalFiles: snapshot.files.length,
  isCurrent: async () => true, log() {} }, { config: { enabled: true, testEnabled: true,
  checkouts: { 'HYGON-AI/sglang-das': path.resolve(args.repo) }, skillRepo: path.resolve(args.skill), maxTools: 24,
  python: args.python || 'python', outputRoot: path.join(output, 'private-run') }, captured: { snapshot, artifacts } });
if (result.testReview?.status !== 'validated') {
  console.error(JSON.stringify({ status: result.testReview?.status, evidence: result.evidence?.map(e => ({ id: e.id, status: e.status, path: e.path, truncated: e.truncated })), manifest: result.manifest?.limitations }));
  throw new Error('Replay did not validate');
}
const provenance = { kind: 'offline_historical_replay', real_model: false, tests_executed: false, network: false,
  source_pr: snapshot.pr.url, source_head: snapshot.pr.head_sha, captured_at: snapshot.captured_at,
  skill_hash: result.testReview.skill_hash, input_hash: sha256({ snapshot, analysis, artifacts }) };
const files = { 'fixture.json': { provenance, snapshot, analysis, artifacts }, 'manifest.json': { ...result.manifest, replay: provenance },
  'review.json': { ...result.testReview.review, replay: provenance }, 'test-backlog.json': result.testReview.backlog,
  'evidence-index.json': { provenance, records: result.evidence.map(({ content, ...entry }) => entry) } };
for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
const caveat = '> 离线历史回放：真实固定版本源码及历史 CI 证据；模型输出由历史分析脚本注入。验证编排、证据约束和交接，不是新一轮模型推理，不表示新增 HCU 测例执行通过。\n\n';
await fs.writeFile(path.join(output, 'report.md'), caveat + result.testReview.report);
const plan = await fs.readFile(path.join(result.testReview.directory, 'generation-plan.json'), 'utf8');
await fs.writeFile(path.join(output, 'generation-plan.json'), plan);
console.log(JSON.stringify({ status: 'offline_replay_validated', head: snapshot.pr.head_sha, verdict: result.testReview.review.verdict,
  behaviors: result.testReview.review.behaviors.length, tasks: result.testReview.backlog.tasks.length,
  tool_calls: result.evidence.length, handoff: result.testReview.handoff, output }, null, 2));
