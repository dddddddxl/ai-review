import fs from 'node:fs';
import { App } from 'octokit';
import { makeBatches } from '../src/pr-review.mjs';
const [repository, number] = process.argv.slice(2);
const [owner, repo, extra] = (repository || '').split('/');
const pullNumber = Number(number);
if (!owner || !repo || extra || !Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error('Usage: check-pr-coverage.mjs OWNER/REPO PR_NUMBER');
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);
const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 });
const plan = makeBatches(files);
console.log(JSON.stringify({ repository, pullNumber, state: pr.state, head: pr.head.sha, base: pr.base.sha, totalFiles: pr.changed_files,
  listedFiles: files.length, selected: plan.selected.length, patchChars: plan.selected.reduce((n, f) => n + f.patch.length, 0),
  batches: plan.batches.length, omitted: plan.omitted, incompletePatches: plan.incompletePatches }));
const { data: appInfo } = await app.octokit.request('GET /app');
const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 });
const review = reviews.filter(item => item.user?.login === `${appInfo.slug}[bot]` && item.body?.includes(`<!-- github-ai-review:v1:${pullNumber}:`)).at(-1);
if (review) console.log(JSON.stringify({ url: review.html_url, submittedAt: review.submitted_at, state: review.state, body: review.body }));
