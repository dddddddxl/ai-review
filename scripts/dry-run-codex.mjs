// Current Codex supplies JSON replies through a private file bridge; no API key or GitHub writes.
// Unlike replay-sglang.mjs, this script never loads fixture.analysis or injects historical answers.
import '../test/deny-network.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReviewPipeline } from '../src/review-pipeline.mjs';
import { gitRead, sha256, sensitiveData } from '../src/review-evidence.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
  i % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[i + 1]]] : pairs, []));
for (const name of ['repo', 'skill', 'fixture', 'output']) if (!args[name]) throw new Error(`Required --${name}`);
const { snapshot, artifacts } = JSON.parse(await fs.readFile(args.fixture, 'utf8'));
if (snapshot?.pr?.number !== 436 || snapshot.pr.head_sha !== '6f0f185a691c16b0134a26f2ff172c7e2af31edb' || !snapshot.capture_consistent)
  throw new Error('Not the pinned, consistent PR #436 sample');
if (sensitiveData({ snapshot, artifacts })) throw new Error('Inputs require privacy review');
const repo = await fs.realpath(args.repo), output = path.resolve(args.output);
const inside = (root, target) => { const relative = path.relative(root, target); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
let ancestor = output;
while (true) {
  try { if (inside(repo, await fs.realpath(ancestor))) throw new Error('Output must be outside target checkout'); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
}
if (inside(repo, output)) throw new Error('Output must be outside target checkout');
const isCurrent = async () => (await gitRead(repo, ['rev-parse', 'HEAD'])).trim() === snapshot.pr.head_sha && !(await gitRead(repo, ['status', '--porcelain'])).trim();
if (!await isCurrent()) throw new Error('Target checkout must be clean and at the pinned head');
const mode = args.mode || 'tests';
if (!['tests', 'both'].includes(mode)) throw new Error('Use --mode tests or both');
const modelWindowMs = Number(args['model-window-ms'] || 180000);
if (!Number.isInteger(modelWindowMs) || modelWindowMs < 1000 || modelWindowMs > 1800000) throw new Error('Model window must be 1000..1800000 ms');
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const run = await fs.mkdtemp(path.join(output, 'codex-dry-run-'));
const bridge = path.join(run, 'bridge'); await fs.mkdir(bridge, { mode: 0o700 });
const provenance = { kind: 'codex_file_bridge_dry_run', model_api_called: false, scripted_answers: false,
  agent_context: 'current_codex_conversation_not_fresh_or_blind', mode, source_pr: snapshot.pr.url,
  source_head: snapshot.pr.head_sha, source_base: snapshot.pr.base_sha, ci_evidence: 'fixed_historical_snapshot',
  captured_at: snapshot.captured_at, input_hash: sha256({ snapshot, artifacts }),
  target_tests_executed: false, github_writes: false, model_window_ms: modelWindowMs };
await fs.writeFile(path.join(run, 'provenance.json'), JSON.stringify(provenance, null, 2), { flag: 'wx', mode: 0o600 });
let calls = 0;
const client = { model: 'current-Codex-file-bridge', format: 'text-json', async generateReview(options) {
  const id = String(++calls).padStart(3, '0');
  const request = path.join(bridge, `request-${id}.json`), reply = path.join(bridge, `reply-${id}.json`);
  await fs.writeFile(request, JSON.stringify({ instructions: options.instructions, input: options.input,
    maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutMs }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'awaiting_codex_reply', request, reply }));
  const deadline = Date.now() + Math.min(options.timeoutMs || modelWindowMs, modelWindowMs);
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(reply, 'utf8');
      if (text.length > 160000) throw new Error('Reply too large');
      const decision = JSON.parse(text);
      if (sensitiveData(decision)) throw new Error('Reply requires privacy review');
      return text;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('evidence_time_budget');
} };
const result = await runReviewPipeline({ client, repository: 'HYGON-AI/sglang-das', pullNumber: 436,
  title: snapshot.pr.title, baseSha: snapshot.pr.base_sha, headSha: snapshot.pr.head_sha,
  files: snapshot.files, totalFiles: snapshot.files.length, isCurrent, log() {} },
{ config: { enabled: mode === 'both', testEnabled: true,
  checkouts: { 'HYGON-AI/sglang-das': repo }, skillRepo: path.resolve(args.skill), maxTools: 24,
  modelWindowMs, python: args.python || 'python', outputRoot: path.join(run, 'skill-output') },
  testsOnly: mode === 'tests', captured: { snapshot, artifacts } });
if (sensitiveData(result)) throw new Error('Result requires privacy review');
await fs.writeFile(path.join(run, 'pipeline-result.json'), JSON.stringify({ provenance, result }, null, 2), { flag: 'wx', mode: 0o600 });
const review = result.testReview;
if (review?.status === 'validated') {
  await fs.writeFile(path.join(run, 'report.md'), '> 当前 Codex 文件桥接干跑；历史 CI 快照；不是独立盲测或模型 API 验收；未运行目标测试。\n\n' + review.report, { flag: 'wx', mode: 0o600 });
  for (const [name, data] of Object.entries({ 'review.json': review.review, 'test-backlog.json': review.backlog }))
    await fs.writeFile(path.join(run, name), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 });
}
console.log(JSON.stringify({ status: review?.status, diagnostic: review?.diagnostic, model_turns: calls,
  tool_calls: result.evidence.length, handoff: review?.handoff, run }));
if (review?.status !== 'validated') process.exitCode = 1;
