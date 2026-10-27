// Evaluation only: immutable GitHub snapshots -> read-only evidence agent.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { App } from 'octokit';
import { createModelClient } from '../src/model-client.mjs';
import { createEvidenceTools, reviewWithEvidenceAgent, reviewWithNativeEvidenceAgent, cleanText, cleanPatch } from '../src/review-agent.mjs';
import { upstreamRoots, upstreamDefinition } from '../src/upstream-context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export { extractSources } from '../src/repository-snapshot.mjs';
import { extractSources } from '../src/repository-snapshot.mjs';
const retained = /\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|c|cc|cpp|cxx|h|hpp|cu|cuh|toml)$/i;
const excluded = /(?:^|\/)(?:\.git|node_modules|vendor|third_party|secrets?|credentials)(?:\/|$)|\.(?:pem|key)$/i;

export function readOnly(client, mutations = []) {
  client.hook.before('request', options => {
    const method = String(options.method || 'GET').toUpperCase();
    if (['GET', 'HEAD'].includes(method) || (method === 'POST' && /^\/app\/installations\/(?:\d+|\{installation_id\})\/access_tokens$/.test(options.url))) return;
    mutations.push({ method, route: 'blocked' });
    throw new Error('read_only_github_boundary');
  });
  return client;
}

async function main() {
  const [inputFile, out] = process.argv.slice(2);
  if (!inputFile || !out) throw new Error('Usage: replay-agent.mjs FROZEN_INPUT_JSON NEW_OUTPUT_DIRECTORY');
  fs.mkdirSync(out, { mode: 0o700 });
  const log = event => fs.appendFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  const inputBytes = fs.readFileSync(inputFile), frozen = JSON.parse(inputBytes);
  if (![frozen.head, frozen.base].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('fixed_sha_required');
  const [owner, repo] = frozen.repository.split('/'), blocked = [];
  const app = new App({ appId: process.env.GITHUB_APP_ID, privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8') });
  readOnly(app.octokit, blocked);
  const { data: installation } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
  const api = readOnly(await app.getInstallationOctokit(installation.id), blocked);
  const began = Date.now();
  let result;
  try {
    log({ type: 'snapshot_start', repository: frozen.repository, head: frozen.head, base: frozen.base });
    const snapshots = {};
    for (const side of ['head', 'base']) {
      const sha = frozen[side];
      const response = await api.request('GET /repos/{owner}/{repo}/tarball/{ref}', { owner, repo, ref: sha,
        request: { timeout: 120000 } });
      if (typeof response.data === 'string') throw new Error('archive_binary_required');
      snapshots[side] = extractSources(Buffer.from(response.data), sha);
      log({ type: 'snapshot_end', side, sha, files: snapshots[side].files.size, bytes: snapshots[side].bytes });
    }
    const metadata = Object.fromEntries(Object.entries(snapshots).map(([side, snapshot]) => [side, {
      sha: snapshot.sha, files: snapshot.files.size, archiveSha256: snapshot.archiveSha256,
      hashes: snapshot.hashes, omissions: snapshot.omissions, bytes: snapshot.bytes }]));
    fs.writeFileSync(path.join(out, 'snapshots.json'), JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 });
    const roots = upstreamRoots(process.env, { repository: frozen.repository, baseRef: frozen.baseRef });
    const upstreamUsed = [];
    const tools = createEvidenceTools({ snapshots, upstreamLookup: async target => {
      const found = upstreamDefinition(roots, target, { maxLines: 200 });
      if (!found || found.missing) return { target, error: 'upstream_definition_unavailable' };
      const packageRoot = roots.get(target.split('.')[0]);
      const relative = path.relative(path.dirname(packageRoot), found.file).split(path.sep).join('/');
      const sourceHash = hash(fs.readFileSync(found.file));
      upstreamUsed.push({ target, path: relative, sourceHash });
      return { target, resolvedModule: found.module, path: relative, sourceHash, start: found.start, end: found.end,
        truncated: found.clipped, text: found.text, provenance: 'configured evaluation upstream snapshot, not PR repository',
        reExportSteps: found.resolution?.length || 0 };
    } });
    const input = { repository: frozen.repository, pullNumber: frozen.pullNumber, head: frozen.head, base: frozen.base,
      title: cleanText(frozen.title), description: cleanText(frozen.description),
      files: frozen.files.map(file => ({ filename: cleanText(file.filename), status: file.status, patch: cleanPatch(file.patch ?? '') })),
      scope: { retainedExtensions: retained.source, excludes: excluded.source,
        repositoryFiles: snapshots.head.files.size, omittedFiles: snapshots.head.omittedFiles,
        availableUpstreamPackages: [...roots.keys()] } };
    fs.writeFileSync(path.join(out, 'request-input.json'), JSON.stringify(input, null, 2), { flag: 'wx', mode: 0o600 });
    const env = { ...process.env, AI_STREAM: 'true', AI_STREAM_MAX_MS: '600000', AI_STREAM_IDLE_TIMEOUT_MS: '90000' };
    const protocol = process.env.AI_AGENT_TOOL_PROTOCOL || 'native';
    if (!['native', 'legacy-json'].includes(protocol)) throw new Error('unknown_agent_tool_protocol');
    const review = protocol === 'native' ? reviewWithNativeEvidenceAgent : reviewWithEvidenceAgent;
    result = await review({ client: createModelClient(env), input, tools, onEvent: log });
    const totals = { attempts: result.calls.length, failed: result.calls.filter(call => call.error).length,
      withoutUsage: result.calls.filter(call => !Number.isFinite(call.usage?.totalTokens)).length,
      reportedTokens: result.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) };
    result = { ...result, repository: frozen.repository, pullNumber: frozen.pullNumber, head: frozen.head, base: frozen.base,
      inputSha256: hash(inputBytes), totalSecondsIncludingPreparation: (Date.now() - began) / 1000, totals,
      configuredModel: env.AI_MODEL, blockedGitHubMutations: blocked.length, commentsPublished: 0, rawReasoningSaved: false };
    fs.writeFileSync(path.join(out, 'tools.json'), JSON.stringify(tools.ledger, null, 2), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(out, 'upstream-used.json'), JSON.stringify(upstreamUsed, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    result = { complete: false, preparationFailure: error.code || error.name, commentsPublished: 0 };
    log({ type: 'preparation_error', error: result.preparationFailure });
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(out, 'done'), '', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ complete: result.complete, failure: result.failure || result.preparationFailure,
    seconds: result.totalSecondsIncludingPreparation, totals: result.totals,
    candidates: result.findings?.length, toolStats: result.toolStats }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
