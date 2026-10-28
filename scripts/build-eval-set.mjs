// Build a recall evaluation set from reference reviewer comments (by default the
// Codex connector) on merged/closed PRs. Read-only GitHub REST calls; set
// GITHUB_TOKEN to avoid the 60 requests/hour anonymous limit.
//
//   node scripts/build-eval-set.mjs HYGON-AI/vllm-plugin-das 225 244 246 ... > eval/vllm-plugin-das.json
//
// Every inline comment becomes one expected defect, keyed to the commit the
// reference reviewer saw. `label` records how strongly it is known to be real:
//   author_fixed  the PR author replied in the thread that it was fixed/addressed
//   changed_after a later commit of the same PR rewrote the commented lines
//                 (likely, not certain, to be the fix)
//   outdated      GitHub marks the comment outdated, lines not located
//   unconfirmed   none of the above; out of the recall denominator by default
//
// EVAL_REFERENCE_REVIEWERS=humans uses every non-bot reviewer instead. Human
// comments mix defects with process requests (rename, delete, move a test,
// add docs); those are dropped by keyword and the rest kept with kind=human so
// they can be scored separately and spot-checked.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [fullName, ...numbers] = process.argv.slice(2);
const reviewers = (process.env.EVAL_REFERENCE_REVIEWERS || 'chatgpt-codex-connector[bot]').split(',');
const humans = reviewers.includes('humans');
const isBot = user => user?.type === 'Bot' || /\[bot\]$/.test(user?.login || '');
// Process requests, style, questions and acknowledgements are not defects.
const processOnly = /^(?:\s*(?:lgtm|ok|好的|收到|同上|\+1|nit[:：]?)\s*$)|(?:文件名|命名|改名|改成英文|重命名|删除(?:该|这个)?文件|将该文件删除|移到|放到|挪到|补充?(?:一下)?(?:测试|readme|文档|注释)|缺少readme|不需要上传|统一规范|格式|缩进|空行|typo|rename|nit\b|style)/i;
const isQuestionOnly = body => /[?？]\s*$/.test(body.trim()) && body.trim().length < 60;
if (!/^[\w.-]+\/[\w.-]+$/.test(fullName || '') || !numbers.length) {
  throw new Error('Usage: build-eval-set.mjs OWNER/REPO PR [PR ...]');
}
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ai-review-eval',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
// EVAL_CACHE_DIR keeps raw GET responses so a rate-limited run can resume.
const cacheDir = process.env.EVAL_CACHE_DIR;
async function fetchJson(url) {
  const file = cacheDir && path.join(cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`);
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  const value = { data: await response.json(), link: response.headers.get('link') || '' };
  if (file) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
  return value;
}
async function get(path) {
  const results = [];
  for (let url = `https://api.github.com${path}`; url;) {
    const { data, link } = await fetchJson(url);
    if (!Array.isArray(data)) return data;
    results.push(...data);
    url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  }
  return results;
}
const fixedReply = /\b(?:fixed|addressed|resolved|done)\b|已修复|已修改|已处理/i;
// Codex puts the title in the first bold line: **<sub><sub>![P1 Badge](...)</sub></sub>  Title**
const titleOf = body => (/\*\*(?:(?:<\/?sub>|!\[[^\]]*\]\([^)]*\))\s*)*([^*\n]+)\*\*/.exec(body)?.[1] || body.split('\n')[0]).trim();
// Did the PR diff from the reviewed commit to the final head rewrite this line?
// Hunk old-side ranges are coordinates in the reviewed commit, as is the comment.
function touched(patch = '', line, window = 3) {
  if (!Number.isInteger(line)) return false;
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].some(([, start, count = '1']) =>
    Number(start) - window <= line && line <= Number(start) + Number(count) + window);
}
const priorityOf = body => /!\[(P\d) Badge\]/.exec(body)?.[1] || null;

const cases = [];
for (const number of numbers.map(Number)) {
  const pr = await get(`/repos/${fullName}/pulls/${number}`);
  const comments = await get(`/repos/${fullName}/pulls/${number}/comments?per_page=100`);
  const later = new Map();
  const changedFiles = async sha => {
    if (sha === pr.head.sha) return [];
    if (!later.has(sha)) later.set(sha, get(`/repos/${fullName}/compare/${sha}...${pr.head.sha}`).then(data => data.files || []));
    return later.get(sha);
  };
  const replies = new Map();
  for (const comment of comments) if (comment.in_reply_to_id) {
    replies.set(comment.in_reply_to_id, [...(replies.get(comment.in_reply_to_id) || []), comment]);
  }
  for (const comment of comments) {
    if (comment.in_reply_to_id) continue;
    if (humans ? isBot(comment.user) || comment.user?.login === pr.user?.login : !reviewers.includes(comment.user?.login)) continue;
    const body = comment.body || '';
    if (humans && (processOnly.test(body) || isQuestionOnly(body) || body.trim().length < 8)) continue;
    const thread = replies.get(comment.id) || [];
    const authorFixed = thread.some(reply => reply.user?.login === pr.user?.login && fixedReply.test(reply.body || ''));
    const line = comment.original_line ?? comment.line ?? null;
    const rewritten = !authorFixed && (await changedFiles(comment.original_commit_id))
      .some(file => file.filename === comment.path && touched(file.patch, line));
    cases.push({
      id: `${fullName}#${number}/${comment.id}`,
      repository: fullName, pullNumber: number, title: pr.title,
      baseRef: pr.base.ref, baseSha: pr.base.sha, headSha: comment.original_commit_id,
      file: comment.path, line,
      priority: priorityOf(body) || /^\s*P([0-3])\b/.exec(body)?.[0].trim() || null,
      issue: humans ? body.replace(/\s+/g, ' ').trim().slice(0, 200) : titleOf(body),
      ...(humans ? { kind: 'human', reviewer: comment.user?.login } : {}),
      label: authorFixed ? 'author_fixed' : rewritten ? 'changed_after' : comment.position === null ? 'outdated' : 'unconfirmed',
      url: comment.html_url,
    });
  }
}
process.stdout.write(`${JSON.stringify({ createdAt: new Date().toISOString(), reviewers, cases }, null, 2)}\n`);
