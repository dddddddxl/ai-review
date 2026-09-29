import { digest } from './review-state.mjs';

const MAX_FILE_ROWS = 20;
const MAX_UNPOSITIONED_FINDINGS = 5;
const priorities = ['P1', 'P2', 'P3'];

const sensitivePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:authorization|api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*(?:bearer\s+)?[^\s,;]{4,}/i,
];

const hasSensitiveContent = value => typeof value === 'string' && sensitivePatterns.some(pattern => pattern.test(value));

function safeText(value, fallback = '', limit = 600) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/\s+/g, ' ');
  const clipped = normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
  return clipped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b').replace(/[\\`*_{}\[\]()#!|]/g, '\\$&');
}

function code(value) {
  const text = String(value);
  const clipped = text.length > 240 ? `…${text.slice(-239)}` : text;
  return `<code>${clipped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
}

function findingIsSafe(finding) {
  return finding && priorities.includes(finding.priority) &&
    ['title', 'file', 'trigger', 'evidence', 'impact', 'suggestion'].every(key =>
      typeof finding[key] === 'string' && finding[key].trim() && !hasSensitiveContent(finding[key]));
}

function safeOverviewItems(value) {
  const raw = Array.isArray(value) ? value : [];
  const safe = [];
  const seen = new Set();
  let filtered = 0;
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim() || hasSensitiveContent(item)) { filtered++; continue; }
    const normalized = item.trim().replace(/\s+/g, ' ');
    const key = normalized.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push(normalized);
    if (safe.length === 4) break;
  }
  return { safe, filtered };
}

export function rightSideLines(patch = '') {
  const lines = new Set();
  let oldLine = null;
  let newLine = null;
  for (const text of String(patch).split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      continue;
    }
    if (newLine === null) continue;
    if (text.startsWith('\\ No newline at end of file')) continue;
    if (text.startsWith('+') && !text.startsWith('+++')) {
      lines.add(newLine++);
      continue;
    }
    if (text.startsWith('-') && !text.startsWith('---')) {
      oldLine++;
      continue;
    }
    // A context line exists on both sides. Unknown metadata ends the hunk.
    if (text.startsWith(' ')) {
      lines.add(newLine++);
      oldLine++;
    } else if (text !== '') {
      oldLine = null;
      newLine = null;
    }
  }
  return lines;
}

function inlineBody(finding) {
  return [
    `**${finding.priority} · ${safeText(finding.title)}**`,
    '',
    `**触发条件：** ${safeText(finding.trigger)}`,
    '',
    `**证据与影响：** ${safeText(finding.evidence)} ${safeText(finding.impact)}`,
    '',
    `**修改建议：** ${safeText(finding.suggestion)}`,
  ].join('\n');
}

function statusFor({ partial, findings }) {
  if (partial) return { icon: '⚪', label: '审查未完成', description: '部分内容未完成审查，当前结论不代表全部改动。' };
  if (findings.some(finding => finding.priority === 'P1')) return { icon: '🔴', label: '需要修改', description: '发现有明确证据的高优先级问题。' };
  if (findings.length) return { icon: '🟡', label: '建议修改', description: '发现有明确证据的问题，建议核对并处理。' };
  return { icon: '🟢', label: '未发现有明确证据的问题', description: '在已提供并完成审查的 diff 范围内未形成可确认问题。' };
}

function changeLabel(file) {
  return ({ added: '新增', removed: '删除', renamed: '重命名', copied: '复制', changed: '修改', modified: '修改' })[file.status] || '修改';
}

function severitySummary(findings) {
  const counts = priorities.map(priority => [priority, findings.filter(finding => finding.priority === priority).length]).filter(([, count]) => count);
  return counts.length ? counts.map(([priority, count]) => `${priority} × ${count}`).join(' · ') : '—';
}

function selectFileRows(files, findings) {
  const byPath = new Map(files.map(file => [file.filename, file]));
  const issuePaths = [...new Set(findings.map(finding => finding.file))];
  const importantPaths = [...files]
    .sort((a, b) => ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0)))
    .map(file => file.filename);
  const selectedPaths = [...new Set([...issuePaths, ...importantPaths])].slice(0, MAX_FILE_ROWS);
  return selectedPaths.map(path => byPath.get(path)).filter(Boolean);
}

function unpositionedSection(findings) {
  if (!findings.length) return '';
  const shown = findings.slice(0, MAX_UNPOSITIONED_FINDINGS).map(finding => [
    `#### ${finding.priority} · ${safeText(finding.title)}`,
    '',
    `- 文件：${code(finding.file)}（无法安全定位到当前 diff 行）`,
    `- 触发条件：${safeText(finding.trigger)}`,
    `- 证据与影响：${safeText(finding.evidence)} ${safeText(finding.impact)}`,
    `- 修改建议：${safeText(finding.suggestion)}`,
  ].join('\n')).join('\n\n');
  const omitted = findings.length - Math.min(findings.length, MAX_UNPOSITIONED_FINDINGS);
  return `<details>\n<summary>无法定位到 diff 行的问题（${findings.length}）</summary>\n\n${shown}${omitted ? `\n\n> 其余 ${omitted} 项未在总评中展开，避免评论过长。` : ''}\n\n</details>`;
}

export function buildPrReviewPublication({ pr, files, result, pullNumber = pr?.number }) {
  const rawFindings = Array.isArray(result.reviewFindings) ? result.reviewFindings : [];
  const safeFindings = rawFindings.filter(findingIsSafe);
  const findingSafetyFiltered = rawFindings.length - safeFindings.length;
  const { safe: changeOverview, filtered: overviewSafetyFiltered } = safeOverviewItems(result.changeOverview);
  const safetyFiltered = findingSafetyFiltered + overviewSafetyFiltered;
  const fileLines = new Map(files.map(file => [file.filename, rightSideLines(file.patch)]));
  const comments = [];
  const unpositioned = [];
  for (const finding of safeFindings) {
    if (Number.isInteger(finding.line) && fileLines.get(finding.file)?.has(finding.line)) {
      comments.push({ path: finding.file, line: finding.line, side: 'RIGHT', body: inlineBody(finding) });
    } else {
      unpositioned.push(finding);
    }
  }

  const partial = Boolean(result.partial || findingSafetyFiltered);
  const status = statusFor({ partial, findings: safeFindings });
  const additions = files.reduce((total, file) => total + (Number.isSafeInteger(file.additions) ? file.additions : 0), 0);
  const deletions = files.reduce((total, file) => total + (Number.isSafeInteger(file.deletions) ? file.deletions : 0), 0);
  const rows = selectFileRows(files, safeFindings).map(file => {
    const findings = safeFindings.filter(finding => finding.file === file.filename);
    return `| ${code(file.filename)} | ${changeLabel(file)} · +${file.additions || 0}/-${file.deletions || 0} | ${severitySummary(findings)} |`;
  });
  const remainingFiles = Math.max(0, files.length - rows.length);
  const candidateCount = Math.max(Number.isSafeInteger(result.candidateCount) ? result.candidateCount : rawFindings.length, rawFindings.length);
  const verificationFiltered = Math.max(0, Number.isSafeInteger(result.verificationFiltered)
    ? result.verificationFiltered : candidateCount - rawFindings.length);
  const coverage = `共 ${Number.isSafeInteger(result.totalFiles) ? result.totalFiles : files.length} 个文件，已完整审查 ${result.reviewedFiles || 0} 个` +
    `${result.partialFiles ? `，部分审查 ${result.partialFiles} 个` : ''}${result.pendingFiles ? `，待审查 ${result.pendingFiles} 个` : ''}。`;
  const failures = Array.isArray(result.failureSummary) && result.failureSummary.length
    ? `\n- 未完成原因：${result.failureSummary.map(item => `${safeText(item.label)}（${item.count} 批）`).join('；')}` : '';
  const overviewLines = changeOverview.length
    ? ['本次变更主要包含：', '', ...changeOverview.map(item => `- ${safeText(item, '', 240)}`)]
    : ['本次变更的语义概览暂未生成，具体修改请查看文件审查摘要。'];

  const body = [
    '## AI Review',
    '',
    `### ${status.icon} ${status.label}`,
    '',
    status.description,
    safeFindings.length ? `\n已确认 ${safeFindings.length} 个问题，其中 ${comments.length} 个已添加到对应代码行。` : '',
    '',
    '<details>',
    '<summary>变更概览</summary>',
    '',
    ...overviewLines,
    '',
    '</details>',
    '',
    '<details>',
    '<summary>文件审查摘要</summary>',
    '',
    '| 文件 | 变更 | 审查结果 |',
    '| --- | --- | --- |',
    ...rows,
    remainingFiles ? `\n> 其余 ${remainingFiles} 个文件未逐项展开。` : '',
    '',
    '</details>',
    '',
    unpositionedSection(unpositioned),
    unpositioned.length ? '' : '',
    '<details>',
    '<summary>审查信息</summary>',
    '',
    `- 变更统计：${Number.isSafeInteger(result.totalFiles) ? result.totalFiles : files.length} 个文件，+${additions}/-${deletions}。`,
    `- 覆盖情况：${coverage}`,
    `- 候选问题：${candidateCount} 项；证据复核过滤：${verificationFiltered} 项；发布前敏感信息保护：${safetyFiltered} 项。${failures}`,
    '- 本服务以 GitHub 提供的 PR diff 为审查主体，PR 描述与按相关性选取的仓库片段仅用于核验；未执行代码或重跑测试，结论仍需维护者核验。',
    '',
    '</details>',
    safeFindings.length ? '提交修复并推送新 commit 后，将自动审查 PR 的最新版本。' : '',
  ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n').trim();

  const fingerprint = digest({ headSha: pr?.head?.sha, body, comments }).slice(0, 24);
  const marker = `<!-- github-ai-review:v1:${pullNumber}:${pr?.head?.sha}:${fingerprint} -->`;
  return { body: `${marker}\n${body}`, comments, marker, fingerprint, safetyFiltered, status: status.label };
}

export async function publishPrReview({ octokit, owner, repo, pullNumber, pr, files, result, botLogin, isCurrent = async () => true }) {
  const publication = buildPrReviewPublication({ pr, files, result, pullNumber });
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner, repo, pull_number: pullNumber, per_page: 100,
  });
  const duplicate = reviews.find(review => review.user?.login === botLogin && review.body?.includes(publication.marker));
  if (duplicate) return { ...publication, created: false, duplicate: true, reviewId: duplicate.id, reviewBody: duplicate.body };
  if (!await isCurrent()) return { ...publication, created: false, stale: true };
  const { data } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: pr.head.sha,
    event: 'COMMENT',
    body: publication.body,
    comments: publication.comments,
  });
  return { ...publication, created: true, reviewId: data?.id, reviewBody: data?.body || publication.body };
}

function safeCiEvidence(evidence) {
  if (!evidence || ['job', 'cause', 'category', 'relation', 'basis', 'suggestion']
    .some(key => typeof evidence[key] !== 'string' || hasSensitiveContent(evidence[key]))) return null;
  return evidence;
}

export function safeCiBackfeedResult(result, restricted = false) {
  const pending = Number.isSafeInteger(result?.pending) && result.pending > 0 ? result.pending : 0;
  return {
    pending,
    ciEvidence: restricted ? [] : (result?.ciEvidence || []).map(safeCiEvidence).filter(Boolean).slice(0, 5),
  };
}

export function renderCiBackfeed({ run, result, restricted = false }) {
  const start = `<!-- github-ai-ci-backfeed:${run.id}:${run.run_attempt || 1}:start -->`;
  const end = `<!-- github-ai-ci-backfeed:${run.id}:${run.run_attempt || 1}:end -->`;
  if (restricted) return `${start}\n<details>\n<summary>CI 结果：质量门禁未通过</summary>\n\n质量门禁检测到需处理的问题；敏感命中原文、字段值、路径和日志引用不在评论中展示，请由有权限的维护者查看原始报告并处理。\n\n</details>\n${end}`;
  const evidence = (result.ciEvidence || []).map(safeCiEvidence).filter(Boolean).slice(0, 5);
  const rows = evidence.map(item => [
    `- **${safeText(item.job, '失败任务', 160)}**：${safeText(item.cause, '已确认失败', 360)}`,
    `  - 与本次改动的关系：${safeText(item.relation, '无法确定', 40)}；${safeText(item.basis, '需人工核验', 300)}`,
    `  - 建议：${safeText(item.suggestion, '根据失败证据处理后重新验证', 300)}`,
  ].join('\n')).join('\n');
  const workflow = hasSensitiveContent(run.name) ? 'CI 工作流' : safeText(run.name || 'CI 工作流', 'CI 工作流', 160);
  const summary = evidence.length ? rows : '当前 CI 未通过，但已处理证据尚未形成可公开核对的直接根因。';
  const progress = result.pending ? `\n\n> CI 分析尚未完成，仍有 ${result.pending} 个失败任务待处理。` : '';
  return `${start}\n<details>\n<summary>CI 失败证据：${workflow}</summary>\n\n${summary}${progress}\n\n</details>\n${end}`;
}

function mergeCiSection(body, section, run) {
  const start = `<!-- github-ai-ci-backfeed:${run.id}:${run.run_attempt || 1}:start -->`;
  const end = `<!-- github-ai-ci-backfeed:${run.id}:${run.run_attempt || 1}:end -->`;
  const at = body.indexOf(start), after = body.indexOf(end);
  let merged = at >= 0 && after >= at ? `${body.slice(0, at)}${section}${body.slice(after + end.length)}` : `${body.trim()}\n\n${section}`;
  const sections = [...merged.matchAll(/<!-- github-ai-ci-backfeed:\d+:\d+:start -->[\s\S]*?<!-- github-ai-ci-backfeed:\d+:\d+:end -->/g)];
  for (const old of sections.slice(0, Math.max(0, sections.length - 5))) merged = merged.replace(old[0], '');
  return merged.replace(/\n{3,}/g, '\n\n').trim();
}

export async function updateReviewWithCiEvidence({ octokit, owner, repo, pullNumber, headSha, botLogin, run, result,
  restricted = false, reviewId, reviewBody, isCurrent = async () => true }) {
  if (!octokit?.rest?.pulls?.listReviews || !octokit?.rest?.pulls?.updateReview) {
    return { integrated: false, reason: 'review_update_unavailable' };
  }
  let review = Number.isSafeInteger(reviewId) && typeof reviewBody === 'string'
    ? { id: reviewId, body: reviewBody, user: { login: botLogin } } : null;
  if (!review) {
    let reviews;
    try {
      reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
        owner, repo, pull_number: pullNumber, per_page: 100,
      });
    } catch {
      return { integrated: false, reason: 'review_lookup_failed' };
    }
    const prefix = `<!-- github-ai-review:v1:${pullNumber}:${headSha}:`;
    review = [...reviews].reverse().find(item => item.user?.login === botLogin && item.body?.includes(prefix));
  }
  if (!review || !Number.isSafeInteger(review.id)) return { integrated: false, reason: 'review_not_found' };
  const section = renderCiBackfeed({ run, result, restricted });
  let body = mergeCiSection(review.body, section, run);
  if (!restricted && (result.ciEvidence || []).some(item => item.relation === '相关')) {
    body = body.replace(/^### [^\n]+\n\n[^\n]+/m,
      '### 🔴 需要修改\n\n代码审查与 CI 失败证据综合后，存在需要处理的问题。');
  }
  if (body === review.body) return { integrated: true, duplicate: true, reviewId: review.id, body };
  if (Buffer.byteLength(body, 'utf8') >= 65000 || !await isCurrent()) return { integrated: false, reason: 'stale_or_too_long' };
  try {
    await octokit.rest.pulls.updateReview({ owner, repo, pull_number: pullNumber, review_id: review.id, body });
  } catch {
    return { integrated: false, reason: 'review_update_failed' };
  }
  return { integrated: true, updated: true, reviewId: review.id, body };
}

export function progressMarker(pullNumber, headSha) {
  return `<!-- github-ai-reviewer-progress:${pullNumber}:${headSha} -->`;
}

export async function upsertProgressComment({ octokit, owner, repo, pullNumber, headSha, body, botLogin }) {
  const marker = progressMarker(pullNumber, headSha);
  const renderedBody = `${marker}\n${body}`;
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: pullNumber, per_page: 100,
  });
  const previous = comments.find(comment => comment.user?.login === botLogin && comment.body?.includes(marker));
  if (previous) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body: renderedBody });
    return previous.id;
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: pullNumber, body: renderedBody });
  return data?.id;
}

export async function deleteProgressComment({ octokit, owner, repo, pullNumber, headSha, botLogin }) {
  const marker = progressMarker(pullNumber, headSha);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: pullNumber, per_page: 100,
  });
  const current = comments.filter(comment => comment.user?.login === botLogin && comment.body?.includes(marker));
  for (const comment of current) {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
  }
  return current.length;
}
