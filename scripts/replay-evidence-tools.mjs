// Post-freeze TOOL-only diagnostics: no model, network, test collection or repository execution.
import '../test/deny-network.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitEvidence, deniedToolResult, sha256, gitRead } from '../src/review-evidence.mjs';
import { createReviewControl } from '../src/review-control.mjs';
import { parseArgs, readBundle, frozenCheckout, privateRun, writePrivate } from './pr-cli-common.mjs';

export async function replayEvidenceTools(args) {
  const plan = JSON.parse(await fs.readFile(path.resolve(args.plan), 'utf8')), rows = [], prepared = [];
  for (const sample of plan.samples) {
    const b = await readBundle(sample.fixture), c = await frozenCheckout(sample.repo, b.snapshot);
    prepared.push({ b, c });
  }
  const requested = path.resolve(args.output);
  for (const { c } of prepared) if (requested === c.repo || requested.startsWith(c.repo + path.sep)) throw new Error('output_inside_checkout');
  const run = await privateRun(args.output, 'tool-replay-', process.cwd());
  for (const { b, c } of prepared) {
    const control = createReviewControl(), read = (repo, command) => control.run('main', 'git', (signal, ms) => gitRead(repo, command, { signal, timeoutMs: Math.ceil(Math.min(ms, 15000)) }));
    const provider = await createGitEvidence({ repo: c.repo, baseSha: b.snapshot.pr.base_sha, headSha: b.snapshot.pr.head_sha,
      diffBase: c.diffBase, files: b.snapshot.files, ci: b, cacheObjects: true, fastSearch: true, read, checkpoint: () => control.assert('main') });
    const directory = path.resolve(args.answers, `pr-${b.pullNumber}`);
    for (const name of (await fs.readdir(directory)).filter(n => /^model-answer-\d+\.json$/.test(n)).sort()) {
      const full = path.join(directory, name);
      if (!(await fs.lstat(full)).isFile() || await fs.realpath(full) !== full) throw new Error('reply_path_invalid');
      const answer = JSON.parse(JSON.parse(await fs.readFile(full, 'utf8')).final_answer);
      if (answer.action !== 'tools') continue;
      for (const request of answer.requests) {
        const start = Date.now(); control.reserveCall('main', 'tool'); let result;
        try { result = { status: 'available', ...await provider.execute(request) }; }
        catch (error) { result = deniedToolResult(error, request); }
        const { content, matches, ...metadata } = result;
        rows.push({ pr: b.pullNumber, head: b.snapshot.pr.head_sha, request, result: { ...metadata, matches_count: matches?.length,
          content_sha256: content === undefined ? null : sha256(content) }, elapsed_ms: Date.now() - start });
      }
    }
    await writePrivate(run, `pr-${b.pullNumber}.json`, { metrics: provider.metrics, budget: control.state(), rows: rows.filter(r => r.pr === b.pullNumber) });
    if (!await c.isCurrent()) throw new Error('stale_review');
  }
  await writePrivate(run, 'tool-replay.json', { kind: 'post_freeze_host_tool_only', model_api_called: false, target_tests_executed: false,
    network: false, answers_directory: path.resolve(args.answers), rows });
  return { run, requests: rows.length, available: rows.filter(r => r.result.status === 'available').length, model_api_called: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await replayEvidenceTools(parseArgs(process.argv.slice(2), ['plan', 'answers', 'output'])))); }
  catch { console.error(JSON.stringify({ status: 'failed', code: 'tool_replay_input_or_dependency_failed' })); process.exitCode = 2; }
}
