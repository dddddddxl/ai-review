# 通用 PR 只读验证与独立评估

本入口把在线证据采集与离线 Codex 文件桥接分开。不会发表评论、触发 CI、执行被审仓库代码或占用加速卡。代码缺陷与测试充分性是两条独立输出；绿色 CI 不等于行为断言充分，没有 coverage 工件时不报告行覆盖率。

## 1. 采集真实输入

```powershell
npm run capture:pr -- --repository HYGON-AI/sglang-das --pr 478 --output C:\review-data\captures
```

仓库和 PR 是参数，可替换。公开仓库可匿名读取；需要鉴权时通过环境变量 `GH_TOKEN` 或 `GITHUB_TOKEN` 提供，不把密钥写进 fixture。仅接受 GitHub GET；请求审计不含凭据或响应正文。每次创建独立 `pr-capture-*` 目录，保存 `fixture.json` 和 `provenance.json`。

默认每请求 15 秒、采集总窗口 180 秒，可通过 `--request-timeout-ms`、`--timeout-ms` 显式调整。文件最多 30 页，CI 元数据列表最多 2 页、8 个 run 明细、4 份 job 日志。文件分页或身份复核失败会显式标记不完整；日志缺失不会被解释为没有测试。

## 2. 准备固定版本副本

从 fixture 取得 base/head，为该 PR 准备独立、干净的 Git checkout，HEAD 必须等于冻结 head，base/head/实际 merge-base 对象必须存在。工具不替用户 checkout/reset，也不运行仓库安装脚本。浅历史仅在 base 本身可证明是 head 祖先、比较区间完整时允许；无法证明即拒绝。

测试审查的受控 skillhub 副本必须固定为 `74376c2b1d263d1e26fa052b21e7847706d6651e`。公开 ai-review 不包含私有 skill 正文，也不自动跟随远端更新。

## 3. 离线桥接干跑

```powershell
npm run dry-run:pr -- --repo C:\review-data\sglang-pr478 --skill C:\controlled\skillhub --fixture C:\review-data\captures\pr-capture-XXX\fixture.json --output C:\review-data\runs --mode both --model-window-ms 1800000
```

`--mode` 可为 `code`、`tests`、`both`，默认 `both`。`code` 不要求 skill；另两种模式缺 skill 时明确报告测试审查未完成。新入口不硬编码仓库、PR 或 SHA。原 `dry-run:codex` 的 #436 入口和 `replay:sglang` 历史回放仍保留。

宿主输出 `bridge/request-NNN.json` 后，Codex 阅读本轮 instructions/input，用对应格式新建 `reply-NNN.json`。不同阶段包括分组、只读取证、候选复核、最终分析，不能都套用同一种响应结构。源码取证通过宿主协议进行；不从旁路读取历史答案或执行目标代码。输入中的顶层 `analysis`、历史 provenance 等不会提供给审查模型。

默认工具预算 24 次、生产模型共享窗口 180 秒、分组窗口 10 秒不变。示例显式使用 30 分钟的文件交互窗口，并写入 provenance；这是等待 Codex 文件答复的时间，不能当作生产模型 API 延迟。窗口扩大不扩大工具预算和每阶段轮数。

每次新建 `pr-dry-run-*`，保留首次输出；重试使用新目录，不覆盖失败记录。Windows 对新运行目录设置私有 ACL，POSIX 使用私有权限。输出不要放在被审 checkout 内。

| 产物 | 含义 |
| --- | --- |
| `provenance.json` | 仓库、PR、提交、输入摘要、skill 版本、模式、交互窗口及上下文声明 |
| `manifest.json` | 代码片段范围、完成与排除原因；不是测试代码覆盖率 |
| `evidence-index.json` | 工具请求、版本、位置、状态和截断信息 |
| `code-review.json` | 产品缺陷审查及定位结果 |
| `test-review.json` | 测试审查与校验状态；不把测试建议转换为产品 bug |
| `report.md`、`pipeline-result.json` | 中文汇总和机器结果 |
| `review.json`、`test-backlog.json`、`generation-plan.json` | skill 成功产出时保存的分析与补测交接；未执行补测 |

退出码：0 为请求阶段均完成，1 为有未完成项，2 为输入或依赖错误。测试阶段的 `validated` 仅表示分析/交接通过校验，不表示 CI、补测代码或硬件已验证。任何截断、拒绝或不足都保留；不能把 partial 写成“没有问题”。

## 4. 独立样本评估

普通干跑始终声明 `blind: false`，不会因为没有 fixture.analysis 就自动升级成盲测。独立评估需要另外保存：预先冻结的样本与输入、先于审查的独立标签、fresh-context 代理身份、首次输出摘要，以及输出冻结后的逐项裁定。

标签和审查输出分开存储；审查代理只收到原始输入和宿主取证响应。评估允许 `unknown`，未知项不计作正确或错误。可裁定准确率、已标注问题召回率、定位正确率、阶段完成率分别计算。没有分母时为 null，不能写成 100%。这些是独立代理标注、主代理复核的样本指标，不是人工认证、全仓召回率或生产保证。

`scripts/score-blind-review.mjs` 只统计已完成裁定的数据，不自动制造 ground truth。运行前核验输入、标签和首次输出的本地相对路径与 SHA-256；输出不覆盖已有文件：

```powershell
node scripts/score-blind-review.mjs examples/independent-pr-review/evaluation.json C:\review-data\metrics.json
```

提交公共示例时只发布经过检查的输入、结果和证据摘要，不复制桥接 request 中的私有 skill 指令。原始运行文件继续保存在私有目录；脱敏导出必须说明与原件的区别，保留原始与导出摘要。

## 5. 回归与补测完成协议

```powershell
$env:AI_REVIEW_SKILL_REPO='C:\controlled\skillhub'
npm run test:acceptance
```

验收要求 Python 真实校验器可用、集成测试零跳过，产出源码指纹绑定的 `docs/offline-validation.json`。

补测计划格式不变，新的完成记录使用 schema v2：场景内 `tests[]` 列出每个真实测试方法和证据。负控按计划的场景级要求关联同场景已通过方法，不要求每个附加方法另造负控。v1 原语义兼容。哈希、版本、实际 case 或已填运行身份冲突不能因为状态未完成而忽略。

`examples/g4-wrapper-validation` 已迁移 v2，保留原始四个方法、三种负控及未完成 CI 选择链状态。此轮只整理工件和校验，不重跑 G4、不修改 SGLang suite 注册、不自动关闭缺口。
