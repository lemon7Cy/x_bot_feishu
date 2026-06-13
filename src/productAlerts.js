import { getProductAnalysis, queryProductCandidates, saveProductAlertRun, saveProductAnalysis } from './db.js';
import { sendFeishu } from './feishu.js';
import { truncate } from './utils.js';

const RANK = { S: 5, A: 4, B: 3, C: 2, Noise: 1, Retry: 0 };

export async function previewProductAlerts(db, config, env, options = {}) {
  return buildProductAlertResult(db, config, env, { ...options, dryRun: true });
}

export async function sendProductAlerts(db, config, env, options = {}) {
  const result = await buildProductAlertResult(db, config, env, options);
  if (result.items.length === 0) {
    if (!options.dryRun) saveProductAlertRun(db, result.window, 'skipped', [], result.card, 'No product alerts passed filters.');
    return { ...result, skipped: true, sent: false, reason: 'No product alerts passed filters.' };
  }
  if (options.dryRun) return { ...result, dryRun: true };
  try {
    await sendFeishu(result.card, env);
    const alertRunId = saveProductAlertRun(db, result.window, 'sent', result.items, result.card);
    return { ...result, sent: true, alertRunId, itemCount: result.items.length };
  } catch (error) {
    saveProductAlertRun(db, result.window, 'error', result.items, result.card, error.message);
    throw error;
  }
}

async function buildProductAlertResult(db, config, env, options = {}) {
  const window = productWindow(config, options);
  const candidates = queryProductCandidates(db, window, config).map((item) => ({ ...item, productAnalysis: null }));
  const analyzed = await analyzeProductCandidates(db, candidates, config, env);
  const items = limitProductItems(filterProductItems(analyzed, config), config);
  const card = buildProductAlertCard(items, config, window);
  return { mode: 'product-alert', window, candidateCount: candidates.length, analyzedCount: analyzed.length, itemCount: items.length, items, card };
}

function productWindow(config, options) {
  const until = options.until ? new Date(options.until) : new Date();
  const hours = Number(options.lookbackHours || config.productAlerts?.lookbackHours || 24);
  const since = options.since ? new Date(options.since) : new Date(until.getTime() - hours * 60 * 60 * 1000);
  return { since, until, timezone: config.timezone || 'Asia/Shanghai' };
}

async function analyzeProductCandidates(db, candidates, config, env) {
  if (!env.VIDEO_LLM_BASE_URL || !env.VIDEO_LLM_MODEL || !env.VIDEO_LLM_API_KEY) return candidates;
  const out = [];
  const pending = [];
  for (const item of candidates) {
    const cached = getProductAnalysis(db, item.id, env.VIDEO_LLM_MODEL);
    if (cached) {
      out.push({ ...item, productAnalysis: cached });
      continue;
    }
    pending.push(item);
  }
  const batchSize = Number(config.productAlerts?.llmBatchSize || 6);
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const analyses = await analyzeProductBatch(batch, env).catch((error) => new Map(batch.map((item) => [item.id, retryAnalysis(error.message)])));
    for (const item of batch) {
      const analysis = analyses.get(item.id) || retryAnalysis('LLM product batch did not return this item.');
      if (analysis.rating !== 'Retry') saveProductAnalysis(db, item.id, env.VIDEO_LLM_MODEL, analysis);
      out.push({ ...item, productAnalysis: analysis.rating === 'Retry' ? analysis : getProductAnalysis(db, item.id, env.VIDEO_LLM_MODEL) });
    }
  }
  return out;
}

async function analyzeProductBatch(items, env) {
  const controller = new AbortController();
  const timeoutMs = Number(env.VIDEO_LLM_TIMEOUT_MS || 90000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${env.VIDEO_LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: { Authorization: `Bearer ${env.VIDEO_LLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.VIDEO_LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: productSystemPrompt() },
        { role: 'user', content: JSON.stringify({ instruction: '逐条分析，必须为每个 item 返回一条结果。', items: items.map(compactProductItem) }, null, 2) }
      ]
    })
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw error;
  }).finally(() => clearTimeout(timer));
  const text = await response.text();
  if (!response.ok) throw new Error(`LLM request failed ${response.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const parsed = parseJson(data.choices?.[0]?.message?.content || '[]');
  const rows = Array.isArray(parsed) ? parsed : parsed.items || parsed.analyses || [parsed];
  const map = new Map();
  for (const row of rows) {
    const itemId = Number(row.item_id || row.itemId || row.id);
    if (itemId) map.set(itemId, normalizeProductAnalysis(row));
  }
  return map;
}

function productSystemPrompt() {
  return `你是 AI 产品情报分析员。判断输入是否值得作为“AI 产品动态”单独推送给团队。重点关注 AI Coding 工具、Agent 平台、MCP/A2A 支持、AI Workflow/Automation、Browser Agent、企业 AI 工具、Product Hunt/Hacker News/官方博客里的真实产品发布或重要功能更新。

硬规则：
1. 必须有明确产品名、链接、发布/更新/支持能力证据，才能 rating B 以上。
2. 纯营销口号、空泛趋势观点、币圈/空投/免费领取/Token 项目评为 Noise 或 C。
3. 只能依据输入，不要编造融资、用户数、性能、公司背景或功能。
4. evidence 必须来自输入原文短句。

输出严格 JSON 数组，不要 Markdown。每项字段：item_id, product_name, rating(S/A/B/C/Noise), relevance(0-100), summary(中文事实摘要), why_it_matters(为什么值得关注), launch_signal(launch/update/mcp_support/ai_coding/agent_platform/workflow/browser_agent/other), product_url, evidence(1-3条数组), reason, tags(数组)。`;
}

function compactProductItem(item) {
  return {
    item_id: item.id,
    source: item.source,
    type: item.source_type,
    title: truncate(item.title, 260),
    summary: truncate(item.summary, 900),
    author: item.author,
    url: item.canonical_url,
    score: item.score,
    confidence: item.confidence,
    reasons: safeJson(item.reasons_json),
    raw: compactRaw(safeJson(item.raw_json))
  };
}

function compactRaw(raw) {
  return { keyword: raw.keyword, repo: raw.repo, stars: raw.stars, instance: raw.instance };
}

function filterProductItems(items, config) {
  const min = config.productAlerts?.minRating || 'B';
  const minRelevance = Number(config.productAlerts?.minRelevance || 80);
  const requireEvidence = config.productAlerts?.requireEvidence !== false;
  return items
    .filter((item) => {
      if (!item.productAnalysis || RANK[item.productAnalysis.rating] < RANK[min]) return false;
      if (Number(item.productAnalysis.relevance || 0) < minRelevance) return false;
      if (requireEvidence && productEvidence(item.productAnalysis).length === 0) return false;
      return true;
    })
    .sort((a, b) => (RANK[b.productAnalysis.rating] - RANK[a.productAnalysis.rating]) || Number(b.productAnalysis.relevance || 0) - Number(a.productAnalysis.relevance || 0));
}

function productEvidence(analysis) {
  if (Array.isArray(analysis.evidence)) return analysis.evidence;
  if (analysis.evidence_json) {
    try { return JSON.parse(analysis.evidence_json); } catch { return []; }
  }
  if (analysis.raw_json) {
    try { return JSON.parse(analysis.raw_json).evidence || []; } catch { return []; }
  }
  return [];
}

function limitProductItems(items, config) {
  const max = Number(config.productAlerts?.maxItemsPerRun || 3);
  return items.slice(0, Math.max(1, max));
}

function buildProductAlertCard(items, config, window) {
  const elements = [{ tag: 'markdown', content: `**AI 产品动态**\n窗口 ${formatCn(window.since, config.timezone)} - ${formatCn(window.until, config.timezone)}\n条目 ${items.length}` }];
  if (items.length === 0) elements.push({ tag: 'markdown', content: '当前窗口没有达到推送阈值的 AI 产品动态。' });
  for (const item of items) {
    const analysis = rawProductAnalysis(item.productAnalysis);
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `[${escapeMd(analysis.product_name || item.title)}](${analysis.product_url || item.canonical_url})\n${tag('摘要')} ${escapeMd(analysis.summary || item.productAnalysis.summary)}\n${tag('重点')} ${escapeMd(analysis.why_it_matters || item.productAnalysis.why_it_matters || item.productAnalysis.reason)}\n${tag('信号')} ${escapeMd(analysis.launch_signal || item.productAnalysis.launch_signal || '-')}\n${tag('来源')} ${escapeMd(item.author || item.source)} ${tag('时间')} ${formatCn(item.published_at, config.timezone)} ${tag('规则分')} ${item.confidence} ${item.score}` });
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `Window UTC: ${window.since.toISOString()} - ${window.until.toISOString()}` }] });
  return { msg_type: 'interactive', card: { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: productAlertTitle(config) }, template: 'green' }, elements } };
}

function productAlertTitle(config) {
  const base = config.productAlerts?.reportTitle || 'AI 产品动态';
  const suffix = config.digest?.reportTitleSuffix ? ` ${config.digest.reportTitleSuffix}` : '';
  return `${base}${suffix} | ${formatCn(new Date(), config.timezone)}`;
}

function normalizeProductAnalysis(value) {
  const rating = ['S', 'A', 'B', 'C', 'Noise'].includes(value.rating) ? value.rating : 'C';
  return {
    version: 'product-v1',
    product_name: String(value.product_name || '').slice(0, 160),
    rating,
    relevance: Math.max(0, Math.min(100, Number(value.relevance || 0))),
    summary: String(value.summary || '').slice(0, 500),
    why_it_matters: String(value.why_it_matters || '').slice(0, 500),
    launch_signal: String(value.launch_signal || 'other').slice(0, 80),
    product_url: String(value.product_url || '').slice(0, 500),
    evidence: Array.isArray(value.evidence) ? value.evidence.map(String).slice(0, 3) : [],
    reason: String(value.reason || '').slice(0, 500),
    tags: Array.isArray(value.tags) ? value.tags.map(String).slice(0, 8) : []
  };
}

function retryAnalysis(reason) {
  return { rating: 'Retry', relevance: 0, summary: '产品动态分析失败。', why_it_matters: '', reason, tags: ['llm_error'] };
}

function parseJson(content) {
  const trimmed = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON content: ${trimmed.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

function rawProductAnalysis(analysis) {
  if (!analysis?.raw_json) return analysis || {};
  try { return JSON.parse(analysis.raw_json); } catch { return analysis || {}; }
}

function safeJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function formatCn(value, timezone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone || 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function tag(text) {
  return `<text_tag color="blue">${escapeMd(text)}</text_tag>`;
}

function escapeMd(text) {
  return String(text || '').replace(/[<>—]/g, (char) => (char === '<' ? '&lt;' : char === '>' ? '&gt;' : '-'));
}
