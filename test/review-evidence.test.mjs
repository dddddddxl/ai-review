import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import {reviewPrBatches,makeBatches} from '../src/pr-review.mjs';
import {runEvidenceTurn,createRepositoryEvidence} from '../src/review-evidence.mjs';
import {createEvidenceTools} from '../src/review-agent.mjs';
import {createModelClient} from '../src/model-client.mjs';
import {limitModelConcurrency} from '../src/review-state.mjs';
import {createModelUsageMeter} from '../src/model-usage.mjs';
import {decodePrReview} from '../src/review-templates.mjs';
const files=[{filename:'a.py',status:'added',patch:'@@ -0,0 +1 @@\n+call(1, 2)',additions:1,deletions:0}];
const finding={priority:'P2',file:'a.py',line:1,title:'Missing argument',trigger:'call is evaluated',evidence:'helper needs three arguments',impact:'startup fails',suggestion:'pass the required argument'};
const response=(name,value)=>({message:{role:'assistant',tool_calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify(value)}}]}});
const generation=(findings=[],options={})=>response('submit_review',{overview:[],findings,limitations:[],coverageComplete:true,...options});
const verdict=type=>response('submit_verdicts',{verdicts:[{index:0,verdict:type,reason:'fixed source contract'}]});
const snapshots={head:{sha:'a'.repeat(40),files:new Map([['helper.py','def call(a,b,c): return a+b+c']])},base:{sha:'b'.repeat(40),files:new Map()}};
const evidenceFactory=()=>createEvidenceTools({snapshots,upstreamLookup:async()=>({error:'missing'})});
const options={repository:'synthetic/repo',pullNumber:1,title:'test',files,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),engine:'evidence-v1',evidenceFactory,log:()=>{},maxDurationMs:1000};
const client=fn=>({model:'mock',format:'openai-chat',generateToolTurn:fn,generateReview:async()=>{throw Error('must not fall back to legacy');}});
const isVerifier=o=>o.tools.some(t=>t.function.name==='submit_verdicts');
const toolsResponse=requests=>({message:{role:'assistant',tool_calls:requests.map((r,i)=>({id:'tool'+i,type:'function',function:{name:r.tool,arguments:JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>k!=='tool')))}}))}});

test('tool repair and final-object repair share four turns without starving finalization',async()=>{
 let n=0;
 const result=await runEvidenceTurn({phase:'generation',input:{},createTools:evidenceFactory,deadlineAt:Date.now()+2000,maxTurns:4,
  client:client(async()=>{
   n++;if(n===1)return {message:{role:'assistant',tool_calls:[{id:'bad',type:'function',function:{name:'code_search',arguments:'{"query":"call","query":"other"}'}}]}};
   if(n===2)return toolsResponse([{tool:'file_read',path:'helper.py'}]);
   if(n===3)return generation([{...finding,trigger:undefined}]);
   return generation([finding]);
  })});
 assert.equal(n,4);assert.equal(result.submission.findings.length,1);assert.equal(result.ledger.length,1);
});

test('generation protocol failure preserves already-read evidence in its checkpoint',async()=>{
 let n=0,saved;
 const result=await reviewPrBatches({...options,state:{read:async()=>null,write:async(_k,v)=>{saved=structuredClone(v);}},
  client:client(async()=>++n===1?toolsResponse([{tool:'file_read',path:'helper.py'}]):{message:{role:'assistant',content:'not JSON'}})});
 assert.equal(result.partial,true);assert.equal(saved.results[0].consultedEvidence.generation[0].result.path,'helper.py');
});

test('cross-batch changed-file candidates survive without completing the other batch',async()=>{
 const other={filename:'b.py',status:'added',patch:'@@ -0,0 +1 @@\n+call(1,2)',additions:1,deletions:0};
 const cross={...finding,file:'b.py'};let sawDiff=false;
 const first={...files[0],patch:files[0].patch+'\n+#'+'x'.repeat(1100),additions:2};
 const result=await reviewPrBatches({...options,files:[first,other],batchChars:1000,batchParallelism:1,client:client(async o=>{
  const input=JSON.parse(o.messages[0].content);
  if(isVerifier(o)){sawDiff=input.candidateDiffs.some(f=>f.filename==='b.py');return verdict('confirmed');}
  assert.deepEqual(input.allowedFindingPaths,['a.py','b.py']);
  return input.files[0].filename==='a.py'?generation([cross]):generation([],{coverageComplete:false});
 })});
 assert.equal(sawDiff,true);assert.equal(result.reviewFindings[0].file,'b.py');assert.equal(result.reviewedFiles,1);assert.equal(result.partialFiles,1);assert.equal(result.partial,true);
});

test('cross-batch routing still rejects files not in the selected PR diff',async()=>{
 const result=await reviewPrBatches({...options,client:client(async()=>generation([{...finding,file:'not-changed.py'}]))});
 assert.equal(result.reviewFindings.length,0);assert.equal(result.partial,true);
});

test('RC1 complete-file units never split a large patch at characters/hunks',()=>{
 const patch='@@ -0,0 +1 @@\n+'+'x'.repeat(30000);
 const plan=makeBatches([{filename:'large.py',patch,status:'added'}],{batchChars:1000,wholeFiles:true});
 assert.equal(plan.batches.length,1);assert.equal(plan.batches[0].fragments[0].end,patch.length);assert.ok(plan.batches[0].text.includes(`    1 +${'x'.repeat(30000)}`));
});
test('sensitive diff paths are omitted before model input',()=>{
 const plan=makeBatches([{filename:'.env',patch:'+credential'},{filename:'secrets/config.py',patch:'+credential'},...files],{wholeFiles:true});
 assert.equal(plan.selected.length,1);assert.equal(plan.omitted.filter(r=>r.reason==='sensitive_path').length,2);
});
test('generation uses a real read-only tool result before its final submission',async()=>{
 let calls=0;
 const result=await reviewPrBatches({...options,client:client(async o=>{
  if(isVerifier(o))return verdict('confirmed');
  if(++calls===1)return toolsResponse([{tool:'file_read',path:'helper.py'}]);
  assert.ok(o.messages.some(m=>m.role==='tool'&&m.content.includes('def call(a,b,c)')));return generation([finding]);
 })});
 assert.equal(calls,2);assert.equal(result.reviewFindings.length,1);assert.equal(result.partial,false);
});
test('evidence generation uses recall-oriented instructions and receives proactive cross-file context',async()=>{
 let generationInstructions='',generationInput='';
 const result=await reviewPrBatches({...options,
  repositoryContext:[{filename:'unchanged_helper.py',kinds:['import'],terms:['call'],origins:['a.py'],excerpt:'def call(a,b,c): return a+b+c'}],
  upstreamContext:new Map([['a.py','TARGET: pkg.mod\nclass X:\n  def f(self, impl): ...']]),
  reviewRules:'MUST pass the implementation argument',
  client:client(async o=>{
   if(isVerifier(o)){assert.ok(o.instructions.includes('缺少上下文不等于存在缺陷'));return verdict('confirmed');}
   generationInstructions=o.instructions;generationInput=o.messages[0].content;return generation([finding]);
  })});
 assert.equal(result.reviewFindings.length,1);
 assert.match(generationInstructions,/函数签名与调用参数冲突/);
 assert.ok(!generationInstructions.includes('不追求数量'));
 assert.match(generationInput,/unchanged_helper\.py/);
 assert.match(generationInput,/TARGET: pkg\.mod/);
 assert.match(generationInput,/MUST pass the implementation argument/);
});
test('verifier searches then reads a missing definition instead of only listing a limitation',async()=>{
 let turns=0;
 const result=await reviewPrBatches({...options,client:client(async o=>{
  if(!isVerifier(o))return generation([finding]);
  if(++turns===1)return toolsResponse([{tool:'code_search',query:'def call'}]);
  if(turns===2){assert.ok(o.messages.at(-1).content.includes('helper.py'));return toolsResponse([{tool:'file_read',path:'helper.py'}]);}
  assert.ok(o.tools.some(t=>t.function.name==='submit_verdicts'));
  assert.ok(o.messages.at(-1).content.includes('a,b,c'));return verdict('refuted');
 })});
 assert.equal(turns,3);assert.equal(result.reviewFindings.length,0);assert.equal(result.partial,false);
});
test('checkpoint is durable before verifier starts; resume does not regenerate candidates',async()=>{
 let saved,generations=0,verifications=0;
 const state={read:async()=>saved,write:async(_key,v)=>{saved=structuredClone(v);}};
 const mock=client(async o=>{
  if(!isVerifier(o)){generations++;return generation([finding]);}
  assert.equal(saved.results[0].pendingVerification.findings.length,1);
  if(++verifications===1)throw new DOMException('synthetic','TimeoutError');return verdict('confirmed');
 });
 const first=await reviewPrBatches({...options,state,client:mock});assert.equal(first.partial,true);
 assert.equal(saved.results[0].pendingVerification.findings.length,1);
 const second=await reviewPrBatches({...options,state,client:mock});
 assert.equal(generations,1);assert.equal(verifications,2);assert.equal(second.reviewFindings.length,1);
});
test('generation timeout makes one request, no splitting or automatic retry',async()=>{
 let calls=0;
 const result=await reviewPrBatches({...options,files:[{filename:'large.py',patch:'+x\n'.repeat(10000),status:'added'}],batchChars:1000,
 client:client(async()=>{calls++;throw new DOMException('synthetic','TimeoutError');})});
 assert.equal(calls,1);assert.equal(result.batches,1);assert.equal(result.partial,true);
});
test('missing native tools cannot silently fall back or produce a green result',async()=>{
 let legacy=0;const result=await reviewPrBatches({...options,client:{model:'mock',generateReview:async()=>{legacy++;return '{"findings":[]}';}}});
 assert.equal(legacy,0);assert.equal(result.partial,true);assert.equal(result.completed,0);
});
test('plain prose without actual function calls is incomplete, not a clean review',async()=>{
 const result=await reviewPrBatches({...options,client:client(async()=>({message:{role:'assistant',content:'No issues'}}))});
 assert.equal(result.partial,true);assert.equal(result.completed,0);
});
test('an unavailable evidence read cannot become clean even if model claims coverageComplete',async()=>{
 let calls=0;const result=await reviewPrBatches({...options,client:client(async()=>++calls===1?
  toolsResponse([{tool:'file_read',path:'missing.py'}]):generation())});
 assert.equal(result.partial,true);assert.equal(calls,2);
});
test('coverageComplete=false remains incomplete even with an empty findings array',async()=>{
 const result=await reviewPrBatches({...options,client:client(async()=>generation([],{coverageComplete:false,limitations:['missing caller']}))});
 assert.equal(result.partial,true);assert.equal(result.completed,0);
});
test('a generic no-runtime-test limitation does not falsely invalidate static coverage',async()=>{
 const result=await reviewPrBatches({...options,client:client(async()=>generation([],{limitations:['no runtime execution']}))});
 assert.equal(result.partial,false);
});
test('missing candidate metadata is retained privately and cannot become clean',async()=>{
 let saved;const {priority,...unranked}=finding;
 const result=await reviewPrBatches({...options,state:{read:async()=>null,write:async(_k,v)=>{saved=structuredClone(v);}},client:client(async()=>generation([unranked]))});
 assert.equal(result.partial,true);assert.equal(saved.results[0].submittedCandidates.length,1);assert.equal(result.reviewFindings.length,0);
});
test('current version changes stop tool reads and discard stale results',async()=>{
 let current=true,reads=0;
 const result=await reviewPrBatches({...options,isCurrent:async()=>current,evidenceFactory:()=>({execute:async()=>{reads++;return {};}}),
  client:client(async()=>{current=false;return toolsResponse([{tool:'file_read',path:'helper.py'}]);})});
 assert.equal(reads,0);assert.equal(result.cancelled,true);
});
test('exhausted turn budget exposes only final submission, with no extra model retry',async()=>{
 let calls=0;
 await assert.rejects(runEvidenceTurn({phase:'verification',client:client(async o=>{
  calls++;if(calls===3)assert.deepEqual(o.tools.map(t=>t.function.name),['submit_verdicts']);
  return toolsResponse([{tool:'file_read',path:'helper.py',start:calls,end:calls}]);
 }),input:{},createTools:evidenceFactory,maxTurns:3,deadlineAt:Date.now()+1000}),e=>e.code==='evidence_budget');
 assert.equal(calls,3);
});
test('native and ordinary calls share one global semaphore and usage scope',async()=>{
 let active=0,peak=0;
 const invoke=async o=>{active++;peak=Math.max(peak,active);await delay(10);o.onMetadata({inputTokens:1,outputTokens:2,totalTokens:3});active--;return 'ok';};
 const meter=createModelUsageMeter(limitModelConcurrency({generateReview:invoke,generateToolTurn:invoke},1)),scope=meter.createScope();
 await scope.run(()=>Promise.all([meter.client.generateReview({}),meter.client.generateToolTurn({}),meter.client.generateReview({})]));
 assert.equal(peak,1);assert.equal(scope.snapshot().requests,3);assert.equal(scope.snapshot().totalTokens,9);
});
test('native calls queued behind the semaphore cannot contact provider after deadline',async()=>{
 let release,calls=0;const hold=new Promise(resolve=>{release=resolve;});
 const native=limitModelConcurrency({generateToolTurn:async o=>{
  if(Date.now()>=o.deadlineAt)throw Object.assign(Error('expired'),{code:'review_deadline'});
  calls++;await hold;return generation();
 }},1);
 const first=native.generateToolTurn({deadlineAt:Date.now()+2000});
 const result=await reviewPrBatches({...options,client:native,maxDurationMs:35});
 assert.equal(result.budgetExceeded,true);assert.equal(calls,1);release();await first;await delay(10);assert.equal(calls,1);
});
test('source searches cannot reveal a file which file_read rejects',async()=>{
 const evidence=createEvidenceTools({snapshots:{head:{sha:'a'.repeat(40),files:new Map([['secrets/config.py','sensitive_literal'],['a.py','safe']])}},upstreamLookup:async()=>({})});
 const result=await evidence.execute({tool:'code_search',query:'sensitive_literal'});assert.equal(result.hits.length,0);
});
test('semantic wording does not replace an independent candidate verdict',()=>{
 const decoded=decodePrReview(JSON.stringify({findings:[{...finding,suggestion:'修复被调用方即可，调用方无需修改'}]}),files);
 assert.equal(decoded.complete,true);assert.equal(decoded.findings.length,1);
});
const tar=entries=>gzipSync(Buffer.concat(entries.flatMap(([name,text])=>{
 const data=Buffer.from(text),header=Buffer.alloc(512);header.write('root/'+name);header.write(data.length.toString(8).padStart(11,'0'),124);header.write('0',156);
 return [header,data,Buffer.alloc((512-data.length%512)%512)];
}).concat([Buffer.alloc(1024)])));

test('prefetched base is shared without redownload or mutating its sensitive-path map',async()=>{
 const baseSnapshot={sha:'b'.repeat(40),files:new Map([['helper.py','base source'],['.aws/credentials.py','hidden']])};
 const reads=[];
 const factory=createRepositoryEvidence({owner:'o',repo:'r',headSha:'a'.repeat(40),baseSha:baseSnapshot.sha,baseSnapshot,deadlineAt:Date.now()+10000,
  octokit:{request:async(_route,args)=>{reads.push(args.ref);return {data:tar([['helper.py','head source']])};}}});
 const result=await factory().execute({tool:'file_read',path:'helper.py',side:'base'});
 assert.match(result.text,/base source/);assert.deepEqual(reads,['a'.repeat(40)]);
 assert.ok(baseSnapshot.files.has('.aws/credentials.py'));
 const search=await factory().execute({tool:'code_search',query:'hidden',side:'base'});assert.equal(search.hits.length,0);
});
test('lazy fixed SHA snapshots are fetched once per review and reused across phases',async()=>{
 const reads=[];const factory=createRepositoryEvidence({owner:'o',repo:'r',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),deadlineAt:Date.now()+1000,
 octokit:{request:async(route,args)=>{assert.equal(route,'GET /repos/{owner}/{repo}/tarball/{ref}');reads.push(args.ref);return {data:tar([['helper.py','safe'],['.aws/credentials.py','sensitive_literal']])};}}});
 assert.equal(reads.length,0);const gen=factory(),verify=factory();
 assert.equal((await gen.execute({tool:'file_read',path:'helper.py'})).sha,'a'.repeat(40));
 assert.equal((await verify.execute({tool:'file_read',path:'helper.py',side:'base'})).sha,'b'.repeat(40));
 assert.equal(reads.length,2);assert.equal((await gen.execute({tool:'code_search',query:'sensitive_literal'})).hits.length,0);
});
test('active service entry selects the new pipeline, not the standalone replay client',()=>{
 const source=fs.readFileSync(new URL('../src/index.mjs',import.meta.url),'utf8');
 assert.ok(source.includes("process.env.AI_PR_REVIEW_ENGINE || 'evidence-v1'"));
 assert.ok(source.includes('engine: prReviewEngine, evidenceFactory'));
 assert.ok(source.includes('client: modelClient'));
});

test('verification evidence failure cannot publish even a confirmed verdict',async()=>{
 let saved,turn=0;
 const result=await reviewPrBatches({...options,state:{read:async()=>null,write:async(_k,v)=>{saved=structuredClone(v);}},client:client(async o=>{
  if(!isVerifier(o))return generation([finding]);
  return ++turn===1?toolsResponse([{tool:'file_read',path:'missing.py'}]):verdict('confirmed');
 })});
 assert.equal(result.reviewFindings.length,0);assert.equal(result.partial,true);
 assert.equal(saved.results[0].failure.code,'evidence_incomplete');
 assert.equal(saved.results[0].pendingVerification.submittedCandidates.length,1);
 assert.equal(result.reviewPending.length,1);assert.match(result.body,/尚未完成证据复核/);
});

test('checkpoint keeps submitted candidates across another interrupted resume',async()=>{
 let saved,generations=0;
 const state={read:async()=>saved,write:async(_k,v)=>{saved=structuredClone(v);}};
 const mock=client(async o=>{if(isVerifier(o))throw new DOMException('synthetic','TimeoutError');generations++;return generation([finding]);});
 await reviewPrBatches({...options,state,client:mock});await reviewPrBatches({...options,state,client:mock});
 assert.equal(generations,1);assert.equal(saved.results[0].submittedCandidates.length,1);
 assert.equal(saved.results[0].pendingVerification.submittedCandidates.length,1);
});

test('an exhausted character budget still returns an explicit failure marker',async()=>{
 const tools=createEvidenceTools({snapshots,upstreamLookup:async()=>({}),maxChars:0});
 const answer=await tools.execute({tool:'file_read',path:'helper.py'});
 assert.equal(answer.error,'evidence_budget');assert.equal(answer.truncated,true);
});

test('RC1 does not issue a legacy model dedup request after native verification',async()=>{
 let legacy=0;
 const mock=client(async o=>isVerifier(o)?response('submit_verdicts',{verdicts:[0,1].map(index=>({index,verdict:'confirmed',reason:'contract'}))}):
  generation([finding,{...finding,title:'Another contract'}]));
 mock.generateReview=async()=>{legacy++;throw Error('unexpected');};
 const result=await reviewPrBatches({...options,client:mock});
 assert.equal(result.reviewFindings.length,2);assert.equal(legacy,0);
});

test('changed upstream evidence blocks completed-state reuse before contacting a model',async()=>{
 let saved,blocked=false,calls=0;
 const factory=()=>evidenceFactory();factory.identity=[['sample','fixed-root']];
 factory.validateEvidence=async()=>{if(blocked)throw Object.assign(Error('changed'),{code:'evidence_unavailable'});};
 const state={read:async()=>saved,write:async(_k,v)=>{saved=structuredClone(v);}};
 const mock=client(async()=>{calls++;return generation();});
 await reviewPrBatches({...options,state,evidenceFactory:factory,client:mock});blocked=true;
 await assert.rejects(reviewPrBatches({...options,state,evidenceFactory:factory,client:mock}),e=>e.code==='evidence_unavailable');
 assert.equal(calls,1);
});

test('bounded finalization advertises only terminal tool without forced-name decoding',async()=>{
 let calls=0;
 const result=await runEvidenceTurn({phase:'verification',input:{},createTools:evidenceFactory,deadlineAt:Date.now()+1000,client:client(async o=>{
  calls++;assert.equal(o.toolChoice,'auto');
  if(calls<4)return toolsResponse([{tool:'file_read',path:'helper.py',start:calls,end:calls}]);
  assert.deepEqual(o.tools.map(t=>t.function.name),['submit_verdicts']);assert.ok(o.instructions.includes('本阶段剩余1次'));
  return verdict('uncertain');
 })});
 assert.equal(calls,4);assert.equal(result.submission.verdicts[0].verdict,'uncertain');
});
