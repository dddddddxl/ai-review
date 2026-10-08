# 仓库维护者复核表

下列结论来自独立代理预标注和静态复核，不是人工认证。请在固定 head 下逐项核对；本轮未执行 SGLang 代码。认可静态论点不代表 CI 已执行该场景。

| PR / 固定 head 前缀 | 待人工裁定的具体问题 | 首次相应通道 | 人工结论 |
| --- | --- | --- | --- |
| #473 / 7f427720 | 8 次停滞后新 UTF-8 leading byte 被阈值分支提前提交；随后完整字符被偏移切片吞掉 | 代码 detected | 待复核 |
| #478 / 4343158c | 已读 MHA 测试强制 fused/关闭 alt_stream，绕过本次修改的串行 fallback | 测试 missed | 待复核 |
| #477 / 3b7049f2 | 现有通用 factory/worker 替身替换真实 HCU 构造/返回契约，未验证修改路径 | 测试 missed | 待复核 |
| #467 / 41dc6cae | 已有 fused TopK 测试不调用新增 HCU torch fallback，尤其局部到扁平索引映射 | 测试 detected | 待复核 |
| #473 / 7f427720 | 三个命名测试的输入粒度未触发其声称的不完整 UTF-8、stall-reset、回溯成功分支 | 测试 missed；代码已识别 | 待复核 |
| #475 / 821fca93 | H16、图重放与 EAGLE 同步的 AST/替身断言不能证明真实内核及共享 buffer/collective 效果 | 测试 detected | 待复核 |
| #475 / 821fca93 | 10 个新文件虽注册 Stage B，但该固定 required 命令的 include-file 白名单不含它们 | 测试 missed | 待复核 |

#463 的 runner 标签差异不是已确认漏测：先确认实际 workflow 版本与 pull_request_target 基线，再判断新配置是否真的被验证。其余 6 条运行未知项也不能凭绿灯或失败状态直接裁定；详见 evaluation.json 的 unknown_expectations。

复核时请记录：是否同意、补充证据的固定 SHA/路径/行号或 run/job/attempt、是否存在替代测试、结论适用范围。不要改写首次模型回复；复核结论另存新版本。
