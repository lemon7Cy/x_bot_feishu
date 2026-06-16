# x_bot_feishu 项目介绍

x_bot_feishu 是一个面向 AI Agent / AI Coding / MCP / 自动化工具方向的信息采集与日报机器人。它会从 GitHub、arXiv、X RSS 等公开来源低频采集信息，做去重、规则评分和 LLM 分析，然后在指定时间把高价值内容整理成飞书日报。

这份文档面向第一次接触项目的同事，帮助快速理解项目目标、架构、运行方式和后续可扩展方向。

## 这个项目解决什么问题

AI Agent 相关信息分散在很多地方：GitHub 新项目、arXiv 论文、X/Twitter 动态、产品发布等。如果每天人工看，很容易漏掉有价值的信息，也很容易被噪音淹没。

这个项目的目标是：

- 自动采集 AI Agent / AI Coding / MCP 相关信息。
- 用规则先做初筛，减少明显无关内容。
- 用 LLM 判断价值、摘要重点、标注类别。
- 按固定日报窗口生成报告。
- 只在指定时间推送一份整理好的日报，避免机器人刷屏。

## 当前核心流程

当前系统被拆成三个阶段：

```text
Collection -> Prepare -> Send
```

### 1. Collection：后台采集

后台定时从多个来源采集内容：

- GitHub Search API
- arXiv API
- X RSS / Nitter-like RSS 源

采集到的数据会写入 SQLite，并进行：

- URL / source_item_id 去重
- 关键词匹配
- 规则评分
- confidence 标记：high / medium / low

采集只负责入库，不负责推送。

### 2. Prepare：生成日报

到达 Prepare 时间后，系统会计算当前报告窗口，并从数据库里选择候选内容。

报告窗口不是自然日 00:00 到 00:00，而是按 Prepare 时间滚动的 24 小时窗口。

例如：

```text
Prepare 时间：08:30
当前日报窗口：昨天 08:30 - 今天 08:30
```

Prepare 阶段会：

- 查询窗口内首次采集到的内容。
- 排除已经进入过历史日报的内容。
- 选择一批候选交给 LLM 分析。
- 根据 LLM rating、evidence、风险等规则过滤。
- 生成飞书卡片 JSON。
- 保存为 prepared digest。

Prepare 阶段不推送飞书。

### 3. Send：推送已准备日报

到达 Send 时间后，系统只读取 Prepare 阶段已经保存好的日报卡片，然后推送飞书。

Send 阶段不会重新采集，也不会重新调用 LLM。这样可以保证“生成”和“推送”之间内容稳定，不会因为临时采集或 LLM 变化导致报告内容漂移。

## 为什么要这样拆分

之前如果把采集、分析、推送放在同一个流程里，会有几个问题：

- 推送时临时采集，导致当天报告窗口不清晰。
- LLM 慢或超时时，飞书推送时间不可控。
- 新采集到的信息可能混入本该已经截止的日报。
- 多个推送入口容易导致 bot 刷屏。

现在拆成 Collection / Prepare / Send 后：

- 采集可以慢一点、稳一点。
- Prepare 可以提前执行，给 LLM 留时间。
- Send 只负责发已准备好的内容。
- 正式飞书推送路径更可控。

## 报告窗口规则

当前窗口模式是：

```text
rolling_prepare_time
```

含义是：

```text
上一次 Prepare 时间 -> 本次 Prepare 时间
```

例如：

```text
当前时间：2026-06-16 09:00
Prepare：08:30
窗口：2026-06-15 08:30 - 2026-06-16 08:30
```

这个项目不再使用 previous_natural_day 作为正式日报窗口。即使旧配置里残留 previous_natural_day，运行时也会归一化成 rolling_prepare_time。

## 去重策略

日报不是“每天把所有高分内容都重新推一次”。

当前策略是：

- 一条内容一旦进入 digest_items，后续默认不再进入新日报。
- 这样可以避免第二天继续推送同一个 GitHub repo、论文或 X 动态。

如果需要重新生成某个窗口的日报，需要谨慎操作，因为删除 digest 记录可能影响去重结果。

## LLM 分析策略

LLM 不会分析窗口内全部内容，而是先由规则评分选出候选，再送给 LLM。

当前 balanced 级别大致是：

```text
llmMaxCandidates: 40
llmMaxCandidatesPerSource: 14
maxItems: 10-12
llmMinRating: B
```

LLM 会给出：

- rating：S / A / B / C / Noise
- relevance
- 摘要
- 创新点或值得关注点
- evidence
- hallucination_risk
- tags

日报最终只保留达到质量要求的内容。`maxItems` 是上限，不代表一定推满。如果当天高质量内容较少，可能只推几条。

## 为什么有时日报条数少

日报条数少通常不是采集不到数据，而是过滤链路比较严格：

- 规则候选很多，但 LLM 只分析 top N。
- rating 低于 B 会被过滤。
- 缺少 evidence 的内容会被过滤。
- 高 hallucination risk 的内容会被过滤。
- 已经推送过的内容会被永久去重。
- 每来源有配额限制。

最近一次排查中，窗口内去重后候选超过 100 条，但由于 LLM 候选上限较低和过滤严格，最终只推了 2 条。因此后续把 balanced 的 LLM 候选池提高到了 40 / per-source 14。

## WebUI 能做什么

WebUI 默认运行在：

```text
http://localhost:8787
```

服务器 Docker 部署时会暴露 8787 端口。

WebUI 主要功能：

- 配置飞书 Webhook。
- 配置关键词和负向词。
- 开关 arXiv / GitHub / X RSS 来源。
- 配置 Prepare / Send 时间。
- 配置报告标题、标题后缀、汇总说明。
- 选择策略预设。
- 查看当前报告窗口。
- 查看日报是否 prepared / sent。
- 手动采集、预览、准备、推送已准备日报。
- 查看最近采集、LLM 分析和 scheduler 状态。

## Docker 部署方式

项目推荐用 Docker Compose 长期运行。

常用更新命令：

```bash
git pull
docker compose up -d --build
docker compose ps
docker compose logs -f x-bot-feishu
```

运行时文件不要提交到仓库：

- `.env`
- `config.json`
- `data/monitor.sqlite`

这些文件通过 Docker volume / bind mount 保留在服务器本地。

## 重要目录

```text
src/ingest.js          采集入口
src/digest.js          日报 preview / prepare / send
src/scheduler.js       内置调度器
src/db.js              SQLite schema 和查询
src/llm.js             LLM 分析
src/feishu.js          飞书卡片和发送
src/web.js             WebUI API
web/app.js             WebUI 前端逻辑
web/index.html         WebUI 页面
config.example.json    配置示例
docker-compose.yml     Docker Compose 配置
```

## 采集稳定性和 403 问题

X RSS / Nitter-like 公共实例经常会出现 403、timeout 或不可用。这是预期内风险。

当前已有分布式关键词采集的基础逻辑：

- 不要求每次采集都打满全部关键词。
- 关键词会按 interval / fullCycleHours 分散到不同轮次。
- 一个完整周期内逐步覆盖所有关键词。

后续可以继续增强：

- 每个平台独立采集间隔。
- 每个平台独立关键词游标。
- 403 后自动退避。
- X RSS instance 健康检查和降权。
- 采集覆盖率统计。

这个方向的原则是：稳定优先，慢一点没关系，不要为了实时性频繁打接口导致限流。

## 当前公开仓库注意事项

仓库公开前需要确认：

- 不提交 `.env`。
- 不提交 `config.json`。
- 不提交 SQLite 数据库。
- 不提交服务器密码、飞书 webhook、GitHub token、LLM API key。

当前仓库中只保留示例配置和代码，真实运行配置应留在服务器本地。

## 给同事的快速体验路径

如果只是想了解代码：

```bash
git clone https://github.com/lemon7Cy/x_bot_feishu.git
cd x_bot_feishu
npm install
cp .env.example .env
cp config.example.json config.json
npm run init-db
npm run web
```

如果没有飞书和 LLM key，也可以先看 WebUI 和采集逻辑；正式日报推送需要配置飞书 webhook 和 LLM API。
