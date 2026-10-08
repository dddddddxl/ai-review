import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { createGitEvidence } from '../src/review-evidence.mjs';
import { loadTestSkill, validateTestAnalysis } from '../src/test-review-skill.mjs';

test('source EOF excludes a terminal separator and preserves actual blank lines', async t => {
  const f = await fixture(t);
  const variants = { lf: ['a\nb\n', 2], crlf: ['a\r\nb\r\n', 2], blank: ['a\n\n', 2], no_eol: ['a\nb', 2], empty: ['', 0], cr: ['a\rb\r', 2], unicode: ['a\u2028b\u2029', 2] };
  for (const [name, [content]] of Object.entries(variants)) await f.write(name + '.txt', content);
  await f.commit(); const head = (await f.git('rev-parse', 'HEAD')).trim();
  const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: head, files: [] });
  for (const [name, [, count]] of Object.entries(variants)) {
    const request = { tool: 'read_file', path: name + '.txt' };
    if (!count) await assert.rejects(provider.execute(request), /line_range_invalid/);
    else assert.equal((await provider.execute(request)).end, count);
    await assert.rejects(provider.execute({ ...request, start: count + 1, end: count + 1 }), /line_range_invalid/);
  }
});

test('default source ranges are accepted unchanged by the actual Python validator',
  { skip: !process.env.AI_REVIEW_SKILL_REPO && 'Set AI_REVIEW_SKILL_REPO for pinned validator.' }, async t => {
    const f = await fixture(t), skill = await loadTestSkill(process.env.AI_REVIEW_SKILL_REPO);
    const provider = await createGitEvidence({ repo: f.repo, baseSha: f.base, headSha: f.head, files: f.files });
    for (const e of f.analysis.evidence) {
      const read = await provider.execute({ tool: 'read_file', path: e.path });
      e.start = read.start; e.end = read.end;
    }
    const result = await validateTestAnalysis({ skill, repo: f.repo, snapshot: f.snapshot, analysis: f.analysis,
      outputRoot: path.join(f.directory, 'out'), python: process.env.AI_REVIEW_PYTHON || 'python' });
    assert.equal(result.status, 'validated');
  });
