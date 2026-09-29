// A publication allowlist, not a keyword replacement over generated prose.
// Scan findings can contain arbitrary sensitive words, paths and encoded values.
const restricted = /quality[\s_-]*gate|质量门禁|敏感|合规|命名审查|sensitive|secret[\s_-]*(?:scan|detect)|gitleaks|trufflehog|audit[\s_-]*hygon|platform[\s_-]*audit/i;
export function isRestrictedCi(run, jobs = []) {
  return [run?.name, run?.path, ...jobs.flatMap(j => [j.name, ...(j.steps || []).map(s => s.name)])]
    .some(value => typeof value === 'string' && restricted.test(value));
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
  return `## AI CI 失败分析\n\n${link}\n\n质量门禁未通过。\n\n> 失败任务 ${failed.length} 个：已完成 ${integer(result.complete)} 个，未完成 ${integer(result.pending)} 个。\n\n${rows.join('\n')}\n\n### 建议处理\n\n由有权限的维护者在 CI 原始报告中定位并处理门禁发现的问题，再验证对应检查。若涉及凭据，应撤销或轮换受影响凭据，而不只是删除文本。\n\n> 隐私保护：本评论不展示扫描命中原文、文件路径、日志引用、任务名称或模型生成的分析细节；折叠区也不包含这些内容。分析完成不代表门禁通过。未执行代码或重跑 CI。`;
}
