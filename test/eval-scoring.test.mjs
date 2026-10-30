import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evaluationDirectory} from '../src/eval-identity.mjs';
test('scorer counts missing and wrong-SHA runs in denominator, never calls proxy true recall',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-review-eval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const item={repository:'o/r',pullNumber:1,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),label:'author_fixed',file:'a.py',line:1,issue:'expected'};
 const missing={...item,pullNumber:2},wrong={...item,pullNumber:3};
 const dataset=path.join(dir,'dataset.json');fs.writeFileSync(dataset,JSON.stringify({cases:[item,missing,wrong]}));
 for(const c of [item,wrong]){
  const out=path.join(dir,'test',evaluationDirectory(c));fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({...c,baseSha:c===wrong?'c'.repeat(40):c.baseSha,
   reviewFindings:[{file:'a.py',line:1,title:'candidate'}]}));
 }
 const response=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/eval-recall.mjs',import.meta.url)),'score',dataset,'test'],
  {env:{...process.env,REPLAY_OUT_DIR:dir},encoding:'utf8'});
 assert.equal(response.status,0,response.stderr);
 const score=JSON.parse(fs.readFileSync(path.join(dir,'test','score.json')));
 assert.equal(score.expected,3);assert.equal(score.scored,1);assert.equal(score.missingRuns,2);
 assert.equal(score.locationProxy.modelConfirmed.rateAcrossAllExpected,'33%');assert.equal(score.recall,null);assert.equal(score.precision,null);
});
test('evaluation replay supplies the frozen base SHA',()=>{
 const source=fs.readFileSync(new URL('../scripts/eval-recall.mjs',import.meta.url),'utf8');
 assert.match(source,/'--base', item\.baseSha/);
});
test('single-PR validation rejects invalid selectors before creating run output',()=>{
 const output=path.join(os.tmpdir(),`ai-review-invalid-selector-${process.pid}-${Date.now()}`);
 for(const value of ['0','-1','1.5','bad']){
  const response=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/quick-compare.mjs',import.meta.url)),
   'run',output,'fixed','--pr',value],{encoding:'utf8'});
  assert.equal(response.status,1);assert.equal(fs.existsSync(output),false);
 }
});
