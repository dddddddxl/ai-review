import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPrBatches} from '../src/pr-review.mjs';
import {runEvidenceTurn,createRepositoryEvidence,evidenceGenerationOptions} from '../src/review-evidence.mjs';
import {createModelClient} from '../src/model-client.mjs';
import {evaluationIdentity,evaluationDirectory,proximityMatches} from '../src/eval-identity.mjs';
import {parseToolArguments} from '../src/tool-arguments.mjs';
const final = arguments_ => ({message:{role:'assistant',tool_calls:[{id:'terminal',type:'function',function:{name:'submit_review',arguments:arguments_}}]}});
const valid = JSON.stringify({overview:[],findings:[],limitations:['synthetic'],coverageComplete:true});
const base = {phase:'generation',input:{},createTools:()=>{throw Error('unexpected tool');},deadlineAt:Date.now()+60000};

test('one malformed terminal gets a bounded correction and preserved diagnostic',async()=>{
 let calls=0;const diagnostics=[];
 const result=await runEvidenceTurn({...base,maxTurns:2,onProtocolDiagnostic:x=>diagnostics.push(x),client:{generateToolTurn:async()=>final(++calls===1?'{}':valid)}});
 assert.equal(calls,2);assert.equal(result.turns,2);assert.equal(diagnostics[0].code,'invalid_terminal_arguments');
 assert.equal(result.protocolDiagnostics[0].repaired,true);
});
test('repair does not restart round budget or convert repeated empty arguments into success',async()=>{
 let calls=0;
 await assert.rejects(runEvidenceTurn({...base,maxTurns:6,client:{generateToolTurn:async()=>{calls++;return final('');}}}),{code:'invalid_tool_response'});
 assert.equal(calls,2);
});
test('last round malformed terminal cannot receive an extra request',async()=>{
 let calls=0;
 await assert.rejects(runEvidenceTurn({...base,maxTurns:1,client:{generateToolTurn:async()=>{calls++;return final('{}');}}}),{code:'invalid_tool_response'});
 assert.equal(calls,1);
});
test('native policy budget and thinking protocol separate checkpoint identities',async()=>{
 const cache=new Map();let calls=0;
 const options={repository:'synthetic/repo',pullNumber:1,title:'cache',engine:'evidence-v1',
  files:[{filename:'a.py',status:'added',patch:'@@ -0,0 +1 @@\n+x = 1'}],baseSha:'b'.repeat(40),headSha:'a'.repeat(40),
  evidenceFactory:()=>({}),state:{read:async k=>cache.get(k),write:async(k,v)=>cache.set(k,structuredClone(v))},log:()=>{},
  client:{model:'mock',format:'openai-chat',thinkingProtocol:'glm',generateToolTurn:async()=>{calls++;return final(valid);}}};
 await reviewPrBatches(options);await reviewPrBatches(options);assert.equal(calls,1);
 await reviewPrBatches({...options,evidenceGenerationTurns:4});assert.equal(calls,2);
 await reviewPrBatches({...options,client:{...options.client,thinkingProtocol:'none'}});assert.equal(calls,3);
});
for(const model of ['GLM-5.3-Flash','glm5.3-flash'])test(`explicit thinking switch for ${model}`,async()=>{
 const bodies=[];const client=createModelClient({AI_API_FORMAT:'openai-chat',AI_MODEL:model,AI_API_KEY:'synthetic',AI_BASE_URL:'https://mock.invalid'},
  {fetchImpl:async(_url,o)=>{bodies.push(JSON.parse(o.body));return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',...final(valid)}]}));}});
 const options={instructions:'',messages:[],tools:[],maxOutputTokens:10};
 await client.generateToolTurn({...options,disableThinking:true});await client.generateToolTurn(options);
 assert.deepEqual(bodies.map(b=>b.thinking.type),['disabled','enabled']);
});
test('unsupported thinking protocol is rejected',()=>assert.throws(()=>createModelClient({AI_API_FORMAT:'openai-chat',AI_MODEL:'mock',AI_API_KEY:'synthetic',AI_THINKING_PROTOCOL:'guess'})));
test('service and CLI share strict generation option validation',()=>{
 assert.deepEqual(evidenceGenerationOptions({}),{evidenceGenerationTurns:6,evidenceGenerationTokens:65536});
 for(const value of ['0','9','2.5','x'])assert.throws(()=>evidenceGenerationOptions({AI_EVIDENCE_GENERATION_TURNS:value}));
 assert.throws(()=>evidenceGenerationOptions({AI_EVIDENCE_GENERATION_TOKENS:'-1'}));
});
test('evaluation identities include full base and head and reject missing version',()=>{
 const item={repository:'a/b',pullNumber:1,baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
 assert.notEqual(evaluationIdentity(item),evaluationIdentity({...item,baseSha:'c'.repeat(40)}));
 assert.match(evaluationDirectory(item),new RegExp(item.baseSha));assert.throws(()=>evaluationIdentity({...item,baseSha:undefined}));
});
test('location proxy cannot reuse one candidate or count remote same-file lines',()=>{
 const expected=[{file:'a.py',line:1},{file:'a.py',line:2},{file:'a.py',line:100}];
 const candidate={file:'a.py',line:1,title:'one'};
 assert.equal(proximityMatches(expected,[candidate,candidate]).size,1);
 assert.equal(proximityMatches([{file:'a.py',line:100}],[candidate]).size,0);
});
test('supplied base identity is checked before use',async()=>{
 const factory=createRepositoryEvidence({octokit:{request:async()=>({data:Buffer.alloc(0)})},owner:'a',repo:'b',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),
  deadlineAt:Date.now()+10000,baseSnapshot:{sha:'c'.repeat(40),files:new Map()}});
 await assert.rejects(factory().execute({tool:'file_read',path:'a.py',side:'base'}));
});
test('ambiguous duplicate JSON paths cannot silently select the last file',()=>{
 assert.throws(()=>parseToolArguments('{"path":"a.py","path":"b.py"}'),/duplicate_tool_key/);
 assert.throws(()=>parseToolArguments('{"x":{"path":1,"p\\u0061th":2}}'),/duplicate_tool_key/);
 assert.deepEqual(parseToolArguments('{"x":{"a":1},"y":{"a":2},"z":"path: a"}'),{x:{a:1},y:{a:2},z:'path: a'});
});
test('five tools are not executed and can be corrected within existing rounds',async()=>{
 let calls=0;const diagnostics=[];
 const over={message:{role:'assistant',tool_calls:Array.from({length:5},(_,i)=>({id:`c${i}`,type:'function',function:{name:'file_read',arguments:'{"path":"a.py"}'}}))}};
 const result=await runEvidenceTurn({...base,maxTurns:2,onProtocolDiagnostic:r=>diagnostics.push(r),client:{generateToolTurn:async()=>++calls===1?over:final(valid)}});
 assert.equal(result.ledger.length,0);assert.equal(calls,2);assert.equal(diagnostics[0].code,'too_many_tools_in_turn');
});
test('duplicate-path evidence arguments are repaired without reading either file',async()=>{
 let calls=0;
 const bad={message:{role:'assistant',tool_calls:[{id:'bad',type:'function',function:{name:'file_read',arguments:'{"path":"a.py","path":"b.py"}'}}]}};
 const result=await runEvidenceTurn({...base,maxTurns:2,client:{generateToolTurn:async()=>++calls===1?bad:final(valid)}});
 assert.equal(result.ledger.length,0);assert.equal(result.protocolDiagnostics[0].code,'invalid_evidence_arguments');
});
test('a missing nested trigger is repaired before the candidate decoder can drop the finding',async()=>{
 const finding={file:'a.py',priority:'P2',title:'wrong result',evidence:'return 1',impact:'incorrect output',suggestion:'handle zero'};
 let calls=0;const diagnostics=[];
 const result=await runEvidenceTurn({...base,maxTurns:2,onProtocolDiagnostic:r=>diagnostics.push(r),client:{generateToolTurn:async()=>
  final(JSON.stringify({overview:[],findings:[++calls===1?finding:{...finding,trigger:'input zero'}],limitations:[],coverageComplete:true}))}});
 assert.equal(calls,2);assert.deepEqual(diagnostics[0].fields,['findings[0].trigger']);assert.equal(result.submission.findings.length,1);
});
test('malformed candidates remain unverified, not counted as verifier rejections',async()=>{
 const submission={overview:[],findings:[{file:'a.py',priority:'P2',title:'missing trigger',evidence:'return 1',impact:'wrong',suggestion:'fix'}],limitations:[],coverageComplete:false};
 const result=await reviewPrBatches({repository:'synthetic/repo',pullNumber:1,title:'schema',engine:'evidence-v1',
  files:[{filename:'a.py',status:'added',patch:'@@ -0,0 +1 @@\n+x = 1'}],baseSha:'b'.repeat(40),headSha:'a'.repeat(40),
  evidenceFactory:()=>({}),evidenceGenerationTurns:1,log:()=>{},client:{model:'mock',format:'openai-chat',generateToolTurn:async()=>final(JSON.stringify(submission))}});
 assert.equal(result.candidateCount,1);assert.equal(result.verificationFiltered,0);assert.equal(result.unverifiedCandidates,1);assert.equal(result.partial,true);
});
