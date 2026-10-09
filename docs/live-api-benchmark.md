# 真实 API 只读耗时测试

此入口显式允许向配置的模型接口发请求，但没有 GitHub 写入/发布路径，不执行被审仓库的代码或测试。原有 `dry-run:pr`、回放和 `npm test` 的断网约束保持不变。API 调用可能产生费用。

## 配置

将配置文件保存在代码仓库之外、仅当前用户可读的目录。不要把密钥放进命令行、示例或 Git 提交。

```dotenv
AI_API_FORMAT=openai-chat
AI_BASE_URL=https://your-approved-gateway/v1/chat/completions
AI_MODEL=your-model
AI_API_KEY=<从安全渠道保存的密钥>
AI_API_TIMEOUT_MS=120000
AI_CHAT_JSON_MODE=true
```

`AI_CHAT_JSON_MODE` 是默认关闭的 Chat Completions 兼容选项：显式发送 `response_format=json_object`，并提示模型只使用文本 JSON 取证协议。仅用于已验证支持该参数的接口。不解析或执行正文中的原生工具分隔符，不从推理文本中抽取答案。若接口不支持、输出截断或最终答案不完整，保留失败状态，不能作“无问题”处理。

HTTP 接口必须额外显式设置 `AI_ALLOW_INSECURE_HTTP=true`，仅限已批准的测试网络；密钥和源码通过该连接没有 TLS 保护。生产应使用 HTTPS。

Messages 网关如果把推理文本作为普通 `text` 块返回，不可直接当作 JSON 最终答案；优先使用能够区分 `reasoning_content` 与最终 `content` 的兼容 Chat 接口，不凭“最后一块”猜测答案。

## 冻结输入与执行

计划文件包含固定版本 skill checkout 和恰好 5 个不同 PR：

```json
{
  "skill": "/absolute/pinned-skillhub-checkout",
  "samples": [
    {"repo":"/absolute/clean-pr-checkout", "fixture":"/absolute/fixture.json", "category":"普通逻辑"}
  ]
}
```

上面只展示单项格式，执行时必须填写 5 项。fixture 由 `capture:pr` 获取；只接受固定 base/head、采集一致、无敏感内容的证据。模型只接收原始快照、源码及取证，不提供已有分析或评估标签。

```powershell
node scripts/benchmark-pr-api.mjs --config C:/private/model.env --plan C:/private/plan.json --output C:/private/results
```

全部样本先通过干净 checkout、SHA 和 skill 版本检查，再发第一个付费请求。结果生成在新的私有目录中，Windows 会先限制继承 ACL。不会自动加载或更改生产服务配置。

## 耗时口径

- 模式固定为 `both`，五个 PR 串行；现有代码批次最多并行 2 个，代码阶段后再进行测试覆盖审查。
- 不复用审查缓存；保持 180 秒共享模型窗口、分组 10 秒、24 次取证预算。这里不是为手工 Codex 桥接扩大的交互窗口。
- 每个 PR 墙钟时间包含 pipeline 内的固定版本准备、模型往返、取证、复核、Python 校验；不包含先前 GitHub 采集、checkout 下载、连接探测和最终报告落盘。180 秒是共享模型阶段预算，不是含准备的 PR 总耗时上限。
- 同时保存每次模型调用的阶段、时间、字符数、token 使用、JSON 有效性、实际返回模型标识、失败类别，以及最终代码/测试完成状态。模型并发调用耗时之和不能当作墙钟时间。
- 总体平均包含失败/未完成样本；完整样本平均单列，没有完整样本则为 `null`。不以少量数据估计 P95 或线上吞吐量，不把历史冻结 CI 当成当前执行结果。
- `validated` 只表示覆盖审查及补测交接通过校验，不表示运行过目标测例或已完成全部审查。普通性能测试不自动标为独立盲测。

每个 PR 保存 `measurement.json`、`manifest.json`、`pipeline-result.json`、`evidence-index.json`、`report.md` 和最终答案记录；测试审查通过时另有 `review.json`、`test-backlog.json` 和私有 skill 输出。私有 skill 正文和原始证据不应复制到公开仓库。

根目录的 `benchmark.json`/`benchmark.md` 汇总五个 PR。失败预跑应保留在独立目录，不覆盖首次输出，也不混进正式五样本平均。
