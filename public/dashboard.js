const ui = {
  accessDialog: document.querySelector('#accessDialog'),
  accessForm: document.querySelector('#accessForm'),
  accessToken: document.querySelector('#accessToken'),
  accessError: document.querySelector('#accessError'),
  refreshButton: document.querySelector('#refreshButton'),
  servicePill: document.querySelector('#servicePill'),
  repositorySearch: document.querySelector('#repositorySearch'),
  queueBody: document.querySelector('#queueBody'),
  emptyState: document.querySelector('#emptyState'),
  visibleCount: document.querySelector('#visibleCount'),
  totalCount: document.querySelector('#totalCount'),
  activeRepositoryRanking: document.querySelector('#activeRepositoryRanking'),
  activeRepositoryEmpty: document.querySelector('#activeRepositoryEmpty'),
  tokenUsageRanking: document.querySelector('#tokenUsageRanking'),
  tokenUsageEmpty: document.querySelector('#tokenUsageEmpty'),
};

let snapshot = null;
let activeKind = 'all';
let accessToken = sessionStorage.getItem('ai-review-dashboard-token') || '';

function text(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return '未知';
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function formatClock(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '未知' : new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

function progressLabel(job) {
  if (!job.progress.total) return job.status === 'done' ? '已完成' : '—';
  return `${job.progress.completed} / ${job.progress.total}`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function repositoryLink(item) {
  const link = document.createElement('a');
  link.href = item.href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = item.repository;
  return link;
}

function rankingItem(item, index, detail, value) {
  const row = document.createElement('li');
  const rank = document.createElement('span');
  rank.className = 'ranking-index';
  rank.textContent = String(index + 1).padStart(2, '0');
  const identity = document.createElement('span');
  identity.className = 'ranking-identity';
  identity.append(repositoryLink(item));
  const secondary = document.createElement('small');
  secondary.textContent = detail;
  identity.append(secondary);
  const metric = document.createElement('strong');
  metric.textContent = value;
  row.append(rank, identity, metric);
  return row;
}

function renderRankings(data) {
  const active = data.rankings?.activeRepositories || [];
  ui.activeRepositoryRanking.replaceChildren(...active.map((item, index) => rankingItem(
    item, index, `PR ${item.pr} · CI ${item.ci} · ${formatAge(item.ageSeconds)}`, `${item.tasks} 个任务`)));
  ui.activeRepositoryEmpty.hidden = active.length > 0;
  text('activeRepositoryTotal', `${active.length} 个仓库`);

  const usage = data.rankings?.tokenUsage || { repositories: [] };
  const tokenRows = usage.repositories || [];
  ui.tokenUsageRanking.replaceChildren(...tokenRows.map((item, index) => rankingItem(
    item, index,
    `输入 ${formatCount(item.inputTokens)} · 输出 ${formatCount(item.outputTokens)}${item.reasoningTokens ? ` · 推理 ${formatCount(item.reasoningTokens)}` : ''}`,
    formatCount(item.totalTokens))));
  ui.tokenUsageEmpty.hidden = tokenRows.length > 0;
  text('tokenUsageTotal', tokenRows.length ? `${formatCount(usage.totalTokens)} Token` : '等待数据');
}

function renderQueue() {
  if (!snapshot) return;
  const search = ui.repositorySearch.value.trim().toLowerCase();
  const jobs = snapshot.jobs.filter(job =>
    (activeKind === 'all' || job.kind === activeKind) &&
    (!search || job.repository.toLowerCase().includes(search)));
  ui.visibleCount.textContent = jobs.length;
  ui.totalCount.textContent = snapshot.jobs.length;
  ui.emptyState.hidden = jobs.length > 0;
  ui.queueBody.replaceChildren(...jobs.map(job => {
    const row = document.createElement('tr');

    const identity = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'job-link';
    link.href = job.href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = job.repository;
    const reference = document.createElement('span');
    reference.className = 'job-reference';
    reference.textContent = job.reference;
    identity.append(link, reference);

    const kind = document.createElement('td');
    kind.className = 'type-label';
    kind.textContent = job.kind === 'pr' ? 'PR Review' : 'CI 分析';

    const status = document.createElement('td');
    const state = document.createElement('span');
    state.className = `state-label ${job.status}`;
    state.textContent = job.statusLabel;
    status.append(state);
    if (job.reason) {
      const reason = document.createElement('span');
      reason.className = 'state-reason';
      reason.textContent = job.reason;
      status.append(reason);
    }

    const progress = document.createElement('td');
    progress.className = 'progress-copy';
    progress.textContent = progressLabel(job);
    if (job.progress.findings || job.progress.failures) {
      const details = document.createElement('small');
      details.textContent = `${job.progress.findings} 个问题 · ${job.progress.failures} 个失败批次`;
      progress.append(details);
    }

    const changed = document.createElement('td');
    changed.className = 'time-cell';
    changed.textContent = formatAge(job.ageSeconds);
    row.append(identity, kind, status, progress, changed);
    return row;
  }));
}

function render(data) {
  snapshot = data;
  text('pendingMetric', data.totals.pending);
  text('runningMetric', data.totals.running);
  text('attentionMetric', data.totals.attention);
  text('completedMetric', data.totals.completed24h);
  text('repositoryMetric', `涉及 ${data.totals.repositories} 个仓库`);
  text('workerMetric', `工作线程 ${data.runtime.activeWorkers} / ${data.runtime.queueWorkers}`);
  text('lastUpdated', formatClock(data.generatedAt));
  text('modelName', data.runtime.model || '未配置');
  text('apiFormat', data.runtime.apiFormat || '未配置');
  text('queueWorkers', `${data.runtime.activeWorkers} / ${data.runtime.queueWorkers}`);
  text('modelConcurrency', data.runtime.modelConcurrency || '—');
  text('uptime', formatUptime(data.service.uptimeSeconds));
  text('prReviewState', data.service.automaticPrReview ? '已启用' : '未启用');
  text('ciReviewState', data.service.ciFailureReview ? '已启用' : '未启用');
  ui.servicePill.classList.toggle('healthy', data.service.status === 'healthy');
  ui.servicePill.lastElementChild.textContent = data.service.statusLabel;
  renderRankings(data);
  renderQueue();
}

async function refresh({ interactive = false } = {}) {
  if (!accessToken) {
    if (!ui.accessDialog.open) ui.accessDialog.showModal();
    return;
  }
  ui.refreshButton.disabled = true;
  if (interactive) ui.refreshButton.textContent = '刷新中…';
  try {
    const response = await fetch('/api/dashboard', {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (response.status === 401) {
      sessionStorage.removeItem('ai-review-dashboard-token');
      accessToken = '';
      ui.accessError.textContent = '访问令牌无效，请重新输入。';
      if (!ui.accessDialog.open) ui.accessDialog.showModal();
      return;
    }
    if (response.status === 503) throw new Error('看板访问尚未在服务端启用。');
    if (!response.ok) throw new Error('暂时无法读取运行数据。');
    render(await response.json());
    ui.accessError.textContent = '';
    if (ui.accessDialog.open) ui.accessDialog.close();
  } catch (error) {
    ui.servicePill.classList.remove('healthy');
    ui.servicePill.lastElementChild.textContent = error.message || '连接失败';
  } finally {
    ui.refreshButton.disabled = false;
    ui.refreshButton.textContent = '立即刷新';
  }
}

ui.accessForm.addEventListener('submit', event => {
  event.preventDefault();
  accessToken = ui.accessToken.value;
  sessionStorage.setItem('ai-review-dashboard-token', accessToken);
  refresh({ interactive: true });
});

ui.refreshButton.addEventListener('click', () => refresh({ interactive: true }));
ui.repositorySearch.addEventListener('input', renderQueue);
document.querySelectorAll('#kindFilters button').forEach(button => {
  button.addEventListener('click', () => {
    activeKind = button.dataset.kind;
    document.querySelectorAll('#kindFilters button').forEach(item => item.classList.toggle('selected', item === button));
    renderQueue();
  });
});

refresh();
setInterval(refresh, 15000);
