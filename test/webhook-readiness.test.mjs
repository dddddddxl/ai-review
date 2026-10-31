import test from 'node:test';
import assert from 'node:assert/strict';
import {Webhooks} from '@octokit/webhooks';
import {registerReviewWebhooks} from '../src/review-webhooks.mjs';
import {dashboardAuthorized,dashboardHeaders} from '../src/dashboard.mjs';
const payload={action:'opened',repository:{full_name:'Test/Repo'},installation:{id:1},pull_request:{number:7,draft:false,title:'change',head:{ref:'feature',sha:'a'.repeat(40)}}};
function setup(enqueue){
 const jobs=[];const hooks=new Webhooks({secret:'synthetic-offline-webhook-secret'});hooks.onError(()=>{});
 registerReviewWebhooks(hooks,{queue:{enqueue:enqueue|| (async j=>jobs.push(j))},allowedRepositories:new Set(['test/repo'])});
 const send=async(p=payload,id='delivery',name='pull_request')=>{const text=JSON.stringify(p);return hooks.verifyAndReceive({id,name,payload:text,signature:await hooks.sign(text)});};
 return {jobs,hooks,send};
}
test('real webhook signature verifier rejects tampering before enqueue',async()=>{
 const f=setup(),text=JSON.stringify(payload),signature=await f.hooks.sign(text);
 await assert.rejects(f.hooks.verifyAndReceive({id:'bad',name:'pull_request',payload:text+' ',signature}));assert.equal(f.jobs.length,0);
});
test('signed allowed PR enqueues fixed identity; duplicate deliveries share one enqueue',async()=>{
 const f=setup();await Promise.all([f.send(),f.send()]);await f.send();assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].headSha,payload.pull_request.head.sha);assert.equal(f.jobs[0].installationId,1);
});
test('signed draft, disallowed repository, sync branch and malformed identity are ignored',async()=>{
 const f=setup();let i=0;
 for(const p of [{...payload,repository:{full_name:'other/repo'}},{...payload,pull_request:{...payload.pull_request,draft:true}},
  {...payload,pull_request:{...payload.pull_request,head:{ref:'sync/official-1',sha:'a'.repeat(40)}}},
  {...payload,pull_request:{...payload.pull_request,head:{ref:'feature',sha:'bad'}}},{...payload,installation:{id:0}}])await f.send(p,String(i++));
 assert.equal(f.jobs.length,0);
});
test('enqueue failure does not permanently consume a signed delivery',async()=>{
 let attempts=0;const f=setup(async()=>{if(++attempts===1)throw Error('synthetic disk failure');});
 await assert.rejects(f.send());await f.send();assert.equal(attempts,2);
});
test('CI success and failure events preserve head/run/attempt and use the same allowlist',async()=>{
 const f=setup();for(const conclusion of ['success','failure','skipped','cancelled'])await f.send({...payload,action:'completed',workflow_run:{id:8,run_attempt:2,head_sha:'b'.repeat(40),head_branch:'feature',conclusion}},conclusion,'workflow_run');
 assert.equal(f.jobs.length,4);assert.ok(f.jobs.every(j=>j.runAttempt===2&&j.runId===8&&j.headSha==='b'.repeat(40)&&j.kind==='ci'));
});
test('dashboard authentication fails closed and responses prevent caching/embedding',()=>{
 assert.equal(dashboardAuthorized({headers:{}},''),false);assert.equal(dashboardAuthorized({headers:{authorization:'Bearer wrong'}},'synthetic'),false);
 assert.equal(dashboardAuthorized({headers:{authorization:'Bearer synthetic'}},'synthetic'),true);
 const h=dashboardHeaders('text/html');assert.equal(h['cache-control'],'no-store');assert.equal(h['x-frame-options'],'DENY');assert.match(h['content-security-policy'],/frame-ancestors 'none'/);
});
