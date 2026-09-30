# AI Review

This repository contains a source snapshot of the `github-ai-reviewer` service that was running on 2026-09-29. The source was exported from production container image `sha256:b06ff5f67d17628178d363b91a0bb0dc94f7390588167a68ac79100cf0aea684`.

The snapshot contains the image's `src/`, `public/`, `scripts/`, `package.json`, and `package-lock.json`. It does **not** include the un-deployed dashboard candidate, `node_modules`, runtime job state, logs, `.env`, API credentials, or GitHub App private keys. This is a source snapshot, not a complete production backup or a deployment configuration.

Install dependencies with `npm ci`. Runtime configuration and secrets must be supplied separately; do not commit them to this public repository.

## 增强审查实验分支

本 fork 增加固定版本动态取证、审查完整性清单、关联分组、仓库补充规则与代码片段定位，并接入外部固定版本 `hcu-coverage-analysis` 的 PR CI Review。两个功能开关默认关闭，不改变现有部署。

配置、边界和离线验收见 [增强审查说明](docs/enhanced-review.md)。固定历史样本见 [SGLang PR #436 回放报告](examples/sglang-pr436/report.md)，它不是一次新的真实模型/硬件实测。

运行 `npm test` 执行离线回归；设置 `AI_REVIEW_SKILL_REPO` 后同时运行真实 Python 校验与交接测试。没有外部 skill 时会明确跳过集成项，不应当作完整验收。
