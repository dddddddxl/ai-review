import { createReviewControl, efficientDiagnostic } from './review-control.mjs';
import { createCiView } from './review-ci-view.mjs';
import { efficientPlan, specialistMethods, METHOD_VERSION } from './efficient-planning.mjs';
import { createGitEvidence, gitRead, sha256, isSha, sensitiveData, deniedToolResult, TOOL_PROTOCOL } from './review-evidence.mjs';
import { loadRules, rulesFor, sealManifest, finalizeManifest, locateFinding } from './review-planning.mjs';
import { loadTestSkill, validateTestAnalysis, sourceEvidenceWasRead } from './test-review-skill.mjs';
import { PR_INSTRUCTIONS, PR_VERIFICATION_INSTRUCTIONS, decodePrReview, renderPrReview } from './review-templates.mjs';
import { collectTestSnapshot } from './test-review-snapshot.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

export function aggregateTestFragments({ fragments, files, headSha, baseSha, diffBase, records }) {
  if (!fragments.length) throw new Error('invalid_test_fragment');
  const arrays = ['evidence', 'behaviors', 'observations', 'findings', 'tasks'];
  const merged = { review_version: 1, head_sha: headSha, platform: fragments[0].platform,
    summary: fragments.map(f => f.summary).join('\n'), limitations: [...new Set(fragments.flatMap(f => f.limitations || []))],
    files: [], ...Object.fromEntries(arrays.map(k => [k, []])) };
  const fileMap = new Map(), maps = Object.fromEntries(arrays.map(k => [k, new Map()]));
  for (const f of fragments) {
    if (f.review_version !== 1 || f.head_sha !== headSha || typeof f.platform !== 'string' || !f.platform || !Array.isArray(f.files) ||
        typeof f.summary !== 'string' || !f.summary || !Array.isArray(f.limitations)) throw new Error('fragment_identity_mismatch');
    // Do not silently merge conflicting platform/observation/semantic identities.
    if (f.platform !== merged.platform) throw new Error('fragment_conflict');
    for (const file of f.files) {
      if (!files.some(p => p.filename === file.path || p.previous_filename === file.path)) throw new Error('fragment_identity_mismatch');
      const prior = fileMap.get(file.path);
      if (prior && prior.status !== file.status) throw new Error('fragment_conflict');
      if (!prior) fileMap.set(file.path, file);
    }
    for (const k of arrays) {
      if (f[k] === undefined && k === 'observations') continue;
      if (!Array.isArray(f[k])) throw new Error('invalid_test_fragment');
      for (const item of f[k]) {
        if (!item || typeof item.id !== 'string' || !item.id) throw new Error('invalid_test_fragment');
        const prior = maps[k].get(item.id);
        if (prior && sha256(prior) !== sha256(item)) throw new Error('fragment_conflict');
        maps[k].set(item.id, item);
      }
    }
  }
  for (const key of arrays) merged[key] = [...maps[key].values()];
  for (const e of merged.evidence) {
    if (e.kind === 'source') {
      if (![headSha, baseSha, diffBase].includes(e.revision)) throw new Error('source_revision_invalid');
      if (!sourceEvidenceWasRead(e, records)) throw new Error('source_not_read');
    } else if (e.kind !== 'artifact' || !records.some(r => r.status === 'available' && r.tool === 'read_artifact' && r.path === e.path && !r.truncated)) throw new Error('artifact_not_read');
  }
  const observations = new Map(merged.observations.map(o => [o.id, o]));
  for (const b of merged.behaviors) {
    const textFields = ['name', 'before', 'after', 'trigger', 'risk', 'oracle', 'counterevidence', 'lane', 'platform', 'selection_reason'];
    if (textFields.some(k => typeof b[k] !== 'string' || !b[k].trim()) || !Array.isArray(b.changed_paths) || !b.changed_paths.length ||
        !Array.isArray(b.evidence) || !b.evidence.length || !Array.isArray(b.selection_evidence) || !b.selection_evidence.length ||
        !Array.isArray(b.tests) || !['supported', 'partial', 'gap', 'unknown'].includes(b.design) || !['included', 'excluded', 'conditional', 'unknown'].includes(b.selection)) throw new Error('invalid_test_fragment');
    const known = new Set(merged.evidence.map(e => e.id));
    if ([...b.evidence, ...b.selection_evidence].some(id => !known.has(id)) || b.tests.some(t => typeof t.path !== 'string' || typeof t.id !== 'string' || !t.id ||
      typeof t.assertion !== 'string' || !t.assertion || !Array.isArray(t.evidence) || !t.evidence.length || t.evidence.some(id => !known.has(id)))) throw new Error('invalid_test_fragment');
    const executions = (b.observations || []).map(id => observations.get(id));
    if (executions.some(o => !o) || new Set(executions.map(o => `${o.run_id}:${o.attempt}:${o.tested_sha}`)).size > 1) throw new Error('fragment_conflict');
  }
  // Only bookkeeping may be synthesized. Never invent behavior/oracle/selection/assertions.
  const paths = [...new Set(files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];
  merged.files = paths.map(path => fileMap.get(path) || { path, status: 'deferred', reason: '该路径尚无完整测试分析片段' });
  if (diffBase !== baseSha) { merged.diff_base = diffBase; merged.diff_base_reason = '使用 Git merge-base 固定比较范围'; }
  return merged;
}

export async function efficientReview(args, { config, captured, octokit, extraRun, testsOnly = false }) {
  const control = createReviewControl({ durationMs: config.deadlineMs ?? 180000, maxTools: config.maxTools ?? 24 });
  const codeRequested = !testsOnly && config.enabled, testsRequested = config.testEnabled;
  const records = [], history = [], batches = [], failures = [], fragments = [];
  let provider, skill, rules, bundle = captured, diffBase, repo, ciView, plan, preparationFailure, firstValidMs = null, firstCodeMs = null, firstTestMs = null, firstFragmentMs = null;
  let stage = 'main';
  const operationStage = new AsyncLocalStorage();
  const read = (directory, command) => control.run(operationStage.getStore() || stage, 'git', (signal, ms) => gitRead(directory, command, { signal, timeoutMs: Math.ceil(Math.min(ms, 15000)) }));
  const current = () => control.run(stage === 'main' || stage === 'incremental' ? stage : 'validation', 'version_check', (signal, ms) => (args.isCurrent || (async () => true))({ signal, timeoutMs: Math.ceil(Math.min(ms, 15000)) }));
  async function evidence(request) {
    control.reserveCall(stage, 'tool');
    const id = `E${Object.values(control.state().tool_calls).reduce((a, b) => a + b, 0)}`;
    let result;
    const requestStage = stage;
    try { result = { status: 'available', ...await control.run(requestStage, 'tool', () => operationStage.run(requestStage, () => provider.execute(request))) }; }
    catch (error) {
      result = { ...deniedToolResult(error, { ...request, revision: request.revision || provider.headSha }), diagnostic: efficientDiagnostic(error) };
      if (['global_time_budget', 'stage_time_budget'].includes(error.code)) { records.push({ id, ...result }); throw error; }
    }
    const record = { id, ...result };
    control.consumeCharacters(JSON.stringify(record).length, stage);
    records.push(record); return record;
  }
  async function model(instructions, input, maxOutputTokens = 12000) {
    if (!await current()) throw new Error('stale_review');
    control.reserveCall(stage, 'model');
    return control.run(stage, 'model', (signal, ms) => args.client.generateReview({ instructions, input,
      maxOutputTokens, timeoutMs: Math.ceil(ms), signal, disableThinking: true }));
  }
  try {
    const template = config.checkouts?.[args.repository] || config.checkouts?.[args.repository.toLowerCase()];
    repo = isSha(args.headSha) ? template?.replaceAll('{head}', args.headSha) : null;
    if (!repo) throw new Error('checkout_not_configured');
    const checkedHead = (await read(repo, ['rev-parse', 'HEAD'])).trim();
    if (checkedHead !== args.headSha || (await read(repo, ['status', '--porcelain', '--untracked-files=all'])).trim()) throw new Error('checkout_not_clean_or_pinned');
    diffBase = (await read(repo, ['merge-base', args.baseSha, args.headSha])).trim();
    const actualPaths = (await read(repo, ['diff', '--no-renames', '--name-only', '-z', diffBase, args.headSha])).split('\0').filter(Boolean);
    const declaredPaths = new Set(args.files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]));
    if (actualPaths.some(p => !declaredPaths.has(p)) || [...declaredPaths].some(p => !actualPaths.includes(p))) throw new Error('diff_scope_mismatch');
    if (testsRequested && !bundle) bundle = await control.run(stage, 'capture', (signal, ms) => {
      const [owner, name] = args.repository.split('/');
      const boundedOctokit = { request(route, options = {}) {
        signal.throwIfAborted(); control.assert(stage);
        if (!route.startsWith(`GET /repos/${owner}/${name}/`)) throw new Error('tool_denied');
        return octokit.request(route, { ...options, request: { ...options.request, signal, timeout: Math.ceil(Math.min(ms, 15000)) } });
      } };
      return collectTestSnapshot({ octokit: boundedOctokit, owner, repo: name, pullNumber: args.pullNumber, files: args.files, extraRun });
    });
    if (bundle && (!bundle.snapshot.capture_consistent || bundle.snapshot.pr.head_sha !== args.headSha || bundle.snapshot.pr.base_sha !== args.baseSha)) throw new Error('stale_snapshot');
    ciView = createCiView(bundle || { snapshot: { pr: { head_sha: args.headSha, base_sha: args.baseSha }, checks: [], runs: [] } });
    provider = await createGitEvidence({ repo, baseSha: args.baseSha, headSha: args.headSha, diffBase, files: args.files,
      ci: bundle || {}, cacheObjects: true, read, ciReader: ciView.page, checkpoint: () => control.assert(operationStage.getStore() || stage) });
    rules = await loadRules(provider);
    if (testsRequested) {
      try { skill = await loadTestSkill(config.skillRepo, { read }); }
      catch (error) { failures.push({ stage: 'preparation', scope: 'tests', diagnostic: efficientDiagnostic(error) }); }
    }
    plan = efficientPlan(args.files);
    for (const batch of plan.batches) batches.push({ ...batch, attempts: [], code: { complete: !codeRequested, findings: [], overview: [] }, test: null, transcript: [] });
  } catch (error) { preparationFailure = efficientDiagnostic(error); failures.push({ stage: 'preparation', scope: 'both', diagnostic: preparationFailure }); }

  async function reviewBatch(batch) {
    const begin = Date.now(), before = records.length;
    const attempt = { stage, started_ms: begin - control.started, status: 'running' }; batch.attempts.push(attempt);
    try {
      // Start with real source proof near the first supplied hunk, not the entire repository.
      if (!batch.transcript.length) {
        for (const f of batch.files.slice(0, testsRequested ? 2 : 1)) {
          const hunk = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(f.patch || '');
          const start = Math.max(1, Number(hunk?.[1] || 1) - 20);
          const existing = records.find(e => e.status === 'available' && e.tool === 'read_file' && e.revision === args.headSha && e.path === f.filename && !e.truncated && e.start <= start && e.end >= start);
          const e = existing || await evidence({ tool: 'read_file', path: f.filename, start }); batch.transcript.push(e);
        }
      }
      const methods = specialistMethods(batch.files.map(f => f.filename));
      const input = { repository: args.repository, pr: args.pullNumber, base_sha: args.baseSha, head_sha: args.headSha, diff_base: diffBase,
        platform: config.platform || '未指定',
        batch_id: batch.id, group: plan.groups.find(g => g.id === batch.group), diff: batch.text,
        requested: { code: codeRequested, tests: testsRequested && Boolean(skill) }, rules: batch.files.flatMap(f => rulesFor(rules, f.filename)),
        methods, ci: ciView.page({ limit_chars: 6000 }), artifacts: ciView.identity.artifacts,
        resume: batch.attempts.length > 1 ? { previous_failure: batch.attempts.at(-2)?.diagnostic, previous_result: batch.lastResult,
          instruction: '沿用已读证据，只纠正未完成/无效字段或增量取证；已确认结果不需要重新整轮扫描。' } : null,
        evidence_index: records.map(({ content, ...r }) => r) };
      const instructions = PR_INSTRUCTIONS + '\n【关联组共同审查】不运行代码。仅审查本批 diff 片段。未提供的相关文件按需读取，优先路径受限搜索；不得把关联线索当完整调用图。' +
        '\n最终 action=final 的 result 结构为 {"code_review":{"overview":[],"findings":[]},"test_analysis":analysis.json或null}。只返回已请求的范围；缺陷须有 existing_code 和 evidence_ids；测试补充建议不作为已确认产品 bug。' +
        (testsRequested && skill ? '\n【测试片段】使用以下固定版本 skill，但 files/behaviors 仅覆盖本批变更文件与片段；它是中间分析不是已通过最终校验。analysis.platform 统一使用 input.platform；behavior.platform 说明实际目标。head_sha 使用完整实际 SHA；所有行为、缺口和任务ID以 batch_id 作前缀，证据ID与引用一致；source 引用必须已通过 read_file 取得，不能引用 diff 猜范围。CI 摘要不是方法执行证明，无日志不要构造 observations；必要语义缺失保留未知、deferred，不编造 oracle。静态充分但运行未核实仍须 evidence_gap，不泛泛要求补测试。\n' + skill.instructions : '') +
        '\nread_ci 可填写 section=overview|checks|statuses|runs|jobs|check_detail|run_detail，cursor、id、run_id、attempt、job_id；按 next_cursor 续读，has_more 不是整体截断，未读页未知。' + TOOL_PROTOCOL;
      while (true) {
        const state = control.state();
        const remainingTools = Math.max(0, Math.min(state.limits.tools - Object.values(state.tool_calls).reduce((a, b) => a + b, 0),
          stage === 'main' ? state.limits.main_tools - state.tool_calls.main : state.limits.tools));
        const text = await model(instructions + (remainingTools ? '' : '\nFINAL_ONLY：本阶段工具配额已耗尽，只能用已有证据形成局部最终结果，未取得的证据/行为标为未知或 deferred，不得声称完整覆盖。'),
          JSON.stringify({ ...input, remaining_tools: remainingTools, remaining_model_calls: 8 - state.model_calls[stage] }) + '\n<tool_evidence>\n' + batch.transcript.map(r => JSON.stringify(r)).join('\n') + '\n</tool_evidence>');
        const decision = JSON.parse(text);
        if (sensitiveData(decision)) throw new Error('sensitive_analysis');
        if (decision.action === 'tools' && Array.isArray(decision.requests) && decision.requests.length > 0 && decision.requests.length <= 8) {
          if (!remainingTools) throw control.stop('evidence_tool_budget', stage);
          for (const request of decision.requests.slice(0, remainingTools)) {
            // Path-local first; widening remains an explicit, budgeted action.
            const scoped = request.tool === 'search_code' && request.prefix === undefined && request.expand_scope !== true
              ? { ...request, prefix: batch.files[0].filename.includes('/') ? batch.files[0].filename.slice(0, batch.files[0].filename.lastIndexOf('/') + 1) : undefined } : request;
            batch.transcript.push(await evidence(scoped));
          }
          continue;
        }
        if (decision.action !== 'final' || !decision.result || Array.isArray(decision.result)) throw new Error('invalid_tool_protocol');
        const value = decision.result; batch.lastResult = value;
        if (codeRequested) {
          const code = decodePrReview(JSON.stringify(value.code_review), batch.files);
          if (!code.complete) throw new Error('invalid_code_fragment');
          if (code.findings.some(f => typeof f.existing_code !== 'string' || !f.existing_code.trim() || !Array.isArray(f.evidence_ids) || !f.evidence_ids.length ||
            f.evidence_ids.some(id => !records.some(r => r.id === id && r.status === 'available' && !r.truncated)))) throw new Error('source_not_read');
          if (code.findings.length) {
            const response = JSON.parse(await model(PR_VERIFICATION_INSTRUCTIONS, JSON.stringify({ candidates: code.findings, diff: batch.text, evidence: batch.transcript }), 2000));
            if (!Array.isArray(response.confirmed) || response.confirmed.some(n => !Number.isInteger(n) || n < 0 || n >= code.findings.length)) throw new Error('invalid_tool_protocol');
            code.findings = [...new Set(response.confirmed)].map(n => locateFinding(code.findings[n], batch.files));
          }
          batch.code = code;
          firstCodeMs ??= Date.now() - control.started; firstValidMs ??= firstCodeMs;
        }
        if (testsRequested && skill) {
          // Identity and read proof gate each fragment before aggregation. Final Python checks still mandatory.
          aggregateTestFragments({ fragments: [value.test_analysis], files: batch.files, headSha: args.headSha, baseSha: args.baseSha, diffBase, records });
          batch.test = value.test_analysis;
          firstFragmentMs ??= Date.now() - control.started;
        }
        attempt.status = 'returned'; attempt.code_complete = batch.code.complete; attempt.test_fragment = Boolean(batch.test);
        break;
      }
    } catch (error) {
      attempt.status = 'failed'; attempt.diagnostic = efficientDiagnostic(error);
      failures.push({ batch: batch.id, stage, diagnostic: attempt.diagnostic });
    } finally {
      attempt.elapsed_ms = Date.now() - begin; attempt.evidence_ids = records.slice(before).map(e => e.id);
      history.push({ batch: batch.id, ...attempt });
    }
  }

  if (!preparationFailure) {
    // Two concurrent batches share one atomic quota. No recursive split/retry after deadline.
    for (let offset = 0; offset < batches.length; offset += 2) {
      try { control.assert('main'); if (control.state().model_calls.main >= 8) { control.stop('model_round_budget', stage); break; } } catch { break; }
      await Promise.all(batches.slice(offset, offset + 2).map(reviewBatch));
    }
    stage = 'incremental';
    for (const batch of batches) {
      if ((!codeRequested || batch.code.complete) && (!testsRequested || !skill || batch.test)) continue;
      try { control.assert(stage); if (control.state().model_calls.incremental >= 8) { control.stop('model_round_budget', stage); break; } } catch { break; }
      // Resume the same transcript. No separate full test-review round or regrouping call.
      await reviewBatch(batch);
    }
  }
  stage = 'validation';
  let testReview = testsRequested ? { status: 'incomplete', report: '测试覆盖审查未完成，不能据此判定没有测试缺口。' } : undefined;
  let analysis;
  if (testsRequested && skill && batches.some(b => b.test)) {
    try {
      if (!await current()) throw new Error('stale_review');
      fragments.push(...batches.filter(b => b.test).map(b => b.test));
      analysis = aggregateTestFragments({ fragments, files: args.files, headSha: args.headSha, baseSha: args.baseSha, diffBase, records });
      testReview = await control.run('validation', 'validation_pipeline', () => validateTestAnalysis({ skill, repo, snapshot: bundle.snapshot,
        analysis, artifacts: bundle.artifacts, outputRoot: config.outputRoot, python: config.python, control }));
      firstTestMs = Date.now() - control.started; firstValidMs ??= firstTestMs;
      if (batches.some(b => !b.test) || analysis.files.some(f => f.status === 'deferred') || plan.incompletePatches.length || !bundle.snapshot.files_complete) {
        testReview = { ...testReview, validation_status: 'validated', status: 'incomplete', report: '> 部分片段未审完，以下为已校验的局部结论。\n\n' + testReview.report };
      }
    } catch (error) { testReview = { ...testReview, diagnostic: efficientDiagnostic(error) }; failures.push({ stage: 'validation', scope: 'tests', diagnostic: testReview.diagnostic }); }
  }
  let versionCurrent = true;
  try { versionCurrent = await current(); } catch (error) { versionCurrent = false; failures.push({ stage: 'validation', scope: 'both', diagnostic: efficientDiagnostic(error) }); }
  if (!versionCurrent && testReview) testReview = { ...testReview, validation_status: testReview.status, status: 'incomplete', diagnostic: { code: 'stale_or_unverified_head' } };
  const budget = control.state(), identity = sha256({ strategy: 'efficient-v1', method_version: METHOD_VERSION, instructions: [PR_INSTRUCTIONS, PR_VERIFICATION_INSTRUCTIONS],
    methods: specialistMethods(args.files.map(f => f.filename)), head: args.headSha, base: args.baseSha,
    rules: rules?.hash, skill: skill?.hash, grouping: plan?.fingerprint, evidence_view: ciView?.identity.snapshot_sha256 });
  const sealed = plan ? sealManifest({ ...args, files: plan.files, plan, groups: plan.groups, rules, rulesHash: rules?.hash, skillHash: skill?.hash,
    evidenceHash: identity, diffBase }) : { manifest_version: 1, repository: args.repository, head_sha: args.headSha, base_sha: args.baseSha, complete: false,
    files: args.files.map(f => ({ path: f.filename, state: 'deferred', reason: preparationFailure?.code })), limitations: [], coverage: { code: 'not_measured', review: 'partial' } };
  let manifest = plan ? finalizeManifest(sealed, batches.map(b => ({ complete: codeRequested && b.code.complete }))) : sealed;
  if (!versionCurrent) { manifest.complete = false; manifest.limitations.push('最终代码版本无法核对或已经变化'); }
  manifest = { ...manifest, strategy: 'efficient', fingerprint: identity, execution: budget, attempts: history,
    required_evidence: analysis?.evidence || [], read_ranges: records.filter(r => r.tool === 'read_file').map(({ content, ...r }) => r),
    scope_status: { code: codeRequested ? manifest.complete ? 'complete' : 'partial' : 'not_requested', tests: testsRequested ? testReview.status : 'not_requested' } };
  // Keep failed reads as immutable audit entries. Resolution references only real, same-version successful reads.
  manifest.evidence_resolutions = records.filter(r => r.status !== 'available' && r.tool === 'read_file').map(r => {
    const related = records.filter(e => e.status === 'available' && e.tool === 'read_file' && !e.truncated && e.revision === r.revision && e.path === r.path);
    return { failed_id: r.id, reason: r.reason, subsequent_read_ids: related.map(e => e.id),
      resolution: r.reason === 'line_range_invalid' && related.length ? 'range_corrected_not_original_range_claimed_complete' : 'unresolved' };
  });
  if (!codeRequested) { manifest.complete = false; manifest.coverage.review = 'not_requested'; }
  const findings = batches.flatMap(b => b.code.complete ? b.code.findings : []);
  const unique = [...new Map(findings.map(f => [sha256({ file: f.file, line: f.line, existing_code: f.existing_code, title: f.title }), f])).values()];
  const codePartial = codeRequested && !manifest.complete;
  const partial = codePartial || testsRequested && testReview.status !== 'validated';
  const result = { strategy: 'efficient', reviewFindings: unique, findings: unique.length, changeOverview: batches.flatMap(b => b.code.overview || []),
    partial, codeReviewPartial: codePartial, manifest, testReview, testFragments: fragments, testAnalysis: analysis,
    failures: failures.length, failureSummary: failures, pending: batches.filter(b => !b.attempts.length).length, batches: batches.length,
    completed: batches.filter(b => b.code.complete && (!testsRequested || b.test)).length, reviewedFiles: manifest.files.filter(f => f.state === 'reviewed').length,
    evidence: records, evidenceBudget: { ...budget, calls: Object.values(budget.tool_calls).reduce((a, b) => a + b, 0), limitations: failures.map(f => f.diagnostic.code) },
    metrics: { first_valid_result_ms: firstValidMs, first_code_result_ms: firstCodeMs, first_test_report_ms: firstTestMs,
      first_test_fragment_ms: firstFragmentMs, cache: provider?.metrics || null, logical_tools: records.length, model_calls: budget.model_calls },
    body: codeRequested ? renderPrReview(JSON.stringify({ findings: unique }), { files: args.files, incompleteCoverage: codePartial,
      failedBatches: batches.filter(b => !b.code.complete).length, batchCount: batches.length }) : '未请求代码缺陷审查。' };
  // Write a versioned audit result; deliberately never restore unverified/legacy cache state.
  if (args.state) await args.state.write(identity, { repository: args.repository, pullNumber: args.pullNumber, headSha: args.headSha, baseSha: args.baseSha,
    strategy: 'efficient', manifest, testReview, evidence: records, evidenceBudget: result.evidenceBudget, partial, codeReviewPartial: codePartial });
  return result;
}
