import fs from 'node:fs';
import { App } from 'octokit';
import { createModelClient } from '../src/model-client.mjs';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { ReviewQueue } from '../src/review-state.mjs';

const [fullName, number, mode = '--dry-run'] = process.argv.slice(2);
const [owner, repo, extra] = (fullName || '').split('/');
const pullNumber = Number(number);
if (!owner || !repo || extra || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !['--publish', '--dry-run'].includes(mode)) throw new Error('Usage: rerun-pr-review.mjs owner/repo number [--publish|--dry-run]');
const allowed = (process.env.ALLOWED_REPOSITORIES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
if (allowed.length && !allowed.includes(fullName.toLowerCase())) throw new Error('Repository not allowed');
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);
const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
if (pr.state !== 'open' || pr.draft) throw new Error('PR must be open and non-draft');
if (mode === '--publish') {
  const queue = new ReviewQueue();
  const id = await queue.enqueue({ repository: fullName, pullNumber, headSha: pr.head.sha, installationId: installation.id });
  console.log(JSON.stringify({ job: id, status: 'queued', head: pr.head.sha, message: 'Service will resume unfinished batches and publish the current native PR Review result.' }));
} else {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 });
  const result = await reviewPrBatches({ client: createModelClient(), files, repository: fullName, pullNumber, title: pr.title,
    headSha: pr.head.sha, baseSha: pr.base.sha, totalFiles: pr.changed_files,
    isCurrent: async () => {
      const { data: latest } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      return latest.state === 'open' && !latest.draft && latest.head.sha === pr.head.sha && latest.base.sha === pr.base.sha;
    } });
  console.log(JSON.stringify(result));
}
