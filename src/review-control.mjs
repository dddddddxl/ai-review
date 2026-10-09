// One immutable clock origin. Scope quotas never mint another PR budget.
export function reviewOptions(args = {}) {
  const strategy = args.strategy || 'legacy';
  if (!['legacy', 'efficient'].includes(strategy)) throw new Error('invalid_strategy');
  if (args['deadline-ms'] !== undefined && args['model-window-ms'] !== undefined ||
      strategy === 'legacy' && args['deadline-ms'] !== undefined || strategy === 'efficient' && args['model-window-ms'] !== undefined) throw new Error('conflicting_time_options');
  const deadlineMs = Number(args['deadline-ms'] ?? 180000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 1800000) throw new Error('invalid_deadline');
  return { strategy, deadlineMs };
}

export function createReviewControl({ durationMs = 180000, maxTools = 24, now = Date.now } = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || !Number.isInteger(maxTools) || maxTools < 1 || maxTools > 100) throw new Error('invalid_review_limits');
  const started = now(), deadline = started + durationMs;
  const ends = { main: started + durationMs * 2 / 3, incremental: started + durationMs * 5 / 6, validation: deadline };
  const models = { main: 0, incremental: 0, validation: 0 }, tools = { main: 0, incremental: 0, validation: 0 };
  const reserve = Math.min(4, maxTools - 1), stops = [], operations = [];
  let characterCount = 0;
  const error = (code, stage) => {
    if (!stops.some(s => s.code === code && s.stage === stage)) stops.push({ code, stage, elapsed_ms: Math.max(0, now() - started) });
    return Object.assign(new Error(code), { code, reviewStage: stage });
  };
  function remaining(stage) { return Math.max(0, Math.min(deadline, ends[stage] ?? deadline) - now()); }
  function assert(stage) {
    if (!Object.hasOwn(ends, stage)) throw new Error('invalid_review_stage');
    if (now() >= deadline) throw error('global_time_budget', stage);
    if (remaining(stage) <= 0) throw error('stage_time_budget', stage);
  }
  function reserveCall(stage, kind) {
    assert(stage);
    if (!['model', 'tool'].includes(kind)) throw new Error('invalid_review_call');
    if (kind === 'model') {
      if (models[stage] >= 8) throw error('model_round_budget', stage);
      models[stage]++;
    } else {
      if (Object.values(tools).reduce((a, b) => a + b, 0) >= maxTools || stage === 'main' && tools.main >= maxTools - reserve) throw error('evidence_tool_budget', stage);
      tools[stage]++;
    }
  }
  async function run(stage, kind, operation) {
    assert(stage);
    const milliseconds = Math.max(1, Math.ceil(remaining(stage))), signal = AbortSignal.timeout(milliseconds);
    const begin = now();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(error(now() >= deadline ? 'global_time_budget' : 'stage_time_budget', stage)); signal.addEventListener('abort', rejectAbort, { once: true }); });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { assert(stage); return operation(signal, milliseconds); }), aborted]);
      assert(stage); return value;
    } finally {
      signal.removeEventListener('abort', rejectAbort);
      operations.push({ stage, kind, elapsed_ms: Math.max(0, now() - begin) });
    }
  }
  return { started, deadline, remaining, assert, reserveCall, run, stop: error,
    consumeCharacters(n, stage) { if (characterCount + n > 120000) throw error('evidence_character_budget', stage); characterCount += n; },
    state() {
      return { strategy: 'efficient', elapsed_ms: Math.max(0, now() - started), limits: { duration_ms: durationMs, tools: maxTools,
        main_ms: durationMs * 2 / 3, incremental_ms: durationMs / 6, validation_reserved_ms: durationMs / 6,
        main_tools: maxTools - reserve, incremental_tools: reserve, model_calls_per_stage: 8, characters: 120000 },
        model_calls: { ...models }, tool_calls: { ...tools }, characters: characterCount,
        exhausted: stops.length > 0 || now() >= deadline, reason: stops.at(-1)?.code || (now() >= deadline ? 'global_time_budget' : null), stops: [...stops], operations: [...operations] };
    } };
}

export function efficientDiagnostic(error) {
  const known = ['global_time_budget', 'stage_time_budget', 'model_round_budget', 'evidence_tool_budget', 'evidence_character_budget',
    'source_not_read', 'artifact_not_read', 'source_revision_invalid', 'fragment_conflict', 'fragment_identity_mismatch', 'invalid_test_fragment',
    'skill_validation_failed', 'handoff_validation_failed', 'stale_review', 'invalid_tool_protocol', 'ci_item_size_limit', 'sensitive_analysis',
    'checkout_not_configured', 'checkout_not_clean_or_pinned', 'diff_scope_mismatch', 'stale_snapshot', 'skill_pin_mismatch', 'invalid_code_fragment'];
  const code = known.includes(error?.code || error?.message) ? error.code || error.message
    : ['TimeoutError', 'AbortError', 'APIConnectionTimeoutError'].includes(error?.name) ? 'model_request_timeout'
    : error?.code === 'ETIMEDOUT' ? 'tool_timeout' : error instanceof SyntaxError ? 'model_json_invalid'
    : error?.code === 'incomplete_response' ? 'model_response_incomplete'
    : Number.isInteger(error?.status) ? 'model_http_error' : 'review_dependency_unavailable';
  return { code, ...(Number.isInteger(error?.status) ? { http_status: error.status } : {}) };
}
