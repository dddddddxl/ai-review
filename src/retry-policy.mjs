export function verificationRetryDecision(job, { limit = 3, baseDelayMs = 60000, now = Date.now() } = {}) {
  const retryCount = Number.isSafeInteger(job?.retryCount) && job.retryCount >= 0 ? job.retryCount + 1 : 1;
  if (retryCount > limit) return { status: 'paused', retryCount, reason: 'verification_retry_exhausted' };
  return {
    status: 'queued',
    retryCount,
    notBefore: now + baseDelayMs * (2 ** (retryCount - 1)),
    reason: 'verification_retry_scheduled',
  };
}
