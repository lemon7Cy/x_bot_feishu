import { analysisWindow } from './time.js';
import { analyzeDigestItems } from './llm.js';
import { getItemAnalysis, queryDigestAnalysisDiagnostics, queryUnanalyzedDigestCandidates, saveItemAnalysis } from './db.js';

export async function runLlmAnalysisPipeline(db, config, env, options = {}) {
  const analysisConfig = config.scheduler?.analysis || {};
  const window = analysisWindow(config, options.date);
  const model = env.VIDEO_LLM_MODEL || null;
  if (!env.VIDEO_LLM_BASE_URL || !env.VIDEO_LLM_MODEL || !env.VIDEO_LLM_API_KEY) {
    return { skipped: true, reason: 'LLM env is not configured.', window, candidateCount: 0, analyzed: 0 };
  }
  const candidates = queryUnanalyzedDigestCandidates(db, window, config, model, {
    limit: options.limit || analysisConfig.maxCandidatesPerRun || 12
  }).map((item) => ({ ...item, matchedKeywords: extractKeywords(item.reasons_json) }));
  if (candidates.length === 0) {
    return { skipped: true, reason: 'No unanalyzed digest candidates.', window, candidateCount: 0, diagnostics: queryDigestAnalysisDiagnostics(db, window, config, model) };
  }
  const result = await analyzeDigestItems(db, candidates, config, env, { getItemAnalysis, saveItemAnalysis }, {
    maxCandidates: candidates.length,
    batchSize: options.batchSize || analysisConfig.batchSize || 4,
    concurrency: options.concurrency || analysisConfig.concurrency || 1,
    onProgress: options.onProgress
  });
  return {
    window,
    candidateCount: candidates.length,
    analyzed: result.trace?.analyzed || 0,
    cached: result.trace?.cached || 0,
    retryableErrors: result.trace?.retryableErrors || 0,
    ratings: result.trace?.ratings || {},
    batches: result.trace?.batches || [],
    model,
    diagnostics: queryDigestAnalysisDiagnostics(db, window, config, model)
  };
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
