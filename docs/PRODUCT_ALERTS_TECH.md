# AI 产品动态技术文档

本文档说明 `x_bot_feishu` 中 AI 产品动态（Product Alerts）模块的设计、数据表、执行流程、去重策略、调度方式和维护入口。

## 1. 设计目标

AI 产品动态和日报是两条独立流水线。

```text
Daily Digest
- 固定窗口
- Prepare / Send 两阶段
- 汇总技术、论文、开源项目和社媒线索
- 使用 digest_runs / digest_items / llm_analyses

Product Alerts
- 事件型检查
- 有高质量 AI 产品动态才推送
- 没有合格内容就 skipped，不发送飞书
- 使用 product_alert_runs / product_alert_items / product_analyses
```

核心原则：

```text
可以不推，但不能乱推。
查重走数据库，不用 LLM 做历史查重。
产品动态 LLM prompt 和日报 LLM prompt 分开，避免判断标准互相污染。
```

## 2. 配置项

配置位于 `config.json` / `config.example.json`。

```json
{
  "productIntel": {
    "enabled": true,
    "keywords": [
      "AI product launch",
      "AI coding tool",
      "agent platform",
      "MCP support",
      "AI workflow",
      "AI browser agent",
      "Product Hunt AI"
    ]
  },
  "productAlerts": {
    "enabled": true,
    "intervalMinutes": 180,
    "lookbackHours": 24,
    "maxItemsPerRun": 2,
    "llmMaxCandidates": 8,
    "minRating": "B",
    "minConfidence": "medium",
    "minRelevance": 80,
    "requireEvidence": true,
    "sendMode": "batch"
  }
}
```

字段说明：

- `productIntel.enabled`：是否启用 AI 产品动态关键词扩展。
- `productIntel.keywords`：产品动态关键词，会合并进各来源采集关键词。
- `productAlerts.enabled`：是否启用产品动态自动检查。
- `productAlerts.intervalMinutes`：自动检查间隔，默认 180 分钟。
- `productAlerts.lookbackHours`：每次检查回看窗口，默认 24 小时。
- `productAlerts.maxItemsPerRun`：每次最多推送条数，默认 2。
- `productAlerts.llmMaxCandidates`：每次最多送入产品 LLM 分析的候选数，默认 8。
- `productAlerts.minRating`：最低 LLM 评级，默认 B。
- `productAlerts.minConfidence`：最低规则置信度，默认 medium。
- `productAlerts.minRelevance`：最低 LLM relevance，默认 80。
- `productAlerts.requireEvidence`：是否要求 LLM 返回 evidence，默认 true。

## 3. 数据库表

### product_analyses

保存产品动态专用 LLM 分析，和日报的 `llm_analyses` 分离。

关键字段：

```text
item_id
product_name
rating
relevance
summary
why_it_matters
launch_signal
product_url
evidence_json
reason
tags_json
model
analyzed_at
raw_json
```

用途：

- 缓存产品 LLM 结果，避免重复调用 LLM。
- 保留产品名、产品链接、发布信号和 evidence。
- 支持后续 WebUI 状态展示和质量诊断。

### product_alert_runs

记录每次产品动态检查/推送。

关键字段：

```text
id
window_start
window_end
status
item_count
card_json
sent_at
error
created_at
```

状态：

```text
sent      已发送
skipped   没有合格内容，未发送
error     推送失败
```

### product_alert_items

记录已经作为产品动态推送过的 item。

关键字段：

```text
alert_run_id
item_id
product_key
sent_at
```

唯一索引：

```sql
CREATE UNIQUE INDEX idx_product_alert_items_item_id
ON product_alert_items(item_id);

CREATE UNIQUE INDEX idx_product_alert_items_product_key
ON product_alert_items(product_key)
WHERE product_key IS NOT NULL;
```

作用：

- 同一个 item 不会作为产品动态重复推送。
- 同一个产品名 + URL 组合不会重复推送。

## 4. 执行流程

### 4.1 Collection

仍然复用现有采集链路：

```text
GitHub / arXiv / X RSS
-> items
-> item_scores
-> item_matches
```

`productIntel.keywords` 会通过 `src/sourceKeywords.js` 合并到来源关键词中。

### 4.2 Product Scanner

入口：`queryProductCandidates()`，位于 `src/db.js`。

查询条件：

```text
published_at 在产品动态窗口内
item_scores.confidence >= productAlerts.minConfidence
未存在于 product_alert_items
命中产品信号或产品关键词
按规则分和发布时间排序
LIMIT productAlerts.llmMaxCandidates
```

产品信号包括：

```text
product:*
AI product
AI coding
agent platform
MCP support
Product Hunt
launch
introducing
now supports
```

### 4.3 Product LLM

入口：`src/productAlerts.js`。

产品 LLM 使用独立 prompt，判断标准：

```text
必须有明确产品名、链接、发布/更新/能力支持证据，才能 B 以上。
纯营销口号、泛泛趋势观点、币圈/空投/免费领取/Token 项目评为 Noise 或 C。
只能依据输入，不编造融资、用户数、性能、公司背景或功能。
evidence 必须来自输入原文。
```

输出结构：

```json
{
  "item_id": 123,
  "product_name": "MCP Studio",
  "rating": "B",
  "relevance": 90,
  "summary": "...",
  "why_it_matters": "...",
  "launch_signal": "launch",
  "product_url": "https://...",
  "evidence": ["..."],
  "reason": "...",
  "tags": ["MCP", "developer-tools"]
}
```

### 4.4 Product Filter

通过条件：

```text
rating >= productAlerts.minRating
relevance >= productAlerts.minRelevance
如果 requireEvidence=true，则必须有 evidence
```

当前默认：

```text
rating >= B
relevance >= 80
必须有 evidence
规则 confidence >= medium
```

因此低规则分或证据不足的内容不会推送。

### 4.5 Product Alert Card

产品动态卡片标题：

```text
AI 产品动态 <digest.reportTitleSuffix> | MM/DD HH:mm
```

例如：

```text
AI 产品动态 星元枢算 Bot | 06/13 19:15
```

内容字段：

```text
产品名 / 链接
摘要
重点
信号
来源
时间
规则分
```

## 5. 调度方式

产品动态不是固定时间推送，而是按间隔检查。

配置：

```json
"intervalMinutes": 180
```

含义：

```text
服务器 scheduler 运行时，每 3 小时检查一次最近 24 小时产品候选。
有合格内容才发送飞书。
没有合格内容则记录 skipped，不发送飞书。
```

调度入口：`src/scheduler.js`

```text
runLocked(db, state, 'product-alert', 'product_alert', () => sendProductAlerts(...))
```

## 6. CLI

预览产品动态：

```bash
node src/cli.js product-preview --lookback-hours 24
```

发送产品动态：

```bash
node src/cli.js product-send --lookback-hours 24
```

通过 npm script：

```bash
npm run product-preview
npm run product-send
```

Docker 中执行：

```bash
docker compose exec -T x-bot-feishu node src/cli.js product-preview --lookback-hours 24
docker compose exec -T x-bot-feishu node src/cli.js product-send --lookback-hours 24
```

## 7. WebUI

WebUI 中新增 `AI 产品动态` 区域：

```text
启用 AI 产品/工具动态监控
产品关键词
检查间隔
回看窗口
每次最多推送
最低评级
预览产品动态
推送产品动态
```

建议测试顺序：

```text
1. 预览产品动态
2. 检查 productResult 中的候选、summary、why_it_matters、signal
3. 确认质量后再手动推送产品动态
4. 上服务器后让 scheduler 自动每 3 小时检查
```

## 8. 故障排查

### 没有推送

这是正常情况。产品动态允许 skipped。

常见原因：

```text
没有 medium/high 规则分候选
LLM rating < B
relevance < 80
缺少 evidence
已经在 product_alert_items 中推送过
```

### 推送内容太少

这是预期。`maxItemsPerRun` 是上限，不是保底。

当前策略是：

```text
可以不推，但不能乱推。
```

### LLM 超时

减少：

```json
"llmMaxCandidates": 4
```

或增大：

```env
VIDEO_LLM_TIMEOUT_MS=120000
```

### 产品动态误推垃圾

优先调整：

```json
"minRating": "A",
"minRelevance": 85,
"minConfidence": "high"
```

或加入负向词：

```json
"blockedKeywords": ["airdrop", "giveaway", "token sale", "presale"]
```

## 9. 主要代码入口

```text
src/productAlerts.js   产品动态主流程、LLM prompt、卡片生成
src/db.js              产品动态表结构、候选查询、保存 run/items/analysis
src/scheduler.js       自动检查 product-alert
src/config.js          productIntel / productAlerts 默认配置
src/settingsStore.js   WebUI 保存 product 配置
src/sourceKeywords.js  合并产品关键词到来源关键词
src/scoring.js         产品信号加分和垃圾信号降权
src/web.js             /api/product/preview 和 /api/product/send
web/index.html         产品动态配置区
web/app.js             产品动态 WebUI 交互
```

## 10. 后续可扩展方向

- 接入 Product Hunt。
- 接入 Hacker News `Show HN` / `Launch HN`。
- 接入官方博客 RSS / changelog。
- 支持产品动态固定时间模式，例如 `11:00, 16:00, 21:00`。
- 增加产品级去重规则，例如抽取官网域名和产品名。
- 增加管理员告警：连续 product-alert error、LLM 超时、飞书发送失败。
