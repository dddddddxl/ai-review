> 当前 Codex 文件桥接干跑；历史 CI 快照；不是独立盲测或模型 API 验收；未运行目标测试。

# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #436](https://github.com/HYGON-AI/sglang-das/pull/436)

- PR 标题：perf: 为 HCU gfx936 DeepSeek-V4 增加 INT8 Persistent Paged MQA Logits
- 目标分支：`release/20260825_v0.5.18`
- Diff base：`50beda6a90ba4dd7c85d667530c2614b13122fbf`
- PR head：`6f0f185a691c16b0134a26f2ff172c7e2af31edb`
- 采集时间：2026-09-28T12:33:00.489051+00:00
- 审查结论：建议补充或修正测试/CI
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

建议补充测试：新路径默认关闭，已读 DSA ABI 与 DSV4 attention 候选不能证明覆盖 Persistent INT8 MQA。识别路由/回退、数值与 TopK、图重放以及 JIT 宽度防卫四类合同。HCU attempt 2 存在失败分片，但不能归因为新内核回归；代码覆盖率未测量。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| python/sglang/srt/environ.py | 已审 | 已读新增 opt-in 开关及默认值，映射 B1。 |
| python/sglang/srt/layers/attention/dsv4/indexer.py | 已审 | 已读改前 dense 调用、改后路由/估长/graph 判定、生产调用和 TopK 分支，映射 B1–B3。 |
| python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu | 已审 | 480 行新增实现均经过宿主读取，核查任务压缩、计算、写回和启动合同，映射 B2/B3；不宣称形式化证明。 |
| python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py | 已审 | 54 行新增包装器均已读取，映射 B2/B4。 |

## CI 运行元数据

| Run / attempt | Workflow / 事件 | 版本关系 | Job | 状态 |
|---|---|---|---|---|
| [35856335333](https://github.com/HYGON-AI/sglang-das/actions/runs/35856335333) / 1 | Cancel PR Workflows on Close / pull_request_target | PR head 元数据匹配 | cancel | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-2) | 失败 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-3) | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-0) | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-1) | 成功 |
| [35820902721](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902721) / 2 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [35820902718](https://github.com/HYGON-AI/sglang-das/actions/runs/35820902718) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [35820751411](https://github.com/HYGON-AI/sglang-das/actions/runs/35820751411) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code compliance | 成功 |
| [35820751411](https://github.com/HYGON-AI/sglang-das/actions/runs/35820751411) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code quality | 成功 |
| [35820751411](https://github.com/HYGON-AI/sglang-das/actions/runs/35820751411) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code security | 成功 |
| [35820751411](https://github.com/HYGON-AI/sglang-das/actions/runs/35820751411) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / All required checks | 成功 |
| [35820749322](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749322) / 1 | Release PR HCU Wheels / pull_request_target | PR head 元数据匹配 | compile (3.10) | 成功 |
| [35820749310](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749310) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [35820749297](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749297) / 1 | Auto Label PRs / pull_request_target | PR head 元数据匹配 | label | 成功 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 取消 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 取消 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 取消 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 取消 |
| [35820749286](https://github.com/HYGON-AI/sglang-das/actions/runs/35820749286) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (${{ matrix.name }}) | 取消 |
| [35856335112](https://github.com/HYGON-AI/sglang-das/actions/runs/35856335112) / 1 | Release HCU Nightly Wheels / push | 合并提交候选（单列） | 未取得 job 明细 | 完成 |

Checks / 外部 status 记录：36 / 0；完整身份、历史及接口可见性见 review.json。

绿色 job 仅表示 job 状态；具体行为通过须由对应版本、平台、lane、test ID 的结果证明。

## PR 行为与测试

| ID / 行为 | 改前 → 改后 | 必测触发条件 | 断言设计 | CI 选择 | 具体行为执行 |
|---|---|---|---|---|---|
| B1 / Persistent 选择、估长与 dense 回退 | INT8 producer 走既有 fn dense 分支。 → 默认关闭；开启后 eager 检查估长与容量比，graph 绕过容量比；满足 gfx936 和元数据合同才走 Persistent。 | INT8 K-cache 已启用、paged 路径、非 FP4/tilelang/aiter；Persistent 开关开启。 | 缺口 | 未知 | 未核验 |
| B2 / INT8 数值、页边界与长度限定 TopK | dense producer 计算全容量 logits。 → 任务压缩后只计算真实 chunk；空行初始化 -INF，非空行远端尾部可未写；下游按真实长度选 TopK。 | 生产路由实际选中 Persistent，合法 INT8 Q/K packed ABI、FP32 权重和 INT32 页表。 | 缺口 | 未知 | 未核验 |
| B3 / 设备任务压缩的 graph capture/replay | INT8 graph 使用 dense producer，无此设备任务压缩。 → graph route 不使用 CPU 估长门槛，每次在同一 stream 运行压缩和主 kernel。 | prefill graph、piecewise/breakable graph 或当前 stream capture，且满足 Persistent 元数据条件。 | 缺口 | 未知 | 未核验 |
| B4 / JIT 包装器非法宽度拒绝与参数转发 | 不存在新增 JIT 包装器。 → 非正或非 64 倍数宽度在加载模块前 ValueError；合法 4D Q reshape 后转发参数。 | 直接调用 persistent_int8_paged_mqa_logits。 | 缺口 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P1] 已审候选缺少 Persistent 路由、有效区数值和动态 graph 专项断言 · F1

- 类型：coverage_gap；置信度：中
- 影响：现有绿色 job 或同名 MQA/graph 测试不能证明新增三类行为；默认关闭使 smoke 更可能漏过。
- 建议：分别补生产路由正反例、独立数值/TopK oracle 和改变长度/页表的 graph 重放，并证明 HCU CI 选择和执行。
- 证据：ROUTE, CALL, ENV, K1, K2, K3, DSA, DSV4, SEARCH

### [P1] 缺场景选择、路径命中及逐测例执行身份 · F3

- 类型：evidence_gap；置信度：高
- 影响：不能将 stage success、文件汇总或不同 attempt 的通过子集记为新增行为通过。
- 建议：补采全部相关分片与有效 selector，输出 head/wheel、run/attempt/job、开关和具体 nodeid 身份；保持当前 execution 未核验。
- 证据：LOG, WF, RUNNER, DSV4

### [P2] 包装器拒绝非法宽度的廉价 CPU 合同可单独补齐 · F2

- 类型：coverage_gap；置信度：中
- 影响：边界或参数转发回归目前缺少直接断言；不应等待大模型 HCU smoke 才暴露。
- 建议：新增非法宽度与合法转发接口测试，mock 仅隔离 JIT，调用真实包装器；明确它不验证设备计算。
- 证据：JIT, SEARCH

### [P2] required-2 日志有 HIPBLAS 分配及端口占用症状，根因待定位 · F4

- 类型：infrastructure_failure；置信度：高
- 影响：该分片文件汇总 10/15，通过数不可当覆盖率；未建立失败与 Persistent 内核因果链。
- 建议：环境/资源调查单列；补全失败文件日志与资源时间线，在独立授权后才重跑。不据此报告产品 bug。
- 证据：LOG

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| G1 | B1 | write | G1-route, G1-length |
| G2 | B2 | upstream_first | G2-boundary |
| G3 | B3 | write | G3-replay |
| G4 | B4 | write | G4-width |

## 限制与待核实

- 当前 Codex 对固定历史输入进行只读分析；不是新 agent 盲测，不是模型 API 适配验收；未运行目标代码、collection、HCU 测试或重跑 CI。
- 实际 tool 预算为 24 次。完整读取新增内核与包装器，并审阅变更路由/TopK 片段；替代覆盖检索有明确边界，没有穷举全仓全部测试语义。
- 一次读取 base workflow 1–180 行不可用，缩小至 1–80 行成功；中间 gate 与所有矩阵配置未全部取证，不声称审查完整选择链。
- base workflow 只作静态对照，未确认它就是当次 pull_request_target 实际工作流 revision；当次 required-2 的选择命令以日志工件为依据。
- 仅有一个失败分片的脱敏日志摘录及元数据，没有逐 nodeid 报告或全部分片日志。10/15 是该分片的测试文件汇总，不是功能或代码覆盖率。
- 无匹配 head 的 coverage 工件，代码行/分支覆盖率未测量；外部开关、其他调度路径及完整安装身份仍存在未知项。
- 元数据不证明测试源码、安装 wheel 或具体测例实际执行；需要 job 日志及逐测试结果。
- head/merge SHA 查询可能遗漏 pull_request_target、workflow_dispatch 和外部调度；按 workflow、PR checks 链接及调度系统补查。
- 合并提交上的 push/release 构建属于合入后证据，不能回填为 PR head 的测试通过。
- checks 保留重跑记录，statuses 保留历史；分析时核对最新 attempt、同名 check 的 app 身份和时间。
- 权限不足、404、分页预算用未知表示，不推断门禁不存在。

## 证据索引

- ROUTE：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:80–179` — 估长包含 speculative/ragged/extend；eager 容量比门槛 2.0；graph 路由跳过该门槛，仍检查硬件、dtype、shape、contiguous 和 device。；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- CALL：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:901–1100` — 生产调用区分 nonpaged、INT8、其他后端，处理 Q 量化与权重，选择 Persistent 或 dense；下游 TopK 传入 c4_seq_lens。；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- TOPK：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:1101–1140` — 其他 TopK 后端亦接收长度；需要验证实际目标后端不会读取未初始化尾部，传参本身不是执行证明。；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- OLD：`50beda6a90ba python/sglang/srt/layers/attention/dsv4/indexer.py:820–980` — 改前 INT8 分支调用现有 fn dense producer，不存在本 PR 的 Persistent 选择。；SHA256 `b7d97000736ed6325682c2f853f38040b7548c263fda5aa0abba88e940f60ec0`
- ENV：`6f0f185a691c python/sglang/srt/environ.py:1390–1400` — INT8 K-cache 和 Persistent 开关默认 False；普通 smoke 不保证命中。；SHA256 `f54cc37c70eedf2f47062336d287563334294cbf208fe68d5bd11f9aba481f09`
- JIT：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py:1–54` — 缓存 JIT 模块、加载 CU；入口在加载前拒绝非正或非 64 倍数的宽度，reshape Q 并调用 persistent。；SHA256 `bc300beb36b11f07b1102755996c745892df4b01acc712cd408396af55d87809`
- K1：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu:1–190` — 任务按真实长度循环；空行填 -INF；非空尾部不保证全容量初始化；读取 Q、权重、页表和 scale。；SHA256 `7b6c6ae78d8c22eee7b8484caa4b789d22663e8c1e1ca5d7a3e236b286947a5d`
- K2：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu:191–375` — INT8 dot、ReLU、head 权重求和和 K scale 构成数值合同，不能用仅 shape 断言代替。；SHA256 `7b6c6ae78d8c22eee7b8484caa4b789d22663e8c1e1ca5d7a3e236b286947a5d`
- K3：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu:376–480` — 有效区写回；设备上压缩任务数；每次同一 stream 启动 prologue 和主 kernel；宽度/批次与临时分配影响 graph 验证。；SHA256 `7b6c6ae78d8c22eee7b8484caa4b789d22663e8c1e1ca5d7a3e236b286947a5d`
- DSA：`6f0f185a691c test/registered/unit/layers/attention/dsa/test_hcu_indexer.py:1–195` — 实际断言是 dsa_indexer 的 LightOp 调用 ABI、后端选择与缓存 shape，不调用本 PR DSV4 Persistent producer。；SHA256 `3783340edca3a2d096ece78c9e2abf4db22894ddea5a2e362f3bc52bb2e80a4a`
- DSV4：`6f0f185a691c test/registered/attention/unittests/dsv4/test_deepseek_v4.py:1–100` — 候选显式绕过生产 C4Indexer，注册 CUDA B200/large runner，不能证明 HCU Persistent 路由或 graph producer 覆盖。；SHA256 `b8a70cb62fd5327f15cb0f78e18df7cc4acfbba70fc9dbd06eaaf572242388c5`
- WF：`50beda6a90ba .github/workflows/pr-test-hcu.yml:740–850` — 静态 Stage B include-file 清单及分片参数；静态配置不冒充实际执行版本。；SHA256 `1ef88cfc496da803b15f4e98994482da3d1dbdd7effa30572915a8855ac84775`
- TRIGGER：`50beda6a90ba .github/workflows/pr-test-hcu.yml:1–80` — pull_request_target 对 release/** 及 python/** 触发；另有 dispatch，不能以路径命中推断 gate 已放行或场景通过。；SHA256 `1ef88cfc496da803b15f4e98994482da3d1dbdd7effa30572915a8855ac84775`
- SELECT：`6f0f185a691c test/run_suite.py:362–430` — include-file 进行精确路径过滤；不匹配 suite 的指定文件会报错。；SHA256 `c7b9ca795455da167ac77b568b1311c1127986e8fe6d2b98b4c3904eadc8d87b`
- RUNNER：`6f0f185a691c test/run_suite.py:480–550` — 注册扫描后按硬件/suite 过滤，再 include-file，最后分片；注册不代表实际执行。；SHA256 `c7b9ca795455da167ac77b568b1311c1127986e8fe6d2b98b4c3904eadc8d87b`
- LOG：`artifacts/job-excerpts.txt` — run 35820902721 attempt 2 required-2 的 checkout/wheel、实际白名单命令及失败症状；仅文件汇总，没有逐 nodeid。；SHA256 `a8d881665501450df725e95a3b3cc5de3bbc152ffc2446c6678552069b856e00`
- SEARCH：`artifacts/search-evidence.txt` — 固定 head 的历史阴性检索与候选范围记录；阴性关键词检索不是全仓无覆盖证明。本次宿主还读取候选源码并做局部路径搜索。；SHA256 `418ebabbc59679e056530e04d6561275426ffa183667d24ca0e3e63a3bbaf4e6`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
