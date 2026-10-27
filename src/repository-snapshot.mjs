import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {cleanText} from './review-agent.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const retained = /\.(?:py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|c|cc|cpp|cxx|h|hpp|cu|cuh|toml|yaml|yml|json|ini|cfg|md|rst|sh|java|kt|sql)$/i;
const excluded = /(?:^|\/)(?:\.git|\.aws|\.ssh|\.codex|\.agents|\.env(?:\.[^/]*)?|node_modules|vendor|third_party|secrets?|credentials)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
const field = (bytes, start, length) => bytes.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');

export function extractSources(archive, sha) {
  const tar = gunzipSync(archive, { maxOutputLength: 384 * 1024 * 1024 });
  const files = new Map(), hashes = {}, omissions = [];
  let longName = null, paxPath = null, total = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const rawSize = field(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('unsupported_tar_size');
    const size = Number.parseInt(rawSize, 8), type = field(header, 156, 1);
    if (offset + 512 + size > tar.length) throw new Error('truncated_tar');
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    const name = longName || paxPath || [field(header, 345, 155), field(header, 0, 100)].filter(Boolean).join('/');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = bytes.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]+)/.exec(bytes.toString('utf8'));
      paxPath = match?.[1] ?? null; continue;
    }
    longName = null; paxPath = null;
    if (type && type !== '0') continue; // No links, devices, directories or executables are materialized.
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..')) throw new Error('unsafe_archive_path');
    const relative = name.split('/').slice(1).join('/');
    if (!relative || !retained.test(relative) || excluded.test(relative)) continue;
    if (size > 2 * 1024 * 1024 || total + size > 128 * 1024 * 1024 || files.size >= 25000) {
      omissions.push({ path: relative, reason: 'snapshot_budget' }); continue;
    }
    if (files.has(relative)) throw new Error('duplicate_archive_path');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { omissions.push({ path: relative, reason: 'invalid_utf8' }); continue; }
    if (text.includes('\0')) { omissions.push({ path: relative, reason: 'binary_content' }); continue; }
    total += size; hashes[relative] = hash(bytes); files.set(relative, cleanText(text.replace(/\r\n/g, '\n')));
  }
  return { sha, files, hashes, archiveSha256: hash(archive), omittedFiles: omissions.length, omissions, bytes: total };
}
