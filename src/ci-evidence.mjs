import { makeBatches } from './pr-review.mjs';

export function redact(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
}

const concrete = /Traceback \(most recent call last\)|\b(?:AssertionError|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|NameError|IndexError|KeyError|OSError|MemoryError|NotImplementedError|ZeroDivisionError)\b|FAILED\s+\S+|(?:^|\s)E\s+(?:assert|\w+Error)|AddressSanitizer|Segmentation fault|HIP error|out of memory|fatal error:/i;
const failure = /Traceback \(most recent call last\)|\b(?:AssertionError|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|NameError|IndexError|KeyError|OSError|MemoryError|NotImplementedError|ZeroDivisionError)\b|FAILED\s+\S+|(?:^|\s)E\s+(?:assert|\w+Error)|AddressSanitizer|Segmentation fault|HIP error|out of memory|fatal error:|\berror:|##\[error\]/i;
const summary = /ChildFailedError|torch\.distributed\.elastic|ProcessExitedException|Sending process|exitcode|exit code|Process completed with exit/i;

const plainLogLine = line => line.replace(/^\d{4}-\d\d-\d\dT\S+\s*/, '').replace(/^\[rank\d+\]:?\s*/, '');
const terminalException = /^(?:[\w.]+(?:Error|Exception|Interrupt|Exit|Fault)|Exception|AssertionError)(?::|\s*$)/;
const failedTest = /^(?:(?:FAIL|ERROR):\s+\S+|FAILED\s+\S+::|FAILED\s*\((?:failures|errors)=)/;

// Keep each traceback (including chained exceptions) together when it fits in
// one request. Otherwise every line continues in subsequent chunks. Selection
// is prioritized, but no longer drops later failures after a global 60k budget.
export function extractEvidence(text, { maxChars = Infinity } = {}) {
  const lines = redact(text).split('\n');
  const plain = lines.map(plainLogLine);
  const candidates = [], seen = new Set();
  let hits = 0;
  function traceEnd(start) {
    for (let j = start + 1; j < lines.length; j++) {
      if (terminalException.test(plain[j])) {
        let next = j + 1;
        while (next < lines.length && !plain[next].trim()) next++;
        if (/During handling of the above exception|The above exception was the direct cause/.test(plain[next] || '')) continue;
        return j + 1;
      }
      // An incomplete traceback ends at a test-run boundary, not thousands of
      // unrelated progress lines. Coverage remains the downloaded log prefix.
      if (/^(?:Ran \d+ tests|={5,}|-{5,}|##\[endgroup\])/.test(plain[j])) return j;
    }
    return lines.length;
  }
  for (let i = 0; i < lines.length; i++) {
    if (!/^Traceback \(most recent call last\):/.test(plain[i])) continue;
    const end = traceEnd(i);
    const start = Math.max(0, i - 4);
    const signature = plain.slice(i, end).join('\n').replace(/\[rank\d+\]|rank[=: ]+\d+/gi, '[rank]');
    if (!seen.has(signature)) candidates.push({ start, end, priority: 0 });
    seen.add(signature);
    i = Math.max(i, end - 1);
  }
  for (let i = 0; i < lines.length; i++) {
    if (!failure.test(lines[i]) && !failedTest.test(plain[i])) continue;
    hits++;
    const signature = lines[i].replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').replace(/\[rank\d+\]|rank[=: ]+\d+/gi, '[rank]').trim();
    if (seen.has(signature)) continue;
    seen.add(signature);
    const strong = failedTest.test(plain[i]) || terminalException.test(plain[i]);
    candidates.push({ start: Math.max(0, i - (strong ? 8 : 3)), end: Math.min(lines.length, i + (strong ? 18 : 8)),
      priority: strong ? 1 : concrete.test(lines[i]) && !summary.test(lines[i]) ? 3 : 4 });
  }
  candidates.push({ start: 0, end: Math.min(15, lines.length), priority: 5 });
  candidates.push({ start: Math.max(0, lines.length - 45), end: lines.length, priority: 2 });
  const chosen = new Set(); let used = 0, clipped = false;
  const blocks = [];
  for (const window of candidates.sort((a, b) => a.priority - b.priority || a.start - b.start)) {
    const indices = [];
    for (let i = window.start; i < window.end; i++) if (!chosen.has(i)) indices.push(i);
    const size = indices.reduce((n, i) => n + Math.min(lines[i].length, 4000) + 40, 0);
    if (used + size > maxChars) { clipped = true; continue; }
    for (const i of indices) chosen.add(i);
    if (indices.length) blocks.push(indices);
    used += size;
  }
  const selected = [...chosen];
  const chunks = []; let current = '', previous = -2;
  for (const block of blocks) {
    const rows = block.map(i => {
    const offset = lines[i].length > 4000 ? Math.max(0, lines[i].search(failure) - 1000) : 0;
    const row = `${i !== previous + 1 ? '\n[日志片段]\n' : ''}L${i + 1}: ${lines[i].slice(offset, offset + 4000)}${lines[i].length > 4000 ? ` [该行过长，仅展示字符偏移${offset}附近]` : ''}\n`;
    previous = i;
    return row;
    });
    const blockSize = rows.reduce((n, row) => n + row.length, 0);
    if (current && current.length + blockSize > 12000) { chunks.push(current); current = ''; }
    for (const row of rows) {
    if (current.length + row.length > 12000 && current) { chunks.push(current); current = ''; }
    current += row;
    }
  }
  if (current) chunks.push(current);
  const clippedLines = selected.filter(i => lines[i].length > 4000).length;
  return { chunks, lines: lines.length, selectedLines: selected.length, matches: hits,
    evidenceClipped: clipped || clippedLines > 0, selectionClipped: clipped, clippedLines, available: true };
}

export async function readLogStream(body, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const reader = body.getReader(), decoder = new TextDecoder();
  const parts = []; let bytes = 0, truncated = false, readError = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, maxBytes - bytes);
      parts.push(decoder.decode(value.subarray(0, take), { stream: true })); bytes += take;
      if (take < value.byteLength || bytes >= maxBytes) { truncated = true; break; }
    }
  } catch { readError = true; }
  finally { await reader.cancel().catch(() => {}); }
  parts.push(decoder.decode());
  const evidence = extractEvidence(parts.join(''));
  return { ...evidence, bytes, truncated, readError, available: bytes > 0 && !readError };
}

export async function jobLog(octokit, owner, repo, jobId) {
  const auth = await octokit.auth({ type: 'installation' });
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${auth.token}`, accept: 'application/vnd.github+json' },
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 302) throw new Error(`Log redirect HTTP ${response.status}`);
  const location = new URL(response.headers.get('location'));
  if (location.protocol !== 'https:') throw new Error('Log URL must use HTTPS');
  const download = await fetch(location, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!download.ok) throw new Error(`Log download HTTP ${download.status}`);
  return readLogStream(download.body);
}

export function planJobEvidence(files, log, job) {
  const evidence = `${job.name}\n${job.steps?.filter(s => s.conclusion === 'failure').map(s => s.name).join('\n') || ''}\n${log.chunks.join('\n')}`;
  // Exact path/basename references have priority over repository ordering. A
  // lexical hit is context selection only, not proof of a causal relationship.
  const direct = files.filter(f => {
    const basename = f.filename.split('/').at(-1);
    return evidence.includes(f.filename) || (basename.length > 5 && evidence.includes(basename));
  });
  const neighboring = direct.map(f => f.patch || '').join('\n');
  const referenced = files.filter(f => direct.includes(f) || (() => {
    const stem = f.filename.split('/').at(-1).replace(/\.[^.]+$/, '');
    return stem.length > 8 && (neighboring.includes(stem) || evidence.includes(stem));
  })());
  const plan = makeBatches(referenced);
  const logs = log.chunks.length ? log.chunks : ['日志不可用；不得推断异常内容。'];
  const count = Math.max(logs.length, plan.batches.length, 1);
  const units = Array.from({ length: count }, (_, i) => {
    const logChunk = logs[i] || logs[0];
    // Every patch batch is still scheduled once. Additional log chunks receive
    // bounded matching patch context too, rather than losing PR context just
    // because the traceback happens after the first log chunk.
    const matching = plan.batches.find(b => b.files.some(f => logChunk.includes(f.filename) || logChunk.includes(f.filename.split('/').at(-1))));
    const patch = plan.batches[i] || matching || plan.batches[0];
    return { log: logChunk, diff: patch?.text || '未匹配到日志引用的可用 PR patch；不能据此判定无关。' };
  });
  return { units, relatedFiles: referenced.length, patchFiles: plan.selected.length,
    missingPatches: plan.omitted.length, incompletePatches: plan.incompletePatches.length, totalFiles: files.length };
}
