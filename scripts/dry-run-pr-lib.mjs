// Importing this module also seals Node network entry points for injected clients.
import '../test/deny-network.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runReviewPipeline } from '../src/review-pipeline.mjs';
import { loadTestSkill, SKILL_COMMIT } from '../src/test-review-skill.mjs';
import { sensitiveData } from '../src/review-evidence.mjs';
import { fail, integer, readBundle, frozenCheckout, privateRun, writePrivate, inputIdentity } from './pr-cli-common.mjs';

export function fileBridge({ directory, modelWindowMs, notify = value => console.log(JSON.stringify(value)) }) {
  let calls = 0;
  return { model: 'Codex-file-bridge-not-blind', format: 'text-json', get calls() { return calls; }, async generateReview(options) {
    const id = String(++calls).padStart(3, '0');
    const request = path.join(directory, `request-${id}.json`), reply = path.join(directory, `reply-${id}.json`);
    await writePrivate(directory, `request-${id}.json`, { instructions: options.instructions, input: options.input, maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutMs });
    notify({ status: 'awaiting_codex_reply', request, reply });
    const deadline = Date.now() + Math.min(options.timeoutMs || modelWindowMs, modelWindowMs);
    while (Date.now() < deadline) {
      try {
        if ((await fs.stat(reply)).size > 160000) fail('reply_size_limit');
        const text = await fs.readFile(reply, 'utf8');
        const decision = JSON.parse(text);
        if (sensitiveData(decision)) fail('sensitive_input');
        return text;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    fail('evidence_time_budget');
  } };
}

export async function dryRunPr(args, { client, notify, legacy = false } = {}) {
  const mode = args.mode || (legacy ? 'tests' : 'both');
  if (!['code', 'tests', 'both'].includes(mode)) fail('invalid_mode');
  const { snapshot, artifacts, repository, pullNumber } = await readBundle(args.fixture);
  if (legacy && (repository !== 'HYGON-AI/sglang-das' || pullNumber !== 436 || snapshot.pr.head_sha !== '6f0f185a691c16b0134a26f2ff172c7e2af31edb' || mode === 'code')) fail('legacy_fixture_mismatch');
  const { repo, isCurrent, diffBase, historyShallow, ancestryVerified } = await frozenCheckout(args.repo, snapshot);
  const modelWindowMs = integer(args['model-window-ms'], 180000, 1000, 1800000);
  const run = await privateRun(args.output, legacy ? 'codex-dry-run-' : 'pr-dry-run-', repo);
  const bridge = path.join(run, 'bridge'); await fs.mkdir(bridge, { mode: 0o700 });
  let skill = null;
  if (mode !== 'code' && args.skill) { try { skill = await loadTestSkill(path.resolve(args.skill)); } catch { /* Explicit incomplete result below; code remains available. */ } }
  const provenance = { kind: 'codex_file_bridge_dry_run', model_api_called: false, scripted_answers: Boolean(client),
    agent_context: 'context_not_independently_verified_not_blind', blind: false, mode, source_pr: snapshot.pr.url, repository,
    source_head: snapshot.pr.head_sha, source_base: snapshot.pr.base_sha, diff_base: diffBase,
    history_shallow: historyShallow, ancestry_verified: ancestryVerified,
    ci_evidence: 'frozen_snapshot_not_current_live_ci', captured_at: snapshot.captured_at, input_hash: inputIdentity(snapshot, artifacts),
    skill_commit: skill?.commit || null, skill_hash: skill?.hash || null, required_skill_commit: mode === 'code' ? null : SKILL_COMMIT,
    skill_status: mode === 'code' ? 'not_requested' : skill ? 'available' : 'unavailable',
    target_tests_executed: false, github_writes: false, network: false, model_window_ms: modelWindowMs, max_tools: 24 };
  await writePrivate(run, 'provenance.json', provenance);
  const model = client || fileBridge({ directory: bridge, modelWindowMs, notify });
  const result = await runReviewPipeline({ client: model, repository, pullNumber, title: snapshot.pr.title || '',
    baseSha: snapshot.pr.base_sha, headSha: snapshot.pr.head_sha, files: snapshot.files,
    totalFiles: snapshot.files_total ?? snapshot.files.length + (snapshot.files_complete ? 0 : 1), isCurrent, log() {} },
  { config: { enabled: mode !== 'tests', testEnabled: mode !== 'code', checkouts: { [repository]: repo },
    ...(args['model-window-ms'] === undefined ? {} : { groupingTimeoutMs: modelWindowMs }),
    skillRepo: skill?.repo, maxTools: 24, modelWindowMs, python: args.python || 'python', outputRoot: path.join(run, 'skill-output') },
    testsOnly: mode === 'tests', captured: { snapshot, artifacts } });
  const current = await isCurrent();
  const evidencePartial = Boolean(result.evidenceBudget?.exhausted) || (result.evidence || []).some(e => e.status !== 'available' || e.truncated);
  const codeStatus = mode === 'tests' ? 'not_requested' : !(result.codeReviewPartial ?? result.partial) && result.manifest?.complete && current && snapshot.files_complete ? 'complete' : 'partial';
  const testStatus = mode === 'code' ? 'not_requested' : result.testReview?.status === 'validated' && current && snapshot.files_complete && !evidencePartial ? 'validated' : 'incomplete';
  const complete = ['complete', 'not_requested'].includes(codeStatus) && ['validated', 'not_requested'].includes(testStatus);
  const status = { overall: complete ? 'complete' : 'partial', code: codeStatus, tests: testStatus, checkout_current: current,
    files_complete: snapshot.files_complete, evidence_partial: evidencePartial,
    caveat: '只读文件桥接；不是独立盲测或真实模型 API 验收；未执行目标测试。validated 仅指测试审查与交接校验。' };
  const manifest = result.manifest || { manifest_version: 1, repository, pull_number: pullNumber, base_sha: snapshot.pr.base_sha,
    head_sha: snapshot.pr.head_sha, diff_base: diffBase, complete: false, status: 'not_requested', files: [],
    coverage: { review: 'not_requested', functionality: 'separate_test_review', code: 'not_measured' } };
  const codeReview = { status: codeStatus, findings: result.reviewFindings || [], overview: result.changeOverview || [],
    findings_count: result.findings || 0, report: mode === 'tests' ? '未请求代码缺陷审查。' : result.body || '代码缺陷审查未完成。' };
  const testReview = { ...result.testReview, status: testStatus, validation_status: result.testReview?.validation_status || result.testReview?.status || 'not_requested' };
  const report = `# PR 只读审查报告\n\n> ${status.caveat}\n\n仓库：${repository}；PR #${pullNumber}；head：${snapshot.pr.head_sha}\n\n` +
    `| 阶段 | 状态 |\n| --- | --- |\n| 代码缺陷审查 | ${codeStatus} |\n| 测试充分性审查 | ${testStatus} |\n| 总体 | ${status.overall} |\n\n` +
    (complete ? '' : '> 本轮存在未完成或截断项，不能据此声称没有缺陷、没有测试缺口或已经完成全部覆盖。\n\n') +
    `## 代码缺陷审查\n\n${codeReview.report}\n\n## 测试充分性审查\n\n${result.testReview?.report || '未请求测试充分性审查。'}\n`;
  for (const [name, value] of Object.entries({ 'status.json': status, 'manifest.json': manifest, 'code-review.json': codeReview,
    'evidence-budget.json': result.evidenceBudget,
    'test-review.json': testReview, 'evidence-index.json': { provenance, records: (result.evidence || []).map(({ content, ...entry }) => entry) },
    'pipeline-result.json': { provenance, status, result }, 'report.md': report })) await writePrivate(run, name, value);
  if (result.testReview?.review) await writePrivate(run, 'review.json', result.testReview.review);
  if (result.testReview?.backlog) await writePrivate(run, 'test-backlog.json', result.testReview.backlog);
  if (result.testReview?.directory && result.testReview.handoff === 'validated_not_executed') {
    await writePrivate(run, 'generation-plan.json', JSON.parse(await fs.readFile(path.join(result.testReview.directory, 'generation-plan.json'), 'utf8')));
  }
  return { exitCode: complete ? 0 : 1, run, result, provenance, status,
    summary: { ...status, tool_calls: result.evidence?.length || 0, model_turns: model.calls ?? null, run } };
}
