export function evaluationIdentity(item) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(item.repository || '') || !Number.isSafeInteger(item.pullNumber) || item.pullNumber < 1 ||
      ![item.baseSha, item.headSha].every(sha => /^[a-f0-9]{40}$/.test(sha || ''))) throw new Error('frozen_evaluation_identity_required');
  return `${item.repository}#${item.pullNumber}@${item.baseSha}...${item.headSha}`;
}
export function evaluationDirectory(item) {
  evaluationIdentity(item);
  return `${item.repository.replace('/', '__')}__${item.pullNumber}__${item.baseSha}__${item.headSha}`;
}
// A location suggestion is not a semantic verdict, precision or true recall.
export function proximityMatches(expected, findings, window = 15) {
  const unique = [...new Map(findings.map(f => [JSON.stringify([f.file, f.line, f.title]), f])).values()];
  const edges = expected.flatMap((e, ei) => unique.flatMap((f, fi) =>
    e.file === f.file && Number.isInteger(e.line) && Number.isInteger(f.line) && Math.abs(e.line - f.line) <= window
      ? [{ ei, fi, distance: Math.abs(e.line - f.line) }] : [])).sort((a, b) => a.distance - b.distance || a.ei - b.ei || a.fi - b.fi);
  const used = new Set(), result = new Map();
  for (const edge of edges) if (!result.has(edge.ei) && !used.has(edge.fi)) {
    result.set(edge.ei, unique[edge.fi]); used.add(edge.fi);
  }
  return result;
}
