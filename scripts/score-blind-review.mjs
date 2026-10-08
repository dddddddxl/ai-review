// Summarize independently adjudicated decisions; this does not manufacture labels.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, safePath } from '../src/review-evidence.mjs';

const judgments = new Set(['supported', 'unsupported', 'incorrect', 'unknown']);
const locations = new Set(['correct', 'incorrect', 'unknown', 'not_applicable']);
const expectedOutcomes = new Set(['detected', 'missed', 'unknown']);
const requireValue = (ok, reason) => { if (!ok) throw new Error(reason); };
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

export function scoreEvaluation(data) {
  requireValue(data.evaluation_version === 1 && data.annotation_source === 'independent_agents_with_root_adjudication', 'unsupported_evaluation');
  requireValue(Number.isInteger(data.expected_samples) && data.expected_samples > 0 && Array.isArray(data.samples), 'invalid_sample_count');
  const unique = new Set();
  const totals = Object.fromEntries(['code', 'tests'].map(track => [track, {
    samples: 0, completed: 0, supported: 0, unsupported: 0, incorrect: 0, unknown: 0,
    detected: 0, missed: 0, expected_unknown: 0, location_correct: 0, location_incorrect: 0,
    location_unknown: 0, location_not_applicable: 0,
  }]));
  for (const sample of data.samples) {
    requireValue(typeof sample.id === 'string' && sample.id && !unique.has(sample.id), 'duplicate_or_missing_sample');
    unique.add(sample.id);
    requireValue(/^[0-9a-f]{40}$/.test(sample.head_sha) && typeof sample.repository === 'string', 'sample_identity_missing');
    requireValue(Array.isArray(sample.sources) && ['input', 'labels', 'first_run'].every(role => sample.sources.some(ref => ref.role === role)), 'evaluation_sources_missing');
    for (const track of ['code', 'tests']) {
      const result = sample[track], total = totals[track];
      requireValue(result && typeof result.completed === 'boolean' && Array.isArray(result.findings) && Array.isArray(result.expected), 'track_result_missing');
      total.samples++; total.completed += Number(result.completed);
      const findingIds = new Set(), expectedIds = new Set();
      for (const finding of result.findings) {
        requireValue(typeof finding.id === 'string' && finding.id && !findingIds.has(finding.id), 'duplicate_finding');
        findingIds.add(finding.id);
        requireValue(judgments.has(finding.judgment) && locations.has(finding.location) && typeof finding.reason === 'string' && finding.reason.trim(), 'invalid_adjudication');
        total[finding.judgment]++; total['location_' + finding.location]++;
      }
      for (const expected of result.expected) {
        requireValue(typeof expected.id === 'string' && expected.id && !expectedIds.has(expected.id) && expectedOutcomes.has(expected.outcome), 'invalid_expected_label');
        expectedIds.add(expected.id);
        total[expected.outcome === 'unknown' ? 'expected_unknown' : expected.outcome]++;
      }
    }
  }
  requireValue(data.samples.length <= data.expected_samples, 'more_samples_than_planned');
  for (const total of Object.values(totals)) {
    total.adjudicable_findings = total.supported + total.unsupported + total.incorrect;
    total.precision = ratio(total.supported, total.adjudicable_findings);
    total.labeled_issue_recall = ratio(total.detected, total.detected + total.missed);
    total.location_accuracy = ratio(total.location_correct, total.location_correct + total.location_incorrect);
    total.completion_rate = ratio(total.completed, total.samples);
  }
  return {
    metrics_version: 1, annotation_source: data.annotation_source, human_certified: false,
    expected_samples: data.expected_samples, observed_samples: data.samples.length,
    sample_shortfall: data.expected_samples - data.samples.length, tracks: totals,
    definitions: {
      precision: 'supported / (supported + unsupported + incorrect); unknown 单列',
      labeled_issue_recall: 'detected / (detected + missed); 仅对预先标注且可裁定的问题计算',
      location_accuracy: 'correct / (correct + incorrect); 不适用和无法验证项单列',
      completion_rate: '形成该阶段完整审查结果的样本比例；不是 CI 或硬件通过率',
      empty_denominator: 'null，不能把没有可判定项写成 100%',
    },
    limitations: ['独立代理标注并由主代理复核，不是人工认证。', '指标只描述冻结样本和已标注范围，不是全仓或生产召回率。', '工件哈希核验不能证明业务判断正确。'],
  };
}

export async function verifySources(root, data) {
  root = await fs.realpath(root);
  for (const sample of data.samples) for (const ref of sample.sources || []) {
    requireValue(safePath(ref.path) && /^[0-9a-f]{64}$/.test(ref.sha256), 'invalid_source_reference');
    const full = await fs.realpath(path.resolve(root, ref.path));
    const relative = path.relative(root, full);
    requireValue(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'source_outside_bundle');
    requireValue(sha256(await fs.readFile(full)) === ref.sha256, 'evaluation_source_hash_changed');
  }
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/score-blind-review.mjs <evaluation.json> <metrics.json>');
  const data = JSON.parse(await fs.readFile(input, 'utf8'));
  const metrics = scoreEvaluation(data);
  await verifySources(path.dirname(path.resolve(input)), data);
  await fs.writeFile(output, JSON.stringify(metrics, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'evaluation_scored', samples: metrics.observed_samples, shortfall: metrics.sample_shortfall }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
