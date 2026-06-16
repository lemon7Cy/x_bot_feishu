# x_bot_feishu

如果你是第一次了解这个项目，建议先看：`docs/PROJECT_OVERVIEW.md`。

AI Agent 情报监控与飞书日报机器人。它会低频采集 arXiv、GitHub、X RSS 中和 Agent / A2A / Agentic 相关的信息，统一清洗入库，规则评分，再用 LLM 做二次分析，最后按定时策略把日报推送到飞书群。

当前推荐流程是三阶段：

```text
Collection: 后台低频采集，只入库、清洗、评分
Prepare: 到准备时间调用 LLM，生成并保存 prepared report
Send: 到推送时间只发送 prepared report，不重新采集、不重新 LLM
```

## 核心特性

- arXiv：按关键词抓取论文，匹配标题和摘要，适合长回看补漏。
- GitHub：抓取仓库、issue、PR，按 star、关键词和来源权重评分。
- X RSS：实验性使用 Nitter/RSS 实例，失败不会影响其他来源和日报推送。
- SQLite：保存原始条目、规则评分、LLM 分析、日报记录和调度器记录。
- LLM 分析：按平台分组、分批切片、长文本裁剪，输出摘要和重点。
- 飞书卡片：简洁日报格式，只保留标题、摘要、重点、来源和关键词。
- 永久去重：一旦进入 `digest_items`，以后默认不再推送同一条内容。
- WebUI：本地配置飞书、关键词、来源、策略、准备/推送时间和运行状态。

## Windows 快速开始

要求：Node.js 20+，建议 Node.js 22 LTS。

```powershell
git clone https://github.com/<your-account>/x_bot_feishu.git
cd x_bot_feishu
npm install
copy .env.example .env
copy config.example.json config.json
npm run init-db
```

编辑 `.env`，至少填写：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
FEISHU_SECRET=
GITHUB_TOKEN=

VIDEO_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
VIDEO_LLM_MODEL=your-model-name
VIDEO_LLM_API_KEY=your-api-key
VIDEO_LLM_TIMEOUT_MS=90000

CONFIG_PATH=./config.json
DB_PATH=./data/monitor.sqlite
PYTHON_BIN=python
```

启动 WebUI：

```powershell
npm run web
```

打开：

```text
http://127.0.0.1:8787
```

如果想让 WebUI 和内置调度器一起跑：

```powershell
npm run web:scheduler
```

也可以只跑调度器：

```powershell
npm run scheduler
```

## macOS / Linux 快速开始

```bash
git clone https://github.com/<your-account>/x_bot_feishu.git
cd x_bot_feishu
npm install
cp .env.example .env
cp config.example.json config.json
npm run init-db
npm run web
```

## 推荐配置

仓库只维护 `config.example.json` 模板。运行时请复制成 `config.json`，再通过 WebUI 或编辑文件修改。真实密钥仍然只放在 `.env` 中。

推荐正式策略：

```json
{
  "timezone": "Asia/Shanghai",
  "ingestion": {
    "sourceLookbackHours": {
      "arxiv": 168,
      "github": 72,
      "xrss": 24
    }
  },
  "scheduler": {
    "collection": {
      "enabled": true,
      "intervalMinutes": 90,
      "distributed": true,
      "fullCycleHours": 10
    },
    "prepare": { "enabled": true, "time": "08:30" },
    "send": { "enabled": true, "time": "09:00" }
  },
  "digest": {
    "window": "previous_natural_day",
    "minConfidence": "medium",
    "llmMinRating": "B"
  }
}
```

含义：

- 每 90 分钟低频采集一次。
- 分布式关键词采集：不会每次把所有关键词打满，而是在约 10 小时内逐步覆盖完整关键词集，降低 X RSS/Nitter 和 arXiv/GitHub 限流风险。
- arXiv 每次回看 7 天。
- GitHub 每次回看 72 小时。
- X RSS 每次回看 24 小时。
- 08:30 准备前一天自然日报告：昨天 00:00 到 23:59 Asia/Shanghai。
- 09:00 只发送已经准备好的报告。
- 准备/推送期间采集到的新内容进入下一天报告。

### 分平台关键词

全局 `keywords` 用于页面展示和兜底。正式采集优先使用 `sourceKeywords`：

```json
{
  "sourceKeywords": {
    "arxiv": ["Agent", "Agentic", "A2A", "MCP", "Tool Calling", "Multi-Agent"],
    "github": ["Agent", "Agentic", "A2A", "MCP", "Workflow", "AI Coding"],
    "xrss": ["A2A", "MCP", "Agentic", "Agent Harness", "Tool Calling"]
  }
}
```

X RSS 不建议使用 `Agent`、`Tool` 这类过泛短词，容易触发公共实例风控，也会带来大量噪声。

## Ubuntu 服务器 Docker 部署

新服务器推荐只安装 Git 和 Docker，Node/npm 依赖由镜像构建处理。

安装基础工具：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
```

安装 Docker：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

退出 SSH 后重新登录，确认权限生效：

```bash
docker ps
```

拉代码：

```bash
git clone https://github.com/lemon7Cy/x_bot_feishu.git
cd x_bot_feishu
```

创建 `.env`：

```bash
nano .env
```

示例：

```env
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
FEISHU_SECRET=

GITHUB_TOKEN=ghp_or_github_pat_xxx

VIDEO_LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
VIDEO_LLM_MODEL=your-model-name
VIDEO_LLM_API_KEY=your-api-key
VIDEO_LLM_TIMEOUT_MS=90000

CONFIG_PATH=/app/config.json
DB_PATH=/app/data/monitor.sqlite
PYTHON_BIN=python3
TWSCRAPE_DB_PATH=/app/data/twscrape/accounts.db
```

保护密钥文件权限：

```bash
chmod 600 .env
```

启动：

```bash
docker compose up -d --build
```

查看状态和日志：

```bash
docker compose ps
docker compose logs -f x-bot-feishu
```

正常日志：

```text
Scheduler started.
WebUI running at http://0.0.0.0:8787
```

浏览器访问：

```text
http://服务器IP:8787
```

如果打不开，检查云厂商安全组或防火墙是否放行 TCP `8787`。建议只允许自己的公网 IP 访问。

更新服务器代码：

```bash
cd ~/x_bot_feishu
git pull
docker compose up -d --build
```

`.env` 由 Docker volume 挂载到 `/app/.env`。程序读取配置时以 `.env` 文件为准，因此在 WebUI 修改 webhook 后会写回 `.env` 并被后续请求读取。

## 常用命令

初始化数据库：

```bash
npm run init-db
```

查看状态：

```bash
npm run status
```

手动采集全部来源：

```bash
npm run ingest
```

手动采集单个来源：

```bash
node src/cli.js ingest --source arxiv
node src/cli.js ingest --source github
node src/cli.js ingest --source xrss
```

预览报告，不发送飞书，也不写入永久去重记录：

```bash
npm run preview
node src/cli.js preview --date 2026-06-11
```

准备报告，会调用 LLM、生成卡片，并写入 `digest_items` 永久去重记录：

```bash
npm run prepare
node src/cli.js prepare --date 2026-06-11
```

发送已准备好的报告，不重新采集、不重新调用 LLM：

```bash
npm run send-prepared
node src/cli.js send-prepared --date 2026-06-11
```

强制重新准备某天报告，适合修改卡片模板后重新测试：

```bash
node src/cli.js prepare --date 2026-06-11 --force
node src/cli.js send-prepared --date 2026-06-11 --force
```

测试飞书 webhook：

```bash
npm run send-test
```

启动内置调度器：

```bash
npm run scheduler
```

启动 WebUI：

```bash
npm run web
```

启动 WebUI + 调度器：

```bash
npm run web:scheduler
```

## 三个平台采集策略

### arXiv

arXiv 使用官方 Atom API。系统按关键词构造查询，过滤发布时间和关键词命中，再标准化入库。

默认策略：

```text
回看 168 小时
适合补漏
论文来源有额外规则评分
```

### GitHub

GitHub 使用 Search API，支持 repositories 和 issues/PRs。建议配置 `GITHUB_TOKEN`，否则容易触发较低限流。

默认策略：

```text
回看 72 小时
star 数高的 repo 加权
无描述、低质量、profile repo 降权
```

### X RSS

X RSS 使用公开 Nitter-like RSS 实例，例如 `xcancel.com`、`nitter.poast.org`、`nitter.privacyredirect.com`。

默认策略：

```text
回看 24 小时
失败只记录错误，不阻断 arXiv/GitHub
适合补充社媒线索，但不作为稳定主来源
```

公共实例经常 403 或 timeout，这是预期风险。

## 数据清洗和入库

所有来源都会被标准化成统一结构：

```text
source
source_type
source_item_id
canonical_url
title
summary
author
published_at
raw_json
```

入库时有两层唯一约束：

```sql
UNIQUE(source, source_item_id)
UNIQUE(canonical_url)
```

重复采集不会重复插入，只会更新已有记录。

之后会写入：

- `item_scores`：规则分、置信度、评分原因。
- `item_matches`：命中的关键词。
- `llm_analyses`：LLM 分析缓存。
- `digest_runs`：日报准备/发送记录。
- `digest_items`：已进入日报的 item，作为永久去重依据。
- `scheduler_runs`：内置调度器运行记录。

## 日报窗口和去重

默认日报窗口是 `previous_natural_day`：

```text
窗口开始时间 = 前一天 00:00 Asia/Shanghai
窗口结束时间 = 前一天 23:59:59 Asia/Shanghai
```

例如：

```text
Prepare: 08:30
Send: 09:00

2026-06-14 08:30 自动准备：
2026-06-13 00:00 - 2026-06-13 23:59 的内容

2026-06-14 09:00 自动推送：
只发送 08:30 已经生成的 prepared report
```

注意：`Send` 阶段不会临时采集、不会临时调用 LLM。如果到推送时间还没有 prepared report，系统会跳过并记录原因。

一旦某条内容进入 prepared report，它会写入 `digest_items`。之后默认永久不再进入后续日报，避免团队连续看到同一条信息。

注意：

```text
preview 不写 digest_items
prepare 写 digest_items
send 只发送 card_json
```

### 推送检查

WebUI 的「推送检查」会输出当前窗口诊断：

```text
当前报告窗口
窗口模式
Prepare / Send 时间
日报是否已生成
日报是否已推送
是否可以准备
是否可以推送
跳过原因
下一步建议
```

常见判断：

```text
not_prepared：还没有 prepared report，需要先准备报告
prepared_not_sent：已生成但未推送，可以发送
already_sent：当前窗口已推送，定时器会跳过
send_error_retryable：上次发送失败，可以重试
prepared_skipped_empty：LLM 没筛出可推送内容
```

测试时可以使用：

```text
标记今日未推送：把当前窗口 sent 改回 prepared，可重发同一份报告
删除日报记录：删除当前窗口 digest_run 和 digest_items，可重新生成
```

## Windows 运行建议

本地测试可以直接开 PowerShell：

```powershell
npm run web:scheduler
```

如果要长期运行，可以用 Windows 任务计划程序：

1. 新建任务。
2. 程序选择 `npm` 或 `npm.cmd`。
3. 参数填写 `run web:scheduler`。
4. 起始位置填写项目目录，例如 `C:\Users\you\x_bot_feishu`。

也可以用 pm2：

```powershell
npm install -g pm2
pm2 start npm --name x_bot_feishu -- run web:scheduler
pm2 logs x_bot_feishu
```

## 安全说明

不要提交以下文件：

- `.env`
- `accounts.db`
- `data/twscrape/accounts.db`
- `data/*.log`
- `.venv/`
- `node_modules/`

`config.json` 和 `data/monitor.sqlite` 是运行态文件，已经从 Git 跟踪中移除。部署新机器时从 `config.example.json` 复制 `config.json`，数据库由 `npm run init-db` 或容器启动自动创建。

如果曾把 GitHub token、飞书 webhook、LLM key 贴到终端命令或聊天中，建议立即在对应平台 revoke/重建。

## 故障排查

### WebUI 保存 webhook 后仍然使用旧 webhook

先更新代码并重建：

```bash
git pull
docker compose up -d --build
```

确认容器读取到了 `.env`：

```bash
docker compose exec -T x-bot-feishu node - <<'NODE'
import { loadEnv } from './src/env.js';
const env = loadEnv(process.cwd());
console.log(env.FEISHU_WEBHOOK_URL ? 'FEISHU_WEBHOOK_URL set' : 'missing');
NODE
```

### 到点没有推送

打开 WebUI 点「推送检查」。常见原因：

```text
not_prepared：Prepare 时间已错过或还没生成，先点「准备报告」
already_sent：当前窗口已经推过，点「标记今日未推送」可重发
prepared_skipped_empty：没有 LLM-approved 内容，降低阈值或等待下一轮采集
send_error_retryable：飞书 webhook/secret 错误，修复后重试
```

命令行查看最近记录：

```bash
docker compose exec -T x-bot-feishu node src/cli.js status
docker compose logs --tail=120 x-bot-feishu
```

### arXiv 测试返回 0

arXiv 24 小时短窗口经常没有新内容，尤其周末。正式采集默认回看 168 小时。建议用 7 天窗口判断 arXiv 是否正常。

### X RSS 403 / 502 / 503

公共 Nitter/RSS 实例不稳定属于预期情况。系统会记录错误但不阻断 GitHub/arXiv 和飞书推送。建议 X RSS 使用更窄关键词，例如 `A2A`、`MCP`、`Agentic`、`Agent Harness`、`Tool Calling`。

## 项目结构

```text
src/cli.js             CLI 入口
src/scheduler.js       内置 collection / prepare / send 调度器
src/ingest.js          采集编排
src/digest.js          preview / prepare / send-prepared
src/llm.js             LLM 批量分析
src/feishu.js          飞书卡片和 webhook
src/db.js              SQLite schema 和查询
src/sourceKeywords.js  分平台关键词选择
src/sources/           arXiv / GitHub / X RSS / Twitter fetchers
web/                   本地 WebUI
scripts/x_fetch.py     实验性 twscrape 桥接脚本
```
