import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const stateDirectory = () => process.env.AI_REVIEW_STATE_DIR || './review-state';

// Only hashes are used as filenames. State can contain review findings: keep it private.
export class ReviewState {
  constructor(directory = stateDirectory()) { this.directory = directory; }
  async read(key) {
    try { return JSON.parse(await fs.readFile(path.join(this.directory, `${digest(key)}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(key, value) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = path.join(this.directory, `${digest(key)}.json`);
    const temp = `${destination}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, destination);
  }
  async entries() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const values = [];
    for (const file of await fs.readdir(this.directory)) {
      if (/^[a-f0-9]{64}\.json$/.test(file)) values.push(JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8')));
    }
    return values;
  }
}

// One durable inbox, consumed by the service only. CLI publishing also goes here,
// so manual continuation cannot race the webhook worker or bypass its concurrency limit.
export class ReviewQueue {
  constructor(directory = stateDirectory()) {
    this.store = new ReviewState(path.join(directory, 'jobs'));
    this.claimChain = Promise.resolve();
  }
  async enqueue(job) {
    const id = randomUUID();
    await this.store.write(id, { ...job, id, status: 'queued', createdAt: Date.now() });
    return id;
  }
  async get(id) { return this.store.read(id); }
  async update(job, status, result = {}) { await this.store.write(job.id, { ...job, status, updatedAt: Date.now(), ...result }); }
  async recover() {
    for (const job of await this.store.entries()) if (job.status === 'running') await this.update(job, 'queued');
  }
  async next(now = Date.now()) { return (await this.store.entries())
    .filter(j => j.status === 'queued' && (!Number.isFinite(j.notBefore) || j.notBefore <= now))
    .sort((a, b) => a.createdAt - b.createdAt)[0]; }
  // Serialize claims inside the single service process. Multiple queue workers
  // may process different jobs concurrently, but can never claim the same file.
  async claimNext() {
    let release;
    const previous = this.claimChain;
    this.claimChain = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const job = await this.next();
      if (!job) return undefined;
      const claimed = { ...job, status: 'running', updatedAt: Date.now() };
      await this.store.write(job.id, claimed);
      return claimed;
    } finally {
      release();
    }
  }
}

export function limitModelConcurrency(client, limit = 2) {
  let active = 0;
  const waiting = [];
  return { ...client, async generateReview(options) {
    options.signal?.throwIfAborted();
    if (active >= limit) await new Promise((resolve, reject) => {
      const entry = { resolve, signal: options.signal };
      entry.abort = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); reject(options.signal.reason); };
      options.signal?.addEventListener('abort', entry.abort, { once: true });
      waiting.push(entry);
    });
    else active++;
    try { options.signal?.throwIfAborted(); return await client.generateReview(options); }
    finally { const next = waiting.shift(); if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); } else active--; }
  } };
}
