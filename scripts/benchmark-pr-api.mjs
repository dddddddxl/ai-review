// Explicit live-model entry. Never import dry-run-pr-lib: its network denial
// must remain intact. This runner has no GitHub client or publication path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';
import { createModelClient, chatCompletionsUrl, anthropicMessagesUrl } from '../src/model-client.mjs';
import { runReviewPipeline } from '../src/review-pipeline.mjs';
import { loadTestSkill } from '../src/test-review-skill.mjs';
import { PR_VERIFICATION_INSTRUCTIONS } from '../src/review-templates.mjs';
import { gitRead, sha256 } from '../src/review-evidence.mjs';
import { reviewOptions } from '../src/review-control.mjs';
import { parseArgs, readBundle, frozenCheckout, privateRun, writePrivate, inputIdentity } from './pr-cli-common.mjs';

const round = n => Math.round(n * 1000) / 1000;
const stageFor = instructions => instructions.includes('【关联组共同审查】') ? 'joint_review' : instructions.startsWith('按功能关联') ? 'grouping'
  : instructions.startsWith(PR_VERIFICATION_INSTRUCTIONS) ? 'code_verification'
  : instructions.includes('执行以下固定版本 skill 的 PR CI Review') ? 'tests' : 'code_generation';

export function summarizeMeasurements(results) {
  const seconds = results.map(r => r.elapsed_seconds);
  const completed = results.filter(r => r.status.overall === 'complete');
  const mean = list => list.length ? round(list.reduce((a, b) => a + b, 0) / list.length) : null;
  return { sample_count: results.length, completed_count: completed.length,
    code_complete_count: results.filter(r => r.status.code === 'complete').length, test_validated_count: results.filter(r => r.status.tests === 'validated').length,
    mean_first_valid_result_seconds: mean(results.map(r => r.metrics?.first_valid_result_ms).filter(n => Number.isFinite(n)).map(n => n / 1000)),
    partial_count: results.filter(r => r.status.overall === 'partial').length,
    failed_count: results.filter(r => r.status.overall === 'failed').length,
    total_pr_seconds: round(seconds.reduce((a, b) => a + b, 0)), mean_pr_seconds: mean(seconds),
    mean_complete_pr_seconds: mean(completed.map(r => r.elapsed_seconds)),
    min_pr_seconds: seconds.length ? Math.min(...seconds) : null,
    max_pr_seconds: seconds.length ? Math.max(...seconds) : null,
    model_requests: results.reduce((n, r) => n + r.calls.length, 0),
    input_tokens: results.reduce((n, r) => n + r.calls.reduce((m, c) => m + (c.metadata?.inputTokens || 0), 0), 0),
    output_tokens: results.reduce((n, r) => n + r.calls.reduce((m, c) => m + (c.metadata?.outputTokens || 0), 0), 0),
    tokens_complete: results.every(r => r.calls.every(c => Number.isInteger(c.metadata?.inputTokens) && Number.isInteger(c.metadata?.outputTokens))),
    caveat: '失败及未完成样本也计入总体平均；仅完整样本的平均另列。少量样本不估计 P95 或线上吞吐量。模型调用可并行，其耗时之和不等于 PR 墙钟时间。' };
}

export function endpointFetch(endpoint, fetchImpl = fetch) {
  const expected = new URL(endpoint).href;
  return async (url, options) => {
    if (new URL(url).href !== expected || options?.method !== 'POST') throw new Error('read_only_model_route_required');
    return fetchImpl(url, { ...options, redirect: 'error' });
  };
}

function measuredClient(env, directory, calls, notify, pr) {
  const endpoint = env.AI_API_FORMAT === 'openai-chat' ? chatCompletionsUrl(env.AI_BASE_URL) : anthropicMessagesUrl(env.AI_BASE_URL);
  const limitedFetch = endpointFetch(endpoint);
  return { model: env.AI_MODEL, format: env.AI_API_FORMAT, async generateReview(options) {
    const row = { id: calls.length + 1, stage: stageFor(options.instructions), started_at: new Date().toISOString(),
      input_characters: options.instructions.length + options.input.length,
      input_hash: sha256({ instructions: options.instructions, input: options.input }),
      max_output_tokens: options.maxOutputTokens, timeout_ms: options.timeoutMs || Number(env.AI_API_TIMEOUT_MS || 120000),
      status: 'running' };
    calls.push(row);
    const start = performance.now();
    notify({ event: 'model_start', pr, call: row.id, stage: row.stage, input_characters: row.input_characters, timeout_ms: row.timeout_ms });
    const client = createModelClient(env, { fetchImpl: async (url, init) => {
      const response = await limitedFetch(url, init);
      row.http_status = response.status;
      const data = await response.clone().json().catch(() => null);
      if (typeof data?.model === 'string' && /^[A-Za-z0-9._:/-]{1,150}$/.test(data.model)) row.returned_model = data.model;
      row.reasoning_field_present = typeof data?.choices?.[0]?.message?.reasoning_content === 'string';
      return response;
    } });
    try {
      const text = await client.generateReview({ ...options, onMetadata(metadata) { row.metadata = metadata; options.onMetadata?.(metadata); } });
      row.output_characters = text.length;
      try { const d = JSON.parse(text); row.json_valid = true; row.action = ['tools', 'final'].includes(d.action) ? d.action : 'other'; }
      catch { row.json_valid = false; }
      // Final-answer field only; no gateway headers, key, or reasoning text.
      await writePrivate(directory, `model-answer-${String(row.id).padStart(3, '0')}.json`, { stage: row.stage, final_answer: text });
      row.status = 'returned';
      return text;
    } catch (error) {
      row.status = 'failed';
      row.error = Number.isInteger(error?.status) ? `http_${error.status}`
        : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout'
        : error?.code === 'incomplete_response' ? 'incomplete_response' : 'model_or_artifact_failure';
      throw error;
    } finally {
      row.elapsed_seconds = round((performance.now() - start) / 1000);
      notify({ event: 'model_end', pr, call: row.id, stage: row.stage, status: row.status, seconds: row.elapsed_seconds,
        ...(row.error ? { error: row.error } : {}), json_valid: row.json_valid ?? null });
    }
  } };
}

export async function benchmarkPrApi(args, notify = value => console.log(JSON.stringify(value))) {
  const { strategy, deadlineMs } = reviewOptions(args);
  const env = dotenv.parse(await fs.readFile(path.resolve(args.config), 'utf8'));
  if (!['openai-chat', 'anthropic-messages'].includes(env.AI_API_FORMAT)) throw new Error('unsupported_benchmark_protocol');
  if (!createModelClient(env).configured) throw new Error('model_not_configured');
  const plan = JSON.parse(await fs.readFile(path.resolve(args.plan), 'utf8'));
  if (!Array.isArray(plan.samples) || plan.samples.length !== 5) throw new Error('five_samples_required');
  const skill = await loadTestSkill(path.resolve(plan.skill));
  const prepared = [], identities = new Set();
  // Freeze and validate all five inputs before the first paid model request.
  for (const sample of plan.samples) {
    const bundle = await readBundle(sample.fixture);
    const checkout = await frozenCheckout(sample.repo, bundle.snapshot);
    const identity = `${bundle.repository}#${bundle.pullNumber}`;
    if (identities.has(identity)) throw new Error('duplicate_sample');
    identities.add(identity); prepared.push({ bundle, checkout, category: sample.category });
  }
  const run = await privateRun(args.output, 'live-pr-benchmark-', process.cwd());
  const sourceCommit = (await gitRead(process.cwd(), ['rev-parse', 'HEAD'])).trim();
  const provenance = { kind: 'real_model_readonly_benchmark', started_at: new Date().toISOString(), model_api_called: true,
    requested_model: env.AI_MODEL, protocol: env.AI_API_FORMAT, endpoint: env.AI_BASE_URL,
    chat_json_mode: env.AI_CHAT_JSON_MODE === 'true',
    insecure_http: new URL(env.AI_BASE_URL).protocol === 'http:', ai_review_commit: sourceCommit,
    skill_commit: skill.commit, skill_hash: skill.hash, mode: 'both', pr_concurrency: 1, code_batch_concurrency: 2,
    strategy, cache: strategy === 'efficient' ? 'per_pr_cold_git_object_cache' : 'disabled_cold_review',
    ...(strategy === 'efficient' ? { deadline_ms: deadlineMs } : { model_window_ms: 180000, grouping_timeout_ms: 10000 }), max_tools: 24,
    agent_context: 'independent_stateless_api_requests_raw_evidence_only', blind: false,
    ci_evidence: 'frozen_snapshot_not_current_live_ci', target_tests_executed: false, github_writes: false,
    sample_selection: '五个已冻结真实 PR：普通逻辑、跨文件、回退开关、测试变更、大 diff；非随机线上样本。',
    timing_scope: '包含固定源码/skill/规则准备、模型往返、取证、候选复核、Python 校验；不含先前 GitHub 采集、checkout 准备、连接探测及报告落盘。',
    runner_hash: sha256(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')),
    samples: prepared.map(({ bundle: b, checkout: c, category }) => ({ pr: b.pullNumber, repository: b.repository,
      url: b.snapshot.pr.url, title: b.snapshot.pr.title, base: b.snapshot.pr.base_sha, head: b.snapshot.pr.head_sha,
      diff_base: c.diffBase, captured_at: b.snapshot.captured_at, input_hash: inputIdentity(b.snapshot, b.artifacts),
      files: b.snapshot.files.length, category })) };
  await writePrivate(run, 'provenance.json', provenance);
  notify({ event: 'benchmark_ready', run, samples: provenance.samples.map(s => s.pr), model: env.AI_MODEL, protocol: env.AI_API_FORMAT });
  const measurements = [];
  for (let i = 0; i < prepared.length; i++) {
    const { bundle: b, checkout: c } = prepared[i], pr = b.pullNumber;
    const directory = path.join(run, `pr-${pr}`); await fs.mkdir(directory, { mode: 0o700 });
    const calls = [], client = measuredClient(env, directory, calls, notify, pr);
    notify({ event: 'pr_start', pr, files: b.snapshot.files.length });
    const start = performance.now();
    let result, status, elapsed;
    try {
      result = await runReviewPipeline({ client, repository: b.repository, pullNumber: pr, title: b.snapshot.pr.title || '',
        prDescription: b.snapshot.pr.body || '', baseSha: b.snapshot.pr.base_sha, headSha: b.snapshot.pr.head_sha, files: b.snapshot.files,
        totalFiles: b.snapshot.files_total ?? b.snapshot.files.length + (b.snapshot.files_complete ? 0 : 1),
        isCurrent: c.isCurrent, log() {} },
      { config: { enabled: true, testEnabled: true, checkouts: { [b.repository]: c.repo }, skillRepo: skill.repo,
        maxTools: 24, strategy, deadlineMs, platform: 'HCU', python: args.python || 'python', outputRoot: path.join(directory, 'skill-output') }, captured: { snapshot: b.snapshot, artifacts: b.artifacts } });
      const current = await c.isCurrent();
      const evidencePartial = strategy === 'efficient' ? result.partial : Boolean(result.evidenceBudget?.exhausted) || (result.evidence || []).some(e => e.status !== 'available' || e.truncated);
      const code = !(result.codeReviewPartial ?? result.partial) && result.manifest?.complete && current && b.snapshot.files_complete ? 'complete' : 'partial';
      const tests = result.testReview?.status === 'validated' && current && b.snapshot.files_complete && !evidencePartial ? 'validated' : 'incomplete';
      status = { overall: code === 'complete' && tests === 'validated' ? 'complete' : 'partial', code, tests,
        checkout_current: current, files_complete: b.snapshot.files_complete, evidence_partial: evidencePartial,
        test_diagnostic: result.testReview?.diagnostic || null, caveat: 'validated 仅代表审查/交接校验，不代表执行了 SGLang 测例。' };
    } catch { status = { overall: 'failed', code: 'incomplete', tests: 'incomplete', reason: 'pipeline_or_dependency_failed' }; }
    elapsed = round((performance.now() - start) / 1000);
    const measurement = { ...provenance.samples[i], elapsed_seconds: elapsed, status, calls,
      model_call_seconds_sum: round(calls.reduce((n, row) => n + row.elapsed_seconds, 0)),
      code_findings: result?.findings || 0, reviewed_files: result?.reviewedFiles || 0,
      code_batches: result?.batches || 0, code_batches_completed: result?.completed || 0,
      evidence_calls: result?.evidenceBudget?.calls || 0, evidence_budget: result?.evidenceBudget || null,
      metrics: result?.metrics || null,
      code_failure_summary: result?.failureSummary || [], test_validation_status: result?.testReview?.validation_status || result?.testReview?.status || null };
    await writePrivate(directory, 'measurement.json', measurement);
    await writePrivate(directory, 'pipeline-result.json', { status, result: result || null });
    await writePrivate(directory, 'manifest.json', result?.manifest || { complete: false });
    await writePrivate(directory, 'evidence-index.json', (result?.evidence || []).map(({ content, ...e }) => e));
    const report = `# SGLang PR #${pr} 真实 API 只读审查\n\n用时：${elapsed} 秒；代码：${status.code}；测试：${status.tests}；总体：${status.overall}。\n\n> 未发布评论、未触发 CI、未执行目标测例。存在未完成项时不能声称无缺陷/无测试缺口。\n\n## 代码审查\n\n${result?.body || '未完成。'}\n\n## 测试审查\n\n${result?.testReview?.report || '未完成。'}\n`;
    await writePrivate(directory, 'report.md', report);
    if (result?.testReview?.review) await writePrivate(directory, 'review.json', result.testReview.review);
    if (result?.testReview?.backlog) await writePrivate(directory, 'test-backlog.json', result.testReview.backlog);
    measurements.push(measurement);
    notify({ event: 'pr_complete', pr, seconds: elapsed, status, model_calls: calls.length, findings: measurement.code_findings });
  }
  const summary = summarizeMeasurements(measurements);
  await writePrivate(run, 'benchmark.json', { provenance, summary, measurements });
  const rows = measurements.map(r => `| [#${r.pr}](${r.url}) | ${r.category} | ${r.files} | ${r.elapsed_seconds} | ${r.calls.length} | ${r.status.code} | ${r.status.tests} |`).join('\n');
  await writePrivate(run, 'benchmark.md', `# ai-review 真实模型 API 耗时测试\n\n模型：${env.AI_MODEL}；协议：${env.AI_API_FORMAT}；模式：both；PR 串行、代码批次最多并发 2。\n\n| PR | 类型 | 文件数 | 总耗时/秒 | API 次数 | 代码状态 | 测试状态 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n总体平均：**${summary.mean_pr_seconds} 秒/PR**；完整完成：${summary.completed_count}/5；完整样本平均：${summary.mean_complete_pr_seconds ?? '无完整样本'}。\n\n${summary.caveat}\n\n${provenance.timing_scope}\n\n采用 180 秒共享模型窗口、24 次工具预算；未手工延长窗口。冻结输入不含历史分析/标注。CI 是历史固定快照，不是当前线上状态。未执行目标测例或占卡，未部署、发布或触发 CI。本结果不是盲测质量认证。\n`);
  return { run, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await benchmarkPrApi(parseArgs(process.argv.slice(2), ['config', 'plan', 'output', 'python', 'strategy', 'deadline-ms', 'model-window-ms'])))); }
  catch { console.error(JSON.stringify({ status: 'failed', code: 'benchmark_configuration_input_or_dependency_failed' })); process.exitCode = 2; }
}
