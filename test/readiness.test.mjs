import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {decoratorContracts,constrainVerdicts,structuralOverview} from '../src/review-contracts.mjs';
import {buildPrReviewPublication} from '../src/pr-publication.mjs';
import {createEvidenceTools} from '../src/review-agent.mjs';
import {ReviewQueue,ReviewState} from '../src/review-state.mjs';
const caller='pkg/patches/new.py',definition='pkg/helpers.py';
const source='from ..helpers import decorate as register\n@register(original, flag)\ndef wrapped(): pass\n';
const snapshot={sha:'a'.repeat(40),files:new Map([[caller,source],[definition,'def decorate(original, flag, implementation):\n    return implementation\n']])};
const files=[{filename:caller,status:'added',patch:'@@ -0,0 +1,3 @@\n'+source.trimEnd().split('\n').map(l=>'+'+l).join('\n')}];
test('decorator prefetch resolves a relative alias at head without executing repository code',()=>{
 const r=decoratorContracts(files,snapshot);assert.equal(r.items.length,1);assert.equal(r.items[0].path,definition);assert.equal(r.items[0].sha,snapshot.sha);assert.match(r.items[0].text,/original, flag, implementation/);
});
test('decorator hints retain ambiguity, missing definitions and hard limits',()=>{
 assert.equal(decoratorContracts(files,{...snapshot,files:new Map([[caller,source]])}).items[0].status,'unresolved');
 assert.equal(decoratorContracts(files,snapshot,{maxItems:0}).omitted,1);
 assert.equal(decoratorContracts(files,snapshot,{maxChars:1}).omitted,1);
 const ambiguous={...snapshot,files:new Map([...snapshot.files,[caller,source+'\ndef register(a): pass\n']])};
 assert.equal(decoratorContracts(files,ambiguous).items[0].status,'ambiguous');
});
test('decorator lookup does not retrieve secret paths or execute imports',()=>{
 const s={...snapshot,files:new Map([['a.py','from secrets import decorate\n@decorate(x)\ndef f(): pass'],['secrets.py','def decorate(x): return x']])};
 const r=decoratorContracts([{filename:'.env',patch:'+@decorate(x)'}],s);assert.deepEqual(r.items,[]);
 const escaped=decoratorContracts([{filename:'a.py',patch:'+@f(x)'}],{...s,files:new Map([['a.py','from ...hidden import f\n@f(x)\ndef x():pass']])});assert.equal(escaped.items[0].status,'unresolved');
});
const valid={index:0,verdict:'confirmed',reason:'definition requires implementation',basis:'fixed_source',unresolved:[],evidenceRefs:[{side:'head',path:definition,line:1,quote:'def decorate(original, flag, implementation):'}]};
const checked=v=>constrainVerdicts({verdicts:[v]},{head:snapshot,base:{sha:'b'.repeat(40),files:new Map()}}).verdicts[0];
test('fixed-source verdict permits a genuine quote but never upgrades uncertainty',()=>{
 assert.equal(checked(valid).verdict,'confirmed');assert.equal(checked({...valid,verdict:'uncertain'}).verdict,'uncertain');
});
test('missing evidence, model memory and unknown premises cannot become confirmation',()=>{
 for(const change of [{basis:'unknown'},{unresolved:['upstream version unknown']},{evidenceRefs:[]},{evidenceRefs:undefined}])assert.equal(checked({...valid,...change}).verdict,'uncertain');
});
test('wrong side, line, quote and sensitive path invalidate confirmations and refutations',()=>{
 for(const verdict of ['confirmed','refuted'])for(const ref of [
  {...valid.evidenceRefs[0],side:'base'}, {...valid.evidenceRefs[0],line:2}, {...valid.evidenceRefs[0],quote:'made up'},
  {...valid.evidenceRefs[0],path:'../helpers.py'}, {...valid.evidenceRefs[0],path:'.env'},
 ])assert.equal(checked({...valid,verdict,evidenceRefs:[ref]}).verdict,'uncertain');
});
test('publication ignores contradictory generation overview even from old cached results',()=>{
 const result={reviewFindings:[],reviewUncertain:[],partial:false,changeOverview:['核心缺陷：已确认严重漏洞'],candidateCount:1,verificationFiltered:1,totalFiles:1,reviewedFiles:1};
 const p=buildPrReviewPublication({pr:{head:{sha:snapshot.sha}},files,result,pullNumber:1});
 assert.doesNotMatch(p.body,/核心缺陷|严重漏洞/);assert.match(p.body,/未发现有明确证据的问题/);assert.match(p.body,/new\.py/);
 assert.deepEqual(structuralOverview([{filename:'.env',status:'added'}]),[]);
});
test('out-of-file reads fail explicitly, prefix search cannot include sibling prefixes',async()=>{
 const s={...snapshot,files:new Map([['src/a.py','target'],['src_other/b.py','target']])};
 const t=createEvidenceTools({snapshots:{head:s},upstreamLookup:async()=>null});
 assert.equal((await t.execute({tool:'file_read',path:'src/a.py',start:8,end:9})).error,'invalid_range');
 const r=await t.execute({tool:'code_search',query:'target',prefix:'src'});assert.equal(r.matched,1);assert.equal(r.hits[0].path,'src/a.py');
});
test('local state backup restores queue and running jobs recover exactly once',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-readiness-'));
 try{
  const source=path.join(root,'source'),backup=path.join(root,'backup'),restored=path.join(root,'restored');
  const state=new ReviewState(source);await state.write({head:'fixed'},{findings:['private synthetic result']});
  const q=new ReviewQueue(source);const id=await q.enqueue({repository:'synthetic/repo',pullNumber:1});await q.claimNext();
  await fs.cp(source,backup,{recursive:true});await fs.cp(backup,restored,{recursive:true});
  assert.deepEqual(await new ReviewState(restored).read({head:'fixed'}),{findings:['private synthetic result']});
  const recovered=new ReviewQueue(restored);await recovered.recover();const claimed=await recovered.claimNext();assert.equal(claimed.id,id);assert.equal(await recovered.claimNext(),undefined);
  assert.equal((await q.get(id)).status,'running');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
