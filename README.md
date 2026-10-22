# HAC-Workbench

只读视图层：展示项目进度、每日工作、开发与运行健康度。不写入其他仓库，不做判断，不自动执行操作。

## 已确定的边界

1. **冻结约束**：只读取 HAC-Metrics 的 `data/` 下 JSON。解析逻辑以 vendor 副本放入本仓库，文件头注明来源 commit。HAC-Metrics 解冻并有新 commit 时，手动同步一次，并在 CHANGELOG 记录。不做自动同步。
2. **运行健康度**：在本仓库 Actions 中运行 MarketPulse-AI 的公开入口。运行外部代码的 job 声明 `permissions: contents: read`，所有 `checkout` 设 `persist-credentials: false`，不向该 job 传入任何 token。运行的代码版本由 `projects.json` 中的 `runtime.ref` 固定，更新需开 Issue 说明原因。
3. **公开仓库，Pages 托管**：页面由 GitHub Pages 发布。HAC-Metrics 已公开，本仓库内容（Issue 号、PR 号、时间戳、进度）不含敏感信息。
4. **鉴权**：公开仓库读取不需要 PAT。`GITHUB_TOKEN` 只用于提交快照，且该 job 不执行任何外部代码。

## 当前阶段

M0：仓库与清单。无功能代码，无 Actions，无 PAT。

## 结构

```text
projects.json       项目清单（人工维护）
ARCHITECTURE.md     由大脑生成草稿，人工审核后提交
```

M1 起再加 `scripts/`、`snapshots/`、`.github/workflows/`。
