import { authoritySignal } from './authority.js';

export async function analyzeDigestItems(db, items, config, env, deps, options = {}) {
  const trace = {
    enabled: Boolean(env.VIDEO_LLM_BASE_URL && env.VIDEO_LLM_MODEL && env.VIDEO_LLM_API_KEY),
    model: env.VIDEO_LLM_MODEL || null,
    candidates: items.length,
    analyzed: 0,
    cached: 0,
    retryableErrors: 0,
    ratings: {},
    batches: [],
    events: []
  };
  if (!env.VIDEO_LLM_BASE_URL || !env.VIDEO_LLM_MODEL || !env.VIDEO_LLM_API_KEY) {
    trace.events.push({ level: 'warn', message: 'LLM env is not configured; skipped analysis.' });
    return { items: items.map((item) => ({ ...item, llmAnalysis: null })), trace };
  }
  const max = config.digest?.llmMaxCandidates || 20;
  const batchSize = config.digest?.llmBatchSize || 4;
  const out = [];
  const pending = [];
  for (const item of items.slice(0, max)) {
    const cached = deps.getItemAnalysis(db, item.id, env.VIDEO_LLM_MODEL);
    if (cached && !isRetryableAnalysis(cached) && !isStaleAnalysis(cached)) {
      trace.cached += 1;
      addRating(trace, cached.rating);
      trace.events.push(eventFor(item, cached, 'cached'));
      out.push({ ...item, llmAnalysis: cached });
      continue;
    }
    pending.push(item);
  }
  options.onProgress?.({ stage: 'llm_plan', message: `LLM candidates=${items.length}, cached=${trace.cached}, pending=${pending.length}` });

  const batches = makeBatchesBySource(pending, batchSize);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchInfo = { index: index + 1, total: batches.length, source: batch[0]?.source, size: batch.length, itemIds: batch.map((item) => item.id) };
    options.onProgress?.({ stage: 'llm_batch_start', message: `正在分析第 ${batchInfo.index}/${batchInfo.total} 批：${batchInfo.source}，${batchInfo.size} 条`, batch: batchInfo });
    console.log(`[llm] batch ${batchInfo.index}/${batchInfo.total} start source=${batchInfo.source} size=${batchInfo.size} itemIds=${batchInfo.itemIds.join(',')}`);
    trace.batches.push({ source: batch[0]?.source, size: batch.length, itemIds: batch.map((item) => item.id), status: 'running' });
    const batchTrace = trace.batches[trace.batches.length - 1];
    const analyses = await analyzeItemBatchWithRetry(batch, env, batchInfo, options).catch((error) => {
      batchTrace.status = 'error';
      batchTrace.error = error.message;
      console.error(`[llm] batch ${batchInfo.index}/${batchInfo.total} error ${error.message}`);
      options.onProgress?.({ stage: 'llm_batch_error', message: `第 ${batchInfo.index}/${batchInfo.total} 批失败：${error.message}`, batch: batchInfo });
      return new Map(batch.map((item) => [item.id, retryAnalysis(error.message)]));
    });

    if (batchTrace.status !== 'error') batchTrace.status = 'success';
    if (batchTrace.status === 'success') {
      console.log(`[llm] batch ${batchInfo.index}/${batchInfo.total} success source=${batchInfo.source}`);
      options.onProgress?.({ stage: 'llm_batch_success', message: `第 ${batchInfo.index}/${batchInfo.total} 批完成：${batchInfo.source}`, batch: batchInfo });
    }
    for (const item of batch) {
      const analysis = analyses.get(item.id) || retryAnalysis('LLM batch did not return this item.');
      if (analysis.rating === 'Retry') {
        trace.retryableErrors += 1;
        trace.events.push({ level: 'error', itemId: item.id, source: item.source, title: item.title, message: analysis.reason });
        out.push({ ...item, llmAnalysis: analysis });
        continue;
      }
      deps.saveItemAnalysis(db, item.id, env.VIDEO_LLM_MODEL, analysis);
      const saved = deps.getItemAnalysis(db, item.id, env.VIDEO_LLM_MODEL);
      trace.analyzed += 1;
      addRating(trace, saved.rating);
      trace.events.push(eventFor(item, saved, 'fresh-batch'));
      out.push({ ...item, llmAnalysis: saved });
    }
  }
  const finalItems = out.concat(items.slice(max).map((item) => ({ ...item, llmAnalysis: null })));
  return { items: finalItems, trace };
}

async function analyzeItemBatchWithRetry(items, env, batchInfo, options = {}) {
  const retries = Math.max(0, Number(env.VIDEO_LLM_RETRIES ?? 2));
  const baseDelay = Math.max(0, Number(env.VIDEO_LLM_RETRY_DELAY_MS || 3000));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await analyzeItemBatch(items, env);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isTransientLlmError(error)) break;
      const delayMs = baseDelay * (attempt + 1);
      console.warn(`[llm] batch ${batchInfo.index}/${batchInfo.total} retry ${attempt + 1}/${retries} in ${delayMs}ms: ${error.message}`);
      options.onProgress?.({
        stage: 'llm_batch_retry',
        message: `第 ${batchInfo.index}/${batchInfo.total} 批失败，${Math.round(delayMs / 1000)} 秒后重试 ${attempt + 1}/${retries}：${error.message}`,
        batch: { ...batchInfo, attempt: attempt + 1, retries, delayMs }
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function isTransientLlmError(error) {
  const status = Number(error.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return /timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(error.message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBatchesBySource(items, batchSize) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.source)) groups.set(item.source, []);
    groups.get(item.source).push(item);
  }
  const batches = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += batchSize) batches.push(group.slice(i, i + batchSize));
  }
  return batches;
}

function retryAnalysis(reason) {
  return { rating: 'Retry', relevance: 0, summary: 'LLM 分析失败，等待下次重试。', factual_summary: 'LLM 分析失败，等待下次重试。', innovation: '', strengths: '', reason, evidence: [], uncertainty: reason, hallucination_risk: 'high', tags: ['llm_error'] };
}

function addRating(trace, rating) {
  trace.ratings[rating] = (trace.ratings[rating] || 0) + 1;
}

function eventFor(item, analysis, mode) {
  return {
    level: ['S', 'A', 'B'].includes(analysis.rating) ? 'pass' : 'drop',
    mode,
    itemId: item.id,
    source: item.source,
    title: item.title,
    rating: analysis.rating,
    relevance: analysis.relevance,
    hallucinationRisk: analysis.hallucination_risk || analysis.hallucinationRisk || rawAnalysis(analysis).hallucination_risk,
    reason: analysis.reason || analysis.summary || ''
  };
}

function isRetryableAnalysis(analysis) {
  return analysis.rating === 'C' && /LLM request timed out|LLM 分析失败|llm_error/i.test(`${analysis.summary || ''} ${analysis.reason || ''} ${analysis.tags_json || ''}`);
}

function isStaleAnalysis(analysis) {
  const raw = rawAnalysis(analysis);
  return !['evidence-v1', 'evidence-v2-product'].includes(raw.version) || !Array.isArray(raw.evidence);
}

async function analyzeItemBatch(items, env) {
  const controller = new AbortController();
  const timeoutMs = Number(env.VIDEO_LLM_TIMEOUT_MS || 90000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${env.VIDEO_LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${env.VIDEO_LLM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: env.VIDEO_LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: batchPrompt(items) }
      ]
    })
  }).catch((error) => {
    if (error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw error;
  }).finally(() => clearTimeout(timer));
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`LLM request failed ${response.status}: ${text.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  const data = JSON.parse(text);
  const parsed = parseJson(data.choices?.[0]?.message?.content || '[]');
  const rows = Array.isArray(parsed) ? parsed : parsed.items || parsed.analyses || [];
  const map = new Map();
  for (const row of rows) {
    const itemId = Number(row.item_id || row.itemId || row.id);
    if (!itemId) continue;
    map.set(itemId, normalizeAnalysis(row));
  }
  return map;
}

function systemPrompt() {
  return `你是 AI Agent 技术与 AI 产品情报分析员。输入会按平台分批给出候选内容。逐条判断是否值得进入内部日报。日报不是 AI 产品动态流，信息情报（论文研究、开源项目、协议/框架/工程实践）应占主要比重，产品动态只收录有明确证据的重要发布或能力更新。

重点关注 Agent Harness、A2A、Agentic、多智能体、工具调用、协议、框架、科研论文、高质量开源项目，以及值得团队关注的 AI 产品/工具动态。

AI 产品动态包括：AI Coding 工具、Agent 平台、MCP/A2A 支持、AI Workflow/Automation、Browser Agent、企业 AI 工具、Product Hunt/Hacker News/官方博客上的真实产品发布或重要功能更新。

防幻觉硬规则：
1. 只能基于输入字段判断，不要补充输入中不存在的事实。
2. 不要声称开源、SOTA、融资、发布、benchmark、性能提升、生产可用，除非输入明确出现。
3. 如果输入信息不足，降低 rating，并在 uncertainty 中说明。
4. X RSS 若没有技术细节、链接、代码、论文或明确产品信息，默认 C 或 Noise。
5. factual_summary 必须是事实复述；why_it_matters 才能写价值判断。
6. evidence 必须是输入 title/summary/raw 中的原文短句，不能编造。
7. 所有 B 及以上评级必须至少有 1 条 evidence；没有证据时 rating 最高 C。
8. AI 产品类内容必须有明确产品名、链接、发布/更新/支持能力证据；纯营销口号、空投、免费领取、币圈项目、泛泛趋势观点应评为 Noise 或 C。

分类标准：research=论文/研究结论，opensource=开源项目/协议/框架/工程实现，product=真实 AI 产品发布或重要功能更新，social=社媒观点/事件线索，noise=噪声。除非有明确产品名、链接和能力/发布证据，否则不要把内容判为 product。

输出严格 JSON 数组，不要 Markdown。数组每项字段：item_id, category(research/opensource/product/social/noise), rating(S/A/B/C/Noise), relevance(0-100), factual_summary(仅事实复述), why_it_matters(为什么值得关注), innovation(输入明确支持的创新点或关键变化), strengths(值得关注的地方), evidence(1-3条原文短句数组), uncertainty(缺失信息或不确定性), hallucination_risk(low/medium/high), reason(入选或过滤理由), tags(数组)。必须为每个输入 item 返回一条结果。`;
}

function batchPrompt(items) {
  const source = items[0]?.source || 'unknown';
  return JSON.stringify({
    source,
    instruction: '请逐条分析，不要合并项目；长文本已被截断，优先依据标题、摘要、来源和链接判断技术价值。',
    items: items.map(compactItem)
  }, null, 2);
}

function compactItem(item) {
  const authority = authoritySignal(item);
  return {
    item_id: item.id,
    source: item.source,
    platform: platformName(item.source),
    type: item.source_type,
    title: truncateText(item.title, 220),
    summary: truncateText(item.summary, summaryLimit(item.source)),
    author: item.author,
    authority,
    url: item.canonical_url,
    score: item.score,
    confidence: item.confidence,
    matched_keywords: item.matchedKeywords || [],
    raw: compactRaw(safeJson(item.raw_json), item.source)
  };
}

function platformName(source) {
  return { arxiv: 'arXiv', github: 'GitHub', xrss: 'X RSS', twitter: 'X/Twitter' }[source] || source || 'unknown';
}

function summaryLimit(source) {
  if (source === 'arxiv') return 1200;
  if (source === 'github') return 700;
  return 500;
}

function compactRaw(raw, source) {
  if (source === 'github') return { stars: raw.stars, repo: raw.repo, keyword: raw.keyword };
  if (source === 'xrss') return { keyword: raw.keyword, instance: raw.instance };
  if (source === 'arxiv') return { authors: raw.authors, arxivUrl: raw.arxivUrl };
  return raw;
}

function truncateText(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function parseJson(content) {
  const trimmed = String(content).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  try { return JSON.parse(trimmed); } catch {}

  const arrayJson = extractBalancedJson(trimmed, '[', ']');
  if (arrayJson) return JSON.parse(arrayJson);
  const objectJson = extractBalancedJson(trimmed, '{', '}');
  if (objectJson) return JSON.parse(objectJson);
  throw new Error(`LLM returned non-JSON content: ${trimmed.slice(0, 300)}`);
}

function extractBalancedJson(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeAnalysis(value) {
  const rating = ['S', 'A', 'B', 'C', 'Noise'].includes(value.rating) ? value.rating : 'C';
  const evidence = Array.isArray(value.evidence) ? value.evidence.map((item) => String(item).slice(0, 180)).filter(Boolean).slice(0, 3) : [];
  const hallucinationRisk = ['low', 'medium', 'high'].includes(value.hallucination_risk) ? value.hallucination_risk : 'medium';
  const factualSummary = String(value.factual_summary || value.summary || '').slice(0, 500);
  const whyItMatters = String(value.why_it_matters || value.strengths || '').slice(0, 500);
  return {
    version: 'evidence-v2-product',
    category: normalizeCategory(value.category),
    rating,
    relevance: Math.max(0, Math.min(100, Number(value.relevance || 0))),
    summary: factualSummary,
    factual_summary: factualSummary,
    why_it_matters: whyItMatters,
    innovation: String(value.innovation || '').slice(0, 500),
    strengths: String(value.strengths || whyItMatters).slice(0, 500),
    evidence,
    uncertainty: String(value.uncertainty || '').slice(0, 500),
    hallucination_risk: hallucinationRisk,
    reason: String(value.reason || '').slice(0, 500),
    tags: Array.isArray(value.tags) ? value.tags.map(String).slice(0, 8) : []
  };
}

function normalizeCategory(category) {
  const value = String(category || '').toLowerCase();
  if (['research', 'opensource', 'product', 'social', 'noise'].includes(value)) return value;
  return 'social';
}

function rawAnalysis(analysis) {
  if (!analysis?.raw_json) return analysis || {};
  try { return JSON.parse(analysis.raw_json); } catch { return analysis || {}; }
}

function safeJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
