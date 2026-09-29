import fs from 'node:fs';
import { App } from 'octokit';
import { ReviewQueue } from '../src/review-state.mjs';

const [repository, number] = process.argv.slice(2);
const [owner, repo, extra] = (repository || '').split('/');
const runId = Number(number);
if (!owner || !repo || extra || !Number.isSafeInteger(runId) || runId < 1) throw new Error('Usage: rerun-ci-review.mjs OWNER/REPO RUN_ID');
const allowed = (process.env.ALLOWED_REPOSITORIES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (allowed.length && !allowed.includes(repository.toLowerCase())) throw new Error('Repository not allowed');
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);
const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
if (run.status !== 'completed') throw new Error('Workflow must be completed; this command does not rerun CI');
const queue = new ReviewQueue();
const id = await queue.enqueue({ kind: 'ci', repository: run.repository.full_name, installationId: installation.id,
  runId, runAttempt: run.run_attempt || 1, headSha: run.head_sha });
console.log(JSON.stringify({ job: id, runId, attempt: run.run_attempt || 1, status: 'queued', message: 'Only AI analysis is queued; the CI workflow is not rerun.' }));
