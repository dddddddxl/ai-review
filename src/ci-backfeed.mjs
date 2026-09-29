const locks = new Map();

const scopeKey = ({ repository, pullNumber, headSha }) =>
  `${String(repository).toLowerCase()}/${pullNumber}/${headSha}`;

export const ciBackfeedRecordKey = ({ repository, pullNumber, headSha, run }) =>
  `ci-backfeed/v1/${scopeKey({ repository, pullNumber, headSha })}/${run.id}/${run.run_attempt || 1}`;

async function withScopeLock(scope, action) {
  const previous = locks.get(scope) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(scope, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (locks.get(scope) === current) locks.delete(scope);
  }
}

export async function savePendingCiBackfeed(state, record) {
  if (!state) return { ...record, status: 'pending', key: ciBackfeedRecordKey(record) };
  const key = ciBackfeedRecordKey(record);
  const previous = await state.read(key);
  if (previous?.status === 'applied') return previous;
  const saved = {
    ...record,
    key,
    version: 1,
    status: 'pending',
    createdAt: previous?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  await state.write(key, saved);
  return saved;
}

export async function applyPendingCiBackfeeds({ state, repository, pullNumber, headSha, apply }) {
  if (!state?.entries || typeof apply !== 'function') return { applied: 0, deferred: 0 };
  const scope = scopeKey({ repository, pullNumber, headSha });
  return withScopeLock(scope, async () => {
    const pending = (await state.entries())
      .filter(record => record?.status === 'pending' && scopeKey(record) === scope)
      .sort((a, b) => a.createdAt - b.createdAt || a.run.id - b.run.id);
    let applied = 0, deferred = 0;
    for (const snapshot of pending) {
      const record = await state.read(snapshot.key);
      if (record?.status !== 'pending') continue;
      const outcome = await apply(record);
      if (!outcome?.integrated) { deferred++; continue; }
      await state.write(record.key, { ...record, status: 'applied', appliedAt: Date.now(), updatedAt: Date.now(),
        reviewId: outcome.reviewId || null });
      applied++;
    }
    return { applied, deferred };
  });
}
