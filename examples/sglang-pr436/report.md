> 离线历史回放：真实固定版本源码及历史 CI 证据；模型输出由历史分析脚本注入。验证编排、证据约束和交接，不是新一轮模型推理，不表示新增 HCU 测例执行通过。

# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #436](https://github.com/HYGON-AI/sglang-das/pull/436)

- PR 标题：perf: 为 HCU gfx936 DeepSeek-V4 增加 INT8 Persistent Paged MQA Logits
- 目标分支：`release/20260825_v0.5.18`
- Diff base：`50beda6a90ba4dd7c85d667530c2614b13122fbf`
- PR head：`6f0f185a691c16b0134a26f2ff172c7e2af31edb`
- 采集时间：2026-09-28T12:33:00.489051+00:00
- 审查结论：建议补充或修正测试/CI
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

PR #436 已有实际HCU CI运行，不能沿用PR正文“未运行”的判断；4个改动文件映射3类新增行为，已审测试未提供新路径的针对性断言。CI红灯与产品回归因果未确定。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| python/sglang/srt/environ.py | 已审 | 已读取本PR对应的开关/路由/JIT/内核行为，并映射行为合同 |
| python/sglang/srt/layers/attention/dsv4/indexer.py | 已审 | 已读取本PR对应的开关/路由/JIT/内核行为，并映射行为合同 |
| python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py | 已审 | 已读取本PR对应的开关/路由/JIT/内核行为，并映射行为合同 |
| python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu | 已审 | 已读取本PR对应的开关/路由/JIT/内核行为，并映射行为合同 |

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
| B1 / 路由选择与安全回退 | INT8 paged路径调用LightOp → 开关启用且满足gfx936/容量比/布局才走Persistent，其他走原分支 | 开关开关两态；容量比<2/=2/>2；缺CPU长度；非gfx936；dtype/shape/contiguous/device不匹配；spec/ragged长度 | 缺口 | 未知 | 未核验 |
| B2 / INT8内核数值、有效长度与TopK | LightOp生成dense logits → JIT加载persistent内核，仅处理真实任务并依赖下游长度限制 | 长度0/1/63/64/65/255/256/257；混合长度/非顺序页表；Q缩放与K尺度；正负值；宽度非法 | 缺口 | 未知 | 未核验 |
| B3 / 图捕获与重复replay | 原LightOp图路径 → 图路由跳过CPU长度/容量比条件，复用当前HIP stream launch compact与persistent | 预热后capture；固定shape下seq_lens/page table变化并重复replay；空行与不同实际长度 | 缺口 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P1] 路由选择与安全回退缺少针对性断言证据 · F1

- 类型：coverage_gap；置信度：高
- 影响：错误进入特化内核，或应走新路径却静默回退
- 建议：按G1补齐；执行结果与CI纳入分别验收，不把CPU检查或文件收集当成HCU内核通过。
- 证据：ENV, ROUTE, CALL, SEARCH, DSA, DSV4

### [P1] INT8内核数值、有效长度与TopK缺少针对性断言证据 · F2

- 类型：coverage_gap；置信度：高
- 影响：页边界/空行错误、尾部未初始化被消费、缩放误差改变TopK
- 建议：按G2补齐；执行结果与CI纳入分别验收，不把CPU检查或文件收集当成HCU内核通过。
- 证据：JIT, KERNEL, TOPK, CALL, SEARCH, DSA, DSV4

### [P1] 图捕获与重复replay缺少针对性断言证据 · F3

- 类型：coverage_gap；置信度：高
- 影响：重放沿用旧任务数或读到旧页表；首次JIT/capture交互不可用
- 建议：按G3补齐；执行结果与CI纳入分别验收，不把CPU检查或文件收集当成HCU内核通过。
- 证据：CALL, KERNEL, JIT, SEARCH, DSA, DSV4

### [P1] 现有CI红灯需独立定位，不能归因新增MQA内核 · F4

- 类型：evidence_gap；置信度：高
- 影响：attempt2的required-2分片10/15测试文件通过；日志含HIPBLAS_STATUS_ALLOC_FAILED、端口占用和服务连接失败症状，但没有新增内核回归因果证据。
- 建议：核验设备资源/服务生命周期、基线复现和所有失败文件；隔离环境重跑需另行授权。不要把文件成功率当覆盖率。
- 证据：LOG

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| G1 | B1 | write | G1-route, G1-length |
| G2 | B2 | upstream_first | G2-boundary, G2-width |
| G3 | B3 | write | G3-replay |

## 限制与待核实

- 本次是只读历史PR审查，没有运行新HCU测试或重跑CI。
- 设计缺口结论限已读候选和记录的检索范围；所有分片完整日志及组织外部变量未全部取得。
- 缺少同版本coverage工件：行/分支/内核覆盖率未测量。
- 失败日志仅脱敏摘录；10/15是测试文件结果，不是test nodeid或功能覆盖率。
- legacy protection接口不可用，不能推断分支无合并门禁。
- 元数据不证明测试源码、安装 wheel 或具体测例实际执行；需要 job 日志及逐测试结果。
- head/merge SHA 查询可能遗漏 pull_request_target、workflow_dispatch 和外部调度；按 workflow、PR checks 链接及调度系统补查。
- 合并提交上的 push/release 构建属于合入后证据，不能回填为 PR head 的测试通过。
- checks 保留重跑记录，statuses 保留历史；分析时核对最新 attempt、同名 check 的 app 身份和时间。
- 权限不足、404、分页预算用未知表示，不推断门禁不存在。

## 证据索引

- ENV：`6f0f185a691c python/sglang/srt/environ.py:1395–1399` — 新增开关默认关闭；SHA256 `f54cc37c70eedf2f47062336d287563334294cbf208fe68d5bd11f9aba481f09`
- ROUTE：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:80–172` — CPU 长度估计、容量比阈值与设备/shape/layout约束；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- CALL：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:901–1008` — graph route与 persistent/LightOp 调用分支；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- TOPK：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/indexer.py:1080–1140` — 下游TopK传递实际序列长度，未初始化尾部不能用全矩阵一致性判定；SHA256 `69227d1c223a54d6385657c29d37c8f4bb4b20b5b9ec9df0eb71da1921da62e1`
- JIT：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py:16–54` — 延迟JIT与宽度校验、query reshape；SHA256 `bc300beb36b11f07b1102755996c745892df4b01acc712cd408396af55d87809`
- KERNEL：`6f0f185a691c python/sglang/srt/layers/attention/dsv4/csrc/paged_mqa_pers_jit.cu:376–480` — 空行任务、紧凑任务表、未填充尾部、当前HIP stream与两阶段launch；SHA256 `7b6c6ae78d8c22eee7b8484caa4b789d22663e8c1e1ca5d7a3e236b286947a5d`
- CI：`6f0f185a691c .github/workflows/pr-test-hcu.yml:757–817` — head侧HCU Stage B白名单；当次命令还用日志核对；SHA256 `1ef88cfc496da803b15f4e98994482da3d1dbdd7effa30572915a8855ac84775`
- DSA：`6f0f185a691c test/registered/unit/layers/attention/dsa/test_hcu_indexer.py:1–155` — 现有测试针对dsa_indexer而非dsv4/indexer；断言LightOp ABI；SHA256 `3783340edca3a2d096ece78c9e2abf4db22894ddea5a2e362f3bc52bb2e80a4a`
- DSV4：`6f0f185a691c test/registered/attention/unittests/dsv4/test_deepseek_v4.py:1–55` — 测试注明绕过C4Indexer，且注册CUDA runner；SHA256 `b8a70cb62fd5327f15cb0f78e18df7cc4acfbba70fc9dbd06eaaf572242388c5`
- LOG：`artifacts/job-excerpts.txt` — 实际attempt2失败job的版本、白名单及失败症状脱敏摘录；SHA256 `a8d881665501450df725e95a3b3cc5de3bbc152ffc2446c6678552069b856e00`
- SEARCH：`artifacts/search-evidence.txt` — PR head内按开关/符号检索并阅读候选的审查记录；不是全仓无覆盖证明；SHA256 `418ebabbc59679e056530e04d6561275426ffa183667d24ca0e3e63a3bbaf4e6`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
