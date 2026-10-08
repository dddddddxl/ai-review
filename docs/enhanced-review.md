# 增强审查与测试覆盖接入

本实现借鉴 Alibaba Open Code Review 的确定性分工、按需取证、分组校验、路径规则和片段定位思路，使用原有 Node.js 服务实现，不依赖 OCR CLI，未复制 OCR 源码。

## 开关与配置

默认保持旧模式。`AI_REVIEW_ENHANCED=true` 开启增强代码审查；`AI_TEST_REVIEW=true` 独立开启测试充分性审查。后者不是测例生成或执行开关。

| 配置 | 含义 |
|---|---|
| `AI_REVIEW_CHECKOUTS` | JSON：仓库全名 → 管理员准备的绝对路径；可用 `{head}` 占位以隔离不同 PR 版本 |
| `AI_REVIEW_SKILL_REPO` | 受控的 skillhub Git 副本路径，HEAD 必须为 `74376c2b1d263d1e26fa052b21e7847706d6651e` |
| `AI_REVIEW_PYTHON` | Python 可执行文件，默认 `python`，推荐 3.10+ |
| `AI_REVIEW_MAX_TOOLS` | 每次 PR 审查共享工具预算，默认 24，上限 100 |
| `AI_REVIEW_STATE_DIR` | 私有运行状态与审查产物目录；不可放进被审 checkout 或公开静态目录 |

例如 `AI_REVIEW_CHECKOUTS={"HYGON-AI/sglang-das":"/srv/review-snapshots/sglang/{head}"}`。
目录必须预先包含 base/head/merge-base Git 对象。测试 skill 校验还要求干净、完整、HEAD 精确匹配的独立副本。服务不会 checkout/reset 用户目录，不会自动安装依赖、初始化子模块、执行目标仓库代码或启动测试。缺副本时报告未完成。快照准备与更新由部署方负责；本轮没有部署该机制。

skill 是外部固定版本依赖：先用拥有权限的账号取得个人 skillhub 的指定提交，再设置路径；公开 fork 不携带该私仓的 skill 文件。没有 skill 时默认测试套件明确跳过 Python 集成项，不能称为完整验收。发布验收必须配置 skill 路径且跳过数为零。

## 三种覆盖含义分开

- 审查执行清单：选中了什么、哪些片段完成、排除/失败/截断/待审原因。
- 功能测试覆盖：断言设计、CI 选择、逐场景执行，各自有独立状态。
- 实测代码覆盖率：没有匹配版本的 coverage 工件就写“未测量”。

模型通过 `action=tools/final` 文本 JSON 协议提出请求，宿主只接受 `read_file/find_files/search_code/read_diff/read_ci/read_artifact`。同一协议适配现有 Responses、Chat Completions 和 Anthropic 文本接口，不接受任意命令或任意 URL。
默认每个推理阶段最多 8 轮，整个审查工具结果最多 120000 字符、工具预算 24 次，模型阶段共享 180 秒窗口。单文件最多 512 KiB，单次读 200 行/16000 字符，搜索最多 100 个候选文件，截断明确记录。程序边界不能证明模型抵抗所有提示注入；仍需下一阶段真实模型评测。

分组先采用目录、同名实现/测试和补丁引用关联；4 个以上文件允许模型提出分组。组大小、重复、未知路径经过校验，漏项补单文件，非法分组回退，随后仍由原有字符预算拆分片段。它是轻量关联分组，不是完整 AST 调用图。

## 仓库补充规则

从固定 base 的 `.ai-review/rules.json` 读取，支持 `*`、`**` 路径匹配；全部匹配项按声明顺序追加。规则影响审查重点，不能覆盖基础隐私、权限、证据和输出协议。head 对规则的修改不会在同一 PR 中生效。

```json
{
  "version": 1,
  "rules": [
    {"id": "hcu-kernels", "path": "**/*.cu", "instruction": "核查 dtype、shape 边界、数值 oracle 与回退路径。"},
    {"id": "tests", "path": "test/**", "instruction": "检查断言是否覆盖新行为以及负控能否识别错误实现。"}
  ]
}
```

问题包含 `existing_code`、`evidence_ids`；程序重新匹配新增 diff。缺片段、重复匹配或只匹配删除行时只做总结，不猜测行号。无外部取证的纯 diff 问题允许证据 ID 为空，但仍经既有候选复核。

## 测试 skill 流程与产物

服务端采集 PR/files/checks/statuses/run/job/attempt；每列表默认最多 2 页、最多 8 个 run 明细、4 份已完成 job 日志。额外通过 check 链接和明确的 run→PR 关联查找 target/dispatch 运行。不会仅凭分支同名建立 PR 关联；外部调度仍可能缺失。

模型阅读固定 skill 的 PR 约定，按真实读过的源码和采集的日志形成 `analysis.json`。宿主核对源码已读区间和工件白名单，再运行原版 `pr_review.py`；有任务时运行原版 `check_handoff.py`。Python 子进程不继承模型或 GitHub 凭据。机器校验检查来源与一致性，不替代对测试语义和运行身份的人工/模型核验。

输出位于私有状态目录下，每次单独建目录：

- `snapshot.json`、`analysis.json`、`artifacts/`：审查输入。
- `result/report.md`、`result/review.json`、`result/test-backlog.json`：原 skill 输出。
- `generation-plan.json`：交接校验结果；不生成代码、不执行场景。
- 服务状态记录中保存审查 manifest、规则/skill/证据指纹及取证索引。

PR 总评增加独立测试状态表，原有产品缺陷列表保持原义。所有 CI 完成结果都可触发测试审查刷新；与原有“失败根因分析”分队列，按 PR head/base 和 run/attempt 检查过期、幂等更新。找不到当前 PR review 时保存待处理状态，不额外创建评论；可重新处理暂停任务。未来启用线上配置会沿用现有发布授权，本轮没有启用服务或发布任何业务评论。

## 离线验收与 SGLang 回放

```powershell
npm ci --ignore-scripts
$env:AI_REVIEW_SKILL_REPO='C:\controlled\skillhub'
npm test
npm run test:acceptance
npm run replay:sglang -- --repo C:\controlled\sglang-pr436 --skill C:\controlled\skillhub --fixture examples/sglang-pr436/fixture.json --output C:\review-output\sglang-pr436
```

Linux 使用相应绝对路径，并以 `AI_REVIEW_SKILL_REPO=/controlled/skillhub npm test` 设置环境变量。SGLang 副本 HEAD 必须为 `6f0f185a691c16b0134a26f2ff172c7e2af31edb`，包含 fixture 内的 base 对象并保持干净。

`npm test` 默认封禁 Node 网络入口；Git 只读取本地对象，Python 校验器只核验本地文件。测试替身不会创建 GitHub 评论。真实模型和 GitHub 检查脚本不属于此测试命令，禁止用它们替代离线验收。

`npm run test:acceptance` 要求外部 skill 可用，拒绝任何失败或跳过，并生成包含测试名称、计数和源码指纹的 `docs/offline-validation.json`。指纹不匹配意味着该记录不能证明当前源码已验收。

`examples/sglang-pr436` 的源码/CI 来源真实且版本固定；分析是历史审查的脚本回放，不是当前模型新推理。示例的代码缺陷阶段为空结果也只是编排夹具，不能证明 PR 没有缺陷。测试报告保留 3 类行为缺口、3 项交接任务；无 HCU 测试执行，无真实行覆盖率。

## Codex 文件桥接干跑

没有模型 API 配置时，可让当前 Codex 读取宿主生成的 `bridge/request-NNN.json` 并提供 `bridge/reply-NNN.json`。这条路径不加载历史 `fixture.analysis`，不自动提供答案，仍经过宿主只读工具、固定版本 skill、实际 Python 分析与交接校验。脚本默认封禁网络，不创建 GitHub App，不发表评论或运行目标代码。

```powershell
npm run dry-run:codex -- --repo C:\controlled\sglang-pr436 --skill C:\controlled\skillhub --fixture examples/sglang-pr436/fixture.json --output C:\private\codex-audit --mode tests --model-window-ms 1800000
```

`tests` 仅审查测试充分性；`both` 还调用代码缺陷阶段。请求文件中含指令、输入与预算；回复使用同一 `action=tools/final` JSON 协议。每次最多 8 个工具请求、总预算 24 次。人工文件交互可显式把本次窗口放宽至最多 30 分钟；不改变服务默认 180 秒窗口。超时/非法输出保留未完成，不能记为通过。

2026-09-30 已对固定 PR #436 完成一次 `tests` 干跑：5 轮、24 次取证、4 个行为、4 项交接任务，实际 Python 校验通过，未执行目标测例。分析与评估在 `examples/sglang-pr436-codex/`。它使用当前对话上下文与历史 CI 快照，不是新 agent 盲测，也不代表真实模型 API 或生产延迟验收。

测试审查失败现在返回安全 `diagnostic.stage/code`，区分快照、模型、证据、分析校验与交接阶段。工具拒绝也保留受限的原因分类和安全路径；不返回 provider 原始错误、Python stderr、敏感请求或凭据。

## 后续阶段（未执行）

通用入口和独立 PR 评估流程见 [PR 验证说明](pr-validation.md)。后续仍需在有模型 API 配置时验证三种协议、真实延迟与共享预算；确认后再配置独立 GitHub App 测试环境，最后按明确场景和资源预算决定是否运行 HCU 测例。本轮不包含历史 commit 自动学习或生产上线。
