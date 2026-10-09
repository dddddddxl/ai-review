// Audit uncertainty and per-scope completion are distinct. An unused failed read
// must not override a finally validated read proof, nor can code completion hide tests.
export function reviewCompletion(result, { strategy = 'legacy', mode = 'both', current = true, filesComplete = true } = {}) {
  const evidencePartial = Boolean(result.evidenceBudget?.exhausted) || (result.evidence || []).some(e => e.status !== 'available' || e.truncated);
  const code = mode === 'tests' ? 'not_requested' : !(result.codeReviewPartial ?? result.partial) && result.manifest?.complete && current && filesComplete ? 'complete' : 'partial';
  const tests = mode === 'code' ? 'not_requested' : result.testReview?.status === 'validated' && current && filesComplete &&
    (strategy === 'efficient' || !evidencePartial) ? 'validated' : 'incomplete';
  const complete = ['complete', 'not_requested'].includes(code) && ['validated', 'not_requested'].includes(tests);
  return { code, tests, overall: complete ? 'complete' : 'partial', evidencePartial };
}
