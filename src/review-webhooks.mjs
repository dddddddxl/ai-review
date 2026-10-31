import {isUpstreamSyncBranch,isUpstreamSyncPullRequest} from './review-policy.mjs';

// Register on Octokit's signature-verifying Webhooks instance. No HTTP listener,
// model call, publication or repository execution is performed by this module.
export function registerReviewWebhooks(webhooks,{queue,allowedRepositories=new Set()}) {
 const deliveries=new Map();
 const enqueue=async(context,job)=>{
  const key=typeof context.id==='string'&&context.id.length<=200?`${job.kind||'pr'}:${context.id}`:null;
  if(key&&deliveries.has(key))return deliveries.get(key);
  const pending=Promise.resolve().then(()=>queue.enqueue(job));
  if(key)deliveries.set(key,pending);
  try{return await pending;}catch(error){if(key)deliveries.delete(key);throw error;}
  finally{if(deliveries.size>1024)deliveries.delete(deliveries.keys().next().value);}
 };
 const eligible=p=>typeof p.repository?.full_name==='string'&&/^[\w.-]+\/[\w.-]+$/.test(p.repository.full_name)&&
  Number.isSafeInteger(p.installation?.id)&&p.installation.id>0&&
  (!allowedRepositories.size||allowedRepositories.has(p.repository.full_name.toLowerCase()));
 webhooks.on('workflow_run.completed',async context=>{
  const p=context.payload,r=p.workflow_run;
  if(!eligible(p)||!r||isUpstreamSyncBranch(r.head_branch)||!Number.isSafeInteger(r.id)||r.id<1||!/^[a-f0-9]{40}$/.test(r.head_sha||''))return;
  await enqueue(context,{kind:'ci',repository:p.repository.full_name,installationId:p.installation.id,runId:r.id,runAttempt:r.run_attempt||1,headSha:r.head_sha});
 });
 webhooks.on(['pull_request.opened','pull_request.synchronize','pull_request.reopened','pull_request.ready_for_review'],async context=>{
  const p=context.payload,pr=p.pull_request;
  if(!eligible(p)||!pr||pr.draft||isUpstreamSyncPullRequest(pr)||!Number.isSafeInteger(pr.number)||pr.number<1||!/^[a-f0-9]{40}$/.test(pr.head?.sha||''))return;
  await enqueue(context,{repository:p.repository.full_name,pullNumber:pr.number,headSha:pr.head.sha,installationId:p.installation.id});
 });
}
