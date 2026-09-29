// Synthetic only: never contacts GitHub, publishes comments, or writes review state.
import assert from 'node:assert/strict';
import { PR_INSTRUCTIONS, CI_INSTRUCTIONS, decodePrReview, renderCiAnalysis, generateTemplateReview } from '../src/review-templates.mjs';
import { reviewPrBatches } from '../src/pr-review.mjs';
import { analyzeCiJobs } from '../src/ci-analysis.mjs';

const { createModelClient } = await import(process.env.MODEL_CLIENT_MODULE || '../src/model-client.mjs');
const original = createModelClient();
const client = { ...original, async generateReview(options) {
  return original.generateReview({ ...options, onMetadata(metadata) {
    console.log(JSON.stringify({ metadata })); options.onMetadata?.(metadata);
  } });
} };
const cleanFiles = [{ filename: 'docs/example.md', status: 'modified', patch: '@@ -1 +1 @@\n-# Guide\n+# User guide' }];
const clean = await generateTemplateReview(client, {
  instructions: PR_INSTRUCTIONS,
  input: `Synthetic documentation title clarification. FILE: docs/example.md\n${cleanFiles[0].patch}`,
  maxOutputTokens: 2000,
  validate: text => decodePrReview(text, cleanFiles).complete,
});
assert.equal(decodePrReview(clean, cleanFiles).complete, true);
assert.equal(decodePrReview(clean, cleanFiles).findings.length, 0);
console.log(JSON.stringify({ case: 'clean-pr', status: 'ok' }));

const unknown = await generateTemplateReview(client, {
  instructions: CI_INSTRUCTIONS,
  input: 'Synthetic lint failure. 日志下载失败，未取得错误内容。PR仅修改文档标题。',
  maxOutputTokens: 2000,
  validate: text => !renderCiAnalysis(text).includes('模型未返回符合模板'),
});
assert(unknown);
assert(!renderCiAnalysis(unknown).includes('模型未返回符合模板'));
console.log(JSON.stringify({ case: 'missing-log-ci', status: 'ok', body: renderCiAnalysis(unknown) }));

const buggy = { filename: 'src/average.py', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1,4 +1,4 @@\n def average(values):\n     if not values:\n         return 0\n-    return sum(values) / len(values)\n+    return sum(values) / 0' };
const docs = { filename: 'docs/generated.md', status: 'added', additions: 180, deletions: 0,
  patch: '@@ -0,0 +1,180 @@\n' + Array.from({ length: 180 }, (_, i) => `+Documentation note ${i}: This section explains the sample project with no executable behavior.`).join('\n') };
const review = await reviewPrBatches({ client, files: [buggy, docs], repository: 'synthetic/model-probe',
  pullNumber: 1, title: 'Synthetic average regression and documentation', baseSha: 'synthetic-base', headSha: 'synthetic-head' });
assert.equal(review.failures, 0);
assert.equal(review.pending, 0);
assert.equal(review.partial, false);
assert(review.batches >= 2);
assert(review.findings >= 1, 'Known divide-by-zero defect must survive candidate verification');
console.log(JSON.stringify({ case: 'batched-pr-with-verification', status: 'ok', ...review }));

const ci = await analyzeCiJobs({ modelClient: client, files: [buggy],
  jobs: [{ id: 1, name: 'unit tests', conclusion: 'failure' }],
  run: { id: 1, run_attempt: 1, name: 'Synthetic CI', head_sha: 'synthetic-head' },
  pr: { head: { sha: 'synthetic-head' }, base: { sha: 'synthetic-base' } }, repository: 'synthetic/model-probe',
  readLog: async () => 'Traceback (most recent call last):\n  File "src/average.py", line 4, in average\n    return sum(values) / 0\nZeroDivisionError: division by zero\nFAILED tests/test_average.py::test_nonempty' });
assert.equal(ci.pending, 0);
assert.equal(ci.complete, 1);
assert(ci.body.includes('ZeroDivisionError'));
console.log(JSON.stringify({ case: 'ci-production-pipeline', status: 'ok', ...ci }));
if (client.format === 'openai-chat') {
  await assert.rejects(client.generateReview({ instructions: PR_INSTRUCTIONS,
    input: 'Return the JSON findings object for a synthetic documentation-only change.', maxOutputTokens: 1 }),
  /no complete final answer/);
  console.log(JSON.stringify({ case: 'truncated-response-rejected', status: 'ok' }));
}
console.log(JSON.stringify({ status: 'ok', model: client.model, format: client.format, syntheticOnly: true }));
