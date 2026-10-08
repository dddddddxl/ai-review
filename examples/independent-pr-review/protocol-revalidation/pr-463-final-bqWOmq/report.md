> 独立保存的最终收尾；取证预算未恢复、首次结果未覆盖。以下校验成功也不代表完整审查或 CI 通过。

# PR CI 审查报告

[https://github.com/HYGON-AI/sglang-das #463](https://github.com/HYGON-AI/sglang-das/pull/463)

- PR 标题：ci(hcu): migrate main workflows to organization runners
- 目标分支：`main`
- Diff base：`ab43824b09055fc790bd5a9166a6a6182b1bccc3`
- PR head：`bd01fc60d46266c47710784dd7051320edbbe002`
- 采集时间：2026-10-08T07:03:20.285Z
- 审查结论：需要补充证据
- 合并门禁：未作自动批准；分支规则与管理员策略由调用方核对。

本轮为 continued_context 的 FINAL_ONLY 协议收尾，不是首次独立审查。仅就具有已读源码证据的六个工作流进行部分测试与 CI 审查，另六个文件延期。迁移后固定使用 ci 与 bw1100 双标签；现有构建版本、wheel 身份断言只能提供局部支持，未证明真实 runner 能力、完整测试选择或本次配置的执行结果。所有行为的测试选择保持 unknown，实际执行未核验；没有据此确认产品缺陷。

## 审查范围

| 变更文件 | 状态 | 理由 |
|---|---|---|
| .github/workflows/hcu-feishu-notify-preview.yml | 待审 | 仅见迁移 diff，未取得可引用的 read_file 源码；完整触发、环境 gate、断言与结果待核验。 |
| .github/workflows/hcu-full-enabled.yml | 待审 | 源码读取被拒绝；只见 diff，不将其伪标为已读源码证据，完整选择和执行链延期。 |
| .github/workflows/hcu-manual-model-test.yml | 待审 | 源码读取被拒绝，覆盖输入停用与手动执行的完整链延期。 |
| .github/workflows/labeler.yml | 待审 | 只有 diff 与运行元数据，没有可引用的 read_file 源码或实际结果断言。 |
| .github/workflows/lint-hcu.yml | 已审 | 已读 1 至 57 行，核对触发、双标签、容器、checkout 与 pre-commit 调用；迁移断言及执行未验证。 |
| .github/workflows/nightly-test-hcu.yml | 已审 | 已审列明的触发、构建和部分矩阵源码及现有构建对齐断言；完整选择和执行保留未知。 |
| .github/workflows/nightly-test-image-hcu.yml | 已审 | 已读 1 至 83 行，核对 workflow_call、镜像、设备和模型挂载及 CItest 入口，未验证执行。 |
| .github/workflows/pr-states.yml | 待审 | 仅见 diff 与成功元数据，没有 read_file 证据或本次双标签配置的效果证明。 |
| .github/workflows/pr-test-hcu.yml | 待审 | 源码读取被拒绝；完整 paths、gate、suite 与产物安装链未核验。 |
| .github/workflows/release-docker-hcu.yml | 已审 | 已读 1 至 89 行，核对 schedule/dispatch 和构建输出到镜像测试的依赖传递。 |
| .github/workflows/release-pr-hcu.yml | 已审 | 已读 1 至 200 行及关联测试，核对触发、容器、版本检查；后续产物与完整执行未核验。 |
| .github/workflows/release-pypi-nightly-hcu.yml | 已审 | 已读 1 至 200 行，核对 release push/dispatch、容器和构建条件；完整发布与验证链未知。 |

## CI 运行元数据

| Run / attempt | Workflow / 事件 | 版本关系 | Job | 状态 |
|---|---|---|---|---|
| [36663746175](https://github.com/HYGON-AI/sglang-das/actions/runs/36663746175) / 1 | Cancel PR Workflows on Close / pull_request_target | PR head 元数据匹配 | cancel | 成功 |
| [36663736872](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736872) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code security | 取消 |
| [36663736872](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736872) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code compliance | 取消 |
| [36663736872](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736872) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code quality | 取消 |
| [36663736872](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736872) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / All required checks | 失败 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 取消 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 取消 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 取消 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 取消 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 取消 |
| [36663736701](https://github.com/HYGON-AI/sglang-das/actions/runs/36663736701) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (${{ matrix.name }}) | 取消 |
| [36663007510](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007510) / 1 | PR Test Mori (AMD) / pull_request | PR head 元数据匹配 | mori-hicache | 跳过 |
| [36663007510](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007510) / 1 | PR Test Mori (AMD) / pull_request | PR head 元数据匹配 | mori-pd | 跳过 |
| [36663007955](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007955) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code compliance | 成功 |
| [36663007955](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007955) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code quality | 成功 |
| [36663007955](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007955) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / Code security | 成功 |
| [36663007955](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007955) / 1 | Quality Gate / pull_request | PR head 元数据匹配 | Checks / All required checks | 成功 |
| [36663007400](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007400) / 1 | PR States / pull_request_target | PR head 元数据匹配 | update-pr-body | 成功 |
| [36663007398](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007398) / 1 | Auto Label PRs / pull_request_target | PR head 元数据匹配 | label | 成功 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Check changes | 失败 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Call PR gate | 跳过 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | PR Test (HCU) finish | 失败 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Validate HCU config | 跳过 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage A HCU smoke | 跳过 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Wait HCU wheels | 跳过 |
| [36663007558](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007558) / 1 | PR Test (HCU) / pull_request_target | PR head 元数据匹配 | Stage B HCU required (${{ matrix.name }}) | 跳过 |
| [36663007650](https://github.com/HYGON-AI/sglang-das/actions/runs/36663007650) / 1 | Release PR HCU Wheels / pull_request_target | PR head 元数据匹配 | 未取得 job 明细 | 完成 |
| [36714097846](https://github.com/HYGON-AI/sglang-das/actions/runs/36714097846) / 1 | Trivy Scan Dev Docker Images / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36690433754](https://github.com/HYGON-AI/sglang-das/actions/runs/36690433754) / 1 | CI Lark Notify / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36687117212](https://github.com/HYGON-AI/sglang-das/actions/runs/36687117212) / 1 | Nightly Test (GB200 72GPU) / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36685919111](https://github.com/HYGON-AI/sglang-das/actions/runs/36685919111) / 1 | Nightly Link Check / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36684218750](https://github.com/HYGON-AI/sglang-das/actions/runs/36684218750) / 1 | Release PyPI Nightly Wheels / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36676937443](https://github.com/HYGON-AI/sglang-das/actions/runs/36676937443) / 1 | Close Stale PRs / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |
| [36667307164](https://github.com/HYGON-AI/sglang-das/actions/runs/36667307164) / 1 | CI Failure Monitor / schedule | 合并提交候选（单列） | 未取得 job 明细 | 完成 |

Checks / 外部 status 记录：28 / 0；完整身份、历史及接口可见性见 review.json。

绿色 job 仅表示 job 状态；具体行为通过须由对应版本、平台、lane、test ID 的结果证明。

## PR 行为与测试

| ID / 行为 | 改前 → 改后 | 必测触发条件 | 断言设计 | CI 选择 | 具体行为执行 |
|---|---|---|---|---|---|
| B_LINT_ROUTING / lint 工作流的 runner 迁移 | 冻结 diff 显示 lint 使用原 self-hosted、hcu、nmz4 标签。 → lint 固定使用 ci 与 bw1100 双标签；push 与 pull_request_target 下继续在容器内 checkout 并调用 pre-commit。 | push 到配置分支或 pull_request_target；是否存在针对调度迁移的测试及其选择入口尚未知。 | 未知 | 未知 | 未核验 |
| B_BUILD_NIGHTLY / 构建、镜像与夜间测试的 runner 环境迁移 | 冻结 diff 显示构建和镜像使用旧 HCU/nmz4 标签，夜间作业依赖动态 runner_label 输出或覆盖输入。 → 迁移后的这些作业固定请求双标签；夜间覆盖输入停用。原设备、staging、模型路径和外部依赖要求仍存在。 | 夜间 schedule/dispatch、PR wheel 路径筛选或 dispatch、release 分支 push，以及构建成功后的镜像 workflow_call；每条通路需分别验证。 | 部分 | 未知 | 未核验 |

代码行/分支/内核覆盖率：未测量。上述状态是已审行为结论，不是全仓覆盖百分比。

## 审查意见

### [P2] 构建与夜间测试只有局部静态断言支持 · F_BUILD_EVIDENCE

- 类型：evidence_gap；置信度：高
- 影响：现有版本和 manifest 反例不验证真实 runner 的设备或跨机器产物可见性；完整选择及本次配置执行结果仍未知，取消运行也不能证明迁移成功。
- 建议：分别补齐每条通路的选择链、workflow/产物身份与真实环境验证结果，优先复用已有断言；未取得证据前保留未知，不归因为产品回归。
- 证据：S_NIGHTLY_BUILD, S_MATRIX, S_IMAGE, S_DOCKER, T_WHEEL, A_CANCEL

### [P2] lint 迁移的断言、选择及执行仍未核验 · F_LINT_EVIDENCE

- 类型：evidence_gap；置信度：中
- 影响：实现配置可读，但没有取得针对新 runner 的具体测试断言与匹配运行结果，不能将工作流存在视为迁移验证通过。
- 建议：后续合法取证先确认现有迁移断言及选择入口，再核对实际 workflow 版本、job 标签、容器与 lint 结果；不要直接推断需要新增测试。
- 证据：S_LINT

## 补测交接

| 任务 | 行为 | 路由 | 场景 ID |
|---|---|---|---|
| TASK_LINT_VALIDATION | B_LINT_ROUTING | validate_existing | CASE_LINT_RUNNER |
| TASK_BUILD_VALIDATION | B_BUILD_NIGHTLY | validate_existing | CASE_STAGING_IDENTITY, CASE_RUNTIME_CAPABILITY |

## 限制与待核实

- 本轮没有新增取证；只使用新请求携带的既有证据。首次回复及结果保持不变，本轮不得计入首次盲测。
- 未接触预标注、其他审查答案或 evaluation；未读取 checkout，未运行目标代码、测试、collection 或 CI。
- hcu-full-enabled.yml、hcu-manual-model-test.yml、pr-test-hcu.yml 读取曾被宿主拒绝；hcu-feishu-notify-preview.yml、labeler.yml、pr-states.yml 仅见 diff，没有满足宿主合同的 read_file 证据，均标记 deferred。
- reviewed 仅表示已审阅列明的源码与关联断言范围，不表示完整执行链或测试覆盖已经核验。
- nightly 的源码阅读仅覆盖 1 至 120、294 至 493、640 至 839 行；构建发布 workflow 有些仅读到 200 行，完整 selector、矩阵后续命令和运行选择仍未知。
- 完整读取了构建对齐测试；现有 runner、workflow 及 CI 引用检索存在范围或截断限制，未命中不能证明全仓没有替代覆盖。
- 快照中的 PR HCU 一次变更检测失败后下游跳过，另一次被关闭 PR 流程取消；失败根因没有足够日志，未归因为本次迁移。
- pull_request_target 元数据关联 PR head 不证明实际 workflow 源版本为 head。快照相关 job 记录单标签 bw1100，不能用来证明 head 的双标签配置已经执行。
- 唯一可读运行工件是关闭 PR 的取消日志，没有 HCU 逐测例结果、设备能力或安装产物身份。没有将不同运行或 attempt 的成功子集拼接。
- 组织 runner 库存、权限范围、变量、环境审批和外部调度不可见；不能据此推断新 runner 存在配置故障。
- 没有同版本 coverage 工件，代码行覆盖率与分支覆盖率未测量；补充验证建议不等于批准合并，也不授权执行测试或外部写入。
- 元数据不能证明具体场景、checkout 或安装产物身份。
- 未执行测试；外部调度、不可见配置与动态选择可能无法核验。

## 证据索引

- S_LINT：`bd01fc60d462 .github/workflows/lint-hcu.yml:1–57` — 存在 push/pull_request_target 触发、双标签容器和 pre-commit 调用；这是实现配置，不能证明 runner 迁移测试已经被 CI 选择。；SHA256 `339efcf53fd9feb5e1ba9da86600361218c49f2aa1b670df1b20c556bb659bfe`
- S_NIGHTLY：`bd01fc60d462 .github/workflows/nightly-test-hcu.yml:1–120` — 夜间 schedule/dispatch、job_filter 与双标签配置可见；旧 runner_label 标记忽略，不能证明当次测试选择或执行。；SHA256 `e14886d95dccffcc8829ffc5c6c509db91c00199a4635573d782fa836199c38d`
- S_NIGHTLY_BUILD：`bd01fc60d462 .github/workflows/nightly-test-hcu.yml:294–493` — 条件构建在双标签 runner 使用设备、驱动及 staging 挂载，并检查 Torch 版本。；SHA256 `e14886d95dccffcc8829ffc5c6c509db91c00199a4635573d782fa836199c38d`
- S_MATRIX：`bd01fc60d462 .github/workflows/nightly-test-hcu.yml:640–839` — 可见部分 needs、suite、分片和设备数矩阵；缺少完整后续 selector，不能证明具体迁移断言进入 CI。；SHA256 `e14886d95dccffcc8829ffc5c6c509db91c00199a4635573d782fa836199c38d`
- S_IMAGE：`bd01fc60d462 .github/workflows/nightly-test-image-hcu.yml:1–83` — dispatch/call 接收镜像，配置双标签、设备和模型挂载，并调用 CItest；没有实际结果证明。；SHA256 `54c0bc7526917abdd4b06753b83a32047e571c84fa510707bf20c9170fdeff91`
- S_DOCKER：`bd01fc60d462 .github/workflows/release-docker-hcu.yml:1–89` — schedule/dispatch 构建镜像，通过 needs 和输出将本次镜像传入镜像测试 workflow。；SHA256 `b6ec9485e3e33a61657e9ce83947409075fea3fcc3c3a9d893b1d4257fd76001`
- S_RELEASE_PR：`bd01fc60d462 .github/workflows/release-pr-hcu.yml:1–200` — PR 路径过滤或 dispatch 触发双标签构建，单 Python 版本矩阵及设备/staging 要求可见。；SHA256 `80b36fa7d702b8021e1071c4bec517d27d73e5856ee2d68980d9f25d417682cc`
- S_RELEASE_NIGHTLY：`bd01fc60d462 .github/workflows/release-pypi-nightly-hcu.yml:1–200` — release 分支 push 或 dispatch 触发双标签构建，容器、设备及部分产物条件可见。；SHA256 `1f330b9573d6e4c5d5bf9aaaf7969bcff1cf40bdc81b1a4f54da40ef2dfc3fc9`
- T_ALIGNMENT：`bd01fc60d462 scripts/ci/hcu/test_hcu_build_alignment.py:1–200` — 断言分支环境、构建版本、Rust 路径与内嵌脚本语法；未断言 runner 标签交集或实际硬件能力。；SHA256 `7c4e9f1576456aa2f8356aa43589a75d41fc233bf74d84e58e20c372b4fc73e6`
- T_WHEEL：`bd01fc60d462 scripts/ci/hcu/test_hcu_build_alignment.py:201–361` — 正反例校验 wheel 与 manifest 身份及安装 guard；临时目录和 mock 不证明真实跨 runner 挂载。；SHA256 `7c4e9f1576456aa2f8356aa43589a75d41fc233bf74d84e58e20c372b4fc73e6`
- A_CANCEL：`artifacts/run-36663746175-attempt-1-job-109723883930.txt` — 取消工作流 run 36663746175 attempt 1 明确请求取消 PR HCU run 36663736701、PR wheel run 36663007650 和质量门禁 run 36663736872；不是测试通过证据。；SHA256 `1ead16d31852698efd1aea01d84b9ea1d919116148e8ec7ec25560a8469bdacc`

校验验证版本、引用和记录一致性；行为判断与日志身份仍须人工/agent 复核。
