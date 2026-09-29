import { jobLog, redact } from './ci-evidence.mjs';
import { analyzeCiJobs } from './ci-analysis.mjs';
import { isRestrictedCi } from './ci-publication.mjs';
import { isUpstreamSyncBranch, isUpstreamSyncPullRequest } from './review-policy.mjs';
import { safeCiBackfeedResult, updateReviewWithCiEvidence } from './pr-publication.mjs';
import { applyPendingCiBackfeeds, ciBackfeedRecordKey, savePendingCiBackfeed } from './ci-backfeed.mjs';
export { redact } from './ci-evidence.mjs';
const failures = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
export const shouldReviewRun = (run, jobs = []) => run?.status === 'completed' &&
  (failures.has(run.conclusion) || (run.conclusion === 'cancelled' && jobs.some(job => failures.has(job.conclusion))));

const sameRepo = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function resolveRunPullRequests(octokit, repository, run) {
  if (run.pull_requests?.length) return { linked: run.pull_requests, method: 'GitHub explicit association' };
  // Some fork pull_request_target runs have an empty pull_requests array.
  // Branch is only a query filter, never evidence by itself. Do not map push,
  // schedule or workflow_dispatch runs to an arbitrary PR sharing a commit.
  if (!['pull_request', 'pull_request_target'].includes(run.event) || !run.head_sha ||
      !run.head_repository?.full_name || !run.head_branch) return { linked: [], method: 'insufficient_run_identity' };
  const owner = repository.owner.login, repo = repository.name;
  const sourceOwner = run.head_repository.full_name.split('/')[0];
  const candidates = await octokit.paginate(octokit.rest.pulls.list, {
    owner, repo, state: 'open', head: `${sourceOwner}:${run.head_branch}`, per_page: 100,
  });
  const matches = candidates.filter(pr => pr.state === 'open' &&
    sameRepo(pr.base?.repo?.full_name, repository.full_name) &&
    sameRepo(pr.head?.repo?.full_name, run.head_repository.full_name) &&
    (!run.head_repository.id || pr.head.repo.id === run.head_repository.id) &&
    pr.head.ref === run.head_branch && pr.head.sha === run.head_sha &&
    (!pr.created_at || !run.created_at || Date.parse(pr.created_at) <= Date.parse(run.created_at)));
  // Count drafts too: two possible associations must never become one by filtering a draft.
  if (matches.length !== 1) return { linked: [], method: matches.length ? 'ambiguous_pr_match' : 'no_exact_pr_match' };
  return { linked: [{ number: matches[0].number, head: { sha: run.head_sha } }], method: 'exact source repository + branch + head SHA' };
}
export function createCiReviewer({ modelClient, botLogin, readJobLog = jobLog, state, backfeedState }) {
  const active = new Set();
  return async function review({ octokit, payload }) {
    const run = payload.workflow_run;
    if (run?.status !== 'completed' || (!failures.has(run.conclusion) && run.conclusion !== 'cancelled'))
      return { status: 'skipped', reason: 'run_not_eligible' };
    if (isUpstreamSyncBranch(run.head_branch)) return { status: 'skipped', reason: 'upstream_sync_pr' };
    if (!modelClient.configured) return { status: 'paused', reason: 'model_not_configured' };
    const owner = payload.repository.owner.login, repo = payload.repository.name;
    const key = `${owner}/${repo}/${run.id}/${run.run_attempt || 1}`;
    if (active.has(key)) return { status: 'skipped', reason: 'already_active' };
    active.add(key);
    try {
      const jobs = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
        owner, repo, run_id: run.id, attempt_number: run.run_attempt || 1, per_page: 100,
      });
      if (!shouldReviewRun(run, jobs)) {
        console.log(`[CI Review] skip run=${run.id}: cancelled_without_failed_jobs`);
        return { status: 'skipped', reason: 'cancelled_without_failed_jobs' };
      }
      const association = await resolveRunPullRequests(octokit, payload.repository, run);
      if (!association.linked.length) {
        console.log(`[CI Review] skip run=${run.id}: ${association.method}`);
        return { status: 'skipped', reason: association.method };
      }
      console.log(`[CI Review] resolve run=${run.id} method=${association.method} prs=${association.linked.map(p => p.number).join(',')}`);
      let integrated = 0, deferred = 0, duplicates = 0, unfinished = 0, skippedSync = 0;
      for (const linked of association.linked) {
        const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: linked.number });
        if (pr.state !== 'open' || pr.draft || pr.base.repo.full_name !== payload.repository.full_name) continue;
        if (linked.head?.sha !== pr.head.sha) continue;
        if (association.method.startsWith('exact') && (!sameRepo(pr.head.repo?.full_name, run.head_repository.full_name) || pr.head.ref !== run.head_branch)) continue;
        if (isUpstreamSyncPullRequest(pr)) { skippedSync++; continue; }
        const restrictedPublication = isRestrictedCi(run, jobs);
        const recordIdentity = { repository: payload.repository.full_name, pullNumber: pr.number, headSha: pr.head.sha, run };
        const recordKey = ciBackfeedRecordKey(recordIdentity);
        const previous = backfeedState ? await backfeedState.read(recordKey) : null;
        const isCurrent = async () => {
          const { data: latest } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
          return latest.state === 'open' && !latest.draft && latest.head.sha === pr.head.sha && latest.base.sha === pr.base.sha;
        };
        const applyStored = () => applyPendingCiBackfeeds({ state: backfeedState, repository: payload.repository.full_name,
          pullNumber: pr.number, headSha: pr.head.sha,
          apply: record => updateReviewWithCiEvidence({ octokit, owner, repo, pullNumber: pr.number,
            headSha: pr.head.sha, botLogin, run: record.run, result: record.result,
            restricted: record.restricted, isCurrent }) });
        if (previous?.status === 'applied') { duplicates++; continue; }
        if (previous?.status === 'pending') {
          const replay = await applyStored();
          integrated += replay.applied;
          deferred += replay.deferred;
          unfinished += previous.result?.pending || 0;
          continue;
        }
        const failed = jobs.filter(job => failures.has(job.conclusion));
        const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
        const result = await analyzeCiJobs({ modelClient, files, jobs: failed, run, pr, repository: payload.repository.full_name, state,
          readLog: job => readJobLog(octokit, owner, repo, job.id),
          isCurrent,
        });
        // Do not publish a diagnosis for a PR that advanced while the model ran.
        const { data: current } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
        if (result.stale || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha || current.state !== 'open' || current.draft) continue;
        const { data: latestRun } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: run.id });
        if (latestRun.run_attempt !== (run.run_attempt || 1) || latestRun.status !== 'completed') continue;
        await savePendingCiBackfeed(backfeedState, { ...recordIdentity,
          run: { id: run.id, run_attempt: run.run_attempt || 1, name: run.name || 'CI 工作流' },
          result: safeCiBackfeedResult(result, restrictedPublication), restricted: restrictedPublication });
        const replay = await applyStored();
        integrated += replay.applied;
        deferred += replay.deferred;
        unfinished += result.pending;
        console.log(`[CI Review] backfeed run=${run.id} pr=${pr.number} integrated=${replay.applied} deferred=${replay.deferred}`);
      }
      const handled = integrated || deferred || duplicates;
      return { status: unfinished ? 'paused' : handled ? 'done' : 'skipped',
        summary: { integrated, deferred, duplicates, unfinished, skippedSync },
        reason: handled ? undefined : skippedSync ? 'upstream_sync_pr' : 'stale_or_ineligible_pr' };
    } finally { active.delete(key); }
  };
}
