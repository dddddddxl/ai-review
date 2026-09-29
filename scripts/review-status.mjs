import { ReviewQueue, ReviewState } from '../src/review-state.mjs';
const queue = new ReviewQueue();
const checkpoints = await new ReviewState().entries();
for (const job of (await queue.store.entries()).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)) {
  const progress = checkpoints.filter(c => c.repository === job.repository && c.pullNumber === job.pullNumber && c.headSha === job.headSha)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  console.log(JSON.stringify({ id: job.id, repository: job.repository, pr: job.pullNumber, head: job.headSha,
    kind: job.kind || 'pr', runId: job.runId, runAttempt: job.runAttempt,
    status: job.status, summary: job.summary, reason: job.reason,
    checkpoint: progress ? { completed: progress.results.filter(r => r?.complete).length,
      pending: progress.results.filter(r => !r).length, failures: progress.results.filter(r => r && !r.complete).length,
      batches: progress.results.length, updatedAt: progress.updatedAt } : undefined }));
}
