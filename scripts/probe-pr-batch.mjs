import fs from 'node:fs';
import { App } from 'octokit';
import { createModelClient } from '../src/model-client.mjs';
import { makeBatches } from '../src/pr-review.mjs';
import { PR_INSTRUCTIONS, decodePrReview } from '../src/review-templates.mjs';
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const owner = 'HYGON-AI', repo = 'sglang-das', pull_number = 336;
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const octokit = await app.getInstallationOctokit(installation.id);
const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
const batch = makeBatches(files).batches[0];
const client = createModelClient(process.env, { fetchImpl: (url, options) => {
  const body = JSON.parse(options.body);
  body.thinking = { type: 'disabled' };
  return fetch(url, { ...options, body: JSON.stringify(body) });
} });
const text = await client.generateReview({ instructions: PR_INSTRUCTIONS,
  input: `任务要求：${PR_INSTRUCTIONS}\n最多2个问题。\n<review_input>\n${batch.text}\n</review_input>\n只返回有效JSON。`, maxOutputTokens: 8000,
  onMetadata: metadata => console.log(JSON.stringify(metadata)),
});
const decoded = decodePrReview(text, batch.files);
console.log(JSON.stringify({ outputChars: text.length, findings: decoded.findings.length, complete: decoded.complete, reasons: decoded.reasons }));
if (!decoded.complete) process.exitCode = 1;
