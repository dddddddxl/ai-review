const themeToggle = document.querySelector('#themeToggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = theme === 'light' ? '深色' : '浅色';
  themeToggle.textContent = next;
  themeToggle.setAttribute('aria-label', `切换到${next}主题`);
}
let savedTheme;
try { savedTheme = localStorage.getItem('ai-review-theme'); } catch {}
applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  try { localStorage.setItem('ai-review-theme', theme); } catch {}
});

const ui = {
  servicePill: document.querySelector('#servicePill'),
  refreshButton: document.querySelector('#refreshButton'),
  repositorySearch: document.querySelector('#repositorySearch'),
  queueBody: document.querySelector('#queueBody'),
  emptyState: document.querySelector('#emptyState'),
  visibleCount: document.querySelector('#visibleCount'),
  totalCount: document.querySelector('#totalCount'),
  activeRepositoryRanking: document.querySelector('#activeRepositoryRanking'),
  activeRepositoryEmpty: document.querySelector('#activeRepositoryEmpty'),
  tokenUsageRanking: document.querySelector('#tokenUsageRanking'),
  tokenUsageEmpty: document.querySelector('#tokenUsageEmpty'),
  usageChart: document.querySelector('#usageChart'),
  usageChartEmpty: document.querySelector('#usageChartEmpty'),
  accessDialog: document.querySelector('#accessDialog'),
  accessForm: document.querySelector('#accessForm'),
  accessToken: document.querySelector('#accessToken'),
  accessError: document.querySelector('#accessError'),
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART = { height: 260, padTop: 18, padRight: 16, padBottom: 30, padLeft: 60 };
const SPARK = { width: 100, height: 30, pad: 3 };
const TIP = { width: 156, lineHeight: 15, padY: 9, padX: 11 };
const REFRESH_MS = 15000;
const kindBars = new Map();
const compactFormatters = new Map();
const fullFormatter = new Intl.NumberFormat('zh-CN');

let snapshot = null;
let activeKind = 'all';
let activeWindow = 'last7d';
let page = 1;
const pageSize = 8;
const isPreview = document.body.dataset.preview === 'true';
const previewState = isPreview ? new URLSearchParams(location.search).get('state') : null;
document.querySelector('#demoNotice').hidden = !isPreview;
let chartBars = [];
let accessToken = isPreview ? 'preview-only' : sessionStorage.getItem('ai-review-dashboard-token') || '';

function text(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function compact(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  if (!compactFormatters.has(digits)) {
    compactFormatters.set(digits, new Intl.NumberFormat('zh-CN',
      { notation: 'compact', maximumFractionDigits: digits }));
  }
  return compactFormatters.get(digits).format(value);
}

function full(value) {
  return Number.isFinite(value) ? fullFormatter.format(value) : '—';
}

function tokenAmount(value) {
  return `${compact(Number.isFinite(value) ? value : 0)} Token`;
}

function formatPercent(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
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

function element(name, className, content) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function svgNode(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function svgText(attributes, content) {
  const node = svgNode('text', attributes);
  node.textContent = content;
  return node;
}

function repositoryLink(item) {
  const link = document.createElement('a');
  link.href = item.href;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = item.repository;
  return link;
}

/* ---------- sparklines ---------- */

function sparkValues(series, field) {
  return series.map(bucket => (Number.isFinite(bucket[field]) ? bucket[field] : 0));
}

function renderSparkline(host, values, toneClass) {
  host.replaceChildren();
  if (!values.length) return;
  const max = Math.max(...values);
  const spanX = Math.max(1, values.length - 1);
  const usableH = SPARK.height - SPARK.pad * 2;
  const points = values.map((value, index) => [
    (index / spanX) * SPARK.width,
    max > 0 ? SPARK.pad + usableH - (value / max) * usableH : SPARK.pad + usableH,
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `M0,${SPARK.height} L${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L')} L${SPARK.width},${SPARK.height} Z`;
  const svg = svgNode('svg', {
    viewBox: `0 0 ${SPARK.width} ${SPARK.height}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
    'aria-hidden': 'true',
    class: `spark-svg ${toneClass}`,
  });
  svg.append(
    svgNode('path', { d: area, class: 'spark-area' }),
    svgNode('polyline', { points: line, class: 'spark-line' }),
  );
  host.append(svg);
}

/* ---------- time series chart ---------- */

function niceCeiling(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = Math.pow(10, exponent);
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

const TIP_ROWS = [
  ['合计', 'totalTokens'],
  ['输入', 'inputTokens'],
  ['输出', 'outputTokens'],
  ['推理', 'reasoningTokens'],
  ['请求', 'requests'],
  ['任务', 'jobs'],
];

// The tooltip is a cached SVG group whose text nodes are updated in place, so a
// mousemove never rebuilds DOM inside a panel that refreshes every 15 seconds.
function buildTooltip() {
  const height = TIP.padY * 2 + TIP.lineHeight * (TIP_ROWS.length + 1);
  const group = svgNode('g', { class: 'chart-tip', 'pointer-events': 'none' });
  const marker = svgNode('line', { class: 'tip-marker', x1: 0, x2: 0, y1: 0, y2: 0 });
  const date = svgText({ class: 'tip-date', x: TIP.padX, y: TIP.padY + 11 }, '');
  const values = new Map();
  group.append(
    svgNode('rect', { class: 'tip-box', width: TIP.width, height, rx: '3' }),
    marker, date,
  );
  TIP_ROWS.forEach(([label, field], index) => {
    const y = TIP.padY + TIP.lineHeight * (index + 1) + 11;
    const node = svgText({ class: 'tip-value', x: TIP.width - TIP.padX, y, 'text-anchor': 'end' }, '');
    group.append(svgText({ class: 'tip-label', x: TIP.padX, y }, label), node);
    values.set(field, node);
  });
  return { group, marker, date, values, height };
}

function renderUsageChart(daily) {
  const host = ui.usageChart;
  chartBars = [];
  host.replaceChildren();
  const buckets = daily?.buckets || [];
  const hasUsage = buckets.some(bucket => bucket.totalTokens > 0);
  // With no metered usage at all, the empty message replaces the axis grid
  // instead of stacking underneath it.
  ui.usageChartEmpty.hidden = hasUsage;
  if (!buckets.length || !hasUsage) return;

  const width = Math.max(360, Math.round(host.clientWidth || 720));
  const { height, padTop, padRight, padBottom, padLeft } = CHART;
  const plotW = Math.max(60, width - padLeft - padRight);
  const plotH = height - padTop - padBottom;
  const max = niceCeiling(Math.max(...buckets.map(bucket => bucket.totalTokens)));
  const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', class: 'chart-svg' });

  for (let step = 0; step <= 4; step++) {
    const y = padTop + (plotH / 4) * step;
    const value = max - (max / 4) * step;
    svg.append(
      svgNode('line', {
        x1: padLeft, x2: (padLeft + plotW).toFixed(2), y1: y.toFixed(2), y2: y.toFixed(2),
        class: step === 4 ? 'grid-line grid-line-base' : 'grid-line',
        'shape-rendering': step === 4 ? 'crispEdges' : 'auto',
      }),
      svgText({ class: 'axis-label', x: padLeft - 10, y: (y + 4).toFixed(2), 'text-anchor': 'end' },
        value > 0 ? compact(value, 1) : '0'),
    );
  }

  const band = plotW / buckets.length;
  const barWidth = Math.max(2, Math.min(34, band - 2));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 62))));

  buckets.forEach((bucket, index) => {
    const centre = padLeft + band * (index + 0.5);
    const x = centre - barWidth / 2;
    const inputH = (bucket.inputTokens / max) * plotH;
    const outputH = (bucket.outputTokens / max) * plotH;
    const inputY = padTop + plotH - inputH;
    const outputY = inputY - outputH;
    const group = svgNode('g');
    group.append(svgNode('rect', {
      x: (centre - band / 2).toFixed(2), y: padTop, width: band.toFixed(2), height: plotH,
      class: 'bar-hit',
    }));

    // A zero-usage day still gets a hairline so a gap reads as "no usage" rather than a missing day.
    if (bucket.totalTokens <= 0) {
      group.append(svgNode('rect', {
        x: x.toFixed(2), y: (padTop + plotH - 1).toFixed(2), width: barWidth.toFixed(2),
        height: '1', class: 'bar-empty', rx: '1',
      }));
    } else {
      if (inputH > 0.5) {
        group.append(svgNode('rect', {
          x: x.toFixed(2), y: inputY.toFixed(2), width: barWidth.toFixed(2),
          height: inputH.toFixed(2), class: 'bar-input', rx: inputH > 1 ? '2' : '0',
        }));
      }
      if (outputH > 0.5) {
        group.append(svgNode('rect', {
          x: x.toFixed(2), y: outputY.toFixed(2), width: barWidth.toFixed(2),
          height: outputH.toFixed(2), class: 'bar-output', rx: outputH > 1 ? '2' : '0',
        }));
      }
    }

    if (index % labelEvery === 0 || index === buckets.length - 1) {
      group.append(svgText({ class: 'axis-label', x: centre.toFixed(2), y: height - 10, 'text-anchor': 'middle' },
        bucket.date.slice(5)));
    }
    svg.append(group);
    chartBars.push({ centre, bucket });
  });

  const tip = buildTooltip();
  tip.marker.setAttribute('y1', padTop);
  tip.marker.setAttribute('y2', padTop + plotH);
  tip.group.setAttribute('hidden', '');
  svg.append(tip.group);
  host.append(svg);
  host._tip = tip;
  host._plot = { padTop, plotH, width, padLeft, padRight, plotW };
}

function highlightChartBar(event) {
  const host = ui.usageChart;
  const tip = host._tip;
  if (!tip || !chartBars.length) return;
  const box = host.getBoundingClientRect();
  const scale = box.width / host._plot.width || 1;
  const pointer = (event.clientX - box.left) / scale;
  let best = chartBars[0];
  for (const bar of chartBars) {
    if (Math.abs(bar.centre - pointer) < Math.abs(best.centre - pointer)) best = bar;
  }
  const { padTop, padLeft, padRight, width } = host._plot;
  const left = best.centre + 12 + TIP.width > width - padRight
    ? best.centre - 12 - TIP.width
    : best.centre + 12;
  tip.marker.setAttribute('x1', best.centre.toFixed(2));
  tip.marker.setAttribute('x2', best.centre.toFixed(2));
  tip.group.setAttribute('transform', `translate(${Math.max(padLeft, left).toFixed(2)} ${padTop})`);
  tip.date.textContent = best.bucket.date;
  for (const [field, node] of tip.values) node.textContent = full(best.bucket[field]);
  tip.group.removeAttribute('hidden');
}

function hideChartTip() {
  const tip = ui.usageChart._tip;
  if (tip) tip.group.setAttribute('hidden', '');
}

/* ---------- stat panels ---------- */

function renderStats(data) {
  const usage = data.usage || {};
  const buckets = selectedDaily().buckets;
  const total = usage.totalTokens || 0;
  const last24h = usage.windows?.last24h || {};
  const last7d = usage.windows?.last7d || {};
  const last30d = usage.windows?.last30d || {};

  const selected = activeWindow === 'all' ? usage : usage.windows?.[activeWindow];
  const labels = {all:'累计 Token',last24h:'近 24 小时 Token',last7d:'近 7 天 Token',last30d:'近 30 天 Token'};
  text('tokenTotalLabel',labels[activeWindow]);
  text('tokenTotal', selected ? tokenAmount(selected.totalTokens) : '暂无计量数据');
  text('tokenTotalSub', selected?.jobs
    ? `${full(selected.jobs)} 个已计量任务 · 输入 + 输出`
    : '等待计量数据');
  renderSparkline(document.getElementById('sparkTokens'), sparkValues(buckets, 'totalTokens'), 'tone-tokens');

  text('token24h', tokenAmount(last24h.totalTokens));
  text('token24hSub', total
    ? `${full(last24h.requests || 0)} 次请求 · 占累计 ${formatPercent(last24h.totalTokens, total)}`
    : '暂无计量数据');
  renderSparkline(document.getElementById('sparkRecent'), sparkValues(buckets.slice(-7), 'totalTokens'), 'tone-recent');

  text('requestTotal', selected ? full(selected.requests || 0) : '—');
  text('requestTotalSub', `近 7 天 ${full(last7d.requests || 0)} 次 · 近 30 天 ${full(last30d.requests || 0)} 次`);
  renderSparkline(document.getElementById('sparkRequests'), sparkValues(buckets, 'requests'), 'tone-requests');

  const average = selected?.requests ? selected.totalTokens / selected.requests : 0;
  text('averageTokens', average ? `${compact(average, 1)} Token` : '—');
  text('averageTokensSub', selected?.requests
    ? `${compact(selected.totalTokens)} Token / ${full(selected.requests)} 次请求`
    : '等待计量数据');
  renderSparkline(document.getElementById('sparkAverage'),
    sparkValues(buckets, 'totalTokens').map((value, index) => {
      const requests = buckets[index]?.requests || 0;
      return requests > 0 ? Math.round(value / requests) : 0;
    }), 'tone-average');

  const days = activeWindow === 'last7d' ? 7 : activeWindow === 'last24h' ? 2 : 30;
  text('usageChartMeta', `最近 ${days} 个 UTC 自然日 · 与滚动时间窗口不同 · 单位 Token`);
}

function selectedDaily() {
  const daily = snapshot?.usage?.daily || {};
  const days = activeWindow === 'last7d' ? 7 : activeWindow === 'last24h' ? 2 : 30;
  return {...daily,buckets:(daily.buckets || []).slice(-days)};
}

function renderUsage() {
  renderStats(snapshot);
  const daily=selectedDaily();
  renderUsageChart(daily);
  document.querySelector('#dailyRows').replaceChildren(...daily.buckets.map(bucket=>{
    const row=document.createElement('tr');
    for(const value of [bucket.date,full(bucket.inputTokens),full(bucket.outputTokens),full(bucket.totalTokens)]) row.append(element('td',null,value));
    return row;
  }));
}

function renderMeter(data) {
  const usage = data.usage || {};
  text('meterInput', full(usage.inputTokens || 0));
  text('meterOutput', full(usage.outputTokens || 0));
  text('meterReasoning', full(usage.reasoningTokens || 0));
  text('meterJobs', full(usage.jobs || 0));
  text('meterSince', usage.firstAt ? usage.firstAt.replace('T', ' ').slice(0, 16) + ' UTC' : '暂无数据');

  const kinds = new Map((usage.kinds || []).map(item => [item.kind, item]));
  const totals = ['pr', 'ci'].map(kind => kinds.get(kind)?.totalTokens || 0);
  const max = Math.max(1, ...totals);
  for (const [index, kind] of ['pr', 'ci'].entries()) {
    const total = totals[index];
    const bar = kindBars.get(kind);
    if (bar) bar.setAttribute('width', ((total / max) * 100).toFixed(2));
    text(kind === 'pr' ? 'kindValuePr' : 'kindValueCi',
      total ? `${compact(total)} · ${formatPercent(total, usage.totalTokens)}` : '0');
  }
}

function buildKindBar(trackId, fillClass) {
  const track = document.getElementById(trackId);
  if (!track) return null;
  const svg = svgNode('svg', {
    viewBox: '0 0 100 8', preserveAspectRatio: 'none',
    focusable: 'false', 'aria-hidden': 'true', class: 'kind-svg',
  });
  const fill = svgNode('rect', { x: 0, y: 0, width: 0, height: 8, rx: '2', class: `kind-fill ${fillClass}` });
  svg.append(fill);
  track.replaceChildren(svg);
  return fill;
}

/* ---------- rankings ---------- */

function rankingItem(item, index, detail, value, amount, maximum) {
  const row = document.createElement('li');
  const identity = element('span', 'ranking-identity');
  identity.append(repositoryLink(item), element('small', null, detail));
  row.append(element('span', 'ranking-index', String(index + 1).padStart(2, '0')), identity, element('strong', null, value));
  const meter=element('meter','ranking-meter');
  meter.min=0;meter.max=Math.max(1,maximum || 0);meter.value=Math.max(0,amount || 0);
  meter.setAttribute('aria-label',`${item.repository}：${value}`);
  row.append(meter);
  return row;
}

function renderRankings(data) {
  const usage = data.usage || {};
  const tokenRows = usage.repositories || [];
  ui.tokenUsageRanking.replaceChildren(...tokenRows.map((item, index) => rankingItem(
    item, index,
    `${full(item.requests)} 次请求 · 输入 ${compact(item.inputTokens)} · 输出 ${compact(item.outputTokens)}`,
    compact(item.totalTokens),item.totalTokens,Math.max(1,...tokenRows.map(row=>row.totalTokens)))));
  ui.tokenUsageEmpty.hidden = tokenRows.length > 0;
  text('tokenUsageTotal', usage.totalTokens ? tokenAmount(usage.totalTokens) : '等待数据');

  const active = data.rankings?.activeRepositories || [];
  ui.activeRepositoryRanking.replaceChildren(...active.map((item, index) => rankingItem(
    item, index, `PR ${item.pr} · CI ${item.ci} · ${formatAge(item.ageSeconds)}`, `${item.tasks} 个任务`,item.tasks,Math.max(1,...active.map(row=>row.tasks)))));
  ui.activeRepositoryEmpty.hidden = active.length > 0;
  text('activeRepositoryTotal', `${active.length} 个仓库`);
}

/* ---------- queue ---------- */

function renderQueue() {
  if (!snapshot) return;
  const search = ui.repositorySearch.value.trim().toLowerCase();
  const jobs = snapshot.jobs.filter(job =>
    (activeKind === 'all' || job.kind === activeKind) &&
    (document.querySelector('#statusFilter').value === 'all' || job.status === document.querySelector('#statusFilter').value) &&
    (!search || job.repository.toLowerCase().includes(search)));
  ui.visibleCount.textContent = jobs.length;
  ui.totalCount.textContent = snapshot.jobs.length;
  ui.emptyState.hidden = jobs.length > 0;
  const pages=Math.max(1,Math.ceil(jobs.length/pageSize));
  page=Math.max(1,Math.min(page,pages));
  text('pageInfo',`第 ${page} / ${pages} 页 · 每页 ${pageSize} 条`);
  document.querySelector('#previousPage').disabled=page===1;
  document.querySelector('#nextPage').disabled=page===pages;
  ui.queueBody.replaceChildren(...jobs.slice((page-1)*pageSize,page*pageSize).map(job => {
    const row = document.createElement('tr');

    const identity = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'job-link';
    link.href = job.href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = job.repository;
    identity.append(link, element('span', 'job-reference', job.reference));

    const status = document.createElement('td');
    status.append(element('span', `state-label ${job.status}`, job.statusLabel));
    if (job.reason) status.append(element('span', 'state-reason', job.reason));

    const progress = element('td', 'progress-copy', progressLabel(job));
    if (job.progress.findings || job.progress.failures) {
      progress.append(element('small', null, `${job.progress.findings} 个问题 · ${job.progress.failures} 个失败批次`));
    }

    row.append(
      identity,
      element('td', 'type-label', job.kind === 'pr' ? 'PR Review' : 'CI 分析'),
      status,
      progress,
      element('td', 'time-cell', formatAge(job.ageSeconds)),
    );
    return row;
  }));
}

/* ---------- render ---------- */

function render(data) {
  snapshot = data;
  text('lastUpdated', formatClock(data.generatedAt));
  text('workerMetric', `工作线程 ${data.runtime.activeWorkers} / ${data.runtime.queueWorkers}`);
  text('pendingMetric', data.totals.pending);
  text('runningMetric', data.totals.running);
  text('attentionMetric', data.totals.attention);
  text('completedMetric', data.totals.completed24h);
  text('repositoryMetric', `涉及 ${data.totals.repositories} 个仓库`);
  text('modelName', data.runtime.model || '未配置');
  text('apiFormat', data.runtime.apiFormat || '未配置');
  text('queueWorkers', `${data.runtime.activeWorkers} / ${data.runtime.queueWorkers}`);
  text('modelConcurrency', data.runtime.modelConcurrency || '—');
  text('uptime', formatUptime(data.service.uptimeSeconds));
  text('prReviewState', data.service.automaticPrReview ? '已启用' : '未启用');
  text('ciReviewState', data.service.ciFailureReview ? '已启用' : '未启用');
  ui.servicePill.classList.toggle('healthy', data.service.status === 'healthy');
  ui.servicePill.lastElementChild.textContent = data.runtime.modelConfigured ? '数据已连接' : '模型未配置';
  renderUsage();
  renderMeter(data);
  renderRankings(data);
  renderQueue();
}

let rendering = false;
async function refresh({ interactive = false } = {}) {
  if (!accessToken) {
    if (!ui.accessDialog.open) ui.accessDialog.showModal();
    return;
  }
  if (rendering) return;
  rendering = true;
  ui.refreshButton.disabled = true;
  if (interactive) ui.refreshButton.textContent = '刷新中…';
  try {
    const response = await fetch('/api/dashboard' + (previewState ? '?state=' + encodeURIComponent(previewState) : ''), {
      headers: { authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (response.status === 401) {
      sessionStorage.removeItem('ai-review-dashboard-token');
      accessToken = '';
      document.querySelector('#connectionError').hidden=false;
      text('connectionError','访问授权已失效，之前显示的数据可能已过期。');
      ui.servicePill.classList.remove('healthy');
      ui.servicePill.lastElementChild.textContent='需要授权';
      ui.accessError.textContent = '访问令牌无效，请重新输入。';
      if (!ui.accessDialog.open) ui.accessDialog.showModal();
      return;
    }
    if (response.status === 503) throw new Error('看板访问尚未在服务端启用。');
    if (!response.ok) throw new Error('暂时无法读取运行数据。');
    render(await response.json());
    document.querySelector('#connectionError').hidden=true;
    ui.accessError.textContent = '';
    if (ui.accessDialog.open) ui.accessDialog.close();
  } catch (error) {
    ui.servicePill.classList.remove('healthy');
    ui.servicePill.lastElementChild.textContent = error.message || '连接失败';
    document.querySelector('#connectionError').hidden=false;
    text('connectionError',(error.message || '连接失败')+(snapshot ? ' 已保留上次结果；请留意最后更新时间。' : ' 尚未加载数据，请稍后重试。'));
  } finally {
    rendering = false;
    ui.refreshButton.disabled = false;
    ui.refreshButton.textContent = '立即刷新';
  }
}

/* ---------- events ---------- */

for (const [kind, trackId, fillClass] of [
  ['pr', 'kindTrackPr', 'fill-pr'],
  ['ci', 'kindTrackCi', 'fill-ci'],
]) {
  const fill = buildKindBar(trackId, fillClass);
  if (fill) kindBars.set(kind, fill);
}

ui.accessForm.addEventListener('submit', event => {
  event.preventDefault();
  accessToken = ui.accessToken.value;
  if (!isPreview) sessionStorage.setItem('ai-review-dashboard-token', accessToken);
  refresh({ interactive: true });
});

ui.refreshButton.addEventListener('click', () => refresh({ interactive: true }));
ui.repositorySearch.addEventListener('input', () => {page=1;renderQueue();});
document.querySelector('#statusFilter').addEventListener('change',()=>{page=1;renderQueue();});
document.querySelector('#previousPage').addEventListener('click',()=>{page--;renderQueue();});
document.querySelector('#nextPage').addEventListener('click',()=>{page++;renderQueue();});
document.querySelector('#showAttention').addEventListener('click',()=>{
  document.querySelector('#statusFilter').value='paused';ui.repositorySearch.value='';activeKind='all';page=1;
  document.querySelectorAll('#kindFilters button').forEach(button=>{const selected=button.dataset.kind==='all';button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  renderQueue();document.querySelector('#queue').scrollIntoView({behavior:'smooth'});
});
document.querySelector('#clearFilters').addEventListener('click',()=>{
  document.querySelector('#statusFilter').value='all';ui.repositorySearch.value='';
  document.querySelector('#kindFilters button[data-kind="all"]').click();
});
document.querySelectorAll('#usageRange button').forEach(button=>button.addEventListener('click',()=>{
  activeWindow=button.dataset.window;
  document.querySelectorAll('#usageRange button').forEach(item=>{item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));});
  if(snapshot)renderUsage();
}));
document.querySelectorAll('#kindFilters button').forEach(button => {
  button.addEventListener('click', () => {
    activeKind = button.dataset.kind;
    page=1;
    document.querySelectorAll('#kindFilters button').forEach(item => {item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));});
    renderQueue();
  });
});
ui.usageChart.addEventListener('mousemove', highlightChartBar);
ui.usageChart.addEventListener('mouseleave', hideChartTip);

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (snapshot) renderUsageChart(selectedDaily());
  }, 160);
});

refresh();
setInterval(refresh, REFRESH_MS);

const navigation=[...document.querySelectorAll('.sidebar nav a')];
function updateNavigation(){
  let current=navigation[0];
  for(const link of navigation){
    if(document.querySelector(link.hash).getBoundingClientRect().top<=120)current=link;
  }
  for(const link of navigation){const active=link===current;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');}
}
window.addEventListener('scroll',updateNavigation,{passive:true});
updateNavigation();
