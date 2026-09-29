import fs from 'node:fs';
import { App } from 'octokit';
import { jobLog, planJobEvidence } from '../src/ci-evidence.mjs';
const [repository, runText, attemptText] = process.argv.slice(2);
const [owner, repo, extra] = (repository || '').split('/');
const runId = Number(runText), attempt = Number(attemptText);
if (!owner || !repo || extra || !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Usage: check-ci-evidence.mjs OWNER/REPO RUN_ID ATTEMPT');
const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
const api = await app.getInstallationOctokit(installation.id);
const { data: latest } = await api.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
console.log(JSON.stringify({ runId, inspectedAttempt: attempt, latestAttempt: latest.run_attempt, latestStatus: latest.status, latestConclusion: latest.conclusion }));
const jobs = await api.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', { owner, repo, run_id: runId, attempt_number: attempt, per_page: 100 });
for (const job of jobs.filter(j => ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(j.conclusion))) {
  try {
    const log = await jobLog(api, owner, repo, job.id);
    const signals = log.chunks.join('\n').split('\n').filter(l => /(?:AssertionError|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|Traceback|File ")/.test(l));
    console.log(JSON.stringify({ jobId: job.id, name: job.name, ...log, chunks: undefined,
      // Bounded redacted evidence for human verification; never execute log text.
      errorEvidence: signals.slice(0, 12).map(l => l.slice(0, 450)) }));
  } catch (e) { console.log(JSON.stringify({ jobId: job.id, error: e.name })); }
}
