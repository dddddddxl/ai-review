> 独立保存的最终收尾；取证预算未恢复、首次结果未覆盖。以下校验成功也不代表完整审查或 CI 通过。

# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #477](https://github.com/HYGON-AI/sglang-das/pull/477)

- PR 标题：fix(hcu): enable EAGLE draft decoding for DeepSeek MLA
- 目标分支：`release/20260825_v0.5.18`
- Diff base：`cfa865d339c0d7191dd044e6980006be799a570a`
- PR head：`3b7049f294910ae75265c5dc66d2a93798460afc`
- 采集时间：2026-10-08T07:02:45.170Z
- 审查结论：需要补充证据
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

本轮为 continued_context 的协议修正收尾，不是新鲜上下文首次盲测，未新增取证。四个变更文件的相关实现已静态审阅；匹配断言、完整 CI 选择链及逐场景执行仍未核验，四项行为均保留 design=unknown、selection=unknown。现有材料支持证据缺口及后续核验建议，不支持确认缺测例、产品回归或行为测试通过。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| python/sglang/srt/layers/attention/flashattention_interface.py | 已审 | 已读变长缓存入口及 int32 累加实现；断言、选择和实际执行未核验。 |
| python/sglang/srt/layers/attention/hcu_mla_backend.py | 已审 | 已读草稿扩展元数据、分发、缓存写入和 MLA 调用片段；完整调用图及硬件结果未核验。 |
| python/sglang/srt/models/deepseek_v2.py | 已审 | 已读共享专家压缩量化配置回退上下文；匹配测试断言未知。 |
| python/sglang/srt/speculative/draft_utils.py | 已审 | 已读工厂返回约定、父子后端标记和 HCU 后端构造；测试证据链未核验。 |

## CI 运行元数据

| Run / attempt | Workflow / 事件 | 版本关系 | Job | 状态 |
|---|---|---|---|---|
| [37735956674](https://github.com/HYGON-AI/sglang-das/actions/runs/37735956674) / 1 | Cancel PR Workflows on Close / pull_request_target | PR head 元数据匹配 | cancel | 成功 |
| [37735182855](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182855) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-2) | 成功 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-3) | 运行中 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-1) | 失败 |
| [37735182751](https://github.com/HYGON-AI/sglang-das/actions/runs/37735182751) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-0) | 成功 |
| [37726044008](https://github.com/HYGON-AI/sglang-das/actions/runs/37726044008) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code compliance | 成功 |
| [37726044008](https://github.com/HYGON-AI/sglang-das/actions/runs/37726044008) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code security | 成功 |
| [37726044008](https://github.com/HYGON-AI/sglang-das/actions/runs/37726044008) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code quality | 成功 |
| [37726044008](https://github.com/HYGON-AI/sglang-das/actions/runs/37726044008) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / All required checks | 成功 |
| [37726043292](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043292) / 1 | Release PR HCU Wheels / pull_request_target | PR head 元数据匹配 | compile (3.10) | 成功 |
| [37726043357](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043357) / 1 | Auto Label PRs / pull_request_target | PR head 元数据匹配 | label | 成功 |
| [37726043355](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043355) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-0) | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-1) | 失败 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-3) | 成功 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-2) | 失败 |
| [37726043294](https://github.com/HYGON-AI/sglang-das/actions/runs/37726043294) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [37735955930](https://github.com/HYGON-AI/sglang-das/actions/runs/37735955930) / 1 | Release HCU Nightly Wheels / push | 合并提交候选（单列） | 未取得 job 明细 | 完成 |

Checks / 外部 status 记录：28 / 0；完整身份、历史及接口可见性见 review.json。

绿色 job 仅表示 job 状态；具体行为通过须由对应版本、平台、lane、test ID 的结果证明。

## PR 行为与测试

| ID / 行为 | 改前 → 改后 | 必测触发条件 | 断言设计 | CI 选择 | 具体行为执行 |
|---|---|---|---|---|---|
| B-DRAFT-EXTEND / HCU MLA 草稿扩展元数据与前向分发 | DRAFT_EXTEND_V2 在 forward_extend 与普通 EXTEND 一同委托 FlashAttention；对应元数据分支没有新增的 FlashAttention 初始化调用。 → DRAFT_EXTEND_V2 继续走 MLA 前向路径，并在非 skip_prefill 时补充 FlashAttention 元数据初始化；普通 EXTEND 仍委托 FlashAttention。 | HCU MLA 接收 DRAFT_EXTEND_V2，分别考虑 skip_prefill、接受长度和非 FP8/FP8 缓存。 | 未知 | 未知 | 未核验 |
| B-FACTORY / 草稿后端返回类型兼容及 HCU 名称标记 | 工厂统一解包二元组，而 HCU 创建函数直接返回后端实例。 → 工厂接受二元组和单实例，HCU 创建函数显式返回名称及实例；继续标记父子后端名称。 | 多步草稿解码的 speculative_num_steps 大于 1，或被选中的后端创建函数返回单实例。 | 未知 | 未知 | 未核验 |
| B-CUMSUM-DTYPE / 变长缓存累加显式采用 int32 | cumsum 未显式指定累加结果 dtype。 → cumsum 显式采用 int32，再与缓存长度同类的前导零拼接。 | 三维查询且具备 cu_seqlens_q、max_seqlen_q、page_table 与 cache_seqlens。 | 未知 | 未知 | 未核验 |
| B-COMPRESSION-CONFIG / 共享专家压缩量化配置回退 | 仅读取 quantization_config，另有量化方法模块名的备用识别。 → quantization_config 缺失或为空时读取 compression_config；非空前者仍优先。 | FP8 共享专家使用仅包含 compression_config 的配置，或 quantization_config 为空。 | 未知 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P2] 四项变更的断言、选择和执行证据尚未核验 · F-EVIDENCE-CHAIN

- 类型：evidence_gap；置信度：高
- 影响：当前已读材料不能证明四项行为经具体测试验证；失败 job 的原因也未知。这是审查证据限制，不是已确认没有测试、产品缺陷或测试失败归因。
- 建议：先补充既有候选测试正文、真实工作流和 runner 选择链，再取得同一 run/attempt 的逐测例结果及 checkout、安装产物身份；同时定位 HCU required 失败日志。
- 证据：SRC-META, SRC-DISPATCH, SRC-FACTORY, SRC-HCU-FACTORY, SRC-DTYPE, SRC-QUANT

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| T-DRAFT-EXTEND | B-DRAFT-EXTEND | validate_existing | C-DRAFT-EXTEND |
| T-FACTORY | B-FACTORY | validate_existing | C-FACTORY-RETURN |
| T-CUMSUM-DTYPE | B-CUMSUM-DTYPE | validate_existing | C-CUMSUM-INT32 |
| T-COMPRESSION-CONFIG | B-COMPRESSION-CONFIG | validate_existing | C-COMPRESSION-FALLBACK |

## 限制与待核实

- 本轮仅据新请求复用原先 24 条真实取证记录，没有继续取证、运行目标代码、收集或运行测试、安装依赖、重跑 CI。
- continued_context：本轮不是新的 fresh_context 首次审查。原首次审查及原回复全部保留；未接触预标注答案、evaluation、他人报告、GitHub 评论或业务 checkout。
- E1/E2/E3/E5/E7/E23 为 line_range_invalid，不计作已读源码；E12/E18/E19/E20 搜索截断，不能据阴性结果证明不存在测试。
- 工作流正文 E22 和 EAGLE 候选测试正文 E24 被 content_denied 拒绝。E21 仅完整枚举限定的 test/registered/hcu/spec 路径，不是全仓覆盖清单。
- selection_evidence 仅引用已读实现所确定的必要运行分支，用于说明待核验的选择条件；这些 source 引用不是 workflow、selector 或 CI 命中证明，故 selection 均保持 unknown。
- 快照显示 HCU run 37726043294 attempt 1 的 required-1、required-2 和 finish 失败；run 37735182751 attempt 1 尚未结束，required-1 失败，required-3 尚无结论。未取得相应逐测试失败日志和运行身份，原因及与本 PR 的因果关系未知。
- 输入列出的日志工件未读取，不能将 PR 状态更新、取消工作流或 gate 成功当作功能测试通过。
- pull_request_target 的实际 workflow 版本、矩阵、suite/selector、外部配置和分支门禁未完整核验；head 源码不能代替实际执行配置。
- 没有匹配的 checkout、实际安装产物身份和逐测例结果；observations 为空，执行未核验。合并提交的发布结果不回填 PR head。
- 没有同版本 coverage 工件，代码行及分支覆盖率未测量；本报告不是批准合并或保证无缺陷。
- 元数据不能证明具体场景、checkout 或安装产物身份。
- 未执行测试；外部调度、不可见配置与动态选择可能无法核验。

## 证据索引

- SRC-DTYPE：`3b7049f29491 python/sglang/srt/layers/attention/flashattention_interface.py:161–185` — E9：变长入口条件及 cumsum 的显式 int32；只证明待测试实现和触发条件，不证明 CI 选中。；SHA256 `49c56b5d1695e4b24c6c87e947111450f349965ba4a7cb597092837f657a64cd`
- SRC-META：`3b7049f29491 python/sglang/srt/layers/attention/hcu_mla_backend.py:247–308` — E6：DRAFT_EXTEND_V2 元数据分支在非 skip_prefill 下新增 FlashAttention 初始化；不是测试运行证据。；SHA256 `51abef72664ea1869d791a4a35768879cbfa41f8ce3d87531d07a75e3c3154a9`
- SRC-DISPATCH：`3b7049f29491 python/sglang/srt/layers/attention/hcu_mla_backend.py:848–920` — E10/E14 的连续已读区间：仅普通 EXTEND 委托 FlashAttention，其他模式继续进行缓存写入和 MLA 调用；不是 CI 选择证据。；SHA256 `51abef72664ea1869d791a4a35768879cbfa41f8ce3d87531d07a75e3c3154a9`
- SRC-QUANT：`3b7049f29491 python/sglang/srt/models/deepseek_v2.py:853–900` — E4：FP8 共享专家先读取 quantization_config，缺失或为空时回退 compression_config，并保留模块名识别途径。；SHA256 `29411a934ec36aa63add1c7b8cdc2e3014e4058f754b3611177e6c0988b0b7f4`
- SRC-FACTORY：`3b7049f29491 python/sglang/srt/speculative/draft_utils.py:61–125` — E8：创建函数返回二元组或单实例均可处理，非空后端被标记名称；多步解码后端仅在步数大于 1 时继续构造。；SHA256 `d304fb348d9873db405604fcf1eff389a0379118e01312540c616bf7b46ea396`
- SRC-HCU-FACTORY：`3b7049f29491 python/sglang/srt/speculative/draft_utils.py:364–376` — E16：HCU 多步草稿创建函数显式返回 hcu_mla 名称和后端实例。；SHA256 `d304fb348d9873db405604fcf1eff389a0379118e01312540c616bf7b46ea396`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
