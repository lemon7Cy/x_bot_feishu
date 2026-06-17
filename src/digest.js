import { attachAnalyses, getDigestRun, getItemAnalysis, getPreparedDigestRun, markDigestSendError, markDigestSent, queryDigestItems, saveItemAnalysis, savePreparedDigestRun, saveSkippedDigestRun } from './db.js';
import { buildDigestCard, sendFeishu } from './feishu.js';
import { analyzeDigestItems } from './llm.js';
import { digestWindow, isRollingPrepareWindow } from './time.js';

export async function runDigest(db, config, env, options = {}) {
  if (options.dryRun) return previewDigest(db, config, env, options);
  if (options.prepareOnly) return prepareDigest(db, config, env, options);
  const prepared = await prepareDigest(db, config, env, options);
  if (prepared.skipped) return prepared;
  return sendPreparedDigest(db, config, env, options);
}

export async function previewDigest(db, config, env, options = {}) {
  return buildDigestResult(db, config, env, { ...options, dryRun: true, excludeDigested: options.includeDigested === true ? false : true });
}

export async function prepareDigest(db, config, env, options = {}) {
  const window = digestWindow(config, options.date);
  const existing = getDigestRun(db, window);
  const sendDueAt = options.sendDueAt || sendDueAtForWindow(config, window);
  if (existing?.status === 'sent' && !options.force) return { prepared: false, skipped: true, reason: 'digest already sent', window, itemCount: existing.item_count };
  if (existing?.status === 'prepared' && !options.force) return { prepared: true, skipped: true, reason: 'digest already prepared', window, digestRunId: existing.id, itemCount: existing.item_count };
  const result = await buildDigestResult(db, config, env, { ...options, excludeDigested: true, ignoreDigestRunId: existing?.id });
  if (result.items.length === 0 && config.digest?.preventEmptySend !== false) {
    const reason = skippedReason(result);
    const id = saveSkippedDigestRun(db, result.window, result.card, reason);
    return { ...result, prepared: false, skipped: true, reason, digestRunId: id, itemCount: 0 };
  }
  const id = savePreparedDigestRun(db, result.window, result.items, result.card, {
    preparedBy: options.preparedBy || 'manual',
    sendDueAt
  });
  return { ...result, prepared: true, digestRunId: id, itemCount: result.items.length };
}

function sendDueAtForWindow(config, window) {
  const sendTime = config.scheduler?.send?.time || `${String(config.digest?.sendHour || 9).padStart(2, '0')}:00`;
  if (window.timezone !== 'Asia/Shanghai') return null;
  if (isRollingPrepareWindow(config)) return new Date(`${window.date}T${sendTime}:00+08:00`).toISOString();
  return new Date(`${nextDate(window.date)}T${sendTime}:00+08:00`).toISOString();
}

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export async function sendPreparedDigest(db, config, env, options = {}) {
  const window = digestWindow(config, options.date);
  const existing = getDigestRun(db, window);
  if (existing?.status === 'sent' && !options.force) {
    return { skipped: true, reason: 'digest already sent', window, itemCount: existing.item_count };
  }
  const prepared = getPreparedDigestRun(db, window);
  if (!prepared || !prepared.card_json) return { sent: false, skipped: true, reason: 'No prepared digest found.', window, itemCount: 0 };
  try {
    await sendFeishu(JSON.parse(prepared.card_json), env);
    markDigestSent(db, prepared.id);
    return { sent: true, window, digestRunId: prepared.id, itemCount: prepared.item_count };
  } catch (error) {
    markDigestSendError(db, prepared.id, error.message);
    throw error;
  }
}

async function buildDigestResult(db, config, env, options = {}) {
  const window = digestWindow(config, options.date);
  const candidates = queryDigestItems(db, window, config, { excludeDigested: options.excludeDigested !== false, ignoreDigestRunId: options.ignoreDigestRunId }).map((item) => ({
    ...item,
    matchedKeywords: extractKeywords(item.reasons_json)
  }));
  const selectedCandidates = selectLlmCandidates(candidates, config);
  const analysisResult = config.digest?.useLlm === false
    ? attachAnalyses(db, selectedCandidates)
    : await analyzeDigestItems(db, selectedCandidates, config, env, { getItemAnalysis, saveItemAnalysis }, { onProgress: options.onProgress });
  const analyzed = Array.isArray(analysisResult) ? analysisResult : analysisResult.items;
  const llmTrace = Array.isArray(analysisResult) ? { enabled: false, candidates: selectedCandidates.length } : analysisResult.trace;
  const filterTrace = buildFilterTrace(analyzed, config);
  const items = limitDigestItems(filterTrace.items, config);
  const card = buildDigestCard(items, config, window);
  return { dryRun: Boolean(options.dryRun), window, candidateCount: candidates.length, selectedCandidateCount: selectedCandidates.length, llmTrace, filterTrace: summarizeFilterTrace(filterTrace), items, card };
}

function skippedReason(result) {
  const filter = result.filterTrace || {};
  const llm = result.llmTrace || {};
  return `No LLM-approved items. candidates=${result.candidateCount}, selected=${result.selectedCandidateCount}, analyzed=${llm.analyzed || 0}, cached=${llm.cached || 0}, ratings=${JSON.stringify(llm.ratings || {})}, filtered=${JSON.stringify(filter.dropped || {})}`;
}

function selectLlmCandidates(items, config) {
  const max = config.digest?.llmMaxCandidates || 30;
  const maxPerSource = config.digest?.llmMaxCandidatesPerSource || 10;
  const preferredSources = ['arxiv', 'github', 'xrss', 'twitter'];
  const counts = new Map();
  const selected = [];
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.source)) groups.set(item.source, []);
    groups.get(item.source).push(item);
  }
  while (selected.length < max) {
    let progressed = false;
    for (const source of preferredSources) {
      const group = groups.get(source) || [];
      const count = counts.get(source) || 0;
      if (count >= maxPerSource || group.length === 0) continue;
      selected.push(group.shift());
      counts.set(source, count + 1);
      progressed = true;
      if (selected.length >= max) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function buildFilterTrace(items, config) {
  const trace = { items: [], dropped: {}, examples: [] };
  if (config.digest?.useLlm === false) return { ...trace, items };
  const min = config.digest?.llmMinRating || 'B';
  const rank = { S: 5, A: 4, B: 3, C: 2, Noise: 1 };
  for (const item of items) {
    const reason = dropReason(item, config, rank, min);
    if (!reason) trace.items.push(item);
    else {
      trace.dropped[reason] = (trace.dropped[reason] || 0) + 1;
      if (trace.examples.length < 12) trace.examples.push({ id: item.id, source: item.source, title: item.title, rating: item.llmAnalysis?.rating || null, relevance: item.llmAnalysis?.relevance || null, reason });
    }
  }
  trace.items = trace.items
    .sort((a, b) => {
      const ratingDiff = rank[b.llmAnalysis.rating] - rank[a.llmAnalysis.rating];
      if (ratingDiff) return ratingDiff;
      const riskDiff = riskRank(analysisRaw(a.llmAnalysis).hallucination_risk) - riskRank(analysisRaw(b.llmAnalysis).hallucination_risk);
      if (riskDiff) return riskDiff;
      const relevanceDiff = Number(b.llmAnalysis.relevance || 0) - Number(a.llmAnalysis.relevance || 0);
      if (relevanceDiff) return relevanceDiff;
      return Number(b.score || 0) - Number(a.score || 0);
    });
  return trace;
}

function dropReason(item, config, rank, min) {
  if (!item.llmAnalysis) return 'no_analysis';
  if (!rank[item.llmAnalysis.rating]) return 'unknown_rating';
  if (rank[item.llmAnalysis.rating] < rank[min]) return `rating_${item.llmAnalysis.rating}`;
  const raw = analysisRaw(item.llmAnalysis);
  if (raw.hallucination_risk === 'high' && rank[item.llmAnalysis.rating] < rank.A) return 'high_hallucination_risk';
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    if (allowEvidenceRelaxation(item, rank)) return null;
    return 'missing_evidence';
  }
  return null;
}

function allowEvidenceRelaxation(item, rank) {
  if (item.llmAnalysis?.rating !== 'B') return false;
  const relevance = Number(item.llmAnalysis?.relevance || 0);
  const score = Number(item.score || 0);
  return relevance >= 80 || score >= 80 || item.confidence === 'high';
}

function summarizeFilterTrace(trace) {
  return { dropped: trace.dropped, examples: trace.examples, approvedBeforeLimit: trace.items.length };
}

function analysisRaw(analysis) {
  if (!analysis?.raw_json) return analysis || {};
  try { return JSON.parse(analysis.raw_json); } catch { return analysis || {}; }
}

function riskRank(risk) {
  return { low: 1, medium: 2, high: 3 }[risk] || 2;
}

function limitDigestItems(items, config) {
  const maxItems = Number(config.digest?.maxItems || 0);
  const maxPerSource = config.digest?.maxItemsPerSource || 10;
  const sourceQuota = config.digest?.sourceQuota || {};
  const mix = config.digest?.contentMix || {};
  const infoMin = maxItems > 0 ? Math.ceil(maxItems * Number(mix.infoMinRatio ?? 0.6)) : 0;
  const productMax = maxItems > 0 ? Math.max(1, Math.floor(maxItems * Number(mix.productMaxRatio ?? 0.3))) : Number(mix.productMaxItems || 6);
  const socialMax = Number(mix.socialMaxItems ?? 1);
  const counts = new Map();
  const limited = [];

  const add = (item) => {
    const count = counts.get(item.source) || 0;
    const limit = sourceQuota[item.source] || maxPerSource;
    if (count >= limit) return false;
    const currentMix = mixCounts(limited);
    const bucket = contentBucket(item);
    if (bucket === 'product' && currentMix.product >= productMax) return false;
    if (bucket === 'social' && currentMix.social >= socialMax) return false;
    limited.push(item);
    counts.set(item.source, count + 1);
    return true;
  };

  for (const item of items) {
    if (contentBucket(item) !== 'info') continue;
    add(item);
    if (maxItems > 0 && (limited.length >= maxItems || mixCounts(limited).info >= infoMin)) break;
  }

  for (const item of items) {
    if (limited.some((selected) => selected.id === item.id)) continue;
    add(item);
    if (maxItems > 0 && limited.length >= maxItems) break;
  }
  return limited;
}

function mixCounts(items) {
  return items.reduce((acc, item) => {
    acc[contentBucket(item)] += 1;
    return acc;
  }, { info: 0, product: 0, social: 0 });
}

function contentBucket(item) {
  const category = String(analysisRaw(item.llmAnalysis).category || item.llmAnalysis?.category || '').toLowerCase();
  if (category === 'product') return 'product';
  if (category === 'social') return 'social';
  return 'info';
}

function extractKeywords(reasonsJson) {
  try {
    return [...new Set(JSON.parse(reasonsJson)
      .filter((reason) => reason.rule?.startsWith('keyword:') && reason.rule !== 'keyword:multiple')
      .map((reason) => reason.detail))];
  } catch {
    return [];
  }
}
