import { attachAnalyses, getDigestRun, getItemAnalysis, getPreparedDigestRun, markDigestSendError, markDigestSent, queryDigestItems, saveItemAnalysis, savePreparedDigestRun } from './db.js';
import { buildDigestCard, sendFeishu } from './feishu.js';
import { analyzeDigestItems } from './llm.js';
import { digestWindow, isRollingPrepareWindow } from './time.js';

export async function runDigest(db, config, env, options = {}) {
  if (options.dryRun) return previewDigest(db, config, env, options);
  if (options.prepareOnly) return prepareDigest(db, config, env, options);
  const prepared = await prepareDigest(db, config, env, options);
  if (prepared.skipped && !prepared.digestRunId) return prepared;
  return sendPreparedDigest(db, config, env, options);
}

export async function previewDigest(db, config, env, options = {}) {
  return buildDigestResult(db, config, env, { ...options, dryRun: true, excludeDigested: false });
}

export async function prepareDigest(db, config, env, options = {}) {
  const window = digestWindow(config, options.date);
  const existing = getDigestRun(db, window);
  const sendDueAt = options.sendDueAt || sendDueAtForWindow(config, window);
  if (existing?.status === 'sent' && !options.force) return { prepared: false, skipped: true, reason: 'digest already sent', window, itemCount: existing.item_count };
  if (existing?.status === 'prepared' && !options.force) return { prepared: true, skipped: true, reason: 'digest already prepared', window, digestRunId: existing.id, itemCount: existing.item_count };
  const result = await buildDigestResult(db, config, env, { ...options, excludeDigested: true, ignoreDigestRunId: existing?.id });
  if (result.items.length === 0 && config.digest?.preventEmptySend !== false) {
    return { ...result, prepared: false, skipped: true, reason: 'No LLM-approved items. Nothing was prepared.' };
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
  const items = limitDigestItems(filterByLlmRating(analyzed, config), config);
  const card = buildDigestCard(items, config, window);
  return { dryRun: Boolean(options.dryRun), window, candidateCount: candidates.length, selectedCandidateCount: selectedCandidates.length, llmTrace, items, card };
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

function filterByLlmRating(items, config) {
  if (config.digest?.useLlm === false) return items;
  const min = config.digest?.llmMinRating || 'B';
  const rank = { S: 5, A: 4, B: 3, C: 2, Noise: 1 };
  return items
    .filter((item) => {
      if (!item.llmAnalysis || !rank[item.llmAnalysis.rating] || rank[item.llmAnalysis.rating] < rank[min]) return false;
      const raw = analysisRaw(item.llmAnalysis);
      if (raw.hallucination_risk === 'high' && rank[item.llmAnalysis.rating] < rank.A) return false;
      if (rank[item.llmAnalysis.rating] >= rank.B && (!Array.isArray(raw.evidence) || raw.evidence.length === 0)) return false;
      return true;
    })
    .sort((a, b) => {
      const ratingDiff = rank[b.llmAnalysis.rating] - rank[a.llmAnalysis.rating];
      if (ratingDiff) return ratingDiff;
      const riskDiff = riskRank(analysisRaw(a.llmAnalysis).hallucination_risk) - riskRank(analysisRaw(b.llmAnalysis).hallucination_risk);
      if (riskDiff) return riskDiff;
      const relevanceDiff = Number(b.llmAnalysis.relevance || 0) - Number(a.llmAnalysis.relevance || 0);
      if (relevanceDiff) return relevanceDiff;
      return Number(b.score || 0) - Number(a.score || 0);
    });
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
  const counts = new Map();
  const limited = [];
  for (const item of items) {
    const count = counts.get(item.source) || 0;
    const limit = sourceQuota[item.source] || maxPerSource;
    if (count >= limit) continue;
    limited.push(item);
    counts.set(item.source, count + 1);
    if (maxItems > 0 && limited.length >= maxItems) break;
  }
  return limited;
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
