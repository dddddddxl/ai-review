// Read-only metadata verification. Never downloads scan logs or publishes comments.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { App } from 'octokit';
import { isRestrictedCi } from '../src/ci-publication.mjs';
const repository = process.argv[2];
const [owner, repo, extra] = (repository || '').split('/');
assert(owner && repo && !extra, 'Expected OWNER/REPO');
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);
const workflows = await octokit.paginate(octokit.rest.actions.listRepoWorkflows, { owner, repo, per_page: 100 });
const protectedWorkflows = workflows.filter(w => isRestrictedCi(w));
assert(protectedWorkflows.length > 0, 'No workflow matched; inspect workflow metadata before relying on privacy classification');
console.log(JSON.stringify({ status: 'ok', repository, protectedWorkflowIds: protectedWorkflows.map(w => w.id),
  logsDownloaded: false, commentsPublished: false }));
