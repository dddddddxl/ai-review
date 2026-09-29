import { PR_INSTRUCTIONS, PR_VERIFICATION_INSTRUCTIONS, decodePrReview, renderPrReview } from './review-templates.mjs';
import { digest } from './review-state.mjs';
import { reviewErrorCode, reviewFailureLabel } from './review-errors.mjs';
import { prDescriptionContext, repositoryContextForBatch } from './pr-context.mjs';

const ignored = /(?:^|\/)(?:node_modules|vendor|dist|build)\/|\.(?:png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|lock)$/i;
// Start at the gateway-accepted ceiling: reasoning and final JSON share this
// allowance. A single step avoids throwing away reasoning on smaller ceilings.
// This is per request, not a whole-review budget; timeout/split guards remain.
export const PR_GENERATION_TOKEN_STEPS = [131072];
export const PR_VERIFICATION_TOKEN_STEPS = [131072];
export const MINIMUM_BATCH_TIMEOUT_MS = 300000;

export function makeBatches(files, { batchChars = 10000 } = {}) {
  if (!Number.isInteger(batchChars) || batchChars < 1000) throw new Error('batchChars must be at least 1000');
  const batches = [], selected = [], omitted = [];
  let current = { text: '', files: [], fragments: [] };
  const flush = () => { if (current.text) batches.push(current); current = { text: '', files: [], fragments: [] }; };
  for (const file of files) {
    if (ignored.test(file.filename)) { omitted.push({ filename: file.filename, reason: 'file_type' }); continue; }
    if (!file.patch) { omitted.push({ filename: file.filename, reason: 'missing_patch' }); continue; }
    selected.push(file);
    const patch = file.patch;
    // Repeat filename and fragment metadata for every piece, including oversized files.
    const header = `FILE: ${file.filename}\nSTATUS: ${file.status}\n`;
    const size = Math.max(1, batchChars - header.length - 600);
    for (let offset = 0; offset < patch.length;) {
      let end = Math.min(offset + size, patch.length);
      if (end < patch.length) {
        // Prefer a complete hunk; oversized hunks split at a line boundary.
        const hunk = patch.lastIndexOf('\n@@ ', end - 1);
        const newline = patch.lastIndexOf('\n', end - 1);
        if (hunk > offset) end = hunk + 1;
        else if (newline > offset) end = newline + 1;
      }
      const previous = offset ? patch.slice(Math.max(0, offset - 350), offset) : '';
      const section = `${header}PATCH FRAGMENT OFFSET: ${offset} (not a source line number)\n${previous ? `PRECEDING CONTEXT (may start mid-line):\n${previous}\nEND CONTEXT\n` : ''}${patch.slice(offset, end)}\n`;
      if (current.text.length + section.length > batchChars) flush();
      current.text += section;
      current.fragments.push({ filename: file.filename, start: offset, end });
      if (!current.files.some(f => f.filename === file.filename)) current.files.push(file);
      if (end < patch.length) flush();
      offset = end;
    }
  }
  flush();
  // GitHub may itself omit or shorten patches. Compare against API change counts.
  const incompletePatches = selected.filter(file => {
    if (!Number.isInteger(file.additions) || !Number.isInteger(file.deletions)) return false;
    const lines = file.patch.split('\n');
    return lines.filter(l => l.startsWith('+')).length !== file.additions || lines.filter(l => l.startsWith('-')).length !== file.deletions;
  }).map(f => f.filename);
  return { batches, selected, omitted, incompletePatches, truncated: incompletePatches.length > 0 };
}

// Supplement candidate verification with bounded snippets from related changed files.
// This is not a claim that unchanged repository code or all cross-file interactions were reviewed.
export function relatedContext(batch, files, findings, maxChars = 12000) {
  const words = [...new Set(JSON.stringify(findings).match(/[A-Za-z_][A-Za-z_0-9]{4,}/g) || [])];
  const related = files.filter(f => f.patch && !ignored.test(f.filename) && !batch.files.some(b => b.filename === f.filename))
    .map(file => ({ file, hits: words.filter(w => file.patch.includes(w)) }))
    .filter(v => v.hits.length).sort((a, b) => b.hits.length - a.hits.length).slice(0, 3);
  return related.map(({ file, hits }) => {
    const at = file.patch.indexOf(hits[0]);
    return `FILE: ${file.filename}\nRELATED PATCH EXCERPT (not full file; may start mid-line):\n${file.patch.slice(Math.max(0, at - 1200), at + 2400)}`;
  }).join('\n\n').slice(0, maxChars);
}

// Split source ranges, not serialized prompt text. Offsets always refer to the
// original GitHub patch; carry its hunk header/context so children cannot treat
// fragment offsets as source coordinates. A single huge line is not bisected.
export function splitReviewBatch(batch, { minChars = 1500 } = {}) {
  const payload = batch.fragments.reduce((n, f) => n + f.end - f.start, 0);
  if (payload < minChars * 2) return null;
  let groups;
  if (batch.fragments.length > 1) {
    let sum = 0, at = 1;
    for (let i = 0; i < batch.fragments.length - 1; i++) {
      sum += batch.fragments[i].end - batch.fragments[i].start;
      at = i + 1;
      if (sum >= payload / 2) break;
    }
    groups = [batch.fragments.slice(0, at), batch.fragments.slice(at)];
  } else {
    const f = batch.fragments[0], patch = batch.files.find(file => file.filename === f.filename).patch;
    const middle = Math.floor((f.start + f.end) / 2);
    const positions = [...patch.slice(f.start, f.end).matchAll(/\n@@ |\n/g)].map(m => f.start + m.index + 1)
      .filter(n => n - f.start >= minChars && f.end - n >= minChars);
    if (!positions.length) return null;
    positions.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    const cut = positions[0];
    groups = [[{ ...f, end: cut }], [{ ...f, start: cut }]];
  }
  return groups.map(fragments => {
    const files = batch.files.filter(file => fragments.some(f => f.filename === file.filename));
    const text = fragments.map(f => {
      const file = files.find(file => file.filename === f.filename);
      const before = file.patch.slice(0, f.start);
      const hunk = [...before.matchAll(/^@@ .*@@.*$/gm)].at(-1)?.[0];
      return `FILE: ${f.filename}\nSTATUS: ${file.status}\nPATCH FRAGMENT OFFSET: ${f.start} (not a source line number)\n` +
        (f.start ? `PRECEDING CONTEXT (not a new hunk; offsets are not source lines):\n${hunk || ''}\n${before.slice(-350)}\nEND CONTEXT\n` : '') +
        file.patch.slice(f.start, f.end) + '\n';
    }).join('\n');
    return { files, fragments, text };
  });
}

const uniqueFindings = findings => [...new Map(findings.map(f => [`${f.file}:${f.line}:${f.title}`, f])).values()];
const uniqueOverview = overview => [...new Map(overview.filter(item => typeof item === 'string' && item.trim())
  .map(item => [item.trim().replace(/\s+/g, ' ').toLocaleLowerCase(), item.trim().replace(/\s+/g, ' ')])).values()];
const leafResults = result => result?.children ? result.children.flatMap(leafResults) : [result];

export async function reviewPrBatches({ client, files, repository, pullNumber, title, baseSha = '', headSha = '', totalFiles = files.length,
  prDescription = '', repositoryContext = [], state, batchChars = 10000, maxBatches = Infinity, maxDurationMs = Infinity,
  isCurrent = async () => true, onProgress = async () => {}, log = console.log }) {
  const plan = makeBatches(files, { batchChars });
  const started = Date.now();
  const description = prDescriptionContext(prDescription);
  // Whole snapshot identity prevents reuse after base/head/title/model/prompt changes.
  const key = digest({ version: 4, instructions: PR_INSTRUCTIONS, verificationInstructions: PR_VERIFICATION_INSTRUCTIONS,
    repository, pullNumber, title, prDescription: description,
    repositoryContext: repositoryContext.map(entry => [entry.filename, entry.kinds, entry.terms, entry.origins, entry.excerpt]), baseSha, headSha,
    model: client.model, format: client.format, batchChars, files: files.map(f => [f.filename, f.status, f.patch, f.additions, f.deletions]) });
  const saved = state ? await state.read(key) : null;
  const results = plan.batches.map((_, i) => saved?.results?.[i] || null);
  let attempted = 0, cancelled = false;
  let saveChain = Promise.resolve();
  const persist = () => {
    saveChain = saveChain.then(async () => { if (state) await state.write(key, { results, updatedAt: Date.now(), repository, pullNumber, baseSha, headSha }); });
    return saveChain;
  };
  const render = (running = false) => {
    const merged = [], seen = new Set();
    for (const result of results) for (const f of result?.findings || []) {
      const id = `${f.file}:${f.line}:${f.title}`;
      if (!seen.has(id)) { seen.add(id); merged.push(f); }
    }
    merged.sort((a, b) => a.priority.localeCompare(b.priority));
    const changeOverview = uniqueOverview(results.flatMap(result => result?.overview || [])).slice(0, 4);
    const failures = results.filter(r => r && !r.complete).length;
    const pending = results.filter(r => !r).length;
    const completed = results.filter(r => r?.complete).length;
    let reviewedFiles = 0, partialFiles = 0, pendingFiles = 0;
    for (const file of plan.selected) {
      const indices = plan.batches.flatMap((b, i) => b.files.some(f => f.filename === file.filename) ? [i] : []);
      if (indices.every(i => results[i]?.complete) && !plan.incompletePatches.includes(file.filename)) reviewedFiles++;
      else if (indices.some(i => results[i])) partialFiles++;
      else pendingFiles++;
    }
    const missingFiles = Math.max(0, totalFiles - files.length);
    const partial = failures > 0 || pending > 0 || plan.omitted.length > 0 || plan.truncated || missingFiles > 0;
    let body = renderPrReview(JSON.stringify({ findings: merged }), { files: plan.selected, includedFiles: reviewedFiles,
      truncated: plan.truncated, incompleteCoverage: partial, failedBatches: failures, batchCount: results.length });
    const leaves = results.flatMap(leafResults);
    const candidateCount = leaves.reduce((total, result) => {
      if (!result) return total;
      const confirmed = Array.isArray(result.findings) ? result.findings.length : 0;
      return total + Math.max(Number.isSafeInteger(result.candidateCount) ? result.candidateCount : confirmed, confirmed);
    }, 0);
    const errors = new Map();
    let retryableVerificationFailures = 0;
    for (const result of leaves) if (result && !result.complete && result.failure) {
      const label = `${result.failure.phase === 'verification' ? '候选复核：' : ''}${reviewFailureLabel(result.failure.code)}`;
      errors.set(label, (errors.get(label) || 0) + 1);
      if (result.failure.phase === 'verification' && result.failure.code === 'model_error' && result.pendingVerification?.findings?.length) {
        retryableVerificationFailures++;
      }
    }
    if (partial) {
      body += `\n\n> 覆盖情况：共 ${totalFiles} 个文件，已审查 ${reviewedFiles} 个${partialFiles ? `，部分审查 ${partialFiles} 个` : ''}${pendingFiles ? `，待审查 ${pendingFiles} 个` : ''}${plan.omitted.length ? `，跳过 ${plan.omitted.length} 个` : ''}${missingFiles ? `，列表未返回 ${missingFiles} 个` : ''}${plan.incompletePatches.length ? `，patch 不完整 ${plan.incompletePatches.length} 个` : ''}。`;
      if (errors.size) body += `\n\n> 失败原因：${[...errors].map(([label, n]) => `${label}（${n} 批）`).join('；')}。不代表代码没有问题。`;
      if (plan.omitted.length) body += `\n\n> 跳过原因：无 patch ${plan.omitted.filter(f => f.reason === 'missing_patch').length} 个；文件类型过滤 ${plan.omitted.filter(f => f.reason === 'file_type').length} 个。`;
      if (pending || failures) body += state
        ? `\n\n> 进度已保存。${running ? '正在继续处理。' : '可用 reviewctl resume OWNER/REPO PR编号 续审，只处理未完成部分。'}`
        : '\n\n> 本次未配置持久化存储，无法续审未完成部分。';
    }
    if (!plan.batches.length) body = `## AI Review\n\n本次没有可供文本审查的 patch，无法形成代码审查结论。\n\n${body.split('\n\n').filter(s => s.startsWith('>')).join('\n\n')}`;
    return { body, failures, pending, batches: results.length, completed, findings: merged.length, reviewFindings: merged, changeOverview,
      candidateCount, verificationFiltered: Math.max(0, candidateCount - merged.length), partial, reviewedFiles, partialFiles,
      pendingFiles, totalFiles, failureSummary: [...errors].map(([label, count]) => ({ label, count })),
      retryableVerificationFailures, cancelled };
  };
  async function runBatch(batch, index, previous = results[index], depth = 0, branch = '', checkpoint = async value => {
    results[index] = value; await persist(); await onProgress(render(true));
  }) {
    if (previous?.complete) return previous;
    if (!await isCurrent()) { cancelled = true; return previous || null; }
    // Keep bisecting timeouts/input overflows until the source fragments can no
    // longer be split safely. There is deliberately no arbitrary depth cap.
    const children = splitReviewBatch(batch);
    const split = async () => {
      const node = { overview: previous?.overview || [], findings: previous?.findings || [], candidateCount: previous?.candidateCount || previous?.findings?.length || 0, complete: false,
        children: children.map((_, i) => previous?.children?.[i] || null) };
      const update = async () => {
        node.overview = uniqueOverview([...(previous?.overview || []), ...node.children.flatMap(c => c?.overview || [])]);
        node.findings = uniqueFindings([...(previous?.findings || []), ...node.children.flatMap(c => c?.findings || [])]);
        node.candidateCount = node.children.reduce((total, child) => total + Math.max(child?.candidateCount || 0, child?.findings?.length || 0), 0);
        node.complete = node.children.every(c => c?.complete);
        await checkpoint(node);
      };
      await update();
      log(`[Review split] ${repository}#${pullNumber} batch=${index + 1}${branch} depth=${depth + 1} children=${children.length}`);
      for (let i = 0; i < children.length; i++) {
        if (cancelled) break;
        await runBatch(children[i], index, node.children[i], depth + 1, `${branch}.${i + 1}`, async value => { node.children[i] = value; await update(); });
      }
      return node;
    };
    if (previous?.children && children) return split();
    const savedPending = previous?.pendingVerification;
    let best = savedPending ? { overview: savedPending.overview || [], findings: savedPending.findings || [],
      complete: Boolean(savedPending.generationComplete), usable: true, reasons: [] } : null;
    let feedback = '', failure = savedPending?.generationFailure || savedPending?.failure || { phase: 'generation', code: 'invalid_response' };
    let tokenStep = 0, correctionRetries = 0, transientRetries = 0, extendedTimeoutUsed = false, attempt = 0;
    let candidateCount = Math.max(previous?.candidateCount || 0, previous?.findings?.length || 0);
    const unchangedContext = repositoryContextForBatch(batch, repositoryContext);
    const descriptionBlock = description ? `<pr_description>\n${description}\n</pr_description>\n` : '';
    const repositoryBlock = unchangedContext ? `<unchanged_repository_context>\n${unchangedContext}\n</unchanged_repository_context>\n` : '';
    while (!savedPending) {
      if (!await isCurrent()) { cancelled = true; return previous || null; }
      attempt++;
      try {
        const text = await client.generateReview({
          instructions: PR_INSTRUCTIONS,
          input: `任务要求：\n${PR_INSTRUCTIONS}\n本批最多报告2个最明确的问题，但绝不要求必须找到问题；如果反驳后发现逻辑自洽、无实际影响或证据不足，必须把该候选从findings中删除。每个字段尽量不超过200字。仅返回JSON。片段偏移量不是源文件行号；片段缺少上下文时不猜测。PR描述和未修改文件片段只用于理解本次diff，问题位置仍必须属于本次diff。\n<review_input>\n仓库：${repository}\nPR：#${pullNumber} ${title}\n批次：${index + 1}/${plan.batches.length}${branch ? ` 子批${branch}` : ''}\n${descriptionBlock}${repositoryBlock}<diff>\n${batch.text}\n</diff>\n</review_input>\n${feedback}`,
          maxOutputTokens: PR_GENERATION_TOKEN_STEPS[tokenStep],
          timeoutMs: extendedTimeoutUsed ? MINIMUM_BATCH_TIMEOUT_MS : undefined,
          disableThinking: true,
          onMetadata: metadata => log(`[Review model] ${repository}#${pullNumber} batch=${index + 1}${branch} attempt=${attempt} ${JSON.stringify(metadata)}`),
        });
        const decoded = decodePrReview(text, batch.files);
        log(`[Review batch] ${repository}#${pullNumber} batch=${index + 1}${branch}/${plan.batches.length} attempt=${attempt} inputChars=${batch.text.length} outputChars=${text.length} findings=${decoded.findings.length} complete=${decoded.complete} reasons=${decoded.reasons.join(',') || 'none'}`);
        if (!best) best = decoded;
        else {
          const combined = new Map([...best.findings, ...decoded.findings].map(f => [`${f.file}:${f.line}:${f.title}`, f]));
          best = { ...decoded, overview: uniqueOverview([...(best.overview || []), ...(decoded.overview || [])]),
            findings: [...combined.values()], complete: best.complete || decoded.complete };
        }
        candidateCount = Math.max(candidateCount, best.findings.length);
        if (decoded.complete) break;
        failure = { phase: 'generation', code: 'invalid_response' };
        if (correctionRetries >= 1) break;
        correctionRetries++;
        tokenStep = Math.min(tokenStep + 1, PR_GENERATION_TOKEN_STEPS.length - 1);
        feedback = `上次格式错误：${decoded.reasons.join(',')}。请修正这些问题，返回完整JSON。`;
      } catch (error) {
        // Only log error categories, never raw provider bodies, credentials or PR content.
        failure = { phase: 'generation', code: reviewErrorCode(error) };
        log(`[Review batch] ${repository}#${pullNumber} batch=${index + 1}${branch} attempt=${attempt} error=${failure.code}`);
        if (children && ['timeout', 'input_too_large'].includes(failure.code)) return split();
        if (failure.code === 'timeout' && !children && !extendedTimeoutUsed) {
          extendedTimeoutUsed = true;
          feedback = '上次最小批次请求超时，请返回简短完整JSON。';
          continue;
        }
        if (failure.code === 'output_truncated' && tokenStep < PR_GENERATION_TOKEN_STEPS.length - 1) {
          tokenStep++;
          feedback = '';
          continue;
        }
        if (['authentication', 'input_too_large', 'output_truncated', 'timeout'].includes(failure.code)) break;
        if (transientRetries >= 1) break;
        transientRetries++;
        tokenStep = Math.min(tokenStep + 1, PR_GENERATION_TOKEN_STEPS.length - 1);
        feedback = '上次调用未完成，请用简短完整JSON重新返回。';
      }
    }
    let pendingToSave = null;
    if (best?.findings.length) {
      let verified = false;
      let verifyTokenStep = 0, verifyRetries = 0, verifyExtendedTimeout = false, verifyAttempt = 0;
      while (!verified) {
      if (!await isCurrent()) { cancelled = true; return previous || null; }
      verifyAttempt++;
      try {
        const verificationRepositoryContext = repositoryContextForBatch(batch, repositoryContext, {
          focusText: JSON.stringify(best.findings),
        });
        const evidenceCheck = await client.generateReview({
          instructions: PR_VERIFICATION_INSTRUCTIONS,
          input: `逐条反驳以下候选，只确认有足够代码证据的实际错误；不确定即不确认。PR描述和未修改文件只能证明本次diff的触发条件或影响，不能把其中的历史问题当作本次新增缺陷。\n<candidates>\n${JSON.stringify(best.findings)}\n</candidates>\n${descriptionBlock}<diff>\n${batch.text}\n</diff>\n<related_changed_context>\n${relatedContext(batch, files, best.findings)}\n</related_changed_context>\n<unchanged_repository_context>\n${verificationRepositoryContext}\n</unchanged_repository_context>\n只返回 {"confirmed":[通过复核的候选下标]}，不需要凑数量。`,
          maxOutputTokens: PR_VERIFICATION_TOKEN_STEPS[verifyTokenStep],
          timeoutMs: verifyExtendedTimeout ? MINIMUM_BATCH_TIMEOUT_MS : undefined,
          disableThinking: true,
          onMetadata: metadata => log(`[Review verification model] ${repository}#${pullNumber} batch=${index + 1}${branch} attempt=${verifyAttempt} ${JSON.stringify(metadata)}`),
        });
        const start = evidenceCheck.indexOf('{'), end = evidenceCheck.lastIndexOf('}');
        const { confirmed } = JSON.parse(evidenceCheck.slice(start, end + 1));
        if (!Array.isArray(confirmed) || confirmed.some(n => !Number.isInteger(n) || n < 0 || n >= best.findings.length)) throw new SyntaxError('Invalid verification result');
        const before = best.findings.length;
        best.findings = [...new Set(confirmed)].map(n => best.findings[n]);
        verified = true;
        log(`[Review verify] ${repository}#${pullNumber} batch=${index + 1}${branch} candidates=${before} confirmed=${best.findings.length}`);
      } catch (error) {
        // Previously checkpointed findings already passed verification for this
        // exact snapshot; a later outage must not erase that usable evidence.
        failure = { phase: 'verification', code: reviewErrorCode(error) };
        log(`[Review verify] ${repository}#${pullNumber} batch=${index + 1}${branch} error=${failure.code}`);
        if (children && ['timeout', 'input_too_large'].includes(failure.code)) return split();
        if (failure.code === 'timeout' && !children && !verifyExtendedTimeout) {
          verifyExtendedTimeout = true;
          continue;
        }
        if (failure.code === 'output_truncated' && verifyTokenStep < PR_VERIFICATION_TOKEN_STEPS.length - 1) {
          verifyTokenStep++;
          continue;
        }
        if (['authentication', 'input_too_large', 'output_truncated', 'timeout'].includes(failure.code) || verifyRetries >= 1) break;
        verifyRetries++;
        verifyTokenStep = Math.min(verifyTokenStep + 1, PR_VERIFICATION_TOKEN_STEPS.length - 1);
      }
      }
      if (!verified) {
        pendingToSave = { overview: best.overview || [], findings: best.findings, generationComplete: Boolean(best.complete),
          candidateCount, failure, generationFailure: best.complete ? null : { phase: 'generation', code: 'invalid_response' } };
        best = { overview: uniqueOverview([...(previous?.overview || []), ...(best?.overview || [])]),
          findings: previous?.findings || [], complete: false };
      } else {
        best.findings = uniqueFindings([...(previous?.findings || []), ...best.findings]);
        if (!best.complete) failure = savedPending?.generationFailure || { phase: 'generation', code: 'invalid_response' };
      }
    }
    const result = best || { overview: previous?.overview || [], findings: previous?.findings || [], complete: false };
    result.candidateCount = Math.max(candidateCount, result.findings.length);
    if (pendingToSave) result.pendingVerification = pendingToSave;
    else delete result.pendingVerification;
    if (!result.complete) {
      result.findings = uniqueFindings([...(previous?.findings || []), ...result.findings]);
      result.failure = failure;
    }
    await checkpoint(result);
    return result;
  }
  // Prioritize never-attempted work on continuation, then retry failures. Explicit
  // caller diagnostics may pause between root batches; production defaults are
  // unbounded. Requests already in flight retain their per-call timeout guard.
  const todo = results.flatMap((r, i) => !r ? [i] : []).concat(results.flatMap((r, i) => r && !r.complete ? [i] : []));
  if (!await isCurrent()) return { ...render(), cancelled: true };
  await persist();
  await onProgress(render(true));
  for (let cursor = 0; cursor < todo.length;) {
    if (attempted >= maxBatches || Date.now() - started >= maxDurationMs) break;
    if (!await isCurrent()) { cancelled = true; break; }
    const group = todo.slice(cursor, cursor + Math.min(2, maxBatches - attempted));
    await Promise.all(group.map(async i => { await runBatch(plan.batches[i], i); await persist(); }));
    attempted += group.length; cursor += group.length;
    await persist();
    await onProgress(render(true));
  }
  await persist();
  return render();
}
