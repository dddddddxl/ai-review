# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #478](https://github.com/HYGON-AI/sglang-das/pull/478)

- PR 标题：fix: remove alt_stream overlap copy when writing KV cache
- 目标分支：`release/20260825_v0.5.18`
- Diff base：`cfa865d339c0d7191dd044e6980006be799a570a`
- PR head：`4343158c539992308a0ec9fcf9da7e4f38426f0f`
- 采集时间：2026-10-08T07:02:45.119Z
- 审查结论：需要补充证据
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

已审两处 KV 写入由图捕获时旁路流并行改为当前流顺序执行的行为。通用回退路径的针对性断言设计未知；HCU 布局有图回放和 FA3 冒烟候选，但仅能提供部分设计支持。快照中 HCU run 37727763205、attempt 1 的 Stage A 成功，Stage B 分片 0/2 成功、1/3 失败；这些状态不能证明具体行为执行，也不能证明失败由本 PR 引入。两项行为的有效选择和匹配身份的执行均未核实，建议验证已有测试与运行证据，不形成产品回归结论。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| python/sglang/srt/mem_cache/memory_pool.py | 已审 | 已读两处 diff、通用写入分派、HCU 布局条件和 _store_kv_layer 调用入口；覆盖审查范围仅限本次流切换移除。 |

## CI 运行元数据

| Run / attempt | Workflow / 事件 | 版本关系 | Job | 状态 |
|---|---|---|---|---|
| [37727766505](https://github.com/HYGON-AI/sglang-das/actions/runs/37727766505) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code compliance | 成功 |
| [37727766505](https://github.com/HYGON-AI/sglang-das/actions/runs/37727766505) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code quality | 成功 |
| [37727766505](https://github.com/HYGON-AI/sglang-das/actions/runs/37727766505) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code security | 成功 |
| [37727766505](https://github.com/HYGON-AI/sglang-das/actions/runs/37727766505) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / All required checks | 成功 |
| [37727763189](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763189) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [37727763302](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763302) / 1 | Auto Label PRs / pull_request_target | PR head 元数据匹配 | label | 成功 |
| [37727763218](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763218) / 1 | Release PR HCU Wheels / pull_request_target | PR head 元数据匹配 | compile (3.10) | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-0) | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-1) | 失败 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-2) | 成功 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (stage-b-required-3) | 失败 |
| [37727763205](https://github.com/HYGON-AI/sglang-das/actions/runs/37727763205) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |

Checks / 外部 status 记录：17 / 0；完整身份、历史及接口可见性见 review.json。

绿色 job 仅表示 job 状态；具体行为通过须由对应版本、平台、lane、test ID 的结果证明。

## PR 行为与测试

| ID / 行为 | 改前 → 改后 | 必测触发条件 | 断言设计 | CI 选择 | 具体行为执行 |
|---|---|---|---|---|---|
| B-KV-FALLBACK-CURRENT-STREAM / 通用 KV 回退写入的图捕获与当前流依赖 | 在未使用前置专用内核且处于图捕获、alt_stream 非空时，K 在当前流、V 在旁路流写入，并以双向 wait_stream 建立依赖；否则顺序写入。 → 通用回退不再检查捕获状态或切换流，K/V 均在当前流依次写入；前置专用内核分派保持不变。 | 经 _store_kv_layer 进入通用实现，未从 CUDA/HIP store_cache 或 CPU AMX 路径提前返回；差异场景是图捕获且提供非空 alt_stream。 | 未知 | 未知 | 未核验 |
| B-KV-HCU-PAGED-CURRENT-STREAM / HCU 分页布局图模式 K/V 顺序写入 | HCU 布局且非 HND 的页索引写入，在图捕获且旁路流存在时将 V 写入旁路流并等待；其他情况同流写入。 → 页索引与 K/V 存储布局保持不变，K/V 写入统一在当前流顺序提交。 | 未从量化或 scaled FP8 路径提前返回，SGLANG_KV_LAYOUT_HCU_FA 为真且 use_hnd 为假；重点是图捕获、旁路流非空及跨页 loc。 | 部分 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P2] 两条改动路径尚缺可核验的图模式回归证据 · F-KV-GRAPH-EVIDENCE

- 类型：evidence_gap；置信度：高
- 影响：已读数值往返测试关闭旁路流或针对其他内核；HCU 图候选仅覆盖输出一致性和冒烟。未建立修改分支、具体断言、PR 选择与匹配身份执行的完整证据链，不能据 CI 成败判断该修复效果。此项是审查证据不足，不是已确认产品缺陷或全仓缺测。
- 建议：先验证候选测试的实际分支、PR/nightly 选择和本次运行身份，补齐相关分片的逐测例日志；仅在确认没有替代覆盖后补充当前流消费者与 K/V 数值回归场景。失败分片单独定位，不预先归因于 PR。
- 证据：E1, E2, E16, E17, E22, E23

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| T-KV-FALLBACK-VERIFY | B-KV-FALLBACK-CURRENT-STREAM | validate_existing | C-KV-FALLBACK-REPLAY |
| T-KV-HCU-PAGED-VERIFY | B-KV-HCU-PAGED-CURRENT-STREAM | validate_existing | C-KV-HCU-PAGED-REPLAY |

## 限制与待核实

- 未执行目标代码、测试、collection 或 CI；未测量代码行覆盖率。
- 共享 24 次工具预算已用完；部分文件搜索和代码搜索截断，未穷尽替代测试或整个调用图。
- 宿主拒绝读取 PR HCU workflow 和 HCU 测试 helper；没有尝试绕过。实际 workflow 版本、矩阵选择、环境覆盖及动态选择仍未知。
- 读取了 base 版本 runner 的前 200 行及 head 测试注册，但不能由此证明 pull_request_target 当次使用的脚本版本与参数。
- read_ci 工具返回截断快照；原始请求内完整元数据只用于描述 run/job 状态。没有把元数据伪装成日志工件或逐测例执行证据。
- 快照列出的唯一已采集日志属于其他质量门禁任务，未用作 KV 行为执行证明；未获得相关 HCU 逐测例结果、checkout 和安装产物身份。
- 合并候选与 PR head 分开处理，未将合并候选结果回填为 head 的通过证据。
- 元数据不能证明具体场景、checkout 或安装产物身份。
- 未执行测试；外部调度、不可见配置与动态选择可能无法核验。

## 证据索引

- E1：`4343158c5399 python/sglang/srt/mem_cache/memory_pool.py:130–220` — 通用实现先尝试 CUDA/HIP store_cache 或等宽 CPU AMX 内核；未提前返回时依次赋值 K/V，不再使用 alt_stream。；SHA256 `f9ce1fae60660d406553c3c87e5ea1a9020664d652c33098077eb7d908722649`
- E2：`4343158c5399 python/sglang/srt/mem_cache/memory_pool.py:2590–2740` — 量化与 scaled FP8 可提前返回；HCU 布局且非 HND 时按 page/offset 顺序写 K/V 并返回。；SHA256 `f9ce1fae60660d406553c3c87e5ea1a9020664d652c33098077eb7d908722649`
- E4：`4343158c5399 python/sglang/srt/mem_cache/memory_pool.py:2741–2820` — 非 vectorized_5d 的 _store_kv_layer 把缓存、索引、行宽及 alt_stream 传给通用实现。；SHA256 `f9ce1fae60660d406553c3c87e5ea1a9020664d652c33098077eb7d908722649`
- E11：`4343158c5399 test/registered/unit/mem_cache/test_store_cache_4d.py:1–200` — 已读 4D kernel 测试以独立目标缓冲区比较 K/V 字节一致性；它直接调用 store_cache_4d，而非本次修改的通用回退函数。；SHA256 `304742e35f9be93990b699b120cfe6db5da18673b4bcd8d457f5ee32db6e2ca5`
- E12：`4343158c5399 test/registered/kernels/ops/kvcache/test_store_cache.py:1–200` — 已读 kernel 测试直接调用 store_cache，并断言目标 K/V 槽与输入相等；不能以此证明通用回退或 HCU 图布局写入被执行。；SHA256 `a4a0431e7512264872d8917c485973a77cda55c85919a3c3faebdf9cab5bcdec`
- E16：`4343158c5399 test/registered/hcu/backends/bw1100/test_torch_compile_cuda_graph_hcu.py:1–99` — 图模式候选注册为 nightly-hcu-1，开启 compile、graph 最大批量 4、FA3 和 page-size 64；断言重复输出一致、批量非空及进程存活，没有直接 KV 数值或修改分支命中断言。；SHA256 `3a31c047da235b328b86ad4ac601adda57c4bec38c8b5fbf1776e9afd490fc86`
- E17：`4343158c5399 test/registered/hcu/attention/test_fa3_text_smoke_hcu.py:1–69` — FA3 冒烟候选注册到 stage-b-test-1-hcu-small，通过可覆盖的 helper 参数启动服务；明确断言为生成结果非空。；SHA256 `3fe3f408f92b4345964071e716c3c3792d888ad5b58738eef79426bfbf2a9f0e`
- E19：`4343158c5399 python/sglang/srt/mem_cache/memory_pool.py:1–129` — HCU 布局条件从 SGLANG_KV_LAYOUT_HCU_FA 读取，默认值为 true；实际进程环境仍可能覆盖。；SHA256 `f9ce1fae60660d406553c3c87e5ea1a9020664d652c33098077eb7d908722649`
- E21：`cfa865d339c0 test/run_suite.py:1–200` — base runner 声明 HCU per-commit suite 名单，并从 CI 注册模块取得收集入口；此片段不证明当次 workflow 参数或具体文件选中。；SHA256 `c7b9ca795455da167ac77b568b1311c1127986e8fe6d2b98b4c3904eadc8d87b`
- E22：`4343158c5399 test/registered/unit/mem_cache/test_asymmetric_mha_pool.py:1–200` — 非对称池往返测试验证 K/V 目标槽及未写槽；构造池时显式关闭 alt_stream，并要求 fused store_cache 可用，未建立本次图捕获回退路径的覆盖。；SHA256 `436af1087d94d0b7b67a26d256e3aff4d9d6b1f2feeb247e048c4f968b029fe5`
- E23：`4343158c5399 test/registered/unit/mem_cache/test_store_cache_4d.py:292–412` — 4D 集成候选使用 UnifiedMHATokenToKVPool、显式关闭 alt_stream，无图捕获/回放步骤；不能作为本次流行为变更的充分反证。；SHA256 `304742e35f9be93990b699b120cfe6db5da18673b4bcd8d457f5ee32db6e2ca5`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
