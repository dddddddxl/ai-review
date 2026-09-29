import http from 'node:http';
import fs from 'node:fs/promises';
import { dashboardHeaders, loadDashboardAssets } from '../src/dashboard.mjs';

const assets = await loadDashboardAssets();
const previewHeaders = contentType => ({
  ...dashboardHeaders(contentType),
  'content-security-policy': dashboardHeaders(contentType)['content-security-policy']
    .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
});
const now = Date.now();
const sample = {
  generatedAt: new Date(now).toISOString(),
  service: { status: 'healthy', statusLabel: '服务正常', uptimeSeconds: 293820, automaticPrReview: true, ciFailureReview: true },
  totals: { pending: 3, running: 2, attention: 1, completed24h: 18, repositories: 4, all: 24 },
  runtime: { activeWorkers: 2, queueWorkers: 4, modelConcurrency: 8, model: 'GLM-5.3-Flash', apiFormat: 'openai-chat', modelConfigured: true },
  rankings: {
    windowDays: 7,
    activeRepositories: [
      { repository: 'HYGON-AI/sglang-das', href: 'https://github.com/HYGON-AI/sglang-das', tasks: 42, pr: 18, ci: 24, ageSeconds: 94 },
      { repository: 'HYGON-AI/Megatron-LM-das', href: 'https://github.com/HYGON-AI/Megatron-LM-das', tasks: 31, pr: 14, ci: 17, ageSeconds: 360 },
      { repository: 'HYGON-AI/runtime', href: 'https://github.com/HYGON-AI/runtime', tasks: 19, pr: 12, ci: 7, ageSeconds: 2800 },
      { repository: 'HYGON-AI/DeepEP-das', href: 'https://github.com/HYGON-AI/DeepEP-das', tasks: 11, pr: 8, ci: 3, ageSeconds: 7200 },
    ],
    tokenUsage: {
      trackedJobs: 58, requests: 186, inputTokens: 824300, outputTokens: 267500, reasoningTokens: 211900, totalTokens: 1091800,
      repositories: [
        { repository: 'HYGON-AI/sglang-das', href: 'https://github.com/HYGON-AI/sglang-das', inputTokens: 412000, outputTokens: 143000, reasoningTokens: 118000, totalTokens: 555000 },
        { repository: 'HYGON-AI/Megatron-LM-das', href: 'https://github.com/HYGON-AI/Megatron-LM-das', inputTokens: 236000, outputTokens: 74500, reasoningTokens: 59000, totalTokens: 310500 },
        { repository: 'HYGON-AI/runtime', href: 'https://github.com/HYGON-AI/runtime', inputTokens: 121000, outputTokens: 34000, reasoningTokens: 26000, totalTokens: 155000 },
        { repository: 'HYGON-AI/DeepEP-das', href: 'https://github.com/HYGON-AI/DeepEP-das', inputTokens: 55300, outputTokens: 16000, reasoningTokens: 8900, totalTokens: 71300 },
      ],
    },
  },
  counts: { queued: 3, running: 2, paused: 1, done: 16, skipped: 1, stale: 1 },
  jobs: [
    { repository: 'HYGON-AI/sglang-das', kind: 'pr', reference: 'PR #375', href: 'https://github.com/HYGON-AI/sglang-das/pull/375', status: 'running', statusLabel: '审查中', reason: null, ageSeconds: 94, progress: { completed: 4, total: 7, findings: 2, failures: 0 } },
    { repository: 'HYGON-AI/Megatron-LM-das', kind: 'ci', reference: 'Run 34445452779', href: 'https://github.com/HYGON-AI/Megatron-LM-das/actions/runs/34445452779', status: 'queued', statusLabel: '等待中', reason: null, ageSeconds: 360, progress: { completed: 0, total: 0, findings: 0, failures: 0 } },
    { repository: 'HYGON-AI/sglang-das', kind: 'ci', reference: 'Run 34765339911', href: 'https://github.com/HYGON-AI/sglang-das/actions/runs/34765339911', status: 'paused', statusLabel: '需处理', reason: '任务执行异常', ageSeconds: 1320, progress: { completed: 3, total: 4, findings: 1, failures: 1 } },
    { repository: 'HYGON-AI/runtime', kind: 'pr', reference: 'PR #330', href: 'https://github.com/HYGON-AI/runtime/pull/330', status: 'done', statusLabel: '已完成', reason: null, ageSeconds: 2800, progress: { completed: 5, total: 5, findings: 0, failures: 0 } },
    { repository: 'HYGON-AI/DeepEP-das', kind: 'pr', reference: 'PR #42', href: 'https://github.com/HYGON-AI/DeepEP-das/pull/42', status: 'done', statusLabel: '已完成', reason: null, ageSeconds: 7200, progress: { completed: 8, total: 8, findings: 3, failures: 0 } },
  ],
};

const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number.parseInt(process.argv[portIndex + 1], 10) : 4173;
const referenceIndex = process.argv.indexOf('--reference');
const reference = referenceIndex >= 0 ? await fs.readFile(process.argv[referenceIndex + 1]) : null;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (request.method === 'GET' && pathname === '/api/dashboard') {
    response.writeHead(200, previewHeaders('application/json; charset=utf-8'));
    response.end(JSON.stringify({ ...sample, generatedAt: new Date().toISOString() }));
    return;
  }
  if (request.method === 'GET' && pathname === '/qa-reference.png' && reference) {
    response.writeHead(200, previewHeaders('image/png'));
    response.end(reference);
    return;
  }
  if (request.method === 'GET' && pathname === '/qa-compare' && reference) {
    response.writeHead(200, previewHeaders('text/html; charset=utf-8'));
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI Review visual QA</title>
      <style>body{margin:0;padding:24px;background:#e6e1d4;color:#1a1a1a;font:14px Arial,sans-serif}h1{margin:0 0 18px}section{margin:0 auto 24px;max-width:1280px;background:#f8f6f1;border-radius:20px;overflow:hidden}h2{margin:0;padding:16px 20px;border-bottom:1px solid #e6e1d4;font-size:14px}img{display:block;width:100%;height:auto}iframe{display:block;width:100%;height:1200px;border:0}</style></head>
      <body><h1>AI Review visual QA</h1><section><h2>Source style reference</h2><img src="/qa-reference.png" alt="Source style reference"></section>
      <section><h2>Rendered implementation</h2><iframe src="/" title="Rendered AI Review dashboard"></iframe></section></body></html>`);
    return;
  }
  const asset = request.method === 'GET' ? assets.get(pathname) : null;
  if (asset) {
    response.writeHead(200, previewHeaders(asset.contentType));
    response.end(asset.body);
    return;
  }
  response.writeHead(404, dashboardHeaders('text/plain; charset=utf-8'));
  response.end('Not found');
});

server.listen(port, '0.0.0.0', () => console.log(`Dashboard preview listening on http://0.0.0.0:${port}`));
