// Repository review profiles. The App is installed on every HYGON-AI
// repository: inference/training plugins, kernel libraries, framework forks,
// Go Kubernetes components and documentation repositories need different
// investigation directions. Each checklist lists directions, never rules that
// imply a defect.
import fs from 'node:fs';

const footer = '清单只是检查方向，不是判错依据，每个候选仍需具体代码证据；清单以外的缺陷同样要报告。';
const intro = kind => `【高风险模式清单】以下是${kind}中常见的缺陷类型。逐项判断本次 diff 是否触及；触及的项必须沿已提供的代码核对，不能只看 diff 本身：`;

// Mined from author-fixed Codex findings on HYGON-AI/vllm-plugin-das.
const INFERENCE = `【高风险模式清单】以下是本类仓库（推理框架插件、算子适配、分布式、CI）中被确认并修复过的缺陷类型。逐项判断本次 diff 是否触及；触及的项必须沿已提供的代码核对，不能只看 diff 本身：
1. 跨进程传播：在主进程设置的环境变量、全局开关、模块级状态、类属性或策略对象，是否能到达 worker、引擎核心进程、Ray actor 或 spawn 子进程（spawn 不继承运行时修改的模块状态，只有环境变量或被显式序列化的配置会传递）。
2. 替换上游实现的语义等价：猴子补丁、OOT 注册、adapter、参考或回退 kernel 是否保留原实现的每个参数、激活变体（如 exact 与 tanh GELU）、router/top-k 权重的应用位置与次数、累加和中间结果精度（FP32 累加、量化 scale 在降精度之前还是之后相乘）、类型转换时机与溢出、返回 view 还是拷贝、in-place 语义、默认开关下的行为和边界输入。
3. 分布式拓扑：TP/PP/DP/EP/CP/PCP/DCP 下使用的 rank、world size、group 是否属于正确的并行维度（全局 rank 与组内 rank、DP 宽度与 TP 宽度混用），分片结果是否遗漏 reduce/gather，各 rank 分支是否一致以免集合通信不匹配或死锁。
4. 图捕获与编译：CUDA/HIP graph 捕获或 torch.compile 区域内是否出现依赖数据的 Python 控制流、host 同步、动态形状、捕获后才变化的张量地址，缓冲区或内存池复用是否与其他输出重叠。
5. 共享状态的读取方：diff 新增或改变的环境变量、配置字段、默认值、函数签名、返回类型或取值格式，要在已提供的上下文中寻找其他读取方，判断它们能否处理新取值（例如设备掩码从整数变为 UUID 后被 int() 解析）。
6. 异常与回退：新增异常由谁捕获；调用方（上游插件加载器、entry point 发现、try/except 回退）是否会吞掉异常并静默走上错误路径；原本可选的依赖是否因新代码变为必需。
7. 默认值与开关：默认开关的改变是否同步到测试期望、worker 侧配置和 CI；只应在某条路径生效的告警、开关或策略是否在其他路径也被触发或遗漏。
8. CI 与工作流：矩阵任务的并发 key、artifact 名称、tag 发布、变量与覆盖项的作用域是否在多个目标间冲突；工作流改动是否同步更新了对应的契约测试。
9. 测试有效性：测试是否真正执行改动路径，期望值是否与实现犯了同样的错误，mock 是否掩盖了真实行为。
${footer}`;

const TRAINING = `${intro('训练框架与训练工具仓库（Megatron、DeepSpeed、verl、slime 等的 HCU 适配）')}
1. 并行切分：TP/PP/DP/EP/CP/ZeRO 下的 rank、group、world size 是否取自正确的并行维度；分片参数、梯度和优化器状态的切分与 all-reduce/reduce-scatter/all-gather 是否成对、作用在正确的 group 上；各 rank 是否走一致的集合通信路径，避免死锁。
2. 数值与混合精度：loss scaling、梯度裁剪、主权重 FP32 副本、bf16/fp16 转换时机、累加精度、归一化与 softmax 的稳定性；替换上游算子或融合 kernel 时前向和反向是否都等价。
3. 反向传播与 autograd：自定义 autograd.Function 的 backward 是否覆盖所有输入、是否正确处理 needs_input_grad、保存的张量是否被 in-place 修改；梯度是否被重复累加或漏累加；梯度累积与 micro-batch 的缩放。
4. 检查点与恢复：保存/加载的字段是否成对，分片 checkpoint 在不同并行度下能否加载，新增状态是否进入 state_dict，随机数状态与数据加载器位置是否恢复。
5. 配置与参数传播：新增参数是否在 argparse/配置类、启动脚本、各 rank/worker、Ray actor 之间一致传递；默认值改变是否同步到测试和文档。
6. 资源与性能回归：显存峰值、通信与计算重叠、额外的 host 同步或 .item()、在每步循环内重复创建大张量或通信 group。
7. 异常与回退：硬件或库不支持时的回退路径是否静默改变语义；被吞掉的异常是否导致训练继续但结果错误。
8. 测试有效性：测试是否真正执行改动路径（多卡逻辑是否只在单卡下验证），期望值是否与实现犯了同样的错误。
${footer}`;

const KERNEL = `${intro('算子库与通信库仓库（C++/CUDA/HIP kernel、Triton/TileLang DSL、集合通信）')}
1. 索引与边界：线程/块索引计算、循环边界、尾块处理、整数溢出（int32 偏移在大张量下溢出）、对齐要求、向量化加载的越界与未对齐访问。
2. 同步与内存模型：__syncthreads/屏障是否覆盖所有共享内存读写、warp 级原语的 mask、原子操作的作用域、流与事件顺序、跨 kernel 的依赖是否在正确的 stream 上。
3. 数值精度：累加类型、类型转换与舍入、量化 scale/zero-point 的应用顺序、fp8/int8/bf16 的饱和与 NaN/Inf 处理，与参考实现的等价性。
4. launch 与资源：grid/block 维度上限、共享内存与寄存器用量、动态共享内存配置、occupancy 假设、不同架构（gfx 版本、HCU 型号）的条件编译分支是否完整。
5. 接口契约：Python 绑定与 C++ 签名、dtype/shape/stride/contiguous 校验、输出张量是否预分配及别名、workspace 大小计算、调用方传入参数的语义是否一致。
6. 通信库：rank/peer 编号、缓冲区注册与生命周期、内存屏障与可见性、超时与错误码传播、多节点与单节点路径的差异。
7. 构建：CMake/setup 中新增源文件、编译选项和架构列表是否同步，条件编译宏在不同平台下是否都能编译。
8. 测试有效性：测试是否覆盖非对齐尺寸、尾块、大尺寸和不同 dtype，参考实现是否与被测实现犯同样的错误，容差是否过宽。
${footer}`;

const FRAMEWORK = `${intro('上游大型框架的 HCU 下游适配仓库（PyTorch、TensorFlow、XLA、JAX、Triton、OpenCV、faiss 等）')}
1. 与上游的差异：本次改动修改了上游原有逻辑时，非 HCU 平台（CUDA/CPU/ROCm 原有路径）的行为是否被意外改变；平台判断宏、环境变量和运行时检测是否把改动限制在 HCU 路径。
2. 构建系统：CMake、Bazel/Starlark、setup.py 中新增的源文件、依赖、编译宏、架构列表与可选开关是否同步；关闭 HCU 选项时能否编译。
3. 设备与后端：设备枚举、流和事件、内存分配器、属性查询在 HCU 上的语义差异；回退到其他后端时是否静默改变结果。
4. 数值与算子：替换或新增的 kernel 与原实现的精度、dtype 覆盖、边界形状是否等价；被禁用的算子是否给出明确报错而不是错误结果。
5. 测试与 CI：被跳过或放宽的测试是否只针对 HCU 且有理由；新增测试是否真正运行在 HCU 路径上。
6. 打包与版本：wheel/包名、版本号、依赖版本约束、动态库搜索路径是否与发布流程一致。
${footer}`;

const GO_SERVICE = `${intro('Go 编写的设备管理与 Kubernetes 组件（device plugin、DRA driver、exporter、监控工具、调度器）')}
1. 错误处理：被忽略的 error、只记日志不返回导致继续使用无效值、错误包装丢失上下文；panic 是否可能在 goroutine 中未被恢复导致进程退出。
2. 并发：共享 map/切片的并发读写、锁的覆盖范围与死锁、goroutine 泄漏（无退出条件或未处理 context 取消）、channel 关闭与阻塞。
3. 资源释放：文件、设备句柄、HTTP body、ticker、gRPC 连接是否在所有返回路径上关闭；defer 在循环中的累积。
4. Kubernetes 语义：device plugin/DRA 的分配与回收是否幂等，kubelet 重启或 Pod 删除后状态是否一致；资源名、注解与标签的格式；RBAC 与 Helm 模板中的权限与新功能是否匹配。
5. 设备信息：设备枚举顺序、ID 与索引的映射、热插拔或部分设备不可用时的处理；指标名称、标签基数与单位是否符合 Prometheus 约定。
6. 配置与兼容：新增命令行参数、配置字段和环境变量的默认值，旧配置是否仍可用；Helm chart、Dockerfile 与代码是否同步。
7. 测试有效性：测试是否只覆盖成功路径，mock 是否掩盖了真实设备或 API 行为。
${footer}`;

const DOCS = `${intro('文档与最佳实践仓库，文档本身就是交付物')}
1. 命令可执行：命令、参数名、环境变量、路径和镜像标签是否真实存在且拼写正确，前后步骤的依赖顺序是否成立，复制粘贴后能否直接运行。
2. 版本一致：框架、驱动、DTK、镜像与模型的版本号在同一文档内及与仓库其他文档是否一致；已废弃的参数是否仍被推荐。
3. 数值与结论：性能数据、显存与卡数需求、精度结论是否与给出的配置和步骤相符，单位是否正确。
4. 链接与引用：内部链接、锚点、图片路径是否存在；引用的脚本和配置文件是否在仓库中。
5. 示例代码：示例代码是否能运行、是否与描述的行为一致。
6. 安全：文档中是否出现真实的凭据、内网地址或个人信息。
${footer}`;

const GENERIC = `${intro('通用代码仓库')}
1. 接口契约：新增或修改的函数签名、返回值、配置字段与所有调用方是否一致。
2. 异常与回退：异常是否被吞掉导致静默走上错误路径，回退路径是否改变语义。
3. 资源与并发：文件、进程、连接是否在所有路径上释放，共享状态的并发访问。
4. 配置与默认值：新增配置和默认值是否同步到调用方、测试和文档。
5. 测试有效性：测试是否真正执行改动路径，期望值是否与实现犯了同样的错误。
${footer}`;

// Added to any profile when the PR touches CI or build files.
const CI_ADDON = `【CI 与构建附加检查】本次改动涉及 CI 或构建文件：矩阵任务之间的并发 key、artifact 名称、tag 发布和变量作用域是否冲突；条件表达式与触发事件是否覆盖预期分支；shell 脚本的错误处理（set -e、管道失败、未加引号的变量）；runner 标签、镜像与缓存键是否与目标一致；工作流改动是否同步更新了对应的契约测试。`;

export const PROFILES = {
  inference: { name: '推理框架插件', checklist: INFERENCE },
  training: { name: '训练框架', checklist: TRAINING },
  kernel: { name: '算子与通信库', checklist: KERNEL },
  framework: { name: '上游框架适配', checklist: FRAMEWORK },
  go: { name: 'Go 设备与 Kubernetes 组件', checklist: GO_SERVICE },
  docs: { name: '文档', checklist: DOCS, docs: true },
  generic: { name: '通用', checklist: GENERIC },
};
export const INFERENCE_CHECKLIST = INFERENCE;

// HYGON-AI repositories as of 2026-10. Unknown repositories fall back to the
// languages of the changed files; AI_REPO_PROFILES overrides both.
const BUILT_IN = {
  inference: ['vllm-plugin-das', 'vllm-das', 'sglang-das', 'sglang-plugin-das', 'LMCache-das', 'mooncake-das',
    'fastsafetensors-das', 'adapter-das', 'triton-inference-server-server-das', 'triton-inference-server-backend-das',
    'triton-inference-server-pytorch-backend-das', 'triton-inference-server-onnxruntime-backend',
    'triton-inference-server-migraphx-backend', 'triton-inference-server-test'],
  training: ['Megatron-LM-das', 'Megatron-bridge-das', 'verl-das', 'slime-das', 'AReal-das', 'Deepspeed-das',
    'TurboPhysAI', 'flash-train', 'DiffSynth-Studio-das', 'apex-das', 'hcu_probe-das', 'one-click-quant',
    'cluster-manager-das', 'hcu-train-simulator'],
  kernel: ['lightop', 'aiter-das', 'composable_kernel-das', 'flash-attention-das', 'FlashMLA-das', 'DeepEP-das',
    'UltraEP-das', 'rocSHMEM-das', 'rccl-dtk', 'TransformerEngine-das', 'Moe', 'deepgemm-das', 'TileKernels-das',
    'BoltOPs', 'causal-conv1d-das', 'spconv-das', 'FastPT'],
  framework: ['pytorch-das', 'tensorflow-das', 'xla-das', 'jax-das', 'triton-das', 'torchvision-das', 'opencv-das',
    'opencv_contrib-das', 'opencv-python-das', 'faiss-das'],
  go: ['hcu-exporter', 'hcu-dcgm', 'k8s-hcu-device-plugin', 'k8s-hcu-dra-driver', 'k8s-hcu-label-node',
    'hcu-container-toolkit', 'volcano'],
  docs: ['inference-cookbook-das', 'train-cookbook-das'],
};
const builtIn = new Map(Object.entries(BUILT_IN).flatMap(([profile, names]) => names.map(name => [name.toLowerCase(), profile])));

export const isDocPath = path => /\.(?:md|mdx|rst|txt|adoc)$/i.test(path) || /(?:^|\/)(?:docs?|cookbook)\//i.test(path) && !/\.(?:py|sh|go|c|cc|cpp|h|hpp|cu|cuh|hip)$/i.test(path);
export const isCiPath = path => /(?:^|\/)\.github\/|(?:^|\/)(?:Dockerfile[^/]*|Makefile|CMakeLists\.txt|BUILD(?:\.bazel)?|WORKSPACE|setup\.py|pyproject\.toml|\.gitlab-ci\.yml)$|\.(?:cmake|bzl)$|(?:^|\/)(?:ci|scripts\/ci|\.ci)\//.test(path);

function fromLanguages(files) {
  const count = pattern => files.filter(file => pattern.test(file.filename)).length;
  const go = count(/\.go$/), native = count(/\.(?:c|cc|cpp|cxx|h|hh|hpp|cu|cuh|hip)$/), python = count(/\.pyi?$/);
  if (go && go >= native && go >= python) return 'go';
  if (native && native >= python) return 'kernel';
  return 'generic';
}

function loadOverrides(environment) {
  if (!environment.AI_REPO_PROFILES) return [];
  try {
    const value = JSON.parse(fs.readFileSync(environment.AI_REPO_PROFILES, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

// AI_REPO_PROFILES=/path/profiles.json:
//   [{"repository": "HYGON-AI/new-repo", "profile": "kernel", "extraChecklist": "…"}]
export function resolveReviewProfile({ repository = '', files = [], environment = process.env } = {}) {
  const name = repository.split('/').pop().toLowerCase();
  const override = loadOverrides(environment).find(entry => String(entry?.repository || '').toLowerCase() === repository.toLowerCase());
  let key = PROFILES[override?.profile] ? override.profile : builtIn.get(name) || fromLanguages(files);
  const reviewable = files.filter(file => file.patch);
  // A PR that only edits documentation is reviewed as documentation anywhere.
  if (reviewable.length && reviewable.every(file => isDocPath(file.filename))) key = 'docs';
  const profile = PROFILES[key];
  const parts = [profile.checklist];
  if (key !== 'inference' && key !== 'docs' && reviewable.some(file => isCiPath(file.filename))) parts.push(CI_ADDON);
  if (typeof override?.extraChecklist === 'string' && override.extraChecklist.trim()) parts.push(`【仓库附加检查】${override.extraChecklist.trim().slice(0, 2000)}`);
  return { key, name: profile.name, docs: Boolean(profile.docs), checklist: parts.join('\n') };
}

// Maintainer review rules from the base branch (never the PR head, which the
// author controls): the root AGENTS.md / REVIEW.md and those in directories of
// changed files. A "Code Review Rules" section is preferred over the whole file.
export function repositoryReviewRules(snapshot, files, { maxChars = 4000 } = {}) {
  if (!snapshot?.files) return '';
  const dirs = new Set(['']);
  for (const file of files) {
    const parts = file.filename.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const sections = [];
  for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
    for (const name of ['AGENTS.md', 'REVIEW.md', '.github/REVIEW.md']) {
      const path = dir ? `${dir}/${name}` : name;
      const text = snapshot.files.get(path);
      if (!text) continue;
      const match = /^#{1,3}\s*(?:Code Review Rules|Review Rules|代码审查规则|审查规则)[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/im.exec(text);
      const body = (match ? match[1] : text).trim();
      if (body) sections.push(`FILE: ${path}\n${body}`);
    }
  }
  const joined = sections.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n[审查规则已按长度截断]` : joined;
}
