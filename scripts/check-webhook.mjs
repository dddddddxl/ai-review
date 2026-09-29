import { createHmac, randomUUID } from 'node:crypto';

const secret = process.env.GITHUB_WEBHOOK_SECRET;
if (!secret) throw new Error('Missing webhook secret');
const url = process.argv[2];
if (!url) throw new Error('Provide the webhook URL');
const body = JSON.stringify({ zen: 'Deployment connectivity test', hook_id: 0 });
for (const valid of [true, false]) {
  const signature = createHmac('sha256', valid ? secret : randomUUID()).update(body).digest('hex');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const passed = valid ? response.ok : [400, 401, 403].includes(response.status);
  console.log(JSON.stringify({ validSignature: valid, status: response.status, passed }));
  if (!passed) process.exitCode = 1;
}
