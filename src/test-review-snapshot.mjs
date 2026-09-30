import { sensitiveText } from './review-evidence.mjs';

// The collector never runs test discovery; all data comes from read-only APIs.
export async function collectTestSnapshot({ octokit, owner, repo, pullNumber, files, maxPages = 2, maxRuns = 8, maxLogs = 4, extraRun = null }) {
  const prefix = `/repos/${owner}/${repo}`;
  const { data: pr } = await octokit.request(`GET ${prefix}/pulls/${pullNumber}`);
  const snapshot = { snapshot_version: 1, repository: `https://github.com/${owner}/${repo}`, captured_at: new Date().toISOString(),
    pr: { number: pullNumber, url: pr.html_url, title: pr.title, state: pr.state, base_branch: pr.base.ref, base_sha: pr.base.sha,
      head_sha: pr.head.sha, merge_sha: pr.merge_commit_sha, head_repository: pr.head.repo?.full_name },
    files, files_complete: files.length === pr.changed_files, checks: [], statuses: [], runs: [], endpoints: {},
    limitations: ['元数据不能证明具体场景、checkout 或安装产物身份。', '未执行测试；外部调度、不可见配置与动态选择可能无法核验。'] };
  async function get(label, route, key, paged = true) {
    const values = []; let more = false;
    try {
      for (let page = 1; page <= (paged ? maxPages : 1); page++) {
        const { data, headers = {} } = await octokit.request(`GET ${prefix}${route}`, paged ? { per_page: 100, page } : {});
        if (!paged) { snapshot.endpoints[label] = { status: 'available', truncated: false }; return data; }
        const batch = key ? data[key] : data;
        if (!Array.isArray(batch)) throw new Error('invalid_list');
        values.push(...batch); more = /rel="next"/.test(headers.link || '');
        if (!more) break;
      }
      snapshot.endpoints[label] = { status: 'available', truncated: more };
    } catch { snapshot.endpoints[label] = { status: 'unavailable', truncated: true }; }
    return paged ? values : null;
  }
  snapshot.endpoints.files = { status: 'available', truncated: !snapshot.files_complete };
  snapshot.checks = await get('head_checks', `/commits/${pr.head.sha}/check-runs?filter=all`, 'check_runs');
  snapshot.statuses = await get('head_statuses', `/commits/${pr.head.sha}/statuses`);
  const runs = new Map();
  for (const [relation, sha] of [['pr_head', pr.head.sha], ['merge_candidate', pr.merge_commit_sha]]) {
    if (!sha) continue;
    for (const r of await get(relation + '_runs', `/actions/runs?head_sha=${sha}`, 'workflow_runs')) runs.set(r.id, { ...r, relation });
  }
  // Check URLs can expose pull_request_target / dispatch runs absent from head queries.
  const candidates = new Set(snapshot.checks.map(c => c.details_url || c.html_url).flatMap(url => {
    const match = typeof url === 'string' && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(url);
    return match && match[1].toLowerCase() === `${owner}/${repo}`.toLowerCase() ? [Number(match[2])] : [];
  }));
  if (extraRun && (extraRun.pull_requests || []).some(p => p.number === pullNumber)) candidates.add(extraRun.id);
  for (const id of [...candidates].slice(0, maxRuns)) if (!runs.has(id)) {
    const r = await get(`linked_run:${id}`, `/actions/runs/${id}`, null, false);
    if (r) runs.set(id, { ...r, relation: r.head_sha === pr.head.sha ? 'pr_head' : r.head_sha === pr.merge_commit_sha ? 'merge_candidate' : 'external_candidate' });
  }
  snapshot.run_details_truncated = runs.size > maxRuns || candidates.size > maxRuns;
  const artifacts = {}; let logCount = 0;
  for (const run of [...runs.values()].slice(0, maxRuns)) {
    const row = Object.fromEntries(['id', 'name', 'event', 'head_sha', 'head_branch', 'path', 'status', 'conclusion', 'run_attempt', 'html_url', 'created_at', 'relation'].map(k => [k, run[k]]));
    row.jobs = await get(`jobs:${run.id}:${run.run_attempt}`, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    for (const job of row.jobs) if (job.status === 'completed' && logCount < maxLogs) {
      logCount++;
      try {
        const { data } = await octokit.request(`GET ${prefix}/actions/jobs/${job.id}/logs`);
        const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
        const file = `artifacts/run-${run.id}-attempt-${run.run_attempt}-job-${job.id}.txt`;
        if (!raw || sensitiveText(raw)) throw new Error('log_unavailable_or_sensitive');
        artifacts[file] = `来源：${prefix}/actions/jobs/${job.id}/logs\nrun=${run.id}; attempt=${run.run_attempt}; job=${job.id}; head_sha=${run.head_sha}\n截断：${raw.length > 64000}\n${raw.slice(0, 64000)}`;
        snapshot.endpoints[`log:${job.id}`] = { status: 'available', truncated: raw.length > 64000, artifact: file };
      } catch { snapshot.endpoints[`log:${job.id}`] = { status: 'unavailable', truncated: true }; }
    }
    snapshot.runs.push(row);
  }
  // Keep budgeted-out identities visible rather than selecting only successful runs.
  for (const run of [...runs.values()].slice(maxRuns)) snapshot.runs.push({ id: run.id, name: run.name, head_sha: run.head_sha,
    status: run.status, conclusion: run.conclusion, run_attempt: run.run_attempt, relation: run.relation, event: run.event, html_url: run.html_url, jobs: [], detail_status: 'deferred_budget' });
  snapshot.branch_rules = await get('branch_rules', `/rules/branches/${encodeURIComponent(pr.base.ref)}`);
  snapshot.required_status_checks = await get('legacy_protection', `/branches/${encodeURIComponent(pr.base.ref)}/protection/required_status_checks`, null, false);
  const end = await get('pr_recheck', `/pulls/${pullNumber}`, null, false);
  snapshot.capture_consistent = Boolean(end && end.head.sha === pr.head.sha && end.base.sha === pr.base.sha && end.merge_commit_sha === pr.merge_commit_sha);
  return { snapshot, artifacts };
}

export function refreshCandidates(run) {
  if (run.status !== 'completed') return [];
  return [...new Set((run.pull_requests || []).map(p => p.number).filter(Number.isSafeInteger))];
}
