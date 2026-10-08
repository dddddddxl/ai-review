# G4 包装器补测：节点隔离实测结果

2026-10-08；针对 SGLang PR #436 的固定历史 head `6f0f185a691c16b0134a26f2ff172c7e2af31edb`，不是当前分支 head。
使用 `hcu-test-generation` skill 固定版本 `aaff435e1eb80e4e187b9b71bd0a39a442f6327e`，仅处理原交接任务 G4 / 场景 G4-width。

## 结论

生成的 CPU 测试可执行，能抓住三个指定接口错误。任务状态仍为 `implemented_unverified`：本地正例/负控成功，但原生 CI 选择被既有注册错误阻塞，真实 CI 未执行。原 PR 缺口未自动关闭。

| 验证项 | 真实结果 | 证据 |
| --- | --- | --- |
| pytest 正例 | 4 个方法通过，0 failed/error/skipped | artifacts/positive.json、positive.xml |
| 仓库原生 unittest 文件入口 | 4 tests，OK，exit 0 | artifacts/native.log |
| 删除宽度防卫 | 2 个方法失败；5 个非法输入触发目标断言 | artifacts/remove_width_guard.json、.log |
| 删除 reshape | 1 个方法失败；64/128 两个输入触发 shape 断言 | artifacts/remove_reshape.json、.log |
| 忽略 num_sms | 1 个方法失败；64/128 两个输入触发 exact-call 断言 | artifacts/ignore_num_sms.json、.log |
| 原生 CPU selector | exit 1，未成功完成选择 | artifacts/selection.json、.log |
| 真实 CI / HCU 内核 | 未运行 | artifacts/summary.json |
| 源码行/分支覆盖率 | 未采集，不提供百分比 | 无 coverage 工件 |

负控为实际隔离修改产品包装器，不是合成失败日志；Codex 复核失败均为 AssertionError，非导入/setup 失败，尚未经人类独立复核。所有负控 errors/skipped 均为 0。
该镜像 pytest 的 subTest 展示会出现“方法 passed + SUBFAILED”混合统计；上表按 JUnit 的四个方法结果归一化，另列失败输入数，不把 console 的 passed 数当作负控通过。

## 测试覆盖范围

原始文件：`python/sglang/srt/layers/attention/dsv4/paged_mqa_pers_jit.py`。
候选新增文件：`test/registered/unit/layers/attention/dsv4/test_persistent_int8_paged_mqa_wrapper.py`。

采用真实 CPU PyTorch 张量，直接导入真实包装器，只 mock `_module()` 返回的 JIT 后端。没有重写被测逻辑。
采用原生 `unittest.TestCase`，pytest 可运行同一测试；避开会导入服务和设备依赖的重型测试基类。

- 宽度 -64、0 必须提前抛 ValueError，不能调用工厂和后端。
- 宽度 1、63、65 同样拒绝，核对具体错误消息。
- 合法 64、128 宽度验证 4D→3D、dtype、CPU 设备、张量值、其余张量身份、8 个位置参数和 num_sms=17 / fill_upto=0。
- 原生 3D 输入不重塑，默认 num_sms=320，输出保持 mock 后端返回对象身份。

不覆盖真实 JIT 编译、缓存工厂、HCU 数值、TopK、graph、生产路由、分布式或性能。整数参数类型已检查，但非整数输入强制转换的完整矩阵未验证。

## CI 阻塞及处理边界

新测试注册的是 `base-a-test-cpu`。执行真实 `test/run_suite.py --hw cpu --suite base-a-test-cpu --include-file registered/unit/layers/attention/dsv4/test_persistent_int8_paged_mqa_wrapper.py --list`。

选择器先扫描并校验整个 registered 目录，再执行 include-file 过滤，因此以下两处既有 `stage-a-test-cpu` 注册触发 ValueError：

- `test/registered/unit/models/test_minimax_eagle3.py:16`
- `test/registered/unit/layers/attention/dsa/test_hcu_sparse_mqa.py:13`

目标提交的 CPU suite 白名单包含 `base-a-test-cpu`，不包含 `stage-a-test-cpu`。本轮没有改动这两个已有文件、绕过校验或声称 CI 已选中/执行了新测试。
下一步需要单独确认两处注册的预期 lane，再修正注册或选择器规则，不能仅凭名称猜测后直接替换。还需核对真实 workflow/gate/matrix 并取得同版本 CI 逐测例结果。

## 实测发现与 completion v2 收尾

原计划 G4-width 是组合场景，生成后自然分为四个命名方法。原 completion v1 的单个 test_id 无法完整表达多方法正例与不同方法的负控。
现已显式迁移到 completion v2：保持原场景 ID，tests 数组逐一记录四个真实 JUnit ID，三份负控分别对应实际失败方法；不再使用代表 ID。未重跑或改写原始运行工件。
校验器固定到 skillhub `74376c2b1d263d1e26fa052b21e7847706d6651e`。方法映射问题已解决，CI 选择与执行阻塞仍然存在，任务继续保持 `implemented_unverified`。
`artifacts/result-counting.json` 从原始 XML 生成，分别记录方法计数、failure 节点数和 JUnit 自带汇总。3D/default 方法只有正例，未宣称具有对应负控。失败断言由 Codex 复核，尚未经人类独立复核。

## 隔离与来源

使用用户指定镜像 `sha256:3ba7d7248f7e082e179f3b8064104232d6fcb5fa3f4398cb0e641810ee6b978f`：Python 3.10.12、PyTorch 2.11.0、HIP build 6.3.26113。
资源限制为 1 CPU / 2 GiB / 128 PIDs；无网络、无设备映射、无 privileged、drop ALL capabilities、只读根文件系统；只读挂载必要库与任务输入。
结果写容器 tmpfs，导出后核对原始日志/XML 哈希；未安装节点依赖、未读取模型目录、未修改或停止既有 nightly 容器。
执行前后设备未初始化；本轮创建的 `codex-g4-cpu-20261008` 容器已删除。任务专属临时输入/工件保留，不含密码。

实际产品源码来自固定 Git archive，不使用镜像内未知版本的 sglang wheel。source.tar 的 SHA256：`63a5f78ae5094d7339e0060ff3d1a76a1f7b0409bf9fea07772e4713e9326bdb`。
执行身份 `patch_sha256` 为实际包装器、新测试和注册模块的规范文件哈希清单摘要，不是 Git diff hash；原始目标 checkout 保持干净。
上游检索只记录目标仓库声明的历史基线；上游树查询不可用，不据此断言上游没有测试。该候选测试原创，标注 Apache-2.0，无上游代码复制。

## 文件与复核

- `generation-plan.json`：保留原审查交接及场景/验收条件，不覆盖历史审计。
- `completion.json`：本轮实际证据、测试身份、负控、未完成条件。
- `artifacts/`：18 份原始环境/JSON/JUnit/日志工件，以及 1 份可追溯的计数解释工件；被引用的脱敏 `.log` 文件一并纳入提交。
- `g4-test.patch`：单个新增测试的候选补丁，尚未应用到业务仓库。
- `run_g4.py`：隔离副本内执行正例、原生入口、选择器和三种负控。
- `finalize_g4.py`：核对下载工件并生成完成记录/补丁，不伪造运行日志。

离线复核（有标准 Python 即可，不需要 Torch）：

```text
python -I -B finalize_g4.py --bundle . --validator-commit 74376c2b1d263d1e26fa052b21e7847706d6651e
python -I -B <固定 skill checkout>/experiments/hcu-testing/skills/hcu-test-generation/scripts/check_completion.py --plan generation-plan.json --completion completion.json
```

预期 `evidence_consistent`，`validated_tasks=[]`。只表示结构、哈希和引用相容，不表示真实 CI 或 HCU 通过。
本轮实际运行完成校验，结果与上述预期一致；候选补丁在原始干净 checkout 上通过 `git apply --check`，未实际应用。
历史 G4 整理阶段曾在 ai-review 配置当时的固定 skill 后执行 `npm test`：45 tests / 45 pass / 0 fail / 0 skipped。未设置该变量的历史首次回归为 27 pass / 18 skipped，不把跳过项计作通过。v2 集成后的当前回归另见 `docs/offline-validation.json`，不把历史 45 项记录作为新版本验收。
重跑需要先从同一 Git SHA 导出指定源码到 source.tar，并在另建的受限容器内运行 `python3 -I -B /input/run_g4.py --input /input --output /output --work /audit/g4`；work 路径必须不存在。复用结果目录前应另建目录，保留历史证据。

本目录作为 ai-review 个人 fork 开发分支的交付内容；未把测试补丁应用到 SGLang，未调用模型 API、发布 PR 评论、部署服务或触发业务 CI。
