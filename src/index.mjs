import "dotenv/config";

import fs from "node:fs";
import path from 'node:path';
import http from "node:http";

import { createNodeMiddleware } from "@octokit/webhooks";
import { App } from "octokit";
import { createModelClient } from "./model-client.mjs";
import { createCiReviewer, resolveRunPullRequests } from "./ci-review.mjs";
import { buildPrRepositoryContext } from './pr-context.mjs';
import { deleteProgressComment, publishPrReview, updateReviewWithCiEvidence, upsertProgressComment } from './pr-publication.mjs';
import { applyPendingCiBackfeeds } from './ci-backfeed.mjs';
import { isUpstreamSyncBranch, isUpstreamSyncPullRequest } from './review-policy.mjs';
import { ReviewState, ReviewQueue, limitModelConcurrency, stateDirectory } from './review-state.mjs';
import { createModelUsageMeter, hasReportedUsage } from './model-usage.mjs';
import { createDashboardSnapshot, dashboardAuthorized, dashboardHeaders, loadDashboardAssets } from './dashboard.mjs';
import { verificationRetryDecision } from './retry-policy.mjs';
import { enhancementConfig, runReviewPipeline } from './review-pipeline.mjs';
import { updateTestReviewSummary } from './pr-publication.mjs';

const requiredEnvironment = [
  "GITHUB_APP_ID",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PRIVATE_KEY_PATH",
];

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

const appId = process.env.GITHUB_APP_ID;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
const port = positiveInteger(process.env.PORT, 3000);
const allowedRepositories = new Set(
  (process.env.ALLOWED_REPOSITORIES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const githubApp = new App({
  appId,
  privateKey: fs.readFileSync(privateKeyPath, "utf8"),
  webhooks: {
    secret: webhookSecret,
  },
});

const modelConcurrency = boundedPositiveInteger(process.env.AI_MODEL_CONCURRENCY, 4, 16);
const queueWorkerConcurrency = boundedPositiveInteger(process.env.AI_REVIEW_WORKERS, 2, 8);
const verificationRetryLimit = boundedPositiveInteger(process.env.AI_VERIFICATION_RETRY_LIMIT, 3, 5);
const verificationRetryDelayMs = positiveInteger(process.env.AI_VERIFICATION_RETRY_DELAY_MS, 60000);
const modelUsageMeter = createModelUsageMeter(limitModelConcurrency(createModelClient(), modelConcurrency));
const modelClient = modelUsageMeter.client;
const modelConfigured = modelClient.configured;
const dashboardToken = process.env.AI_DASHBOARD_TOKEN || '';
const dashboardAssets = await loadDashboardAssets();

const reviewState = new ReviewState();
const enhancedConfig = enhancementConfig();
const testRefreshState = new ReviewState(path.join(stateDirectory(), 'test-refresh'));
const activeTestRefreshes = new Set();
const reviewQueue = new ReviewQueue();
const ciBackfeedState = new ReviewState(path.join(stateDirectory(), 'ci-backfeed'));
await reviewQueue.recover();
const { data: appInfo } = await githubApp.octokit.request('GET /app');
const botLogin = `${appInfo.slug}[bot]`;
const reviewCi = createCiReviewer({ modelClient, botLogin, state: new ReviewState(path.join(stateDirectory(), 'ci')), backfeedState: ciBackfeedState });
githubApp.webhooks.on('workflow_run.completed', async (context) => {
  const repository = context.payload.repository.full_name.toLowerCase();
  if (allowedRepositories.size && !allowedRepositories.has(repository)) return;
  const run = context.payload.workflow_run;
  if (isUpstreamSyncBranch(run.head_branch)) return;
  await reviewQueue.enqueue({ kind: 'ci', repository: context.payload.repository.full_name,
    installationId: context.payload.installation.id, runId: run.id, runAttempt: run.run_attempt || 1, headSha: run.head_sha });
  if (enhancedConfig.testEnabled) await reviewQueue.enqueue({ kind: 'test-ci', repository: context.payload.repository.full_name,
    installationId: context.payload.installation.id, runId: run.id, runAttempt: run.run_attempt || 1, headSha: run.head_sha });
});

githubApp.webhooks.on(
  [
    "pull_request.opened",
    "pull_request.synchronize",
    "pull_request.reopened",
    "pull_request.ready_for_review",
  ],
  async (context) => {
    const { payload } = context;
    const pullRequest = payload.pull_request;
    const repository = payload.repository.full_name.toLowerCase();

    if (pullRequest.draft) return;
    if (isUpstreamSyncPullRequest(pullRequest)) return;
    if (
      allowedRepositories.size > 0 &&
      !allowedRepositories.has(repository)
    ) {
      return;
    }

    await reviewQueue.enqueue({ repository: payload.repository.full_name, pullNumber: pullRequest.number,
      headSha: pullRequest.head.sha, installationId: payload.installation.id });
  },
);

githubApp.webhooks.onError((error) => {
  console.error(`[Webhook] ${safeErrorMessage(error)}`);
});

async function reviewPullRequest(job) {
  const { repository, pullNumber } = job;
  if (allowedRepositories.size && !allowedRepositories.has(repository.toLowerCase())) return { status: 'skipped' };
  const [owner, repo] = repository.split('/');
  const octokit = await githubApp.getInstallationOctokit(job.installationId);
  const { data: currentPr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (currentPr.state !== 'open' || currentPr.draft || currentPr.head.sha !== job.headSha) return { status: 'stale' };
  if (isUpstreamSyncPullRequest(currentPr)) return { status: 'skipped', reason: 'upstream_sync_pr' };

  console.log(
    `[Review] start repository=${repository} pr=${pullNumber} job=${job.id}`,
  );

  if (!modelConfigured) {
    await upsertProgressComment({
      octokit,
      owner,
      repo,
      pullNumber,
      headSha: currentPr.head.sha,
      botLogin,
      body: [
        "## AI Review",
        "",
        "GitHub App 和 Webhook 已连接，但模型服务尚未配置。",
        "",
        "请在服务端配置 `AI_API_KEY` 和 `AI_MODEL` 后重启容器。",
      ].join("\n"),
    });
    console.log(
      `[Review] model-not-configured repository=${repository} pr=${pullNumber}`,
    );
    return { status: 'paused', reason: 'model_not_configured' };
  }

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const repositoryContext = await buildPrRepositoryContext({ octokit, owner, repo, baseSha: currentPr.base.sha, files,
    log: message => console.log(message) });

  const isCurrent = async () => {
    const { data: latest } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    return latest.state === 'open' && !latest.draft && latest.head.sha === currentPr.head.sha && latest.base.sha === currentPr.base.sha;
  };
  let lastPublished = 0;
  const result = await runReviewPipeline({ client: modelClient, files, repository, pullNumber, title: currentPr.title,
    prDescription: currentPr.body || '', repositoryContext,
    headSha: currentPr.head.sha, baseSha: currentPr.base.sha, totalFiles: currentPr.changed_files, state: reviewState,
    batchChars: positiveInteger(process.env.AI_REVIEW_BATCH_CHARS, 10000),
    isCurrent,
    onProgress: async progress => {
      if (Date.now() - lastPublished < 60000 || !await isCurrent()) return;
      await upsertProgressComment({ octokit, owner, repo, pullNumber, headSha: currentPr.head.sha, botLogin, body: progress.body });
      lastPublished = Date.now();
    },
  }, { config: enhancedConfig, octokit });
  if (result.cancelled || !await isCurrent()) return { status: 'stale' };

  const publication = await publishPrReview({ octokit, owner, repo, pullNumber, pr: currentPr, files, result, botLogin, isCurrent });
  if (publication.stale) return { status: 'stale' };
  let preferredReview = Number.isSafeInteger(publication.reviewId) && typeof publication.reviewBody === 'string'
    ? { id: publication.reviewId, body: publication.reviewBody } : null;
  const backfeed = await applyPendingCiBackfeeds({ state: ciBackfeedState, repository, pullNumber,
    headSha: currentPr.head.sha,
    apply: async record => {
      const outcome = await updateReviewWithCiEvidence({ octokit, owner, repo, pullNumber, headSha: currentPr.head.sha,
        botLogin, run: record.run, result: record.result, restricted: record.restricted,
        reviewId: preferredReview?.id, reviewBody: preferredReview?.body, isCurrent });
      if (outcome.integrated && typeof outcome.body === 'string') preferredReview = { id: outcome.reviewId, body: outcome.body };
      return outcome;
    } });
  if (backfeed.applied || backfeed.deferred) {
    console.log(`[Review] ci-backfeed repository=${repository} pr=${pullNumber} applied=${backfeed.applied} deferred=${backfeed.deferred}`);
  }
  await deleteProgressComment({ octokit, owner, repo, pullNumber, headSha: currentPr.head.sha, botLogin });

  console.log(
    `[Review] ${result.partial ? 'partial' : 'complete'} repository=${repository} pr=${pullNumber} batches=${result.batches} completed=${result.completed} pending=${result.pending} failedBatches=${result.failures}`,
  );
  return { status: result.retryableVerificationFailures ? 'retry' : result.pending || result.failures || result.testReview?.status === 'incomplete' ? 'paused' : 'done',
    retryableVerificationFailures: result.retryableVerificationFailures,
    summary: { batches: result.batches, completed: result.completed, pending: result.pending, failures: result.failures,
      findings: result.findings, reviewedFiles: result.reviewedFiles, partial: result.partial,
      ...(result.testReview ? { testReviewStatus: result.testReview.status } : {}) } };
}

async function reviewWorkflowRun(job) {
  if (allowedRepositories.size && !allowedRepositories.has(job.repository.toLowerCase())) return { status: 'skipped', reason: 'repository_not_allowed' };
  const [owner, repo] = job.repository.split('/');
  const octokit = await githubApp.getInstallationOctokit(job.installationId);
  const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: job.runId });
  if (run.run_attempt !== job.runAttempt || run.status !== 'completed') return { status: 'skipped', reason: 'run_attempt_changed_or_unfinished' };
  if (isUpstreamSyncBranch(run.head_branch)) return { status: 'skipped', reason: 'upstream_sync_pr' };
  return reviewCi({ octokit, payload: { workflow_run: run,
    repository: { owner: { login: owner }, name: repo, full_name: job.repository } } });
}

async function refreshTestCoverage(job) {
  if (!enhancedConfig.testEnabled || !modelConfigured) return { status: 'skipped', reason: 'test_review_disabled_or_model_unconfigured' };
  if (allowedRepositories.size && !allowedRepositories.has(job.repository.toLowerCase())) return { status: 'skipped' };
  const [owner, repo] = job.repository.split('/');
  const octokit = await githubApp.getInstallationOctokit(job.installationId);
  const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: job.runId });
  if (run.status !== 'completed' || run.run_attempt !== job.runAttempt || isUpstreamSyncBranch(run.head_branch)) return { status: 'stale' };
  const association = await resolveRunPullRequests(octokit, { owner: { login: owner }, name: repo, full_name: job.repository }, run);
  let unfinished = false;
  for (const linked of association.linked) {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: linked.number });
    if (pr.state !== 'open' || pr.draft || linked.head?.sha !== pr.head.sha || isUpstreamSyncPullRequest(pr)) continue;
    const key = [job.repository, pr.number, pr.base.sha, pr.head.sha, run.id, run.run_attempt];
    const activeKey = JSON.stringify(key);
    if (activeTestRefreshes.has(activeKey)) { unfinished = true; continue; }
    activeTestRefreshes.add(activeKey);
    try {
      const previous = await testRefreshState.read(key);
      if (previous?.status === 'done') continue;
      const isCurrent = async () => {
        const { data: latest } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
        const { data: currentRun } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
        return latest.state === 'open' && !latest.draft && latest.head.sha === pr.head.sha && latest.base.sha === pr.base.sha && currentRun.run_attempt === run.run_attempt;
      };
      let testReview = previous?.testReview;
      if (!testReview || testReview.status !== 'validated') {
        const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
        ({ testReview } = await runReviewPipeline({ client: modelClient, files, repository: job.repository, pullNumber: pr.number,
          title: pr.title, baseSha: pr.base.sha, headSha: pr.head.sha, isCurrent, state: reviewState },
        { config: enhancedConfig, octokit, extraRun: run, testsOnly: true }));
      }
      const outcome = await updateTestReviewSummary({ octokit, owner, repo, pullNumber: pr.number, headSha: pr.head.sha, botLogin, testReview, isCurrent });
      const status = testReview.status === 'validated' && outcome.status === 'done' ? 'done' : 'paused';
      await testRefreshState.write(key, { status, testReview, repository: job.repository, pullNumber: pr.number, headSha: pr.head.sha });
      if (status !== 'done') unfinished = true;
    } finally { activeTestRefreshes.delete(activeKey); }
  }
  return { status: unfinished ? 'paused' : 'done' };
}

// Only this process consumes the durable inbox. Claims remain serialized while
// different jobs can run concurrently. The global model semaphore is the final
// provider-load boundary across every PR and CI worker.
let dispatcherBusy = false;
let activeWorkers = 0;
async function processQueuedJob(job) {
  const usageScope = modelUsageMeter.createScope(job.usage);
  try {
    const { status, ...result } = await usageScope.run(() =>
      job.kind === 'ci' ? reviewWorkflowRun(job) : job.kind === 'test-ci' ? refreshTestCoverage(job) : reviewPullRequest(job));
    const usage = usageScope.snapshot();
    if (status === 'retry') {
      const decision = verificationRetryDecision(job, { limit: verificationRetryLimit, baseDelayMs: verificationRetryDelayMs });
      const { status: retryStatus, ...retryState } = decision;
      await reviewQueue.update(job, retryStatus, { ...result, ...retryState, ...(hasReportedUsage(usage) ? { usage } : {}) });
      return;
    }
    await reviewQueue.update(job, status, { ...result, ...(hasReportedUsage(usage) ? { usage } : {}) });
  } catch (error) {
    console.error(`[Review queue] error=${error.name || 'Error'}`);
    const usage = usageScope.snapshot();
    await reviewQueue.update(job, 'paused', { reason: 'worker_error',
      ...(hasReportedUsage(usage) ? { usage } : {}) }).catch(() => {});
  }
}
const workerTimer = setInterval(async () => {
  if (dispatcherBusy) return;
  dispatcherBusy = true;
  try {
    while (activeWorkers < queueWorkerConcurrency) {
      const job = await reviewQueue.claimNext();
      if (!job) break;
      activeWorkers++;
      void processQueuedJob(job).finally(() => { activeWorkers--; });
    }
  } catch (error) {
    console.error(`[Review queue dispatcher] error=${error.name || 'Error'}`);
  } finally { dispatcherBusy = false; }
}, 1000);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInteger(value, fallback, maximum) {
  return Math.min(positiveInteger(value, fallback), maximum);
}

function safeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

const middleware = createNodeMiddleware(githubApp.webhooks, {
  path: "/api/webhook",
});

const server = http.createServer(async (request, response) => {
  const pathname = new URL(
    request.url || "/",
    "http://localhost",
  ).pathname;

  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (request.method === "GET" && pathname === "/ready") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ready",
        apiFormat: modelClient.format,
        insecureHttp: modelClient.insecureHttp,
        model: modelClient.model || null,
        modelConfigured,
        automaticPrReview: true,
        ciFailureReview: true,
        queueWorkers: queueWorkerConcurrency,
        modelConcurrency,
      }),
    );
    return;
  }

  if (request.method === 'GET' && pathname === '/api/dashboard') {
    if (!dashboardToken) {
      response.writeHead(503, dashboardHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ error: 'dashboard_not_configured' }));
      return;
    }
    if (!dashboardAuthorized(request, dashboardToken)) {
      response.writeHead(401, { ...dashboardHeaders('application/json; charset=utf-8'), 'www-authenticate': 'Bearer' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      const snapshot = await createDashboardSnapshot({ queue: reviewQueue, activeWorkers,
        queueWorkers: queueWorkerConcurrency, modelConcurrency, model: modelClient.model,
        apiFormat: modelClient.format, modelConfigured });
      response.writeHead(200, dashboardHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify(snapshot));
    } catch {
      response.writeHead(500, dashboardHeaders('application/json; charset=utf-8'));
      response.end(JSON.stringify({ error: 'dashboard_unavailable' }));
    }
    return;
  }

  const dashboardAsset = request.method === 'GET' ? dashboardAssets.get(pathname) : null;
  if (dashboardAsset) {
    response.writeHead(200, dashboardHeaders(dashboardAsset.contentType));
    response.end(dashboardAsset.body);
    return;
  }

  middleware(request, response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `[Server] listening port=${port} modelConfigured=${modelConfigured} automaticPrReview=true ciFailureReview=true queueWorkers=${queueWorkerConcurrency} modelConcurrency=${modelConcurrency}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(workerTimer);
    server.close(() => process.exit(0));
  });
}
