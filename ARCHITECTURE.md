# ARCHITECTURE.md —— HAC-Workbench · v1.0

## 0. 边界
- **一句话目标**：以静态页面只读展示项目进度、每日工作、开发与运行健康度。
- **明确不做/不输出**：不写其他仓库，不做判断或自动操作，不自动同步上游解析器。
- **V1 范围上限**：2 个项目：`HAC-Flow`（`process`）和 `MarketPulse-AI`（`product`）；仅供人工查看。
- **下游消费者**：无（页面供人查看）。

## 1. 组件与通信
| 组件 | 职责 | 允许接触 | 禁止接触 |
| :--- | :--- | :--- | :--- |
| 采集/解析（M1 起） | 获取项目事实、解析指标、生成快照 | 公开 GitHub REST API；HAC-Metrics `data/` JSON；本仓库 vendor 解析副本 | 向上游仓库写入；调用冻结范围外数据 |
| 静态页面（M1 起） | 展示快照及三态 | 已生成的 JSON 快照 | 直接请求外部 API、持有 token、执行操作 |
| 运行检查（M3） | 检查固定版本的公开运行入口 | `MarketPulse-AI` 固定 SHA 的代码及公开 K 线接口 | secret、写权限、未固定版本的代码 |
| 快照提交 job（M1 起） | 仅提交已校验快照 | 本仓库快照与提交权限 | 执行外部代码 |
- **通信方式**：Actions 采集结果 → 经校验的 JSON 快照 → GitHub Pages；无数据库、队列或自动决策。M0 不实现上述功能。

## 2. 通用硬约束
- **C1 外部依赖**：GitHub REST API 只读，单请求超时 5 秒；超时、非预期响应、403/429 限流时本轮失败并以非 0 退出，不重试、不覆盖旧快照。`MarketPulse-AI` 公开 K 线接口仅 M3 经独立 Issue 启用，M0/M1 禁止调用。防：阻塞与限流误报成功。验证：测试（超时/限流/禁止调用）。
- **C2 失败不污染**：快照在同目录写临时文件、校验后 `rename`；任何失败不得改动旧快照字节。防：半写入破坏历史状态。验证：测试（写入/校验/重命名失败后旧字节不变）。
- **C3 结果有限明确**：页面状态仅 `有效` / `未知` / `陈旧`；缺失、解析失败或无验证数据为 `未知`，不得以 `0` 或 `通过` 代替；过期按 P2 判定。防：空数据误报正常。验证：测试（三态与空值）。
- **C4 密钥最小暴露**：公开仓库读取不使用 PAT；`GITHUB_TOKEN` 仅供快照提交 job，禁止传入运行 job、vendor、页面及日志。防：凭据被外部代码读取。验证：扫描 + 终审清单。
- **C5 红牌文件**：`.github/**`、`AGENTS.md`、`ARCHITECTURE.md`、`vendor/**`（解析副本）、测试配置及依赖清单/锁文件，以及 `projects.json` 中的 `repo` 与 `runtime` 字段，普通 Issue 不得修改；仅 Human 单独批准的架构 Issue 可改。`projects.json` 的 `planned` 字段：普通 Issue 仅允许把 `planned[].issue` 从 `null` 改为正整数；新增或删除 `planned` 条目需架构 Issue。M1 起 `planned` 变更须通过 schema 校验：`issue` 只能为 `null` 或正整数，不得出现 `repo`、`runtime` 字段。防：任务顺带改治理边界；或误改被测仓库。验证：终审清单（Files changed）+ 测试（schema，M1 实现）。

## 3. 模式库
- **P1 页面零外部调用**：页面仅读取已生成快照，不直接抓取或计算外部数据。防：页面加载受限流/网络故障影响。验证：测试 + 扫描。
- **P2 新鲜度标注**：快照附 `as_of`（UTC ISO 8601）及 `age_seconds`；以当前时刻计算，超过 129600 秒（36 小时）显示 `陈旧`；不存在或不可校验显示 `未知`。防：过期数据伪装实时。验证：测试（边界时钟）。

## 4. 项目特有约束
- **X1 冻结来源**：只读取 HAC-Metrics 的 `data/` JSON；解析器 vendor 文件头标来源 commit，仅上游解冻且有新 commit 时手动同步并记 CHANGELOG；禁止自动同步。防：解析语义无记录漂移。验证：扫描 + 终审清单。
- **X2 运行 job 隔离**：仅 M3 开启；`permissions: contents: read`、所有 checkout `persist-credentials: false`、不传 token；`projects.json` 的 `runtime.ref` 必须为完整固定 commit SHA，缺失则拒绝运行。防：被测代码获取写权限或漂移。验证：扫描 + 测试。
- **X3 快照提交隔离**：与运行 job 分开；该 job 权限仅 `contents: write`，不执行任何外部代码，仅提交经校验快照。防：不可信代码利用提交权限。验证：扫描 + 终审清单。

## 5. 技术栈与目录
- **语言/运行时**：Node.js（内置模块）、静态 HTML/JS、GitHub Actions/Pages。**测试命令**：`node --test`。**启动命令**：无（M0 未实现页面）。
- **单 PR 行数上限**：300（含测试）。
- **M0 文件 → 职责**：`README.md` → 边界与阶段；`projects.json` → 人工维护的项目清单；`ARCHITECTURE.md` → 硬约束；M1 起才增设 `scripts/`、`snapshots/`、`vendor/`、`.github/workflows/`。

## 6. 风险区域（命中则异源 QA）
- **高风险区域**：网络请求；解析外部输入（GitHub API 响应）；外部数据写入（快照提交）。其余由 Human 查看 diff 验收。