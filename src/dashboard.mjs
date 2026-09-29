import fs from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

const assetFiles = new Map([
  ['/', ['../public/next/index.html', 'text/html; charset=utf-8']],
  ['/next/', ['../public/next/index.html', 'text/html; charset=utf-8']],
  ['/legacy/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/next/base.css', ['../public/next/base.css', 'text/css; charset=utf-8']],
  ['/next/dashboard.css', ['../public/next/dashboard.css', 'text/css; charset=utf-8']],
  ['/next/dashboard.js', ['../public/next/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.css', ['../public/dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['../public/dashboard.js', 'text/javascript; charset=utf-8']],
]);

const statusLabels = {
  queued: '等待中',
  running: '审查中',
  paused: '需处理',
  done: '已完成',
  skipped: '已跳过',
  stale: '已过期',
};

const reasonLabels = {
  worker_error: '任务执行异常',
  model_not_configured: '模型尚未配置',
  upstream_sync_pr: '上游同步任务',
  repository_not_allowed: '仓库未启用',
  run_attempt_changed_or_unfinished: '工作流状态已变化',
  run_not_eligible: '工作流无需分析',
  cancelled_without_failed_jobs: '未发现失败任务',
  insufficient_run_identity: '无法关联到 PR',
  ambiguous_pr_match: '匹配到多个 PR',
  no_exact_pr_match: '未匹配到当前 PR',
  already_active: '任务已在执行',
  stale_or_ineligible_pr: 'PR 已更新或不再适用',
};

const terminalStatuses = new Set(['done', 'skipped', 'stale']);
const visibleStatuses = Object.keys(statusLabels);
const activeRankingStatuses = new Set(['queued', 'running', 'paused', 'done']);
const rankingWindowDays = 7;
const rankingWindowMs = rankingWindowDays * 24 * 60 * 60 * 1000;
const usageSeriesDays = 30;
const usageRepositoryLimit = 10;
const dayMs = 24 * 60 * 60 * 1000;
const usageFields = ['requests', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'];

function safeRepository(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : 'unknown/unknown';
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeTimestamp(value) {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}

function changedAt(row) {
  const value = Number.isFinite(row?.updatedAt) ? row.updatedAt : row?.createdAt;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function jobKind(row) {
  return row?.kind === 'ci' ? 'ci' : 'pr';
}

function jobProgress(job) {
  const summary = job?.summary && typeof job.summary === 'object' ? job.summary : {};
  const batches = safeInteger(summary.batches);
  const completed = Math.min(safeInteger(summary.completed), batches || Number.MAX_SAFE_INTEGER);
  return {
    completed,
    total: batches,
    findings: safeInteger(summary.findings),
    failures: safeInteger(summary.failures),
  };
}

function publicJob(job, now) {
  const repository = safeRepository(job.repository);
  const kind = jobKind(job);
  const status = visibleStatuses.includes(job.status) ? job.status : 'paused';
  const number = kind === 'pr' ? safeInteger(job.pullNumber) : safeInteger(job.runId);
  const href = number
    ? `https://github.com/${repository}/${kind === 'pr' ? `pull/${number}` : `actions/runs/${number}`}`
    : `https://github.com/${repository}`;
  const stamp = changedAt(job);
  return {
    repository,
    kind,
    reference: number ? (kind === 'pr' ? `PR #${number}` : `Run ${number}`) : (kind === 'pr' ? 'PR' : 'CI Run'),
    href,
    status,
    statusLabel: statusLabels[status],
    reason: reasonLabels[job.reason] || null,
    createdAt: safeTimestamp(job.createdAt),
    updatedAt: safeTimestamp(stamp),
    ageSeconds: stamp ? Math.max(0, Math.round((now - stamp) / 1000)) : null,
    progress: jobProgress(job),
  };
}

function rankingRows(rows, now) {
  return rows.filter(row => {
    const stamp = changedAt(row);
    return stamp > 0 && now - stamp <= rankingWindowMs;
  });
}

function activeRepositoryRanking(rows, now) {
  const repositories = new Map();
  for (const row of rankingRows(rows, now)) {
    if (!activeRankingStatuses.has(row.status)) continue;
    const repository = safeRepository(row.repository);
    if (repository === 'unknown/unknown') continue;
    const current = repositories.get(repository) || { repository, tasks: 0, pr: 0, ci: 0, latestAt: 0 };
    current.tasks++;
    current[jobKind(row)]++;
    current.latestAt = Math.max(current.latestAt, changedAt(row));
    repositories.set(repository, current);
  }
  return [...repositories.values()]
    .sort((left, right) => right.tasks - left.tasks || right.latestAt - left.latestAt || left.repository.localeCompare(right.repository))
    .slice(0, 8)
    .map(item => ({
      repository: item.repository,
      href: `https://github.com/${item.repository}`,
      tasks: item.tasks,
      pr: item.pr,
      ci: item.ci,
      lastActiveAt: safeTimestamp(item.latestAt),
      ageSeconds: Math.max(0, Math.round((now - item.latestAt) / 1000)),
    }));
}

function usageValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyUsage() {
  const counters = { jobs: 0 };
  for (const field of usageFields) counters[field] = 0;
  return counters;
}

function addUsage(counters, usage) {
  counters.jobs++;
  for (const field of usageFields) {
    counters[field] = Math.min(Number.MAX_SAFE_INTEGER, counters[field] + usageValue(usage[field]));
  }
}

// Only jobs where the provider reported at least one request carry metering data.
// Everything else (skipped, stale, pre-metering runs) is excluded from token sums.
function meteredUsage(row) {
  const usage = row?.usage;
  return usage && usageValue(usage.requests) > 0 ? usage : null;
}

function windowUsage(rows, now, windowMs) {
  const counters = emptyUsage();
  for (const row of rows) {
    const usage = meteredUsage(row);
    if (!usage) continue;
    const stamp = changedAt(row);
    if (!stamp || now - stamp > windowMs) continue;
    addUsage(counters, usage);
  }
  return counters;
}

// Daily buckets are UTC calendar days, matching the timestamps stored in state
// and the container clock. Rows outside the window are dropped, not merged.
function dailyUsageSeries(rows, now) {
  const todayStart = Math.floor(now / dayMs) * dayMs;
  const buckets = new Map();
  for (let offset = usageSeriesDays - 1; offset >= 0; offset--) {
    const date = new Date(todayStart - offset * dayMs).toISOString().slice(0, 10);
    buckets.set(date, { date, ...emptyUsage(), pr: 0, ci: 0 });
  }
  for (const row of rows) {
    const usage = meteredUsage(row);
    if (!usage) continue;
    const stamp = changedAt(row);
    if (!stamp) continue;
    const bucket = buckets.get(new Date(stamp).toISOString().slice(0, 10));
    if (!bucket) continue;
    addUsage(bucket, usage);
    bucket[jobKind(row)]++;
  }
  return { days: usageSeriesDays, buckets: [...buckets.values()] };
}

// Lifetime aggregates stay independent of the ranking window so the console can
// show a running total that never drops when individual rows age out.
function usageSummary(rows, now) {
  const overall = emptyUsage();
  const byKind = new Map();
  const byRepository = new Map();
  let firstAt = 0;
  let lastAt = 0;
  for (const row of rows) {
    const usage = meteredUsage(row);
    if (!usage) continue;
    addUsage(overall, usage);
    const kind = jobKind(row);
    const kindCounters = byKind.get(kind) || emptyUsage();
    addUsage(kindCounters, usage);
    byKind.set(kind, kindCounters);
    const repository = safeRepository(row.repository);
    if (repository !== 'unknown/unknown') {
      const repositoryCounters = byRepository.get(repository) || emptyUsage();
      addUsage(repositoryCounters, usage);
      byRepository.set(repository, repositoryCounters);
    }
    const stamp = changedAt(row);
    if (stamp) {
      if (!firstAt || stamp < firstAt) firstAt = stamp;
      if (stamp > lastAt) lastAt = stamp;
    }
  }
  return {
    ...overall,
    tokensPerRequest: overall.requests ? Math.round(overall.totalTokens / overall.requests) : 0,
    firstAt: safeTimestamp(firstAt),
    lastAt: safeTimestamp(lastAt),
    kinds: ['pr', 'ci'].map(kind => ({ kind, ...(byKind.get(kind) || emptyUsage()) })),
    repositories: [...byRepository.entries()]
      .map(([repository, counters]) => ({ repository, href: `https://github.com/${repository}`, ...counters }))
      .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.repository.localeCompare(right.repository))
      .slice(0, usageRepositoryLimit),
    windows: {
      last24h: windowUsage(rows, now, dayMs),
      last7d: windowUsage(rows, now, rankingWindowMs),
      last30d: windowUsage(rows, now, usageSeriesDays * dayMs),
    },
    daily: dailyUsageSeries(rows, now),
  };
}

function tokenUsageRanking(rows, now) {
  const repositories = new Map();
  let trackedJobs = 0;
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  for (const row of rankingRows(rows, now)) {
    const usage = meteredUsage(row);
    if (!usage) continue;
    const repository = safeRepository(row.repository);
    if (repository === 'unknown/unknown') continue;
    trackedJobs++;
    const current = repositories.get(repository) || { repository, jobs: 0,
      requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    current.jobs++;
    for (const field of Object.keys(totals)) {
      const value = usageValue(usage[field]);
      current[field] = Math.min(Number.MAX_SAFE_INTEGER, current[field] + value);
      totals[field] = Math.min(Number.MAX_SAFE_INTEGER, totals[field] + value);
    }
    repositories.set(repository, current);
  }
  return {
    windowDays: rankingWindowDays,
    trackedJobs,
    ...totals,
    repositories: [...repositories.values()]
      .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests || left.repository.localeCompare(right.repository))
      .slice(0, 8)
      .map(item => ({ ...item, href: `https://github.com/${item.repository}` })),
  };
}

export function dashboardAuthorized(request, configuredToken) {
  if (!configuredToken) return false;
  const header = request.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(configuredToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createDashboardSnapshot({
  queue,
  activeWorkers = 0,
  queueWorkers = 0,
  modelConcurrency = 0,
  model = null,
  apiFormat = null,
  modelConfigured = false,
  now = Date.now(),
  uptimeSeconds = process.uptime(),
}) {
  const rows = (await queue.store.entries())
    .sort((left, right) => changedAt(right) - changedAt(left));
  const counts = Object.fromEntries(visibleStatuses.map(status => [status, 0]));
  for (const row of rows) counts[visibleStatuses.includes(row.status) ? row.status : 'paused']++;
  const completed24h = rows.filter(row => terminalStatuses.has(row.status) &&
    now - changedAt(row) <= dayMs).length;
  const repositories = new Set(rows.map(row => safeRepository(row.repository)).filter(value => value !== 'unknown/unknown'));
  const usage = usageSummary(rows, now);

  return {
    generatedAt: new Date(now).toISOString(),
    service: {
      status: modelConfigured ? 'healthy' : 'attention',
      statusLabel: modelConfigured ? '服务正常' : '模型未配置',
      uptimeSeconds: Math.max(0, Math.round(uptimeSeconds)),
      automaticPrReview: true,
      ciFailureReview: true,
    },
    totals: {
      pending: counts.queued,
      running: counts.running,
      attention: counts.paused,
      completed24h,
      repositories: repositories.size,
      all: rows.length,
    },
    runtime: {
      activeWorkers: safeInteger(activeWorkers),
      queueWorkers: safeInteger(queueWorkers),
      modelConcurrency: safeInteger(modelConcurrency),
      model: typeof model === 'string' && model ? model.slice(0, 100) : null,
      apiFormat: typeof apiFormat === 'string' && apiFormat ? apiFormat.slice(0, 60) : null,
      modelConfigured: Boolean(modelConfigured),
    },
    usage: {
      windowDays: usageSeriesDays,
      ...usage,
    },
    rankings: {
      windowDays: rankingWindowDays,
      activeRepositories: activeRepositoryRanking(rows, now),
      tokenUsage: tokenUsageRanking(rows, now),
    },
    counts,
    jobs: rows.slice(0, 50).map(job => publicJob(job, now)),
  };
}

export async function loadDashboardAssets() {
  const assets = new Map();
  for (const [pathname, [relativePath, contentType]] of assetFiles) {
    assets.set(pathname, {
      body: await fs.readFile(new URL(relativePath, import.meta.url)),
      contentType,
    });
  }
  return assets;
}

export function dashboardHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}
