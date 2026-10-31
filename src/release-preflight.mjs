import fs from 'node:fs';
import {createPrivateKey} from 'node:crypto';

// Read-only diagnostics. Never print environment values, paths or key material.
export function releasePreflight(environment=process.env) {
 const checks=[];
 const add=(id,ok,note)=>checks.push({id,status:ok?'pass':'blocked',note});
 for(const key of ['GITHUB_APP_ID','GITHUB_WEBHOOK_SECRET','GITHUB_PRIVATE_KEY_PATH','AI_MODEL'])
  add(key,Boolean(environment[key]),'必须由部署环境提供，报告不包含字段值');
 add('model_credential',Boolean(environment.AI_API_KEY||environment.OPENAI_API_KEY||environment.ANTHROPIC_API_KEY),'必须通过私有配置或密钥管理注入');
 let keyValid=false;
 try { keyValid=createPrivateKey(fs.readFileSync(environment.GITHUB_PRIVATE_KEY_PATH)).asymmetricKeyType==='rsa'; }catch{}
 add('app_private_key',keyValid,'只在内存检查 RSA 私钥，不输出或复制');
 let secureEndpoint=false;
 try { secureEndpoint=new URL(environment.AI_BASE_URL||environment.OPENAI_BASE_URL||environment.ANTHROPIC_BASE_URL).protocol==='https:'; }catch{}
 add('encrypted_model_endpoint',secureEndpoint,'生产使用 HTTPS 或另行审定加密隧道；本机获准 HTTP 实测不等于生产验收');
 const repositories=(environment.ALLOWED_REPOSITORIES||'').split(',').map(s=>s.trim()).filter(Boolean);
 add('explicit_repository_allowlist',repositories.length>0&&repositories.every(r=>/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r)),'灰度必须明确仓库白名单，空值会扩大接收范围');
 add('persistent_state_directory',Boolean(environment.AI_REVIEW_STATE_DIR),'需配置独立持久化目录并人工核验权限、备份和恢复');
 add('dashboard_auth',Boolean(environment.AI_DASHBOARD_TOKEN),'应配置独立面板访问凭据');
 add('explicit_review_engine',['legacy','evidence-v1'].includes(environment.AI_PR_REVIEW_ENGINE),'上线显式选择已验收引擎，不依赖默认值');
 return {schemaVersion:1,kind:'read_only_deployment_preflight',checks,
  configurationReady:checks.every(c=>c.status==='pass'),productionReady:false,
  manualGates:['轮换已在聊天中暴露的模型密钥并确认旧密钥失效；私钥如曾泄露正文也必须轮换',
   '核验 GitHub App 安装范围与最小权限、Webhook 签名及实际回调',
   '独立样本语义复核、完成率/耗时/成本验收',
   '专用测试 PR 的实际评论与重复事件验证',
   '单服务实例、持久化状态备份、固定镜像/提交及回滚演练'],
  note:'配置检查通过不代表模型质量、真实发布或生产部署通过；未启动服务、未调用模型。'};
}
