# 六个独立 SGLang PR：只读盲审与协议复核

2026-10-08；仓库 `HYGON-AI/sglang-das`。这是独立代理预标注、fresh-context 代理审查、另一代理裁定与主代理复核的样本实验，不是人工认证、生产基准或全仓召回率。未调用模型 API、运行 SGLang 代码、生成/执行补测、使用 HCU、触发 CI 或发布 PR 评论。

## 结论

通用入口和离线交接可复用，但**六个首次运行均为 partial，不能宣称已经达到完整自动审查的质量门槛**。审查确实找到了有静态反例支持的问题，也暴露出宿主协议、预算以及模型证据引用的不足。首次输出未改写，后续重跑、机械修正和 continued-context 收尾另存。

- #473 找到 1 个产品逻辑问题、2 个测试有效性问题；不是 3 个产品 bug。
- #467、#478 的 EOF 元数据修正以及 #477 的独立收尾通过分析/交接校验，但仍不代表 CI 已覆盖或测试通过。
- 没有 coverage 工件，源码行/分支覆盖率为**未测量**。文件审查完成度、测试设计覆盖、CI 选择与执行证据分别表达。
- G4 完成记录可验证且保留四个方法、三个负控，仍是 `implemented_unverified`，不自动关闭缺口。

## 样本与首次运行

从更新时间倒序的最近 60 个非草稿 PR 中按类别选取，排除 #436，无合成 PR 补位。选样依据与候选列表见 `selection.json`、`recent60.json`；输入完整固定版本见 `inputs/`。

| PR | 类别 / 固定 head 前缀 | 首次代码 / 测试阶段 | 首次主要限制 | 首次报告 |
| --- | --- | --- | --- | --- |
| #478 | 普通逻辑 / `4343158c` | partial / incomplete | JSON 换行后的 `@triton.jit` 被误识别为邮箱，下一桥接请求被拒绝 | [报告](first-runs/pr-478/pr-dry-run-eih1C8/report.md) |
| #477 | 跨文件 / `3b7049f2` | partial / incomplete | source 引用使用 `head` 别名、分段读取合并和选择证据引用不足 | [报告](first-runs/pr-477/pr-dry-run-DjmmlW/report.md) |
| #467 | 开关/回退 / `41dc6cae` | partial / incomplete | 宿主把文件终止换行当成额外一行，导致 Python 校验器拒绝 | [报告](first-runs/pr-467/pr-dry-run-JB4H4y/report.md) |
| #473 | 测试变更 / `7f427720` | partial / incomplete | 字符预算耗尽前没有测试最终输出；代码片段缩进造成定位失败 | [报告](first-runs/pr-473/pr-dry-run-Ub3Dmk/report.md) |
| #463 | CI 选择 / `bd01fc60` | partial / incomplete | 24 次取证耗尽，提交了未被成功读取范围支持的 source 引用 | [报告](first-runs/pr-463/pr-dry-run-5GUDcT/report.md) |
| #475 | 大 diff / `821fca93` | partial / incomplete | 31 文件共享预算，工具拒绝与未读范围引用，最终校验失败 | [报告](first-runs/pr-475/pr-dry-run-99STpQ/report.md) |

#475 在选样与采集之间更新了 head；初选 `cbb0073c` 仍保留于 selection，**审查和预标注只针对重新冻结的 `821fca93`**。见 `pr-475-captured.freeze.json`，不能用初选 head 复现本次结果。

普通入口的 `provenance.blind=false` 刻意未改。fresh-context 隔离属于本实验编排声明，见 `blind-attestation.json`；它不是宿主自动认证。宿主在实验中修复了协议缺陷，各次源代码不完全相同，因此不是单一固定宿主二进制的严格 A/B 试验。目标 Git 版本、证据快照和 skill 固定版本没有自动漂移。

## 质量指标与用户复核

见 `evaluation.json` 的逐项理由、`adjudication-independent.json` 的独立复核及 `metrics.json` 的机械统计。unknown 不进入准确率分母；预标注也允许被复核否定，不能作为绝对真值。代码通道中的测试有效性问题单独标识，不能补算成测试通道召回。首次未产出最终结果是完成率失败，不用修复结果替换。

| 首次指标 | 代码通道 | 测试通道 |
| --- | --- | --- |
| 严格阶段完成率 | 0/6 | 0/6 |
| 已确认预标注问题召回 | 1/1（只有一个生产缺陷样本） | 2/6（33.3%） |
| 已提交且在限定范围内获证据支持的论点 | 3/3 | 8/8 |
| 可核验行号比例 | 0/3 | 0/8 |
| 已定位项目的定位正确率 | null（没有分母） | null（没有分母） |
| 预标注未知项（不入召回分母） | 0 | 7 |

“获支持论点”不是“产品缺陷准确率 100%”：代码三条中两条是测试设计问题；测试八条中六条原始类型是证据缺口。没有标注真阴性，没有依据计算通常分类意义的 accuracy。可确认测试缺口中，#467 fallback 与 #475 AST/替身覆盖限制被识别；#478 fallback、#477 HCU 分支、#473 测试粒度及 #475 CI 白名单问题未在首次测试通道识别。

六份首次输出合计 73 个模型答复回合、42 轮取证请求、123 个请求、122 条保留证据记录；请求数不等于成功取证数。一条超字符预算的结果未保存为可用证据。4/6 提交过测试 final，但校验/完整性没有通过，不能计为完成。

## 一个有意义的发现：#473

`detokenizer_manager.py` 的停滞阈值分支可能把新收到但尚未完整的 UTF-8 尾部提前提交。静态反例：连续 8 次 `0x80` 后，再逐步输入 `E4 / B8 / AD`；阈值分支先提交 `E4` 对应的替换字符并推进偏移，后续完整的“中”无法恢复。判断依据是 PR 自带 byte-fallback tokenizer 契约和源码逐步推导，**本轮未执行反例**。

两处测试有效性问题分别是：完整 CJK 字节一次传入，未触发跨步不完整字符；每步以 ASCII 结尾，未触发其声称验证的干净边界回溯。首次报告没有可用行号；定位器修正仅去除统一前导缩进后，定位到生产文件 473 行、测试文件 115 / 127 行。详见 [独立定位修正](protocol-revalidation/pr-473-anchors/anchors.json)，不覆盖首次定位指标。

## 修复、重验与仍未解决的问题

已修复并回归：

1. JSON 转义换行导致的装饰器邮箱误报，保留真实邮箱/密钥阻断。
2. 相同固定 SHA/文件连续 `read_file` 片段可合并证明已读；跨版本、间隙和不一致哈希仍拒绝。
3. JS 行范围与 Python `splitlines()` 对齐，消除 EOF 多算一行。
4. 定位允许统一前导缩进差异；不改变词法内容，不猜重复匹配位置。
5. 工具/字符耗尽后，在原有轮次和时限内保留一次 FINAL_ONLY；不增加取证额度，保留 partial。并发额度原子预留、缓存预算保守恢复、代码与测试阶段状态隔离。

修复后产物均在 `protocol-revalidation/`，#478 全新上下文重跑另在 `reruns/`。`validated` 只表示分析结构、证据约束与交接通过；所有样本仍没有获得完整的新 CI 行为执行证据。

| 后续独立保存的处理 | 分析/交接校验 | 是否算完整审查 |
| --- | --- | --- |
| #467 原 final 仅修正宿主 EOF 元数据 | validated | 否，执行证据仍不完整 |
| #478 全新上下文重跑后，仅修正 EOF 元数据 | validated | 否，不替换首次失败 |
| #477 continued-context FINAL_ONLY | validated | 否，预算耗尽且设计/选择/执行未知 |
| #463 continued-context FINAL_ONLY | validated | 否，6 文件延期、执行未核验 |
| #473 continued-context FINAL_ONLY | incomplete / source_not_read | 否，仍有未被成功读取支持的引用 |
| #475 continued-context FINAL_ONLY | incomplete / skill_validation_failed | 否，三个行为 selection_evidence 为空，不符合固定协议 |

#475 的最后失败已用实际 Python 校验器定位为“证据引用缺失或未知”。没有编造选择证据来让报告变绿，也没有降低固定校验标准。这与新的 FINAL_ONLY 预算机制是否工作是两回事：机制已收尾并保留限制，模型仍可能给出不合规引用。

下一轮优先级：

| 优先级 | 问题 | 验收方向 |
| --- | --- | --- |
| P1 | 模型把 diff/搜索命中或被拒绝内容当成已读取 source，或引用不完整选择证据 | 收紧证据引用生成协议；返回可直接引用的类型化证据描述，拒绝时指出具体字段，不放宽可信校验 |
| P1 | 24 次共享额度容易被生产代码消耗，测试阶段只剩未知结论 | 基于冻结范围规划两个阶段的取证优先级、去重读取；先保留现有总预算，比较有效信息/请求比 |
| P1 | 安全过滤可能整文件拒绝含内部端点或合法文本的 workflow | 设计可审计的片段级脱敏和权限边界，禁止为了通过审查直接关闭敏感检测 |
| P2 | 大 diff 主要依赖浅层分组/搜索，漏掉 ABI、路由和断言关联 | 下一轮再做关系分析深化；本轮不宣称已构建调用图或业务知识库 |
| P2 | 静态存在测试不能证明实际被选入并执行 | 对齐完整 head/merge/run/job/attempt 身份，补齐真实逐测例工件；未知项保持未知 |
| P2 | 独立代理预标注仍有误差，6 样本规模小 | 由仓库维护者复核 `evaluation.json`，再扩大样本，不把该样本精度推广为生产保证 |

#463 的 runner 标签差异已从“确认选择缺口”降级为执行身份/证据不足：`pull_request_target` 等基线语义可能造成差异，不能仅凭标签推断未测试。G4 的两处原生 suite 注册问题仍属独立业务仓库阻塞，本轮未修改。

## 复现与工件可信度

完整使用说明见 [通用入口文档](../../docs/pr-validation.md)。只读重新采集会得到**新的**快照，不能冒充本次冻结输入。干跑应使用独立干净 checkout、完整 base/head/merge-base 对象及固定 skillhub `74376c2b1d263d1e26fa052b21e7847706d6651e`。

```text
npm run capture:pr -- --repository HYGON-AI/sglang-das --pr 478 --output <new-capture-dir>
npm run dry-run:pr -- --repo <fixed-clean-checkout> --skill <fixed-skillhub> --fixture <frozen-fixture.json> --output <new-run-dir> --mode both --model-window-ms 1800000
node scripts/score-blind-review.mjs examples/independent-pr-review/evaluation.json <new-metrics.json>
```

文件桥接仍需代理逐轮响应，不能把上述命令理解为无需模型交互的自动回放；30 分钟是显式交互窗口，不是生产 API 响应时间。原 #436 命令保留；三种模式与错误路径由受控替身回归，不把合成回归样本算进这六个真实 PR。

公开包是脱敏导出，不含桥接 request、私有 skill 正文或令牌。绝对路径替换、#463 workflow 中的内部 IPv4 替换均记录于 `export-provenance.json`，它同时保留原始/导出 SHA-256；原始预标注中的 input_sha256 指原件，导出件身份需使用映射核对。实际被引用的日志字节未修改，均随包保存。保留的原始模型回复是审查结果，不是经过格式校验的可信结论。

本轮 ai-review 离线自动化：93/93 通过、0 跳过；skillhub 审计集 136/136、PR 审查校验 23/23 通过。完整测试名和源码指纹见 [offline-validation.json](../../docs/offline-validation.json)。这些自动化结果验证编排、协议和约束，不证明真实模型判断、SGLang CI 或 HCU 效果。
