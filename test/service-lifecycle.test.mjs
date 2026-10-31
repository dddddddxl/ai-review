import test from 'node:test';
import assert from 'node:assert/strict';
import {createServiceLifecycle,runtimeReadiness} from '../src/service-lifecycle.mjs';
test('runtime readiness never labels unconfigured or draining service ready',()=>{
 assert.equal(runtimeReadiness({modelConfigured:false}).statusCode,503);
 assert.equal(runtimeReadiness({modelConfigured:true,draining:true}).statusCode,503);
 const r=runtimeReadiness({modelConfigured:true});assert.equal(r.statusCode,200);assert.equal(r.body.qualityApproved,false);
});
test('shutdown drain waits for active tasks and tolerates rejected tasks',async()=>{
 const s=createServiceLifecycle();let done,settled=false;
 s.track(new Promise(r=>{done=r;}));s.track(Promise.reject(Error('synthetic')));
 const drain=s.drain().then(()=>{settled=true;});assert.equal(s.draining,true);
 await Promise.resolve();assert.equal(settled,false);done();await drain;assert.equal(settled,true);await s.drain();
});
