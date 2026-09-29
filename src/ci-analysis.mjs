import { extractEvidence, planJobEvidence, redact } from './ci-evidence.mjs';
import { digest } from './review-state.mjs';
import { CI_EVIDENCE_INSTRUCTIONS, decodeCiEvidence, upstreamStatusSignals, summarizeCiWorkflow, boundedCiBody } from './ci-summary.mjs';
import { reviewErrorCode, reviewFailureLabel } from './review-errors.mjs';

export const CI_EVIDENCE_TOKEN_STEPS = [6000, 12000, 24000, 48000, 96000, 131072];
export const MINIMUM_CI_BATCH_TIMEOUT_MS = 300000;

// Protocol exceptions and invalid evidence both receive a bounded retry. Never
// parse reasoning_content or relax exact-quote/schema checks to obtain success.
export async function generateCiEvidence(client, { input, evidenceLog, isCurrent = async () => true, log = () => {}, context = {}, timeoutMs }) {
  let attempt = 0, tokenStep = 0, correctionRetries = 0, feedback = '';
  while (true) {
    if (!await isCurrent()) throw Object.assign(new Error('Snapshot changed'), {code:'snapshot_changed'});
    attempt++;
    try {
      const text = await client.generateReview({ instructions: CI_EVIDENCE_INSTRUCTIONS,
        input: `${input}\n引用要求：evidence 必须保留原始 L数字: 前缀。优先复制独立异常行，包含时间戳和原始报错，不要把多行合并为一行，也不要添加省略号。${feedback}`,
        disableThinking: true, maxOutputTokens: CI_EVIDENCE_TOKEN_STEPS[tokenStep], timeoutMs,
        onMetadata: metadata => log('[CI model] ' + JSON.stringify({ ...context, attempt,
          stopReason:['stop','length','end_turn','max_tokens','content_filter'].includes(metadata.stopReason) ? metadata.stopReason : 'other',
          outputTokens:Number.isFinite(metadata.outputTokens) ? metadata.outputTokens : undefined,
          reasoningTokens:Number.isFinite(metadata.reasoningTokens) ? metadata.reasoningTokens : undefined })) });
      try { return decodeCiEvidence(text, evidenceLog); }
      catch (error) { throw Object.assign(new Error('CI validation failed'), {code:error.message === 'unverified_direct_evidence' ? 'ci_evidence_invalid' : 'ci_schema_invalid'}); }
    } catch (error) {
      const code = reviewErrorCode(error);
      log('[CI attempt] ' + JSON.stringify({...context, attempt, code}));
      if (!await isCurrent()) throw Object.assign(new Error('Snapshot changed'), {code:'snapshot_changed'});
      if (code === 'output_truncated' && tokenStep < CI_EVIDENCE_TOKEN_STEPS.length - 1) {
        tokenStep++;
        feedback = '';
        continue;
      }
      if (['authentication','response_refused','input_too_large','snapshot_changed','timeout','output_truncated'].includes(code) || correctionRetries >= 1) throw error;
      correctionRetries++;
      tokenStep = Math.min(tokenStep + 1, CI_EVIDENCE_TOKEN_STEPS.length - 1);
      feedback = '\n上次响应未通过校验。请返回完整 JSON；证据必须从本批逐字引用，不能核对时返回 unknown 和空 evidence。';
    }
  }
}

function splitTextAtLine(text, minChars = 1200) {
  if (typeof text !== 'string' || text.length < minChars * 2) return null;
  const middle = Math.floor(text.length / 2);
  const positions = [...text.matchAll(/\n/g)].map(match => match.index + 1)
    .filter(at => at >= minChars && text.length - at >= minChars)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  if (!positions.length) return null;
  const at = positions[0];
  return [text.slice(0, at), text.slice(at)];
}

// Split the larger splittable input component. Log lines and diff lines remain
// intact so evidence can still be verified byte-for-byte against each child.
export function splitCiEvidenceUnit(unit) {
  const candidates = ['log', 'diff'].map(field => ({ field, parts: splitTextAtLine(unit[field]), size: unit[field]?.length || 0 }))
    .filter(candidate => candidate.parts).sort((a, b) => b.size - a.size);
  if (!candidates.length) return null;
  const { field, parts } = candidates[0];
  return parts.map(part => ({ ...unit, [field]: part }));
}

const ciResultComplete = result => Boolean(result && (result.kind || result.children?.every(ciResultComplete)));
const ciResultLeaves = (result, path) => result?.children
  ? result.children.flatMap((child, i) => ciResultLeaves(child, `${path}.${i + 1}`))
  : [{ result, path }];

export async function analyzeCiJobs({ modelClient, files, jobs, run, pr, repository, readLog, state,
  maxUnits = Infinity, maxDurationMs = Infinity, isCurrent = async () => true, log: diagnosticLog = console.log }) {
  const key = digest({ version: 'ci-summary-v3', instructions: CI_EVIDENCE_INSTRUCTIONS, repository, run: run.id, attempt: run.run_attempt,
    head: pr.head.sha, base: pr.base.sha, model: modelClient.model, format: modelClient.format, files,
    jobs: jobs.map(j => [j.id, j.conclusion]) });
  const saved = await state?.read(key);
  const records = saved?.records || {};
  const start = Date.now(); let used = 0, stale = false;
  const persist = async () => { await state?.write(key, { records, updatedAt: Date.now() }); };
  // Include every failed job; only explicit diagnostic bounds may pause scheduling.
  for (const job of jobs) {
    if (records[job.id]?.complete && records[job.id]?.evidenceVersion === 4) continue;
    if (used >= maxUnits || Date.now() - start >= maxDurationMs) break;
    if (!await isCurrent()) { stale = true; break; }
    let log;
    try { log = await readLog(job); if (typeof log === 'string') log = { ...extractEvidence(log), bytes: Buffer.byteLength(log), truncated: false }; }
    catch { log = { chunks: ['日志下载失败或不可用；不得推断日志内容。'], available: false, bytes: 0, lines: 0, selectedLines: 0, matches: 0 }; }
    const plan = planJobEvidence(files, log, job);
    const signature = digest(plan.units);
    const prior = records[job.id];
    const record = { ...plan, units: undefined, log: { ...log, chunks: undefined }, signature,
      upstreamSignals: upstreamStatusSignals(log.chunks.join('\n')),
      results: prior?.signature === signature ? prior.results : Array(plan.units.length).fill(null),
      failures: prior?.signature === signature ? { ...prior.failures } : {}, complete: false, evidenceVersion: 4 };
    records[job.id] = record;
    const inputFor = (unit, label) => `Workflow: ${run.name}\nJob: ${job.name}\n结论: ${job.conclusion}\nRun SHA: ${run.head_sha}\nPR SHA: ${pr.head.sha}\n片段: ${label}\n日志读取: ${JSON.stringify(record.log)}\n相关diff: ${plan.patchFiles}/${files.length} 文件，缺失patch=${plan.missingPatches}，不完整patch=${plan.incompletePatches}\n<logs>\n${redact(unit.log)}\n</logs>\n<diff>\n${redact(unit.diff)}\n</diff>`;
    const analyzeUnit = async (unit, previous, path, checkpoint) => {
      if (ciResultComplete(previous)) return previous;
      if (!await isCurrent()) { stale = true; return previous || null; }
      const children = splitCiEvidenceUnit(unit);
      const split = async () => {
        const node = { complete: false, children: children.map((_, i) => previous?.children?.[i] || null) };
        delete record.failures[path];
        const update = async () => { node.complete = node.children.every(ciResultComplete); await checkpoint(node); };
        await update();
        diagnosticLog('[CI split] ' + JSON.stringify({run:run.id,job:job.id,unit:path,children:children.length}));
        for (let i = 0; i < children.length && !stale; i++) {
          await analyzeUnit(children[i], node.children[i], `${path}.${i + 1}`, async value => { node.children[i] = value; await update(); });
        }
        return node;
      };
      if (previous?.children && children) return split();
      const invoke = timeoutMs => generateCiEvidence(modelClient, {
        evidenceLog: redact(unit.log), isCurrent, log: diagnosticLog, timeoutMs,
        context: {run:run.id,job:job.id,unit:path}, input: inputFor(unit, `${path}/${plan.units.length}`),
      });
      try {
        const value = await invoke(undefined);
        delete record.failures[path];
        if (!path.includes('.')) delete record.failures[Number(path) - 1];
        await checkpoint(value);
        return value;
      } catch (error) {
        let code = reviewErrorCode(error);
        if (error.code === 'snapshot_changed') stale = true;
        if (!stale && children && ['timeout','input_too_large'].includes(code)) return split();
        // A leaf that cannot be reduced gets one final request with the longer
        // timeout. It is still bounded and never changes whole-round budgets.
        if (!stale && !children && code === 'timeout') {
          try {
            const value = await invoke(MINIMUM_CI_BATCH_TIMEOUT_MS);
            delete record.failures[path];
            if (!path.includes('.')) delete record.failures[Number(path) - 1];
            await checkpoint(value);
            return value;
          } catch (extendedError) {
            code = reviewErrorCode(extendedError);
            if (extendedError.code === 'snapshot_changed') stale = true;
          }
        }
        record.failures[path] = code;
        await checkpoint(previous || null);
        return previous || null;
      }
    };
    for (let i = 0; i < plan.units.length; i++) {
      if (ciResultComplete(record.results[i])) continue;
      if (used >= maxUnits || Date.now() - start >= maxDurationMs) break;
      if (!await isCurrent()) { stale = true; break; }
      used++;
      await analyzeUnit(plan.units[i], record.results[i], `${i + 1}`, async value => { record.results[i] = value; await persist(); });
      await persist();
      if(stale) break;
    }
    record.complete = log.available && record.results.every(ciResultComplete);
    await persist();
    if (stale) break;
  }
  const complete = jobs.filter(j => records[j.id]?.complete).length;
  const pending = jobs.length - complete;
  const workflow = summarizeCiWorkflow(jobs, records);
  const ciEvidence = [...new Map(workflow.summaries.flatMap(({ job, summary }) => (summary?.causes || []).map(cause => ({
    job: job.name, cause: cause.cause, category: cause.category, relation: cause.relation,
    basis: cause.basis, suggestion: cause.suggestion,
  }))).map(item => [`${item.job}\n${item.cause}\n${item.relation}\n${item.basis}`, item])).values()];
  // Detailed logs, selected diff metadata, verified quotes and per-batch state
  // remain in the persisted records. The public comment contains only the
  // deduplicated workflow summary and an unfinished-analysis notice.
  const { body, displayClipped } = boundedCiBody(workflow.body, []);
  const unfinishedFailures = new Map();
  let unavailableLogs = 0;
  if (pending) {
    for (const job of jobs) {
      const record = records[job.id];
      if (record?.complete) continue;
      if (record?.log && !record.log.available) unavailableLogs++;
      for (const code of Object.values(record?.failures || {})) {
        unfinishedFailures.set(code, (unfinishedFailures.get(code) || 0) + 1);
      }
    }
  }
  const failureSummary = [...unfinishedFailures].map(([code, count]) => `${reviewFailureLabel(code)}${count > 1 ? `（${count} 处）` : ''}`).join('；');
  return { body, complete, pending, stale, displayClipped, unitsUsed: used,
    ciEvidence,
    publicJobs: jobs.map(job => ({ id: job.id, complete: Boolean(records[job.id]?.complete),
      categories: [...new Set((records[job.id]?.results || []).flatMap((r, i) => ciResultLeaves(r, `${i + 1}`)).map(leaf => leaf.result?.category).filter(Boolean))] })),
    coverage: pending ? `分析未完成：仍有 ${pending} 个失败任务未处理。${unavailableLogs ? `日志不完整或不可用（${unavailableLogs} 个任务）。` : ''}${failureSummary ? `处理未完成原因：${failureSummary}。` : ''}进度已保存，可用 reviewctl ci-review OWNER/REPO RUN_ID 续审。` : '' };
}
