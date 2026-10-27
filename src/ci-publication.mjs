// A publication allowlist, not a keyword replacement over generated prose.
// Scan findings can contain arbitrary sensitive words, paths and encoded values.
const restricted = /quality[\s_-]*gate|质量门禁|敏感|合规|命名审查|sensitive|secret[\s_-]*(?:scan|detect)|gitleaks|trufflehog|audit[\s_-]*hygon|platform[\s_-]*audit/i;
export function isRestrictedCi(run, jobs = []) {
  return [run?.name, run?.path, ...jobs.flatMap(j => [j.name, ...(j.steps || []).map(s => s.name)])]
    .some(value => typeof value === 'string' && restricted.test(value));
}

const gateStatuses = new Set(['invalid', 'blocked', 'partial', 'passed']);
export const safeGateStatus = value => gateStatuses.has(value) ? value : 'unknown';

// The gate's machine footer, not model prose or a scanner's finding text.
// Missing, conflicting or incomplete output must never become a clean scan.
export function qualityGateLogStatus(text) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line =>
    line.replace(/^L\d+:\s*/, '').replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim());
  const statuses = new Set();
  for (let i = 1; i < lines.length; i++) {
    const match = /^RESULT=(invalid|blocked|partial|passed)$/.exec(lines[i]);
    if (match && /^SUMMARY=\S/.test(lines[i - 1])) statuses.add(match[1]);
  }
  return statuses.size === 1 ? [...statuses][0] : 'unknown';
}

export function restrictedCiMessage(status) {
  if (status === 'invalid') return { title: '质量门禁：扫描执行失败',
    body: '部分检查执行异常或报告无效，扫描未完成；不能据此认定代码存在缺陷或敏感信息泄露。请维护者查看原始运行报告，排除执行异常后重新验证。已完成检查如有阻断项仍需处理。' };
  if (status === 'blocked') return { title: '质量门禁：存在阻断项',
    body: '有效检查报告标记了阻断项，请由有权限的维护者查看原始报告并核验处理；这不是 AI 对具体代码缺陷的独立确认。' };
  if (status === 'partial') return { title: '质量门禁：扫描未完成',
    body: '仅完成部分检查，尚不能判断整体是否通过；请维护者查看原始报告并完成剩余检查。' };
  return { title: '质量门禁：未通过，原因待核实',
    body: '尚无可确认的有效扫描结论，可能是检查执行异常或规则阻断，不能据此认定代码存在缺陷。请维护者查看原始运行报告。' };
}

const categories = new Set(['代码', '依赖', '环境', '基础设施', '无法确定']);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function renderRestrictedCi({ run, failed, result }) {
  // Never copy arbitrary names, URLs, paths, SHAs, model prose or quoted evidence.
  // Only a validated GitHub Actions run URL is retained, without query/hash.
  let link = '请在仓库 Actions 页面查看对应工作流。';
  try {
    const url = new URL(run.html_url);
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
        /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(url.pathname) &&
        url.pathname.endsWith(`/actions/runs/${integer(run.id)}`)) {
      link = `[查看质量门禁运行](https://github.com${url.pathname})`;
    }
  } catch { /* Never echo malformed provider URLs. */ }
  const rows = failed.map((job, index) => {
    const item = result.publicJobs?.find(j => j.id === job.id);
    const labels = [...new Set((item?.categories || []).filter(c => categories.has(c)))];
    return `- 失败任务 ${index + 1}：${item?.complete ? '分析已完成' : '分析未完成'}；问题分类：${labels.join('、') || '无法确定'}。`;
  });
  const message = restrictedCiMessage(safeGateStatus(result.gateStatus));
  return `## AI CI 失败分析\n\n${link}\n\n${message.title}\n\n${message.body}\n\n> 失败任务 ${failed.length} 个：已完成 ${integer(result.complete)} 个，未完成 ${integer(result.pending)} 个。\n\n${rows.join('\n')}\n\n> 隐私保护：本评论不展示扫描命中原文、文件路径、日志引用、任务名称或模型生成的分析细节；折叠区也不包含这些内容。分析完成不代表门禁通过。未执行代码或重跑 CI。`;
}
