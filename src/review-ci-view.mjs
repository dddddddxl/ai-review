import { createHash } from 'node:crypto';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pick = (v, keys) => Object.fromEntries(keys.filter(k => v?.[k] !== undefined).map(k => [k, v[k]]));
const checkKeys = ['id', 'name', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at', 'html_url', 'details_url', 'check_suite'];
const runKeys = ['id', 'name', 'head_sha', 'run_attempt', 'event', 'relation', 'status', 'conclusion', 'html_url', 'workflow_id', 'path', 'head_branch', 'created_at', 'updated_at'];
const jobKeys = ['id', 'name', 'run_id', 'run_attempt', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at', 'html_url'];

export function createCiView(bundle) {
  const snapshot = bundle.snapshot || bundle, artifacts = bundle.artifacts || {};
  const identity = { snapshot_sha256: hash(snapshot), pr: pick(snapshot.pr, ['number', 'url', 'title', 'base_branch', 'base_sha', 'head_sha', 'merge_sha']), captured_at: snapshot.captured_at,
    capture_consistent: snapshot.capture_consistent, endpoints: snapshot.endpoints, limitations: snapshot.limitations,
    counts: { checks: snapshot.checks?.length || 0, statuses: snapshot.statuses?.length || 0, runs: snapshot.runs?.length || 0,
      jobs: (snapshot.runs || []).reduce((n, r) => n + (r.jobs?.length || 0), 0), artifacts: Object.keys(artifacts).length }, artifacts: Object.keys(artifacts).slice(0, 100), artifact_index_truncated: Object.keys(artifacts).length > 100 };
  // Omitted provider app/owner metadata is not represented as execution proof.
  const items = [
    ...(snapshot.checks || []).map(c => ({ section: 'checks', data: { ...pick(c, checkKeys),
      ...(c.check_suite ? { check_suite: pick(c.check_suite, ['id', 'head_sha', 'status', 'conclusion', 'url']) } : {}), output_available: Boolean(c.output) } })),
    ...(snapshot.statuses || []).map(c => ({ section: 'statuses', data: pick(c, ['id', 'context', 'state', 'sha', 'target_url', 'description', 'created_at']) })),
    ...(snapshot.runs || []).flatMap(r => [{ section: 'runs', data: { ...pick(r, runKeys), jobs_count: r.jobs?.length || 0 } },
      ...(r.jobs || []).map(j => ({ section: 'jobs', data: { ...pick(j, jobKeys), run_id: r.id, run_attempt: r.run_attempt, run_head_sha: r.head_sha,
        steps: (j.steps || []).map(s => pick(s, ['name', 'number', 'status', 'conclusion'])) } }))]),
    { section: 'branch_rules', data: snapshot.branch_rules }, { section: 'required_status_checks', data: snapshot.required_status_checks }];
  function page(request = {}) {
    const section = request.section || 'overview';
    if (!['overview', 'checks', 'statuses', 'runs', 'jobs', 'branch_rules', 'required_status_checks', 'check_detail', 'run_detail'].includes(section)) throw new Error('tool_denied');
    let selected = items.filter(i => section === 'overview' || i.section === section);
    if (section.endsWith('_detail')) {
      const raw = section === 'check_detail' ? snapshot.checks : snapshot.runs;
      selected = (raw || []).filter(v => String(v.id) === String(request.id) && (request.attempt === undefined || v.run_attempt === request.attempt)).map(data => ({ section, data }));
    } else {
      if (request.run_id !== undefined) selected = selected.filter(i => String(i.data?.run_id ?? i.data?.id) === String(request.run_id));
      if (request.attempt !== undefined) selected = selected.filter(i => i.data?.run_attempt === request.attempt);
      if (request.job_id !== undefined) selected = selected.filter(i => i.section === 'jobs' && String(i.data.id) === String(request.job_id));
    }
    const cursor = request.cursor ?? 0;
    const maxCharacters = request.limit_chars ?? 16000;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2000 || maxCharacters > 16000) throw new Error('query_invalid');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > selected.length) throw new Error('query_invalid');
    const result = { ...identity, section, total_items: selected.length, cursor, items: [], next_cursor: null, has_more: false, projection: !section.endsWith('_detail'), execution: 'not_verified' };
    // Keep identity bounded; detailed branch metadata is obtainable as items.
    if (JSON.stringify(result).length > 14000) throw new Error('ci_item_size_limit');
    let index = cursor;
    while (index < selected.length) {
      const next = { ...result, items: [...result.items, selected[index]], next_cursor: index + 1 < selected.length ? index + 1 : null };
      if (JSON.stringify(next).length > maxCharacters) {
        if (!result.items.length) throw new Error('ci_item_size_limit');
        result.next_cursor = index; break;
      }
      result.items.push(selected[index++]);
    }
    result.has_more = result.next_cursor !== null;
    return result;
  }
  return { identity, page };
}
