// Read-only capture and frozen model replay. No publication, CI or repository execution.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {App} from 'octokit';
import {createModelClient} from '../src/model-client.mjs';
import {extractSources} from '../src/repository-snapshot.mjs';
import {buildPrRepositoryContext} from '../src/pr-context.mjs';
import {repositoryReviewRules,resolveReviewProfile} from '../src/repo-profile.mjs';
import {createRepositoryEvidence} from '../src/review-evidence.mjs';
import {sanitizeReviewInput} from '../src/review-agent.mjs';
import {ReviewState} from '../src/review-state.mjs';
import {parseToolArguments} from '../src/tool-arguments.mjs';
import {toolSchemaErrors} from '../src/tool-schema.mjs';
const [command,outputArg,variant,baselineRoot]=process.argv.slice(2);
const output=path.resolve(outputArg||'replay-results/quick');
const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2),{flag:'wx'});
const readonly=client=>{
 client.hook.before('request',o=>{
  const method=String(o.method||'GET').toUpperCase();
  if(!['GET','HEAD'].includes(method)&&!(method==='POST'&&/^\/app\/installations\/(?:\d+|\{installation_id\})\/access_tokens$/.test(o.url)))throw new Error('github_write_blocked');
 });return client;
};
async function capture(){
 fs.mkdirSync(output,{recursive:false});
 const app=new App({appId:process.env.GITHUB_APP_ID,privateKey:fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH,'utf8')});
 readonly(app.octokit);
 const option=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
 const repository=option('--repository')||'HYGON-AI/vllm-plugin-das';
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('invalid_repository');
 const [owner,repo]=repository.split('/');
 const current=process.argv.includes('--current');
 const numbers=(option('--prs')||'225,269').split(',').map(Number);
 if(!numbers.length||numbers.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(numbers).size!==numbers.length)throw new Error('invalid_pr_number');
 if(!current&&repository!=='HYGON-AI/vllm-plugin-das')throw new Error('historical_repository_mismatch');
 const {data:installation}=await app.octokit.request('GET /repos/{owner}/{repo}/installation',{owner,repo});
 const api=readonly(await app.getInstallationOctokit(installation.id));
 const cases=current?[]:JSON.parse(fs.readFileSync(new URL('../eval/vllm-plugin-das.json',import.meta.url))).cases;
 const fixtures=[];
 for(const pullNumber of numbers){
  const {data:pr}=await api.rest.pulls.get({owner,repo,pull_number:pullNumber});
  const headSha=current?pr.head.sha:cases.find(c=>c.pullNumber===pullNumber)?.headSha;
  if(!headSha)throw new Error('historical_head_missing');
  const commits=current?[]:await api.paginate(api.rest.pulls.listCommits,{owner,repo,pull_number:pullNumber,per_page:100});
  const head=current?null:(await api.rest.repos.getCommit({owner,repo,ref:headSha})).data;
  const historicalHeadPresent=commits.some(c=>c.sha===headSha);
  const requestedBase=current?pr.base.sha:historicalHeadPresent?commits[0].parents[0].sha:head.parents[0].sha;
  const {data:comparison}=await api.rest.repos.compareCommitsWithBasehead({owner,repo,basehead:`${requestedBase}...${headSha}`});
  const baseSha=comparison.merge_base_commit?.sha||requestedBase;
  if(!comparison.files?.length||comparison.files.length>=300)throw new Error('diff_empty_or_possible_truncation');
  const fixture={repository:`${owner}/${repo}`,pullNumber,title:pr.title,baseSha,headSha,baseRef:pr.base.ref,
   targetBaseSha:requestedBase,comparisonKind:current?'current_pr_merge_base':historicalHeadPresent?'first_pr_commit_parent':'single_historical_commit_parent',
   capturedAt:new Date().toISOString(),files:comparison.files.map(({filename,status,patch,additions,deletions,previous_filename})=>({filename,status,patch,additions,deletions,previous_filename})),
   limitations:['Historical PR description and bot comments excluded from model input','No installed upstream packages; upstream dependencies may be unknown'],archives:{}};
  for(const [side,sha] of [['base',baseSha],['head',headSha]]){
   const file=`${sha}.tar.gz`,location=path.join(output,file);
   if(!fs.existsSync(location)){
    const {data}=await api.request('GET /repos/{owner}/{repo}/tarball/{ref}',{owner,repo,ref:sha,request:{timeout:120000}});
    if(typeof data==='string')throw new Error('binary_archive_required');
    fs.writeFileSync(location,Buffer.from(data),{flag:'wx'});
   }
   fixture.archives[side]={file,sha256:hash(fs.readFileSync(location))};
  }
  save(`pr-${pullNumber}.json`,fixture);fixtures.push({pullNumber,headSha,baseSha,comparisonKind:fixture.comparisonKind,files:fixture.files.length});
  console.log(JSON.stringify({captured:pullNumber,files:fixture.files.length,comparisonKind:fixture.comparisonKind}));
 }
 save('manifest.json',{fixtures,source:'real GitHub evidence',noReferenceAnswersInFixtures:true});
}
async function probe(){
 const client=createModelClient();let metadata;
 const started=Date.now();
 const answer=await client.generateToolTurn({instructions:'Connectivity test only. Call finish with {"ok":true}.',
  messages:[{role:'user',content:'Return the requested tool call.'}],tools:[{type:'function',function:{name:'finish',parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}}}],
  disableThinking:true,maxOutputTokens:256,onMetadata:m=>metadata=m});
 const status={model:client.model,thinkingProtocol:client.thinkingProtocol,thinkingRequested:'disabled',seconds:(Date.now()-started)/1000,
  tool:answer.message.tool_calls?.[0]?.function?.name,metadata};
 save('model-probe.json',status);console.log(JSON.stringify(status));
}
async function run(){
 if(!['baseline','fixed'].includes(variant))throw new Error('unknown_variant');
 const prFlag=process.argv.indexOf('--pr');
 const selectedPr=prFlag<0?null:Number(process.argv[prFlag+1]);
 if(selectedPr!==null&&(!Number.isSafeInteger(selectedPr)||selectedPr<1))throw new Error('invalid_pr_number');
 const root=variant==='baseline'?path.resolve(baselineRoot):fileURLToPath(new URL('..',import.meta.url));
 const moduleAt=relative=>import(variant==='baseline'?pathToFileURL(path.join(root,relative)).href:new URL(`../${relative}`,import.meta.url));
 const {reviewPrBatches,DEFAULT_REVIEW_DURATION_MS}=await moduleAt('src/pr-review.mjs');
 const {createModelClient:makeClient}=await moduleAt('src/model-client.mjs');
 const runDir=path.join(output,variant);fs.mkdirSync(runDir,{recursive:true});
 for(const pullNumber of selectedPr===null?[225,269]:[selectedPr]){
  const fixtureBytes=fs.readFileSync(path.join(output,`pr-${pullNumber}.json`)),fixture=JSON.parse(fixtureBytes);
  if(fixture.pullNumber!==pullNumber||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fixture.repository)||
   ![fixture.baseSha,fixture.headSha].every(s=>/^[a-f0-9]{40}$/.test(s)))throw new Error('invalid_fixture_identity');
  const [owner,repo]=fixture.repository.split('/');
  const dir=path.join(runDir,`pr-${pullNumber}`);fs.mkdirSync(dir);
  const sourceFiles=fs.readdirSync(path.join(root,'src')).filter(n=>n.endsWith('.mjs')).sort()
   .map(name=>({path:`src/${name}`,sha256:hash(fs.readFileSync(path.join(root,'src',name)))}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({startedAt:new Date().toISOString(),variant,repository:fixture.repository,
   pullNumber,baseSha:fixture.baseSha,headSha:fixture.headSha,inputSha256:hash(fixtureBytes),
   sourceFingerprint:hash(JSON.stringify(sourceFiles)),sourceFiles,harnessSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
   referenceAnswersProvided:false,contextType:'fresh_model_messages',blindEvaluation:false},null,2),{flag:'wx'});
  const started=Date.now(),deadlineAt=started+DEFAULT_REVIEW_DURATION_MS;
  const snapshots={};
  for(const side of ['base','head']){
   const archive=fs.readFileSync(path.join(output,fixture.archives[side].file));
   if(hash(archive)!==fixture.archives[side].sha256)throw new Error('snapshot_hash_mismatch');
   snapshots[side]=extractSources(archive,fixture[`${side}Sha`]);
  }
  // The collector is fixed for both variants; only model orchestration and context policy differ.
  const localApi={request:async(_route,args)=>{
   const side=args.ref===fixture.baseSha?'base':args.ref===fixture.headSha?'head':null;
   if(!side)throw new Error('unfrozen_git_request');
   return {data:fs.readFileSync(path.join(output,fixture.archives[side].file))};
  }};
  const context=variant==='fixed'?await buildPrRepositoryContext({octokit:localApi,owner,repo,baseSha:fixture.baseSha,files:fixture.files,snapshot:snapshots.base}):[];
  const rules=variant==='fixed'?repositoryReviewRules(snapshots.base,fixture.files):'';
  const factory=createRepositoryEvidence({octokit:localApi,owner,repo,headSha:fixture.headSha,baseSha:fixture.baseSha,baseSnapshot:snapshots.base,deadlineAt});
  // Hold the wire-level thinking request constant even though the old native client omitted it.
  const raw=makeClient(process.env,{fetchImpl:(url,options)=>fetch(url,{...options,
   body:JSON.stringify({...JSON.parse(options.body),thinking:{type:'enabled'}})})});
  const records=[],logs=[],candidates=[];let firstResultMs=null;
  const client={...raw,generateToolTurn:async options=>{
   const begin=Date.now(),record={phase:options.tools.some(t=>t.function.name==='submit_verdicts')?'verification':'generation',
    inputChars:JSON.stringify(options.messages).length,thinkingRequested:options.disableThinking?'disabled':'enabled_or_provider_default'};
   try{
    const answer=await raw.generateToolTurn({...options,onMetadata:m=>{record.usage=m;options.onMetadata?.(m);},
     onToolDelta:delta=>fs.appendFileSync(path.join(dir,'tool-deltas.jsonl'),JSON.stringify({call:records.length+1,...delta})+'\n')});
    record.submissions=sanitizeReviewInput(answer.message.tool_calls);
    if(!answer.message.tool_calls?.length&&typeof answer.message.content==='string'){
     record.finalContentChars=answer.message.content.length;
     record.finalContentHash=hash(answer.message.content);
     try{
      const value=parseToolArguments(answer.message.content.trim());
      const schema=options.tools.find(t=>t.function.name===(record.phase==='verification'?'submit_verdicts':'submit_review'))?.function.parameters;
      if(schema&&!toolSchemaErrors(value,schema).length)record.finalJson=sanitizeReviewInput(value);
     }catch{}
    }
    if(firstResultMs===null&&record.submissions?.some(c=>['submit_review','submit_verdicts'].includes(c.function?.name)))firstResultMs=Date.now()-started;
    return answer;
   }catch(error){record.error=error?.code||error?.name||'error';record.status=error?.status;throw error;}
   finally{record.seconds=(Date.now()-begin)/1000;records.push(record);fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify(record)+'\n');console.log(JSON.stringify({variant,pullNumber,call:records.length,phase:record.phase,seconds:record.seconds,error:record.error}));}
  }};
  const result=await reviewPrBatches({client,files:fixture.files,repository:fixture.repository,pullNumber,title:fixture.title,
   baseSha:fixture.baseSha,headSha:fixture.headSha,totalFiles:fixture.files.length,engine:'evidence-v1',evidenceFactory:factory,
   repositoryContext:context,reviewRules:rules,profile:resolveReviewProfile({repository:fixture.repository,files:fixture.files}),
   evidenceGenerationTurns:4,evidenceGenerationTokens:32768,batchChars:80000,thinking:true,deadlineAt,state:new ReviewState(path.join(dir,'state')),
   onCandidates:r=>candidates.push(r),log:l=>{logs.push(l);fs.appendFileSync(path.join(dir,'log.txt'),l+'\n');}});
  const summary={variant,pullNumber,repository:fixture.repository,baseSha:fixture.baseSha,headSha:fixture.headSha,inputSha256:hash(fixtureBytes),
   model:raw.model,thinkingProtocol:raw.thinkingProtocol||'provider_default',wireThinkingPolicy:'enabled for both variants (experiment override)',sameGenerationBudget:{turns:4,tokens:32768},
   seconds:(Date.now()-started)/1000,firstTerminalMs:firstResultMs,modelCalls:records.length,partial:result.partial,completed:result.completed,batches:result.batches,
   findings:result.reviewFindings,uncertain:result.reviewUncertain,candidateCount:result.candidateCount,failures:result.failures,
   inputTokens:records.reduce((n,r)=>n+(r.usage?.inputTokens||0),0),outputTokens:records.reduce((n,r)=>n+(r.usage?.outputTokens||0),
   0),limitations:fixture.limitations,networkCaptureExcludedFromTiming:true,referenceAnswersProvided:false};
  for(const [file,data]of [['result.json',result],['summary.json',summary],['candidates.json',candidates]])fs.writeFileSync(path.join(dir,file),JSON.stringify(data,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(dir,'report.md'),result.body||JSON.stringify(result,null,2),{flag:'wx'});
  console.log(JSON.stringify({finished:variant,pullNumber,seconds:summary.seconds,partial:summary.partial,findings:summary.findings.length,uncertain:summary.uncertain.length}));
 }
}
try{if(command==='capture')await capture();else if(command==='probe')await probe();else if(command==='run')await run();else throw new Error('usage: quick-compare.mjs capture|probe|run OUTPUT [baseline|fixed BASELINE_ROOT]');}
catch(error){console.error(JSON.stringify({error:error?.code||error?.name||'error',status:error?.status}));process.exitCode=1;}
