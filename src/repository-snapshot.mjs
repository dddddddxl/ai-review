import {gunzipSync, createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {cleanText} from './review-agent.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Source, build and configuration files across Python, C/C++/CUDA/HIP, Go,
// MLIR/TableGen, Bazel and CMake repositories.
const retainedExtension = /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|inc|cu|cuh|hip|cl|s|mlir|td|proto|toml|yaml|yml|json|ini|cfg|md|mdx|rst|sh|java|kt|sql|bzl|bazel|cmake|tpl|mod|sum)$/i;
const retainedName = /(?:^|\/)(?:BUILD|WORKSPACE|MODULE|CMakeLists\.txt|Makefile|Dockerfile[^/]*|requirements[^/]*\.txt|go\.mod)$/;
const retained = path => retainedExtension.test(path) || retainedName.test(path);
const excluded = /(?:^|\/)(?:\.git|\.aws|\.ssh|\.codex|\.agents|\.env(?:\.[^/]*)?|node_modules|vendor|third_party|secrets?|credentials)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
const field = (bytes, start, length) => bytes.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');

// Shared per-entry logic for the buffered and streaming readers.
function createCollector({ maxTextBytes, maxFiles, maxFileBytes, prefer }) {
  const files = new Map(), hashes = {}, omissions = [];
  let longName = null, paxPath = null, total = 0;
  return {
    files, hashes, omissions, get total() { return total; },
    // Decides from the header alone whether the body is needed.
    wants(header) {
      const type = field(header, 156, 1), size = Number.parseInt(field(header, 124, 12).trim(), 8);
      if (type === 'L' || type === 'x') return true;
      if (type && type !== '0') return false;
      const relative = this.relative(header);
      return Boolean(relative) && retained(relative) && !excluded.test(relative) && size <= maxFileBytes;
    },
    relative(header) {
      const name = longName || paxPath || [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join('/');
      if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..')) throw new Error('unsafe_archive_path');
      return name.split('/').slice(1).join('/');
    },
    entry(header, bytes) {
      const rawSize = field(header, 124, 12).trim();
      if (!/^[0-7]+$/.test(rawSize)) throw new Error('unsupported_tar_size');
      const size = Number.parseInt(rawSize, 8), type = field(header, 156, 1);
      if (type === 'L') { longName = bytes.toString('utf8').replace(/\0.*$/s, ''); return; }
      if (type === 'x') { paxPath = /(?:^|\n)\d+ path=([^\n]+)/.exec(bytes.toString('utf8'))?.[1] ?? null; return; }
      // No links, devices, directories or executables are materialized.
      if (type && type !== '0') { longName = null; paxPath = null; return; }
      const relative = this.relative(header);
      longName = null; paxPath = null;
      if (!relative || !retained(relative) || excluded.test(relative)) return;
      // Files near the change are kept beyond the budget, up to a hard ceiling.
      const preferred = prefer(relative), ceiling = preferred ? 2 : 1;
      if (!bytes || size > maxFileBytes || total + size > maxTextBytes * ceiling || files.size >= maxFiles * ceiling) {
        omissions.push({ path: relative, reason: 'snapshot_budget' }); return;
      }
      if (files.has(relative)) throw new Error('duplicate_archive_path');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { omissions.push({ path: relative, reason: 'invalid_utf8' }); return; }
      if (text.includes('\0')) { omissions.push({ path: relative, reason: 'binary_content' }); return; }
      total += size; hashes[relative] = hash(bytes); files.set(relative, cleanText(text.replace(/\r\n/g, '\n')));
    },
  };
}

export function extractSources(archive, sha) {
  const tar = gunzipSync(archive, { maxOutputLength: 384 * 1024 * 1024 });
  const collector = createCollector({ maxTextBytes: 128 * 1024 * 1024, maxFiles: 25000, maxFileBytes: 2 * 1024 * 1024, prefer: () => false });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const rawSize = field(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('unsupported_tar_size');
    const size = Number.parseInt(rawSize, 8);
    if (offset + 512 + size > tar.length) throw new Error('truncated_tar');
    collector.entry(header, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { sha, files: collector.files, hashes: collector.hashes, archiveSha256: hash(archive), omittedFiles: collector.omissions.length,
    omissions: collector.omissions, bytes: collector.total };
}

// Streaming variant for large repositories (TensorFlow, PyTorch, OpenCV): the
// expanded archive is never held in memory; only retained source text is.
// `prefer(path)` keeps files near the change when the budget runs out.
export async function extractSourcesStreaming(archive, sha, { maxTextBytes = 256 * 1024 * 1024, maxFiles = 80000,
  maxFileBytes = 2 * 1024 * 1024, prefer = () => false } = {}) {
  const collector = createCollector({ maxTextBytes, maxFiles, maxFileBytes, prefer });
  const gunzip = createGunzip();
  gunzip.end(archive);
  let pending = Buffer.alloc(0), header = null, need = 512, keep = false, body = [], remaining = 0, done = false;
  for await (const chunk of gunzip) {
    if (done) continue;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (!done) {
      if (!header) {
        if (pending.length < 512) break;
        const block = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (block.every(byte => byte === 0)) { done = true; break; }
        const rawSize = field(block, 124, 12).trim();
        if (!/^[0-7]+$/.test(rawSize)) throw new Error('unsupported_tar_size');
        header = Buffer.from(block);
        const size = Number.parseInt(rawSize, 8);
        remaining = Math.ceil(size / 512) * 512; need = size; keep = collector.wants(header); body = [];
        if (!remaining) { collector.entry(header, Buffer.alloc(0)); header = null; }
        continue;
      }
      if (!pending.length) break;
      const take = Math.min(remaining, pending.length);
      if (keep) body.push(pending.subarray(0, take));
      pending = pending.subarray(take);
      remaining -= take;
      if (remaining) break;
      collector.entry(header, keep ? Buffer.concat(body).subarray(0, need) : null);
      header = null; body = [];
    }
  }
  if (header) throw new Error('truncated_tar');
  return { sha, files: collector.files, hashes: collector.hashes, archiveSha256: hash(archive), omittedFiles: collector.omissions.length,
    omissions: collector.omissions, bytes: collector.total, streaming: true };
}
