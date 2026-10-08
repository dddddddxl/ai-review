import { collectTestSnapshot } from '../src/test-review-snapshot.mjs';
import { sensitiveData } from '../src/review-evidence.mjs';
import { fail, integer, repositoryName, privateRun, writePrivate, inputIdentity } from './pr-cli-common.mjs';

export function readOnlyApi(api, { requestTimeoutMs = 15000, timeoutMs = 180000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const requests = [];
  return { requests, async request(route, params = {}) {
    if (typeof route !== 'string' || /[\r\n]/.test(route) || !/^GET \/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(route) || params.url || params.baseUrl || (params.method && params.method !== 'GET')) fail('read_only_route_required');
    const remaining = Math.min(requestTimeoutMs, deadline - Date.now());
    if (remaining <= 0) fail('capture_timeout');
    const controller = new AbortController(); let timer;
    const record = { route, page: params.page ?? null, per_page: params.per_page ?? null, timeout_ms: remaining, started_at: new Date().toISOString() };
    const started = Date.now();
    try {
      const result = await Promise.race([
        api.request(route, { ...params, request: { signal: controller.signal, timeout: remaining } }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('request_timeout')); }, remaining); }),
      ]);
      record.status = 'available'; return result;
    } catch (error) {
      record.status = error?.message === 'request_timeout' ? 'timeout' : 'unavailable'; throw error;
    } finally { clearTimeout(timer); record.elapsed_ms = Date.now() - started; requests.push(record); }
  } };
}
export async function capturePr(args, { octokit } = {}) {
  if (!args.output) fail('output_required');
  const repository = repositoryName(args.repository), [owner, repo] = repository.split('/');
  const pullNumber = integer(args.pr, NaN, 1, Number.MAX_SAFE_INTEGER);
  const requestTimeoutMs = integer(args['request-timeout-ms'], 15000, 1, 60000);
  const timeoutMs = integer(args['timeout-ms'], 180000, 1, 600000);
  const maxFilePages = integer(args['max-file-pages'], 30, 1, 30);
  if (!octokit) {
    const { Octokit } = await import('octokit');
    // Existing token or anonymous public GET only; no installation-token POST.
    octokit = new Octokit({ auth: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined, retry: { enabled: false }, throttle: { enabled: false },
      request: { timeout: requestTimeoutMs }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  }
  const api = readOnlyApi(octokit, { requestTimeoutMs, timeoutMs }), route = `/repos/${repository}/pulls/${pullNumber}`;
  const { data: before } = await api.request(`GET ${route}`);
  if (!Number.isSafeInteger(before?.changed_files) || before.changed_files < 0) fail('invalid_api_response');
  const files = []; let more = false, filesAvailable = true;
  try {
    for (let page = 1; page <= maxFilePages; page++) {
      const { data, headers = {} } = await api.request(`GET ${route}/files`, { per_page: 100, page });
      if (!Array.isArray(data)) fail('invalid_api_response');
      for (const file of data) files.push(Object.fromEntries(['filename', 'previous_filename', 'status', 'additions', 'deletions', 'changes', 'patch'].filter(k => file[k] !== undefined).map(k => [k, file[k]])));
      more = /rel="next"/.test(headers.link || '');
      if (!more) break;
    }
  } catch { filesAvailable = false; more = true; }
  const { snapshot, artifacts } = await collectTestSnapshot({ octokit: api, owner, repo, pullNumber, files });
  snapshot.files_total = before.changed_files;
  snapshot.capture_consistent = snapshot.capture_consistent && before.head?.sha === snapshot.pr.head_sha && before.base?.sha === snapshot.pr.base_sha && before.merge_commit_sha === snapshot.pr.merge_sha;
  snapshot.files_complete = snapshot.files_complete && filesAvailable && !more && files.length === before.changed_files && new Set(files.map(f => f.filename)).size === files.length;
  snapshot.endpoints.files = { status: filesAvailable ? 'available' : 'unavailable', truncated: !snapshot.files_complete };
  if (!snapshot.files_complete) snapshot.limitations.push('PR 文件列表未完整取得；不能把未列出文件计为已审查。');
  if (!snapshot.capture_consistent) snapshot.limitations.push('采集期间 PR 版本变化或无法完成身份复核；该快照不能用于冻结审查。');
  if (sensitiveData({ snapshot, artifacts })) fail('sensitive_input');
  const provenance = { kind: 'github_read_only_capture', repository, pull_number: pullNumber, github_writes: false,
    target_tests_executed: false, model_api_called: false, request_timeout_ms: requestTimeoutMs, capture_timeout_ms: timeoutMs,
    max_file_pages: maxFilePages, metadata_max_pages: 2, max_run_details: 8, max_job_logs: 4,
    requests: api.requests, input_hash: inputIdentity(snapshot, artifacts) };
  const run = await privateRun(args.output, 'pr-capture-');
  await writePrivate(run, 'fixture.json', { provenance, snapshot, artifacts });
  await writePrivate(run, 'provenance.json', provenance);
  const complete = snapshot.capture_consistent && snapshot.files_complete;
  return { exitCode: complete ? 0 : 1, run, snapshot, artifacts,
    summary: { status: complete ? 'captured' : 'incomplete', files: files.length, total_files: before.changed_files,
      capture_consistent: snapshot.capture_consistent, files_complete: snapshot.files_complete, run } };
}
