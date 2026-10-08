# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #467](https://github.com/HYGON-AI/sglang-das/pull/467)

- PR 标题：[DSV4.1] 绕开topk_transform_ragged_v2融合,解决TP8报错问题
- 目标分支：`feat/20260920_deepseek-v4.1`
- Diff base：`258ba9c1601a92f86b09e644a7a2c6953569ecb0`
- PR head：`41dc6cae2d23a40ecf600a89e72e173bd6a4366c`
- 采集时间：2026-10-08T07:03:02.652Z
- 审查结论：需要补充证据
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

本次变更将 HCU dense prefill TopK 回退扩展到普通缓存池，并改为局部列筛选后加扁平 KV 偏移。已读融合 TopK 的窗口、偏移及边界断言，但它们不直接调用本次回退。快照中 PR Test (HCU) run 36681595281 attempt 1 的 Stage A/B 为 cancelled，Wait HCU wheels 和汇总 job 为 failure；wheel run 36681595245 的初始化容器步骤失败。门禁日志仅证明自动调度获准，未获得固定 head 对应的逐测例执行、checkout 与安装产物身份，不能认定产品回归或测试通过。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| python/sglang/srt/layers/attention/deepseek_v4_backend.py | 已审 | 已审全部提供的 diff，沿 dense prefill 调度、ks/compress_lens 构造、候选掩码及 page/raw 输出映射检查；底层算子和实际执行保留未知。 |

## CI 运行元数据

| Run / attempt | Workflow / 事件 | 版本关系 | Job | 状态 |
|---|---|---|---|---|
| [36686977255](https://github.com/HYGON-AI/sglang-das/actions/runs/36686977255) / 1 | Cancel PR Workflows on Close / pull_request_target | PR head 元数据匹配 | cancel | 成功 |
| [36681595343](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595343) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 成功 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 成功 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 成功 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 失败 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 取消 |
| [36681595281](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595281) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (${{ matrix.name }}) | 取消 |
| [36681595225](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595225) / 1 | Auto Label PRs / pull_request_target | PR head 元数据匹配 | label | 成功 |
| [36681595245](https://github.com/HYGON-AI/sglang-das/actions/runs/36681595245) / 1 | Release PR HCU Wheels / pull_request_target | PR head 元数据匹配 | compile (3.10) | 失败 |

Checks / 外部 status 记录：11 / 0；完整身份、历史及接口可见性见 review.json。

绿色 job 仅表示 job 状态；具体行为通过须由对应版本、平台、lane、test ID 的结果证明。

## PR 行为与测试

| ID / 行为 | 改前 → 改后 | 必测触发条件 | 断言设计 | CI 选择 | 具体行为执行 |
|---|---|---|---|---|---|
| B_HCU_DISPATCH / 普通与 LayerSplit 缓存池统一进入 HCU TopK 回退 | 只有 HCU 且 LayerSplit 缓存池进入 PyTorch 回退，其他情况调用融合 TopK。 → 所有 HCU 缓存池进入 PyTorch 回退，非 HCU 仍调用融合 TopK。 | HCU、dense FP4 索引器可用、extend 模式且提供序列长度元数据，并有可见压缩 KV。 | 未知 | 未知 | 未核验 |
| B_LOCAL_TO_FLAT / 局部有效列转换为扁平 KV 索引并正确填充 | HCU 回退按 [ks, ks+compress_lens) 过滤 logits 列，并直接使用列号。 → 按 [0, compress_lens) 过滤局部 logits 列，再将有效排名加 ks，后续映射到 page/raw 索引。 | 多请求 dense prefill，特别是后续请求 ks 非零、可见长度不同、可见长度小于 topk 或为零的行。 | 部分 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P2] 尚未建立 HCU 回退断言、有效选择与固定 head 执行证据的对应关系 · F_HCU_EVIDENCE

- 类型：evidence_gap；置信度：高
- 影响：现有已读融合 TopK 断言不能证明本次 backend 分发和局部到扁平索引转换已被验证。gate 放行也不能替代具体测例结果；当前不能确认普通池、LayerSplit 或 TP8 修复已通过验证。
- 建议：先验证是否有直接命中回退的现有测例并补齐选择、checkout/wheel 与逐测例日志；不足时再补有独立预期和负控的针对性场景。失败基础设施的根因另行取证，不归因于产品代码。
- 证据：S_BACKEND, S_TOPK_TEST_COMMON, S_TOPK_TEST_RAGGED, S_ATTENTION_CANDIDATE, A_GATE

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| T_VALIDATE_HCU_DISPATCH | B_HCU_DISPATCH | validate_existing | C_HCU_POOL_DISPATCH |
| T_VALIDATE_LOCAL_OFFSETS | B_LOCAL_TO_FLAT | validate_existing | C_MULTI_REQUEST_LOCAL_OFFSETS |

## 限制与待核实

- 只读审查，未执行代码、测试、collection 或 CI 重跑，未安装依赖。
- base 的 HCU workflow 读取返回 content_denied；未绕过限制，实际 workflow revision、矩阵、runner、suite 和 selector 链未完整核验。
- 两次较宽源码搜索截断；deepseek_v4 文件发现也截断。已完成若干局部替代测试检索，不代表全仓不存在其他覆盖。
- LightOp 底层实现未提供；不能仅凭包装函数或 CPU/mock 验证硬件数值正确性。
- 未取得失败 job 的原始日志，初始化容器及等待 wheel 的具体原因未知，不能归因于本 PR。read_ci 工具输出被截断，CI 概况另依据宿主完整输入快照。
- 未取得与固定 head 匹配的 coverage 工件；行/分支覆盖率未测量，不填写百分比。PR head 与合并提交未混用。
- 元数据不能证明具体场景、checkout 或安装产物身份。
- 未执行测试；外部调度、不可见配置与动态选择可能无法核验。

## 证据索引

- S_BACKEND：`41dc6cae2d23 python/sglang/srt/layers/attention/deepseek_v4_backend.py:3290–3488` — E1：extend 条件、每请求偏移与局部可见长度、HCU 回退及排序后的 page/raw 输出映射。；SHA256 `68d8ad0961267e0118b5a35a8b79672a40c8954fc03ee2cdabb15e6329eb77da`
- S_LOGITS：`41dc6cae2d23 python/sglang/srt/layers/attention/deepseek_v4_backend.py:350–460` — E7：dense 索引器可用性探测及 LightOp 包装调用；未给出 LightOp 内核实现。；SHA256 `68d8ad0961267e0118b5a35a8b79672a40c8954fc03ee2cdabb15e6329eb77da`
- S_TOPK_TEST_COMMON：`41dc6cae2d23 test/registered/kernels/ops/attention/test_topk_v2.py:1–200` — E17：注册 CUDA/AMD 测试；参考结果检查索引集合及有效数量，允许有限边界误差；此段没有 HCU 注册。；SHA256 `d8951ca67d1302cca6ed1d465669b662dfe1f7e4769c64fc16eb421cf05c2fbe`
- S_TOPK_TEST_RAGGED：`41dc6cae2d23 test/registered/kernels/ops/attention/test_topk_v2.py:309–469` — E22：窗口外高分、非零偏移、负无穷和省略 row_starts 的断言均直接调用融合 TopK，不经过 backend 的 HCU PyTorch 回退。；SHA256 `d8951ca67d1302cca6ed1d465669b662dfe1f7e4769c64fc16eb421cf05c2fbe`
- S_ATTENTION_CANDIDATE：`41dc6cae2d23 test/registered/attention/unittests/dsv4/test_deepseek_v4.py:1–200` — E21：候选 attention 测试注册为 CUDA，文件说明压缩 attention 场景预置稀疏页索引并绕过生产索引器；已读片段不足以证明 HCU dense TopK 覆盖。；SHA256 `668c0886453c02382159954935ab2070c9a5d91e0d07db93336f528489d91178`
- A_GATE：`artifacts/run-36681595281-attempt-1-job-109778168182.txt` — E23：run 36681595281 attempt 1 的 PR gate 因 HCU 相关路径自动放行；日志不是硬件测试结果，也没有 checkout/wheel 的测试身份闭环。；SHA256 `34144faf2a9cd8d467b9197cf715bc317cea11957d38edba136d773aba643329`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
