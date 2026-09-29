import fs from 'node:fs';
for (const name of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(name)) continue;
  let args;
  try { args = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean); }
  catch { continue; }
  if (args.length === 5 && args[0] === 'node' && args[1] === 'scripts/rerun-pr-review.mjs' && args[2] === 'HYGON-AI/sglang-das' && args[3] === '336' && args[4] === '--publish') {
    process.kill(Number(name), 'SIGTERM');
    console.log('Stopped previous diagnostic replay only.');
  }
}
