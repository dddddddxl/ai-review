// Read-only model integration probe. No GitHub comments, queue writes or CI reruns.
import assert from 'node:assert/strict';
import { createModelClient } from '../src/model-client.mjs';
import { analyzeCiJobs } from '../src/ci-analysis.mjs';

let options, live = process.argv[2] === '--live';
if (live) {
  const { readFileSync } = await import('node:fs');
  const { App } = await import('octokit');
  const { jobLog } = await import('../src/ci-evidence.mjs');
  const { resolveRunPullRequests } = await import('../src/ci-review.mjs');
  const [repository, runNumber] = process.argv.slice(3);
  const [owner, repo, extra] = (repository || '').split('/');
  const runId = Number(runNumber);
  assert(owner && repo && !extra && Number.isSafeInteger(runId) && runId > 0, 'Expected --live OWNER/REPO RUN_ID');
  const allowed = (process.env.ALLOWED_REPOSITORIES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  assert(!allowed.length || allowed.includes(repository.toLowerCase()), 'Repository not allowed');
  const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
  const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
  const octokit = await app.getInstallationOctokit(installation.id);
  const { data: run } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
  const jobs = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    { owner, repo, run_id: run.id, attempt_number: run.run_attempt || 1, per_page: 100 });
  const failed = jobs.filter(j => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(j.conclusion));
  assert(failed.length, 'Run no longer has failed jobs; historical failure will not be replayed');
  const association = await resolveRunPullRequests(octokit, run.repository, run);
  let pr = { head: { sha: run.head_sha }, base: { sha: 'not-provided' } }, files = [];
  if (association.linked.length === 1) {
    const { data: current } = await octokit.rest.pulls.get({ owner, repo, pull_number: association.linked[0].number });
    if (current.head.sha === run.head_sha) {
      pr = current;
      files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
    }
  }
  console.log(JSON.stringify({ mode: 'read-only-preview', run: run.id, attempt: run.run_attempt, files: files.length,
    currentMatchingPr: pr.number || null, note: 'Historical diagnosis preview, not a current PR publication' }));
  options = { repository, run, pr, files, jobs: failed, readLog: j => jobLog(octokit, owner, repo, j.id) };
} else {
  options = { repository: 'synthetic/ci', run: { id: 1, run_attempt: 1, name: 'Synthetic CI', head_sha: 'synthetic-head' },
    pr: { head: { sha: 'synthetic-head' }, base: { sha: 'synthetic-base' } },
    files: [{ filename: 'tests/test_mega_moe_feature.py', status: 'added', additions: 1, deletions: 0,
      patch: '@@ -0,0 +1 @@\n+from torch.testing._internal.common_distributed import MultiProcessTestCase' }],
    jobs: [{ id: 1, name: 'Unit tests', conclusion: 'failure' }, { id: 2, name: 'Finish', conclusion: 'failure' }],
    readLog: async j => ({ available: true, bytes: 900, lines: 12, selectedLines: 12, matches: 3,
      chunks: j.id === 1 ? [
        'L500: pip installation complete\nL505: torch.distributed.elastic Sending process 505 closing signal SIGTERM',
        "L601: ERROR collecting tests/test_mega_moe_feature.py\nL602: tests/test_mega_moe_feature.py:1: from torch.testing._internal.common_distributed import MultiProcessTestCase\nL603: torch/testing/_internal/common_utils.py:59: import expecttest\nL604: ModuleNotFoundError: No module named 'expecttest'",
        'L700: ERROR tests/test_mega_moe_feature.py\nL701: stopping after 1 failures\nL702: Process completed with exit code 1.'
      ] : ['L60: [[ "${UNIT_RESULT}" == "success" ]]\nL67: UNIT_RESULT: failure\nL70: Process completed with exit code 1.'] }) };
}
const result = await analyzeCiJobs({ ...options, modelClient: createModelClient() });
if (process.env.CI_PREVIEW_REPORT) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.CI_PREVIEW_REPORT, '# AI CI 失败分析预览（未发布）\n\n' + result.coverage + '\n\n' + result.body + '\n', { mode: 0o600 });
}
if (!live) {
  assert.equal(result.pending, 0);
  const overview = result.body.split('\n\n---\n\n')[0];
  assert.match(overview, /expecttest/);
  assert.match(overview, /连带失败信号/);
  assert.match(result.body, /相关：/);
  assert.match(result.body, /<details>/);
  assert.doesNotMatch(result.body, /获取.*(?:2\/3|3\/3)/);
}
console.log(JSON.stringify({ status: result.pending ? 'partial' : 'ok', complete: result.complete, pending: result.pending,
  live, published: false, body: result.body }));
