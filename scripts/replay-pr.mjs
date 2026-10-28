// Replay the production PR review pipeline for any head commit without publishing.
// Every GitHub request except GET/HEAD and installation-token creation is rejected,
// so a replay can never comment, review, label or edit anything.
import fs from 'node:fs';
import path from 'node:path';
import { App } from 'octokit';
import { createModelClient } from '../src/model-client.mjs';
import { createModelUsageMeter } from '../src/model-usage.mjs';
import { limitModelConcurrency, ReviewState } from '../src/review-state.mjs';
import { DEFAULT_REVIEW_DURATION_MS, reviewPrBatches } from '../src/pr-review.mjs';
import { prepareRepositoryReview } from '../src/pr-context.mjs';
import { resolveReviewProfile } from '../src/repo-profile.mjs';
import { upstreamContextForFiles, upstreamRoots } from '../src/upstream-context.mjs';
import { buildPrReviewPublication } from '../src/pr-publication.mjs';
import {createRepositoryEvidence} from '../src/review-evidence.mjs';
import {sanitizeReviewInput} from '../src/review-agent.mjs';

const usage = 'Usage: replay-pr.mjs OWNER/REPO PR [--head SHA] [--base SHA] [--base-ref NAME] [--label NAME] [--concurrency N]';
const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const [fullName, number] = argv.filter((value, i) => !value.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const [owner, repo, extra] = (fullName || '').split('/');
const pullNumber = Number(number);
if (!owner || !repo || extra || !Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error(usage);
const label = flag('label') || 'adhoc';
const concurrency = Number(flag('concurrency') || process.env.REPLAY_MODEL_CONCURRENCY || 2);
const engine = flag('engine') || process.env.AI_PR_REVIEW_ENGINE || 'evidence-v1';
if (!['evidence-v1','legacy'].includes(engine)) throw new Error('Unknown review engine');

const tokenRoute = /^\/app\/installations\/(?:\{installation_id\}|\d+)\/access_tokens$/;
function readOnly(octokit) {
  octokit.hook.before('request', options => {
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || (method === 'POST' && tokenRoute.test(options.url))) return;
    throw new Error(`replay is read-only; blocked ${method} ${options.url}`);
  });
  return octokit;
}

const app = new App({ appId: process.env.GITHUB_APP_ID,
  privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
readOnly(app.octokit);
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = readOnly(await app.getInstallationOctokit(installation.id));

const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
const headSha = flag('head') ? (await octokit.rest.repos.getCommit({ owner, repo, ref: flag('head') })).data.sha : pr.head.sha;
const baseSha = flag('base') || pr.base.sha;
const baseRef = flag('base-ref') || pr.base.ref;
// The PR file list only exists for the current head; historical heads use the
// same three-dot comparison GitHub uses for pull request diffs.
const files = headSha === pr.head.sha && baseSha === pr.base.sha
  ? await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 })
  : (await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${baseSha}...${headSha}` })).data.files;

const out = path.join(process.env.REPLAY_OUT_DIR || '/app-runs', label, `${owner}__${repo}__${pullNumber}__${headSha.slice(0, 10)}`);
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
// A repeated command must not overwrite an earlier run's evidence.
fs.mkdirSync(out, { mode: 0o700 });
const logFile = fs.createWriteStream(path.join(out, 'log.txt'));
const lines = [];
const log = message => { const line = `${new Date().toISOString()} ${message}`; lines.push(line); logFile.write(`${line}\n`); console.log(line); };

// Keep final answers and call status; reasoning token counts remain in usage.
// Raw reasoning is not requested or persisted by this harness.
const callsFile = path.join(out, 'calls.jsonl');
const meter = createModelUsageMeter(limitModelConcurrency(createModelClient(), concurrency));
let modelCallAttempts = 0, failedCalls = 0, callsWithoutUsage = 0;
const client = { ...meter.client, async generateReview(options) {
  let content = null, error = null, usageReported = false;
  modelCallAttempts++;
  try {
    content = await meter.client.generateReview({ ...options, onMetadata: metadata => {
      usageReported = ['inputTokens', 'outputTokens', 'totalTokens'].some(key => Number.isFinite(metadata[key]));
      options.onMetadata?.(metadata);
    } });
    return content;
  } catch (failure) { error = failure?.reason || failure?.code || failure?.name || 'error'; throw failure; }
  finally {
    if (error) failedCalls++;
    if (!usageReported) callsWithoutUsage++;
    fs.appendFileSync(callsFile, `${JSON.stringify({ at: new Date().toISOString(),
      phase: options.input.includes('<candidates>') ? 'verification' : 'generation',
      batch: (/批次：([^\n]+)/.exec(options.input) || [])[1] || null, inputChars: options.input.length,
      error, usageReported, content })}\n`, { mode: 0o600 });
  }
} };
if (typeof meter.client.generateToolTurn === 'function') client.generateToolTurn = async options => {
  modelCallAttempts++;
  let error = null, usageReported = false, submissions = null;
  try {
    const response = await meter.client.generateToolTurn({...options,onMetadata:metadata=>{
      usageReported=['inputTokens','outputTokens','totalTokens'].some(key=>Number.isFinite(metadata[key]));
      options.onMetadata?.(metadata);
    }});
    submissions=sanitizeReviewInput(response.message.tool_calls);
    return response;
  } catch(failure){error=failure?.reason||failure?.code||failure?.name||'error';throw failure;}
  finally {
    if(error)failedCalls++;
    if(!usageReported)callsWithoutUsage++;
    fs.appendFileSync(callsFile,JSON.stringify({at:new Date().toISOString(),native:true,
      phase:options.tools.some(t=>t.function.name==='submit_verdicts')?'verification':'generation',
      inputChars:JSON.stringify(options.messages).length,error,usageReported,submissions})+'\n',{mode:0o600});
  }
};
const scope = meter.createScope();
const started = Date.now();
const maxDurationMs = Number(process.env.AI_REVIEW_MAX_DURATION_MS) || DEFAULT_REVIEW_DURATION_MS;
log(`[Replay] start ${fullName}#${pullNumber} head=${headSha} base=${baseSha} files=${files.length} label=${label} concurrency=${concurrency}`);
const candidates = [];
const roots=upstreamRoots(process.env,{repository:fullName,baseRef});
const upstreamContext = engine==='legacy'?upstreamContextForFiles(files,{roots}):new Map();
const result = await scope.run(async () => {
  const { repositoryContext, reviewRules } = engine==='legacy'?await prepareRepositoryReview({ octokit, owner, repo, baseSha, files, upstreamRoots: roots, log }):{ repositoryContext: [], reviewRules: '' };
  const profile = resolveReviewProfile({ repository: fullName, files });
  log(`[Replay] profile ${profile.key} rules=${reviewRules.length}chars`);
  const evidenceFactory=engine==='evidence-v1'?createRepositoryEvidence({octokit,owner,repo,baseSha,headSha,roots,deadlineAt:started+maxDurationMs}):undefined;
  log(`[Replay] context ${repositoryContext.map(entry => `${entry.filename}(${entry.kinds.join('+')})`).join(' ') || '(none)'}`);
  log(`[Replay] upstream ${[...upstreamContext].map(([file, text]) => `${file}:${(text.match(/^TARGET: /gm) || []).length}targets/${text.length}chars`).join(' ') || '(none)'}`);
  return reviewPrBatches({ client, files, repository: fullName, pullNumber, title: pr.title,
    prDescription: pr.body || '', repositoryContext, upstreamContext, headSha, baseSha, totalFiles: files.length,
    engine,evidenceFactory,profile,reviewRules,thinking:process.env.AI_REVIEW_THINKING!=='off',batchParallelism:Number(process.env.AI_REVIEW_BATCH_PARALLELISM)||undefined,batchChars: Number(process.env.AI_REVIEW_BATCH_CHARS) || (engine==='evidence-v1'?80000:10000), log,
    state: new ReviewState(path.join(out, 'state')), maxDurationMs, deadlineAt: started + maxDurationMs,
    onCandidates: record => { candidates.push(record); fs.writeFileSync(path.join(out, 'candidates.json'), JSON.stringify(candidates, null, 2)); } });
});
const publication = buildPrReviewPublication({ pr: { number: pullNumber, head: { sha: headSha } }, files, result, pullNumber });
const count = pattern => lines.filter(line => pattern.test(line)).length;
const summary = {
  repository: fullName, pullNumber, headSha, baseSha, label, engine, thinking: process.env.AI_REVIEW_THINKING !== 'off', seconds: Math.round((Date.now() - started) / 1000),
  batches: result.batches, completed: result.completed, failures: result.failures, partial: result.partial,
  candidates: result.candidateCount, verificationFiltered: result.verificationFiltered, findings: result.findings,
  uncertain: result.reviewUncertain?.length ?? 0,
  baseRef, maxDurationMs, budgetExceeded: result.budgetExceeded, duplicatesMerged: result.duplicatesMerged || 0,
  modelCallAttempts, failedCalls, callsWithoutUsage,
  timeouts: count(/error=timeout/), splits: count(/\[Review split\]/), modelErrors: count(/error=model_error/),
  usage: scope.snapshot(),
  reviewFindings: result.reviewFindings.map(f => ({ priority: f.priority, file: f.file, line: f.line, title: f.title })),
  reviewUncertain: (result.reviewUncertain || []).map(f => ({ priority: f.priority, file: f.file, line: f.line, title: f.title })),
};
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(out, 'publication.md'), publication.body);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
log(`[Replay] done ${JSON.stringify(summary)}`);
logFile.end();
fs.writeFileSync(path.join(out, 'done'), '');
