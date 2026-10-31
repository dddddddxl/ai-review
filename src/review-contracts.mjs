export const safeContractPath = p => typeof p==='string' && p.length<500 && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') &&
 !p.split('/').some(s=>!s||s==='.'||s==='..') && !/(?:^|\/)(?:\.git|\.aws|\.ssh|\.codex|\.agents|\.env(?:\.[^/]*)?|secrets?|credentials|node_modules)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(p);

export function structuralOverview(files) {
 const safe=files.filter(f=>safeContractPath(f.filename));
 return safe.slice(0,4).map(f=>`${({added:'新增',removed:'删除',renamed:'重命名'})[f.status]||'修改'} ${f.filename}；缺陷结论以最终复核区为准。`);
}

// Bounded lexical hints, not a Python parser or a claim of a complete call graph.
// Only fixed-head source is read; decorators run before the decorated function.
export function decoratorContracts(files,snapshot,{maxItems=8,maxChars=10000}={}) {
 const items=[];let chars=0,omitted=0;
 for(const f of files){
  if(!f.filename?.endsWith('.py')||!safeContractPath(f.filename))continue;
  const text=snapshot.files.get(f.filename);if(typeof text!=='string')continue;
  const added=String(f.patch||'').split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1));
  const names=[...new Set(added.flatMap(l=>/^\s*@([A-Za-z_]\w*)\s*\(/.exec(l)?.slice(1)||[]))];
  for(const name of names){
   if(items.length>=maxItems){omitted++;continue;}
   const targets=[{file:f.filename,symbol:name}];
   for(const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n]+)/gm)){
    const imports=m[2].replace(/[()]/g,'').split(',').map(s=>s.trim().split(/\s+as\s+/));
    for(const [symbol,alias]of imports){
     if((alias||symbol)!==name||!/^\w+$/.test(symbol))continue;
     let stem;
     if(m[1].startsWith('.')){
      const n=m[1].match(/^\.+/)[0].length;
      if(n>=f.filename.split('/').length)continue;
      stem=[...f.filename.split('/').slice(0,-n),...m[1].slice(n).split('.').filter(Boolean)].join('/');
     }else{
      const parts=f.filename.split('/'),module=m[1].split('.'),i=parts.indexOf(module[0]);
      stem=[...(i<0?[]:parts.slice(0,i)),...module].join('/');
     }
     targets.push({file:stem+'.py',symbol},{file:stem+'/__init__.py',symbol});
    }
   }
   const matches=[];
   for(const t of targets){
    if(!safeContractPath(t.file))continue;
    const source=snapshot.files.get(t.file);if(typeof source!=='string')continue;
    const lines=source.split('\n');
    for(let i=0;i<lines.length;i++)if(new RegExp(`^(?:async\\s+)?def\\s+${t.symbol}\\s*\\(`).test(lines[i])){
     let end=i+1;while(end<lines.length&&end<i+35&&(!lines[end].trim()||/^\s/.test(lines[end])))end++;
     matches.push({path:t.file,start:i+1,end,text:lines.slice(i,end).map((l,k)=>`${i+k+1}: ${l}`).join('\n')});
    }
   }
   if(matches.length!==1){items.push({caller:f.filename,symbol:name,status:matches.length?'ambiguous':'unresolved'});continue;}
   const hit=matches[0];if(chars+hit.text.length>maxChars){omitted++;continue;}
   chars+=hit.text.length;items.push({caller:f.filename,symbol:name,status:'located',side:'head',sha:snapshot.sha,...hit});
  }
 }
 return {kind:'bounded_static_decorator_hints',items,omitted,characters:chars,limitations:['Lexical hints only; aliases, dynamic rebinding and callable decorators still require semantic review.']};
}

// A real source citation is necessary, not sufficient, for a semantic verdict.
// The model must separately justify causality. Never upgrade a verdict here.
function diffLines(patch=''){
 const found=new Set();let line=null;
 for(const s of patch.split('\n')){const h=/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(s);if(h){line=Number(h[1]);continue;}
  if(line!==null&&(s.startsWith('+')&&!s.startsWith('+++')||s.startsWith(' ')))found.add(line++);}
 return found;
}
export function constrainVerdicts(submission,snapshots,{candidates=[],files=[]}={}){
 return { ...submission,verdicts:submission.verdicts.map(v=>{
  if(v.verdict==='uncertain')return v;
  const errors=[];
  if(v.basis!=='fixed_source')errors.push('missing_fixed_source_basis');
  if(!Array.isArray(v.unresolved)||v.unresolved.length)errors.push('unresolved_premises');
  if(!Array.isArray(v.evidenceRefs)||!v.evidenceRefs.length||v.evidenceRefs.length>8)errors.push('missing_or_excessive_citations');
  for(const ref of v.evidenceRefs||[]){
   const s=snapshots[ref.side];
   if(!s||!safeContractPath(ref.path)||!Number.isSafeInteger(ref.line)||ref.line<1||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>1000){errors.push('invalid_citation');continue;}
   const line=s.files.get(ref.path)?.split('\n')[ref.line-1];
   if(typeof line!=='string'||!line.includes(ref.quote))errors.push('citation_not_in_fixed_source');
  }
  if(errors.length)return {...v,verdict:'uncertain',modelVerdict:v.verdict,evidenceGuard:errors,resolvedLine:null,
   reason:`宿主证据校验未通过（${[...new Set(errors)].join(', ')}）；原模型结论未采纳。${v.reason||''}`};
  const candidate=candidates[v.index],file=files.find(f=>f.filename===candidate?.file);
  const lines=diffLines(file?.patch),sourceLines=snapshots.head?.files.get(candidate?.file)?.split('\n')||[];
  const locations=(v.evidenceRefs||[]).filter(r=>r.side==='head'&&r.path===candidate?.file&&lines.has(r.line)&&sourceLines.filter(l=>l.includes(r.quote)).length===1);
  const exact=locations.filter(r=>r.line===candidate?.line),unique=[...new Set(locations.map(r=>r.line))];
  // Never infer a line from a title or broad textual similarity.
  return {...v,resolvedLine:exact.length?candidate.line:unique.length===1?unique[0]:null};
 })};
}
