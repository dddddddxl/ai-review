import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitRead, isSha, safePath, sensitiveData, sha256, safeProcessEnvironment } from '../src/review-evidence.mjs';

const exec = promisify(execFile);

export const fail = code => { throw new Error(code); };
export function parseArgs(argv, allowed) {
  const args = {};
  if (argv.length % 2) fail('invalid_arguments');
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(args, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments');
    args[key] = argv[i + 1];
  }
  return args;
}
export function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('invalid_number');
  return n;
}
export function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || ['.', '..'].includes(value.split('/')[1])) fail('invalid_repository');
  return value;
}
export function validateBundle(input) {
  // Deliberately discard fixture.analysis, provenance and every other top-level field.
  const snapshot = structuredClone(input?.snapshot), artifacts = structuredClone(input?.artifacts ?? {});
  if (!snapshot || snapshot.snapshot_version !== 1 || !snapshot.pr || !Array.isArray(snapshot.files) || typeof snapshot.files_complete !== 'boolean') fail('invalid_snapshot');
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/.exec(snapshot.repository || '');
  const repository = repositoryName(match?.[1]);
  const pullNumber = integer(snapshot.pr.number, NaN, 1, Number.MAX_SAFE_INTEGER);
  if (![snapshot.pr.base_sha, snapshot.pr.head_sha].every(isSha) || (snapshot.pr.merge_sha != null && !isSha(snapshot.pr.merge_sha))) fail('invalid_revision');
  if (snapshot.capture_consistent !== true) fail('inconsistent_snapshot');
  if (snapshot.pr.url?.toLowerCase() !== `https://github.com/${repository}/pull/${pullNumber}`.toLowerCase()) fail('snapshot_identity_mismatch');
  const seen = new Set();
  for (const file of snapshot.files) {
    if (!safePath(file.filename) || seen.has(file.filename) || !['added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged'].includes(file.status) ||
      (file.previous_filename !== undefined && !safePath(file.previous_filename)) || (file.patch !== undefined && typeof file.patch !== 'string')) fail('invalid_files');
    seen.add(file.filename);
  }
  if (snapshot.files_total !== undefined && (!Number.isSafeInteger(snapshot.files_total) || snapshot.files_total < snapshot.files.length || (snapshot.files_complete && snapshot.files_total !== snapshot.files.length))) fail('invalid_files');
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) fail('invalid_artifacts');
  for (const [name, content] of Object.entries(artifacts)) if (!safePath(name) || !name.startsWith('artifacts/') || typeof content !== 'string') fail('invalid_artifacts');
  if (sensitiveData({ snapshot, artifacts })) fail('sensitive_input');
  return { snapshot, artifacts, repository, pullNumber };
}
export async function readBundle(filename) {
  if (!filename || (await fs.stat(filename)).size > 32 * 1024 * 1024) fail('fixture_size_limit');
  return validateBundle(JSON.parse(await fs.readFile(filename, 'utf8')));
}
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
export async function privateRun(output, prefix, forbiddenRoot) {
  if (!output) fail('output_required');
  const requested = path.resolve(output);
  if (forbiddenRoot && inside(forbiddenRoot, requested)) fail('output_inside_checkout');
  let ancestor = requested;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (forbiddenRoot && inside(forbiddenRoot, real)) fail('output_inside_checkout');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const run = await fs.mkdtemp(path.join(await fs.realpath(requested), prefix));
  await fs.chmod(run, 0o700);
  // POSIX modes do not restrict inherited Windows ACLs. Seal the newly-created
  // run directory before writing any source, CI log or model request into it.
  if (process.platform === 'win32') {
    const options = { env: safeProcessEnvironment(), timeout: 15000, windowsHide: true };
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], options);
    const sid = stdout.match(/\bS-1-5-(?:\d+-)*\d+\b/)?.[0];
    if (!sid) fail('private_directory_unavailable');
    await exec('icacls.exe', [run, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], options);
  }
  return run;
}
export async function writePrivate(directory, name, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (sensitiveData(value)) fail('sensitive_output');
  await fs.writeFile(path.join(directory, name), text, { flag: 'wx', mode: 0o600 });
}
export async function frozenCheckout(repo, snapshot) {
  if (!repo) fail('repo_required');
  const root = await fs.realpath(repo);
  const isCurrent = async () => (await gitRead(root, ['rev-parse', 'HEAD'])).trim() === snapshot.pr.head_sha && !(await gitRead(root, ['status', '--porcelain', '--untracked-files=all'])).trim();
  if (!await isCurrent()) fail('checkout_not_clean_or_pinned');
  const historyShallow = (await gitRead(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  for (const sha of [snapshot.pr.base_sha, snapshot.pr.head_sha]) await gitRead(root, ['cat-file', '-e', `${sha}^{commit}`]);
  let diffBase;
  try { diffBase = (await gitRead(root, ['merge-base', snapshot.pr.base_sha, snapshot.pr.head_sha])).trim(); }
  catch (error) { if (historyShallow) fail('shallow_comparison_unverified'); throw error; }
  // A shallow history is sufficient only when the supplied base itself is
  // reachable from head: the complete comparison interval is then present.
  if (historyShallow && diffBase !== snapshot.pr.base_sha) fail('shallow_comparison_unverified');
  await gitRead(root, ['merge-base', '--is-ancestor', diffBase, snapshot.pr.head_sha]);
  return { repo: root, isCurrent, diffBase, historyShallow, ancestryVerified: true };
}
export function inputIdentity(snapshot, artifacts) { return sha256({ snapshot, artifacts }); }
export async function cliMain(run) {
  try { const result = await run(); console.log(JSON.stringify(result.summary)); process.exitCode = result.exitCode; }
  catch (error) {
    // Never expose Octokit/provider payloads, subprocess stderr or credentials.
    const safe = new Set(['invalid_arguments', 'invalid_number', 'invalid_repository', 'invalid_snapshot', 'invalid_revision', 'inconsistent_snapshot', 'snapshot_identity_mismatch', 'invalid_files', 'invalid_artifacts', 'sensitive_input', 'fixture_size_limit', 'output_required', 'output_inside_checkout', 'sensitive_output', 'repo_required', 'checkout_not_clean_or_pinned', 'shallow_comparison_unverified', 'invalid_mode', 'legacy_fixture_mismatch', 'capture_timeout', 'request_timeout', 'read_only_route_required', 'invalid_api_response', 'private_directory_unavailable']);
    console.error(JSON.stringify({ status: 'failed', code: safe.has(error?.message) ? error.message : 'cli_input_or_dependency_failed' }));
    process.exitCode = 2;
  }
}
