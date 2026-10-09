import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, privateRun, writePrivate } from './pr-cli-common.mjs';

export function compareBenchmarks(before, after) {
  for (const key of ['requested_model', 'protocol', 'skill_commit']) if (before.provenance[key] !== after.provenance[key]) throw new Error('benchmark_identity_mismatch');
  if (before.measurements.length !== 5 || after.measurements.length !== 5) throw new Error('benchmark_sample_mismatch');
  const seen = new Set();
  const rows = after.measurements.map(a => {
    const b = before.measurements.find(b => b.pr === a.pr && b.repository === a.repository);
    if (!b || seen.has(a.pr) || ['head', 'base', 'input_hash', 'diff_base'].some(k => a[k] !== b[k])) throw new Error('benchmark_identity_mismatch');
    seen.add(a.pr);
    return { pr: a.pr, repository: a.repository, head: a.head, base: a.base, input_hash: a.input_hash,
      before: { seconds: b.elapsed_seconds, status: b.status, model_calls: b.calls.length, evidence_calls: b.evidence_calls },
      after: { seconds: a.elapsed_seconds, status: a.status, model_calls: a.calls.length, evidence_calls: a.evidence_calls,
        first_valid_seconds: Number.isFinite(a.metrics?.first_valid_result_ms) ? a.metrics.first_valid_result_ms / 1000 : null,
        cache: a.metrics?.cache || null } };
  });
  return { comparison_version: 1, model: after.provenance.requested_model, skill_commit: after.provenance.skill_commit,
    before_commit: before.provenance.ai_review_commit, after_commit: after.provenance.ai_review_commit,
    before: before.summary, after: after.summary, rows,
    completion_improved: after.summary.completed_count > before.summary.completed_count,
    quality_gate: 'pending_post_freeze_adjudication', acceptance: 'not_approved_by_timing_alone',
    caveats: ['legacy 是模型窗口；efficient 是准备/模型/工具/校验共享 deadline，限制更严格。',
      '输入 token 在 timeout 缺失 usage 时是下限；不能比较成完整账单。', '首个有效结果旧版未采集，不能补猜基线。',
      '不是人工认证，不估计全仓召回率或线上并发吞吐。'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2), ['before', 'after', 'output']);
    const read = name => fs.readFile(path.resolve(name), 'utf8').then(JSON.parse);
    const result = compareBenchmarks(await read(args.before), await read(args.after));
    const run = await privateRun(args.output, 'benchmark-comparison-', process.cwd());
    await writePrivate(run, 'comparison.json', result);
    const table = result.rows.map(r => `| #${r.pr} | ${r.before.seconds} | ${r.after.seconds} | ${r.before.status.overall} → ${r.after.status.overall} | ${r.after.first_valid_seconds ?? '未形成'} | ${r.before.model_calls} → ${r.after.model_calls} |`).join('\n');
    await writePrivate(run, 'comparison.md', `# 五 PR 效率复测对照\n\n| PR | 旧耗时/秒 | 新耗时/秒 | 总体状态 | 新版首个有效结果/秒 | 模型次数 |\n| --- | --- | --- | --- | --- | --- |\n${table}\n\n旧均值 ${result.before.mean_pr_seconds} 秒，新均值 ${result.after.mean_pr_seconds} 秒；完整样本 ${result.before.completed_count} → ${result.after.completed_count}；新版完整样本均值 ${result.after.mean_complete_pr_seconds ?? 'null'} 秒。\n\n尚须输出冻结后质量裁定；不能仅凭时间判定通过。\n`);
    console.log(JSON.stringify({ run, completion_improved: result.completion_improved }));
  } catch { console.error(JSON.stringify({ status: 'failed', code: 'comparison_identity_or_dependency_failed' })); process.exitCode = 2; }
}
