const base=new URL(process.env.AI_BASE_URL);
let path=base.pathname.replace(/\/$/,'');
path=path.endsWith('/chat/completions')?path.slice(0,-'/chat/completions'.length)+'/models':path+(path.endsWith('/v1')?'':'/v1')+'/models';
const url=new URL(base);url.pathname=path;url.search='';url.hash='';
const response=await fetch(url,{headers:{authorization:`Bearer ${process.env.AI_API_KEY}`},signal:AbortSignal.timeout(15000)});
let data={};try{data=await response.json();}catch{}
const models=Array.isArray(data.data)?data.data:[];
const target=models.find(m=>String(m.id).toLowerCase()===String(process.env.AI_MODEL).toLowerCase());
const allowed=['id','owned_by','context_length','max_context_length','max_model_len','max_tokens','max_output_tokens','output_token_limit'];
const metadata=target?Object.fromEntries(allowed.filter(k=>['string','number'].includes(typeof target[k])).map(k=>[k,target[k]])):null;
console.log(JSON.stringify({status:response.status,models:Array.isArray(data.data)?models.length:undefined,exactMatch:Boolean(target),metadata,availableFields:target?Object.keys(target).filter(k=>!/(key|token|url|endpoint|secret)/i.test(k)).sort():[]}));
