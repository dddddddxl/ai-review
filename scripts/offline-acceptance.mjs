import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { sha256, safeProcessEnvironment } from '../src/review-evidence.mjs';
import { SKILL_COMMIT } from '../src/test-review-skill.mjs';
if (!process.env.AI_REVIEW_SKILL_REPO) throw new Error('Acceptance requires AI_REVIEW_SKILL_REPO; skipped integration tests are not acceptance.');
const tests = (await fs.readdir('test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `test/${f}`);
const child = spawn(process.execPath, ['--import', './test/deny-network.mjs', '--test', '--test-reporter=tap', ...tests], {
  env: { ...safeProcessEnvironment(), AI_REVIEW_SKILL_REPO: process.env.AI_REVIEW_SKILL_REPO,
    ...(process.env.AI_REVIEW_PYTHON ? { AI_REVIEW_PYTHON: process.env.AI_REVIEW_PYTHON } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', b => { output += b; process.stdout.write(b); });
child.stderr.on('data', b => process.stderr.write(b));
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
const number = key => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(k => [k, number(k)]));
if (exitCode !== 0 || !counts.tests || counts.pass !== counts.tests || counts.fail || counts.skipped || counts.cancelled || counts.todo) throw new Error('Offline acceptance incomplete');
const files = ['package.json'];
for (const dir of ['src', 'test']) for (const file of (await fs.readdir(dir)).sort()) if (file.endsWith('.mjs')) files.push(`${dir}/${file}`);
for (const file of ['scripts/offline-acceptance.mjs', 'scripts/replay-sglang.mjs', 'scripts/dry-run-codex.mjs',
  'scripts/pr-cli-common.mjs', 'scripts/capture-pr-lib.mjs', 'scripts/capture-pr.mjs',
  'scripts/dry-run-pr-lib.mjs', 'scripts/dry-run-pr.mjs', 'scripts/score-blind-review.mjs']) files.push(file);
const hashes = {};
for (const file of files) hashes[file] = sha256((await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n'));
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/offline-validation.json', JSON.stringify({ validation_version: 1, kind: 'offline', real_model_called: false,
  business_comments_published: false, target_tests_executed: false, skill_commit: SKILL_COMMIT,
  node_version: process.version, counts, tests: [...output.matchAll(/^# Subtest: (.+)$/gm)].map(m => m[1]), source_sha256: hashes }, null, 2) + '\n');
console.log('Offline acceptance passed; docs/offline-validation.json written.');
