import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityGateLogStatus, restrictedCiMessage, renderRestrictedCi } from '../src/ci-publication.mjs';
import { extractEvidence, readLogStream } from '../src/ci-evidence.mjs';
import { createCiReviewer } from '../src/ci-review.mjs';
import { applyPendingCiBackfeeds, ciBackfeedIsCurrent } from '../src/ci-backfeed.mjs';
import { renderCiBackfeed, safeCiBackfeedResult, updateReviewWithCiEvidence } from '../src/pr-publication.mjs';

const footer = status => `2026-10-21T06:49:11.725Z SUMMARY=/private/report.md\n2026-10-21T06:49:11.726Z RESULT=${status}\n`;
const memoryState = () => {
  const values = new Map();
  return { read: async key => structuredClone(values.get(key) || null),
    write: async (key,value) => values.set(key,structuredClone(value)),
    entries: async () => structuredClone([...values.values()]) };
};
const section = (id,attempt,text) => `<!-- github-ai-ci-backfeed:${id}:${attempt}:start -->\n${text}\n<!-- github-ai-ci-backfeed:${id}:${attempt}:end -->`;
const reviewBody = '<!-- github-ai-review:v1:21:abc:test -->\n## AI Review\n\n### 🔴 需要修改\n\n原有 P1 代码问题仍需处理。';

function fixture({reviews=true, name='Quality Gate'}={}) {
  const f={ calls:0, logReads:0, fileReads:0, updates:[], log:footer('invalid'), state:memoryState(), afterRead:()=>{} };
  f.pr={number:21,state:'open',draft:false,head:{sha:'abc'},base:{sha:'base',repo:{full_name:'org/repo'}}};
  f.run={id:12,run_attempt:1,status:'completed',conclusion:'failure',head_sha:'abc',name,
    pull_requests:[{number:21,head:{sha:'abc'}}]};
  f.latest=structuredClone(f.run);
  f.reviews=reviews?[{id:71,user:{login:'reviewer[bot]'},body:reviewBody}]:[];
  const listReviews=()=>{}, listFiles=()=>{};
  f.octokit={rest:{actions:{getWorkflowRun:async()=>({data:structuredClone(f.latest)})},
    pulls:{listReviews,listFiles,get:async()=>({data:structuredClone(f.pr)}),
      updateReview:async args=>{f.updates.push(args);f.reviews.find(r=>r.id===args.review_id).body=args.body;return {data:{id:args.review_id}};}}},
    paginate:async route=>{
      if(route===listReviews)return structuredClone(f.reviews);
      if(route===listFiles){f.fileReads++;return [];}
      if(typeof route==='string')return [{id:99,name:'Code security',conclusion:'failure'}];
      throw Error('Unexpected request');
    }};
  f.client={configured:false,generateReview:async()=>{f.calls++;return JSON.stringify({cause:'日志不足，原因待确认',category:'无法确定',
    relation:'无法确定',basis:'只有失败状态',suggestion:'查看原始日志',verification:'核对失败步骤',limitations:'未执行代码',kind:'unknown',evidence:[]});}};
  f.review=createCiReviewer({modelClient:f.client,
    botLogin:'reviewer[bot]',backfeedState:f.state,readJobLog:async()=>{f.logReads++;f.afterRead();return f.log;}});
  f.deliver=run=>f.review({octokit:f.octokit,payload:{repository:{owner:{login:'org'},name:'repo',full_name:'org/repo'},workflow_run:structuredClone(run||f.run)}});
  f.advance=(attempt,conclusion)=>{Object.assign(f.run,{run_attempt:attempt,conclusion});f.latest=structuredClone(f.run);};
  return f;
}

for(const status of ['invalid','blocked','partial','passed'])test(`gate machine footer preserves ${status} without raw report data`,()=>{
  assert.equal(qualityGateLogStatus(footer(status)),status);
  assert.equal(qualityGateLogStatus(footer(status).replace('RESULT=', '\x1b[31mRESULT=')),status);
});
test('missing, echoed, malformed and conflicting gate footers are unknown',()=>{
  for(const log of ['0 findings','RESULT=passed','echo "SUMMARY=/private"\necho "RESULT=blocked"',
    'SUMMARY=/private\nRESULT=failed',footer('passed')+footer('invalid'),'SUMMARY=/private\nRESULT=passed extra'])
    assert.equal(qualityGateLogStatus(log),'unknown');
});
test('machine footer is captured before evidence-window selection',()=>{
  const log='unrelated prefix\n'.repeat(100)+footer('blocked')+'unrelated progress\n'.repeat(2000);
  const evidence=extractEvidence(log);
  assert.equal(evidence.gateStatus,'blocked');
  assert.ok(!evidence.chunks.join('\n').includes('RESULT=blocked'));
});
test('truncated or broken log transport cannot claim a valid scan',async()=>{
  const log=footer('blocked')+'tail'.repeat(100);
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(log));c.close();}});
  const result=await readLogStream(body,{maxBytes:150});
  assert.equal(result.truncated,true);assert.equal(result.gateStatus,'unknown');
  let reads=0;
  const broken=new ReadableStream({pull(c){if(reads++===0)c.enqueue(new TextEncoder().encode(footer('blocked')));else c.error(Error('broken'));}});
  const bad=await readLogStream(broken);
  assert.equal(bad.readError,true);assert.equal(bad.gateStatus,'unknown');
});
for(const [status,title] of [['invalid','扫描执行失败'],['blocked','存在阻断项'],['partial','扫描未完成'],['unknown','原因待核实']])
  test(`restricted status ${status} renders only allowlisted text`,()=>{
    const result=safeCiBackfeedResult({gateStatus:status,ciEvidence:[{cause:'private-secret'}],arbitrary:'private-secret'},true);
    const body=renderCiBackfeed({run:{id:12,run_attempt:1,name:'Quality Gate private-secret'},result,restricted:true});
    assert.match(body,new RegExp(title));assert.doesNotMatch(body,/private-secret|检测到需处理的问题/);
    assert.deepEqual(result.ciEvidence,[]);
    const standalone=renderRestrictedCi({run:{id:12},failed:[],result});
    assert.ok(standalone.includes(restrictedCiMessage(status).title));
  });
test('arbitrary model status cannot enter the restricted publication',()=>{
  assert.equal(safeCiBackfeedResult({gateStatus:'private-secret'},true).gateStatus,'unknown');
});
test('invalid scan backfeeds execution failure with no model, diff read or sensitive details',async()=>{
  const f=fixture();f.log+='sensitive-match-value private-secret';
  await f.deliver();
  assert.equal(f.updates.length,1);assert.match(f.reviews[0].body,/扫描执行失败/);
  assert.doesNotMatch(f.reviews[0].body,/private-secret|检测到需处理的问题|SUMMARY=/);
  assert.equal(f.calls,0);assert.equal(f.fileReads,0);
  await f.deliver();assert.equal(f.updates.length,1);assert.equal(f.logReads,1);
});
test('valid blocked scan is distinct from execution failure',async()=>{
  const f=fixture();f.log=footer('blocked');await f.deliver();
  assert.match(f.reviews[0].body,/存在阻断项/);assert.doesNotMatch(f.reviews[0].body,/扫描执行失败/);
});
test('unavailable logs or a passed footer in a failed run cannot imply findings or green',async()=>{
  for(const log of [null,footer('passed'),{available:false,gateStatus:'blocked'},{available:true,readError:true,gateStatus:'blocked'}]){
    const f=fixture();f.log=log;await f.deliver();
    assert.match(f.reviews[0].body,/原因待核实/);assert.doesNotMatch(f.reviews[0].body,/存在阻断项|门禁已通过/);
  }
});
test('success replaces all older attempts of this run, preserving other CI and real PR findings',async()=>{
  const f=fixture();
  f.reviews[0].body+='\n\n'+section(13,1,'OTHER-RUN-FAILURE');
  await f.deliver();f.advance(2,'failure');f.log=footer('blocked');await f.deliver();
  assert.doesNotMatch(f.reviews[0].body,/backfeed:12:1:/);
  const reads=f.logReads;f.advance(3,'success');await f.deliver();
  const body=f.reviews[0].body;
  assert.match(body,/质量门禁已通过/);assert.match(body,/第 3 次执行/);
  assert.doesNotMatch(body,/扫描执行失败|存在阻断项|backfeed:12:[12]:/);
  assert.match(body,/OTHER-RUN-FAILURE/);assert.match(body,/原有 P1/);assert.match(body,/🔴 需要修改/);
  assert.equal(f.logReads,reads);assert.equal(f.calls,0);assert.equal(f.fileReads,0);
  const updates=f.updates.length;await f.deliver();assert.equal(f.updates.length,updates);
});
test('legacy comments containing two failed attempts are both replaced by one success section',async()=>{
  const f=fixture();f.reviews[0].body+='\n\n'+section(12,1,'OLD-FAIL-ONE')+'\n\n'+section(12,2,'OLD-FAIL-TWO');
  f.advance(3,'success');await f.deliver();
  assert.doesNotMatch(f.reviews[0].body,/OLD-FAIL|backfeed:12:[12]:/);
  assert.equal((f.reviews[0].body.match(/backfeed:12:3:start/g)||[]).length,1);
});
test('ordinary failed CI still uses the model and success later updates only its CI section',async()=>{
  const f=fixture({name:'Unit tests'});f.client.configured=true;f.log='AssertionError: expected 1 but got 0';
  await f.deliver();assert.equal(f.calls,1);assert.equal(f.fileReads,1);assert.match(f.reviews[0].body,/CI 失败证据：Unit tests/);
  f.advance(2,'success');await f.deliver();
  assert.equal(f.calls,1);assert.equal(f.fileReads,1);assert.match(f.reviews[0].body,/该运行已通过/);
  assert.match(f.reviews[0].body,/原有 P1/);assert.doesNotMatch(f.reviews[0].body,/CI 失败证据：Unit tests/);
});
test('an old failure webhook arriving after success cannot restore obsolete failure',async()=>{
  const f=fixture();const old=structuredClone(f.run);await f.deliver();
  f.advance(3,'success');await f.deliver();const body=f.reviews[0].body,reads=f.logReads;
  await f.deliver(old);assert.equal(f.reviews[0].body,body);assert.equal(f.logReads,reads);
});
test('a failure overtaken by a rerun while reading logs is not saved or published',async()=>{
  const f=fixture();f.afterRead=()=>{f.latest={...f.run,run_attempt:2,status:'in_progress'};};
  await f.deliver();assert.equal(f.updates.length,0);assert.equal((await f.state.entries()).length,0);
});
test('successful runs without an old failure section do not spam comments or call the model',async()=>{
  const f=fixture();f.advance(1,'success');await f.deliver();
  assert.equal(f.updates.length,0);assert.equal(f.logReads,0);assert.equal(f.calls,0);
  assert.equal((await f.state.entries()).length,0);
  f.advance(2,'success');await f.deliver();assert.equal(f.updates.length,0);
});
test('pending old failures are superseded if success arrives before the PR review',async()=>{
  const f=fixture({reviews:false});await f.deliver();
  assert.equal((await f.state.entries())[0].status,'pending');
  f.advance(3,'success');await f.deliver();
  assert.equal((await f.state.entries()).find(r=>r.run.run_attempt===1).status,'superseded');
  f.reviews.push({id:71,user:{login:'reviewer[bot]'},body:reviewBody});
  const replay=await applyPendingCiBackfeeds({state:f.state,repository:'org/repo',pullNumber:21,headSha:'abc',
    apply:record=>updateReviewWithCiEvidence({octokit:f.octokit,owner:'org',repo:'repo',pullNumber:21,headSha:'abc',
      botLogin:'reviewer[bot]',run:record.run,result:record.result,restricted:record.restricted,
      isCurrent:()=>ciBackfeedIsCurrent({octokit:f.octokit,owner:'org',repo:'repo',headSha:'abc',run:record.run})})});
  assert.equal(replay.deferred,0);assert.equal(f.updates.length,0);assert.equal(f.reviews[0].body,reviewBody);
});
test('successful old-head, closed and draft PR notifications never update a review',async()=>{
  for(const change of [f=>f.pr.head.sha='new',f=>f.pr.state='closed',f=>f.pr.draft=true]){
    const f=fixture();await f.deliver();f.advance(3,'success');change(f);
    const body=f.reviews[0].body;await f.deliver();assert.equal(f.reviews[0].body,body);
  }
});
test('latest-run guard rejects mismatched SHA, attempt, conclusion and unfinished run',async()=>{
  for(const change of [{head_sha:'new'},{run_attempt:2},{conclusion:'success'},{status:'in_progress'}]){
    const f=fixture();Object.assign(f.latest,change);
    assert.equal(await ciBackfeedIsCurrent({octokit:f.octokit,owner:'org',repo:'repo',headSha:'abc',run:f.run}),false);
  }
});
test('direct publication cannot restore an older attempt even with related CI evidence',async()=>{
  const f=fixture();f.reviews[0].body=reviewBody+'\n\n'+section(12,3,'SUCCESS');
  const body=f.reviews[0].body;
  await updateReviewWithCiEvidence({octokit:f.octokit,owner:'org',repo:'repo',pullNumber:21,headSha:'abc',botLogin:'reviewer[bot]',
    run:f.run,result:{ciEvidence:[{relation:'相关'}]}});
  assert.equal(f.updates.length,0);assert.equal(f.reviews[0].body,body);
});
