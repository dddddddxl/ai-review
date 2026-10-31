// Local lifecycle only: no timers, network calls or implicit shutdown deadline.
export function createServiceLifecycle(){
 const active=new Set();let draining=false;
 return {
  get draining(){return draining;},
  track(promise){const p=Promise.resolve(promise);active.add(p);p.then(()=>active.delete(p),()=>active.delete(p));return p;},
  async drain(){draining=true;while(active.size)await Promise.allSettled([...active]);},
 };
}
export function runtimeReadiness({modelConfigured,draining=false}){
 const ready=Boolean(modelConfigured)&&!draining;
 return {statusCode:ready?200:503,body:{status:ready?'ready':'not_ready',modelConfigured:Boolean(modelConfigured),draining,
  scope:'configuration_and_process_only',qualityApproved:false}};
}
