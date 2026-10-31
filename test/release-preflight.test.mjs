import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelClient} from '../src/model-client.mjs';
import {buildPrReviewPublication,publishPrReview} from '../src/pr-publication.mjs';
import {verificationRetryDecision} from '../src/retry-policy.mjs';
import {releasePreflight} from '../src/release-preflight.mjs';
import {toolSchemaErrors} from '../src/tool-schema.mjs';
import {NATIVE_REVIEW_TOOLS} from '../src/review-agent.mjs';

const env={AI_API_FORMAT:'openai-chat',AI_API_KEY:'synthetic',AI_MODEL:'mock',AI_BASE_URL:'https://mock.invalid',AI_STREAM:'true'};
const wire=events=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n');
test('tool delta diagnostics expose hashes only, never source, secrets or reasoning',async()=>{
 const events=[{choices:[{index:0,delta:{role:'assistant',reasoning_content:'PRIVATE_THOUGHT',tool_calls:[{index:0,id:'private-id',type:'function',function:{name:'file_read',arguments:'{"path":"PRIVATE_SOURCE"}'}}]},finish_reason:'tool_calls'}]}];
 const diagnostics=[];
 const client=createModelClient(env,{fetchImpl:async()=>wire(events)});
 await client.generateToolTurn({instructions:'',messages:[],tools:[],onToolDelta:e=>diagnostics.push(e),maxOutputTokens:10});
 assert.equal(diagnostics.length,1);assert.match(diagnostics[0].idHash,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(diagnostics),/PRIVATE|private-id|file_read/);
});

const pr={number:1,head:{sha:'a'.repeat(40)}};
const files=[{filename:'a.py',patch:'@@ -0,0 +1 @@\n+x = 1',status:'added'}];
const finding={priority:'P2',title:'wrong result',file:'a.py',line:1,trigger:'zero input',evidence:'x = 1',impact:'wrong output',suggestion:'handle zero'};
const result={reviewFindings:[finding],reviewedFiles:1,totalFiles:1,partial:false};
function publisher(){
 const reviews=[],writes=[];
 const octokit={paginate:async()=>structuredClone(reviews),rest:{pulls:{listReviews:()=>{},createReview:async args=>{
  writes.push(args);const review={id:1,body:args.body,user:{login:'bot'}};reviews.push(review);return {data:review};
 }}}};
 return {reviews,writes,args:{octokit,owner:'org',repo:'repo',pullNumber:1,pr,files,result,botLogin:'bot'}};
}
test('publication pins commit, locates valid lines and deduplicates repeated delivery',async()=>{
 const f=publisher();await publishPrReview(f.args);const again=await publishPrReview(f.args);
 assert.equal(f.writes.length,1);assert.equal(again.duplicate,true);
 assert.equal(f.writes[0].commit_id,pr.head.sha);assert.equal(f.writes[0].comments[0].line,1);
});
test('head guard failure prevents all review writes',async()=>{
 const f=publisher();const outcome=await publishPrReview({...f.args,isCurrent:async()=>false});
 assert.equal(outcome.stale,true);assert.equal(f.writes.length,0);
});
test('invalid location is summary-only; incomplete never becomes green',()=>{
 const publication=buildPrReviewPublication({pr,files,result:{...result,partial:true,reviewFindings:[{...finding,line:500}]}});
 assert.equal(publication.comments.length,0);assert.equal(publication.status,'审查未完成');assert.doesNotMatch(publication.body,/🟢/);
});
test('verification retry uses backoff and stops at configured ceiling',()=>{
 assert.deepEqual(verificationRetryDecision({retryCount:1},{now:100,baseDelayMs:10}),{status:'queued',retryCount:2,notBefore:120,reason:'verification_retry_scheduled'});
 assert.equal(verificationRetryDecision({retryCount:3}).status,'paused');
});
test('concurrent duplicate publications serialize within the service process',async()=>{
 const f=publisher();await Promise.all([publishPrReview(f.args),publishPrReview(f.args)]);
 assert.equal(f.writes.length,1);
});
test('deployment diagnostics fail closed and never disclose credential values',()=>{
 const report=releasePreflight({AI_API_KEY:'PRIVATE_TEST_CREDENTIAL',AI_BASE_URL:'http://test.invalid'});
 assert.equal(report.configurationReady,false);assert.equal(report.productionReady,false);
 assert.equal(report.checks.find(c=>c.id==='encrypted_model_endpoint').status,'blocked');
 assert.equal(report.checks.find(c=>c.id==='explicit_repository_allowlist').status,'blocked');
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_TEST_CREDENTIAL|test\.invalid/);
});
for(const bad of [undefined,-1,16,0.5])test(`ambiguous stream index ${bad} is rejected, never merged into index zero`,async()=>{
 const event={choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:bad,id:'a',type:'function',function:{name:'file_read',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
 const client=createModelClient(env,{fetchImpl:async()=>wire([event])});
 await assert.rejects(client.generateToolTurn({instructions:'',messages:[],tools:[]}),{reason:'stream_tool_identity'});
});
test('changing call IDs at one stream index is rejected before argument concatenation',async()=>{
 const events=['a','b'].map(id=>({choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name:'file_read',arguments:'{}'}}]}}]}));
 const client=createModelClient(env,{fetchImpl:async()=>wire(events)});
 await assert.rejects(client.generateToolTurn({instructions:'',messages:[],tools:[]}),{reason:'stream_tool_identity'});
});
test('parallel tool compatibility override is explicit and otherwise absent',async()=>{
 const bodies=[];
 const client=createModelClient({...env,AI_STREAM:'false'},{fetchImpl:async(_url,o)=>{
  bodies.push(JSON.parse(o.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'done'}}]}));
 }});
 await client.generateToolTurn({instructions:'',messages:[],tools:[],parallelToolCalls:false});
 await client.generateToolTurn({instructions:'',messages:[],tools:[]});
 assert.equal(bodies[0].parallel_tool_calls,false);assert.equal('parallel_tool_calls' in bodies[1],false);
});
test('host schema rejects wrong types, enum, missing fields and unexpected keys without echoing values',()=>{
 const schema=NATIVE_REVIEW_TOOLS.find(t=>t.function.name==='file_read').function.parameters;
 for(const value of [{side:'head'},{path:'a.py',side:'other'},{path:'a.py',start:1.5},{path:'a.py',PRIVATE_SECRET:'value'}])
  assert(toolSchemaErrors(value,schema).length>0);
 assert.equal(toolSchemaErrors({path:'a.py',side:'head',start:1,end:20},schema).length,0);
 assert.doesNotMatch(JSON.stringify(toolSchemaErrors({path:'a.py',PRIVATE_SECRET:'value'},schema)),/PRIVATE_SECRET|value/);
});
test('publication lock releases after a failed write and still blocks stale waiting results',async()=>{
 const f=publisher();let fail=true;
 const original=f.args.octokit.rest.pulls.createReview;
 f.args.octokit.rest.pulls.createReview=async args=>{if(fail){fail=false;throw Error('synthetic_write_failure');}return original(args);};
 await assert.rejects(publishPrReview(f.args));
 const stale=await publishPrReview({...f.args,isCurrent:async()=>false});assert.equal(stale.stale,true);
 await publishPrReview(f.args);assert.equal(f.writes.length,1);
});
test('opt-in JSON transport uses text protocol but leaves execution to the same host validators',async()=>{
 let body;
 const client=createModelClient({...env,AI_STREAM:'false',AI_TOOL_TRANSPORT:'json'},{fetchImpl:async(_url,o)=>{
  body=JSON.parse(o.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"tool_calls":[{"name":"file_read","arguments":{"path":"a.py"}}]}'}}]}));
 }});
 const answer=await client.generateToolTurn({instructions:'readonly',messages:[],tools:NATIVE_REVIEW_TOOLS,maxOutputTokens:100,disableThinking:true});
 assert.equal(client.toolTransport,'json');assert.equal(body.tools,undefined);
 assert.equal(answer.message.tool_calls[0].function.name,'file_read');assert.equal(answer.message.tool_calls[0].function.arguments,'{"path":"a.py"}');
 assert.match(body.messages[0].content,/允许的工具定义/);
});
test('JSON transport never silently collapses duplicate fields',async()=>{
 const content='{"tool_calls":[{"name":"file_read","arguments":{"path":"a.py","path":"b.py"}}]}';
 const client=createModelClient({...env,AI_STREAM:'false',AI_TOOL_TRANSPORT:'json'},{fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}))});
 const answer=await client.generateToolTurn({instructions:'',messages:[],tools:NATIVE_REVIEW_TOOLS});
 assert.equal(answer.message.tool_calls,undefined);assert.equal(answer.message.content,content);
});
test('unknown transport is rejected instead of silently enabling another protocol',()=>{
 assert.throws(()=>createModelClient({...env,AI_TOOL_TRANSPORT:'other'}),/Invalid AI_TOOL_TRANSPORT/);
});
