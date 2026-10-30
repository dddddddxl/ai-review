# AI Review

This repository contains the `github-ai-reviewer` service source. The current code includes CI recovery fixes and the bounded-evidence review engine RC1.1.

## Version status

- CI recovery fixes distinguish scan execution failures from confirmed code issues, and replace obsolete failure messages after a successful rerun. These fixes were deployed separately on 2026-10-21.
- RC1.1 uses complete-file review units, read-only repository evidence tools, independent verification, durable candidate checkpoints, and shared concurrency/accounting/deadline controls. It is a release candidate, **not an end-to-end quality-approved production release**.
- The candidate service defaults to `AI_PR_REVIEW_ENGINE=evidence-v1`. Set `AI_PR_REVIEW_ENGINE=legacy` explicitly to select the previous review path; there is no automatic fallback.
- Publishing this source does not change the running production service or its model/API/concurrency configuration.

## Install and test

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The frozen RC1.1 candidate passed 81 offline regressions. These tests do not call a model. Real GLM verification controls rejected two unsupported candidates and confirmed one argument-contract defect; they do not establish whole-PR generation recall, precision or throughput. See [validation and limitations](docs/RELEASE-RC1.1.txt).

Runtime configuration and secrets must be supplied separately. The repository must not contain `node_modules`, job state, model-run outputs, logs, `.env`, API credentials, GitHub App keys or private deployment backups. It is source code, not a full production backup or a deployment configuration.

See [operations](REVIEW-QUALITY-OPERATIONS.txt) before replay or deployment. Whole-PR quality, latency/memory/throughput and deployment preflight remain required.

## Original snapshot provenance

The original main commit `9d8ed7143027c13b2c869fb9d30587b581ecf535` published the production source snapshot from 2026-09-29, exported from image `sha256:b06ff5f67d17628178d363b91a0bb0dc94f7390588167a68ac79100cf0aea684`. Its history is retained. The present candidate is a modified version of that snapshot.

Do not commit credentials or private operational data to this public repository.

## 1027 召回与可靠性修复候选（2026-10-30）

本分支在 `8ee0769` 及同事补丁上继续修复，不代表已部署或通过生产质量验收。

- native 生成使用召回导向指令，预注入关联上下文与可信 base 规则；候选仍需独立复核。
- 缓存包含实际 native 指令、工具、检查清单、预算、推理协议及证据视图指纹；旧缓存不复用。
- `AI_THINKING_PROTOCOL=glm|none` 控制兼容接口参数；GLM 常见名称自动识别。启用与禁用均显式发请求，但网关是否执行仍需验证，不能仅凭 HTTP 成功认定。
- 终结参数缺失、重复 JSON 字段、单轮超过 4 个工具允许一次定向纠错；仍共享原有轮次和 deadline，不新增隐形额度，不执行不明确的取证请求。原始失败及纠错结果进入诊断。
- 预取 base 快照复用于取证，按 SHA 校验；不修改共享快照。服务与回放共用生成参数校验。
- `eval-recall.mjs` 固定完整 base/head，拒绝版本不符的结果；缺失运行计入总分母。输出 `locationProxy` 只是待人工复核的一对一位置匹配，`precision/recall=null`；不把改过代码等同于缺陷确认，不把待发布结果等同于已发布。

### 快速只读对比

通过本地环境提供 GitHub App 私钥路径和模型密钥，不填写到命令示例或提交文件中。

```sh
# OUTPUT 必须是不存在的新目录。仅采集两个历史 PR 的原始证据，不读取 bot 评论作为模型答案。
node scripts/quick-compare.mjs capture OUTPUT
node scripts/quick-compare.mjs probe OUTPUT
node scripts/quick-compare.mjs run OUTPUT baseline /path/to/8ee0769-checkout
node scripts/quick-compare.mjs run OUTPUT fixed
```

两个版本串行执行，使用相同冻结输入、同一模型及显式 enabled 推理请求、4 轮/32768 输出生成预算；不以增加预算作为质量改善。沿用既有全流程默认 deadline，不额外收紧。记录每次调用、完整结论、未知项和耗时，不保存原始思考内容。计时包括本地快照准备和模型调用，不包括一次性的 GitHub 采集网络耗时。

这只是两个已知历史样本的定向回归，不是独立盲测或准确率证明。完整验收仍需未用于调优的新样本、无缺陷对照、人工语义裁定，以及生产预取耗时和网关参数生效检查。没有配置的上游依赖仍应视为未知。

### 本轮实测状态

GLM-5.3-Flash 对两个冻结历史样本的原版审查均因工具协议失败，耗时约 216 秒、297 秒。首轮修复版在第一个样本生成 4 条候选，但嵌套必填 `trigger` 全部缺失，373 秒后仍未完成；第二个样本复现同类问题，提前结束并保留检查点，不计作成功。后续补上逐条字段校验、定向修复，以及“未验证候选”和“复核反驳”的独立计数。一次约 42 秒的真实格式修复调用补齐 4 条候选，其他字段不变；它不是语义复核或端到端质量验收。

当前不能宣称提速、准确率提升或可以上线。下一步应先对最新版本完成一个小型端到端对照，再扩展样本；优先减少无关搜索及长推理，对缺少的上游定义提供固定版本源码。切勿用增大预算或把未知标成通过来提高表面完成率。
