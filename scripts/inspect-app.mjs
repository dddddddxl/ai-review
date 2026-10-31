import fs from 'node:fs';
import path from 'node:path';
import {App} from 'octokit';
const [repository,output]=process.argv.slice(2);
if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||'')||!output)throw Error('repository_and_new_output_required');
const [owner,repo]=repository.split('/');
const readonly=client=>{client.hook.before('request',r=>{
 if(!['GET','HEAD'].includes(r.method)&&!(r.method==='POST'&&/^\/app\/installations\/(?:\d+|\{installation_id\})\/access_tokens$/.test(r.url)))throw Error('github_write_blocked');
});return client;};
try{
 fs.mkdirSync(output);
 const app=new App({appId:process.env.GITHUB_APP_ID,privateKey:fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH,'utf8')});readonly(app.octokit);
 const {data:info}=await app.octokit.request('GET /app');
 const {data:installation}=await app.octokit.request('GET /repos/{owner}/{repo}/installation',{owner,repo});
 const api=readonly(await app.getInstallationOctokit(installation.id));
 const {data:prs}=await api.rest.pulls.list({owner,repo,state:'all',sort:'updated',direction:'desc',per_page:20});
 const report={repository,capturedAt:new Date().toISOString(),appPermissions:info.permissions,installationPermissions:installation.permissions,
  repositorySelection:installation.repository_selection,events:installation.events,
  candidates:prs.filter(pr=>!pr.draft).map(pr=>({number:pr.number,title:pr.title,baseRef:pr.base.ref,headSha:pr.head.sha,state:pr.state,updatedAt:pr.updated_at})),
  limitations:['Permissions are observed, not modified','No webhook delivery or publication performed','No comments or reference reviews fetched']};
 fs.writeFileSync(path.join(output,'inspection.json'),JSON.stringify(report,null,2),{flag:'wx'});
 console.log(JSON.stringify(report,null,2));
}catch(error){console.error(JSON.stringify({error:error.code||error.name,status:error.status}));process.exitCode=1;}
