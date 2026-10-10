# efficient 策略：效率与可靠性优化

生产默认仍为 `legacy`。`efficient` 是显式启用的实验策略，不代表可以上线。

## 使用

```sh
npm run dry-run:pr -- --repo /clean/pr-head --skill /pinned/skillhub --fixture /frozen/fixture.json --output /private/audit --mode both --strategy efficient --deadline-ms 180000
# 模型配置保存在本机私有文件，不能提交到仓库。
node scripts/benchmark-pr-api.mjs --config /private/model.env --plan /frozen/five-pr-plan.json --output /private/audit --strategy efficient --deadline-ms 180000
```

服务配置：`AI_REVIEW_STRATEGY=efficient`，可选 `AI_REVIEW_DEADLINE_MS=180000`。时间参数必须与策略匹配：`--model-window-ms` 只用于 legacy，`--deadline-ms` 只用于 efficient，两者不能同时出现。三种 mode 不变；未请求的范围不启动额外审查。

## 实现和证据边界

- 全 PR 一个时钟：默认 120 秒共同审查、最多至第 150 秒增量收尾、第 180 秒前校验。提前完成立即前进；Python 校验器共享剩余时间，不各自追加窗口。
- 工具全局 24 次，主阶段最多 20 次；两个并行批次共享原子额度，缓存命中仍计逻辑调用。模型每个逻辑阶段最多 8 次，候选复核也计入。停止后保留已经核验的结果及失败历史，不继续递归拆分。
- CI 首页限制 16,000 字符，保留原始快照哈希、SHA、run/job/attempt、数量及分页入口。原始快照仍供可信 Python 校验；未读页与具体测例运行是未知。
- Git 读取只看固定对象。仓库内缓存大小/内容和在途请求；缓存也检查版本、路径、普通文件、隐私和大小。最多 64 个对象缓存条目。文件返回真实行数和续读位置，越界请求拒绝并返回合法范围。
- 定向搜索的 `path` 为精确文件；范围搜索先筛选普通、安全且未超限的 Git 对象，再用固定提交的 `git grep` 批量搜索。每页最多 100 个候选文件，返回分页及截断信息；空页不等于全仓不存在。预读每个必要源码片段最多 80 行，后续按需续读。
- 确定性分组依据 diff 内静态导入、接口/调用字面引用、测试与 CI 路径。这不是完整调用图。每组最多 10 文件，每批最多 20,000 字符，超大关联组件拆分仍保留关联摘要；测试和内核文件不默认排除。
- 代码与测试在同一循环分析；Python/Docker/CI/内核专项方法由受控程序选择，不另开整轮模型调用。测试片段不是最终报告：核对来源、SHA、ID、oracle 和运行身份，再通过原有固定版本覆盖分析与交接校验器。
- 共审只投递固定 skill 的 PR 模式指令，不投递全仓分支分析内容或历史答案；原校验标准不变。工作槽释放后立即调度下一批，不等待同一对批次全部结束。两个 Python 校验器从第一次进入校验起共享最多 30 秒（默认 deadline），且不超过全局剩余时间。
- 不编造缺失断言、oracle、日志或运行身份。代码缺陷须复核，片段定位由程序执行；歧义定位只进入摘要。规则仅从可信 base 读取。

## 工件

`manifest.json` 记录文件、片段、关联组、尝试、必需证据、已读范围、两类完成状态；`evidenceBudget` 记录时间/次数/停止原因；`metrics` 区分首个有效结果、逻辑取证、物理 Git 执行、缓存命中及物理耗时。测试输出仍为 `report.md`、`review.json`、`test-backlog.json`；缺依赖或格式失败记未完成。

策略、规则、skill、分组、专项方法及 CI 视图进入指纹。当前 efficient 只写审计缓存，不恢复之前的分析；因此旧策略结果、刷新后的 CI 结果不会被误复用。跨 CI 刷新的静态分析复用尚需单独实现和验收，暂不以复用为性能收益。

## 验收原则

离线测试默认断网，固定 Python 校验器实际执行；真实复测只跑指定五 PR 的冻结输入，串行、冷缓存、both。不运行目标仓库代码、测试或 CI，不发布评论，不占卡。

平均耗时包括未完成样本；完整样本的平均另外统计，零完整样本为 null。真实 API 输出需先冻结，再与既有标注比对。仅时间下降、空报告或降低证据要求均不算验收通过。静态审查完成不是具体方法执行通过，也不代表实测代码覆盖率；无工件仍为“未测量”。

## 本轮状态与离线诊断

2026-10-09：自动化回归 120/120 通过，零跳过；真实五 PR 复测平均 151.207 秒，完整完成 0/5，因此性能验收未通过。随后修正版本只经过离线测试和原始工具请求回放，不能把首次真实结果改成“修正后已通过”。详见 [验收报告](review-efficiency-v2-assessment.md) 和 [机器可读结果](benchmarks/review-efficiency-v2.json)。开发分支仅本地提交，未推送、未合并、未上线。

2026-10-10 更新：用户明确授权先推送再复测，开发分支已推送。修正版同五 PR 平均 151.228 秒，完整完成仍为 0/5，验收仍未通过；没有合并或上线。见 [修正版真实复测报告](review-efficiency-v2-rerun-20261010.md) 与 [机器摘要](benchmarks/review-efficiency-v2-rerun-20261010.json)。上段保留为首次验收的历史状态。

以下诊断不会请求模型接口，也不会执行目标仓库代码或测例：

```sh
# 仅回放已经冻结的 model-answer 文件中的只读取证请求。
node scripts/replay-evidence-tools.mjs --plan /private/five-pr-plan.json --answers /private/frozen-live-run --output /private/audit
node scripts/compare-pr-benchmarks.mjs --before /private/legacy/benchmark.json --after /private/efficient/benchmark.json --output /private/audit
```

复测须单独获准；不要因离线修复通过就自动增加付费样本。deadline 控制宿主调度、模型、Git 和校验进程；它不是硬实时保证，Node 调度及最终审计落盘可能有少量额外开销。生产仍默认 legacy。
