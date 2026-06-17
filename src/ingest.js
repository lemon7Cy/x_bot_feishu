import { getCollectionSourceState, markCollectionSourceSuccess, recordIngestionFinish, recordIngestionStart, updateCollectionSourceState, upsertItem } from './db.js';
import { scoreItem } from './scoring.js';
import { ingestionWindow, sourceIngestionWindow } from './time.js';
import { fetchArxiv } from './sources/arxiv.js';
import { fetchGitHub } from './sources/github.js';
import { fetchTwitter } from './sources/twitter.js';
import { fetchXRss } from './sources/xrss.js';
import { configForSourceKeywords, keywordsForSource } from './sourceKeywords.js';

const FETCHERS = {
  arxiv: (config, window, env, root) => fetchArxiv(config, window, env, root),
  github: (config, window, env, root) => fetchGitHub(config, window, env, root),
  xrss: (config, window, env, root) => fetchXRss(config, window, env, root),
  twitter: (config, window, env, root) => fetchTwitter(config, window, env, root)
};

export async function ingest(db, config, env, options = {}, root = process.cwd()) {
  const window = options.since && options.until
    ? { since: new Date(options.since), until: new Date(options.until) }
    : ingestionWindow(config);
  const sources = options.source ? [options.source] : Object.entries(config.sources).filter(([, enabled]) => enabled).map(([source]) => source);
  const results = [];
  for (const source of sources) {
    if (!FETCHERS[source]) {
      results.push({ source, status: 'error', error: `Unknown source: ${source}`, inserted: 0, updated: 0 });
      continue;
    }
    const sourceWindow = options.since && options.until ? window : sourceIngestionWindow(config, source);
    const state = getCollectionSourceState(db, source);
    if (!options.force && isBackedOff(state)) {
      const result = { source, status: 'skipped', inserted: 0, updated: 0, error: `Backoff active until ${state.backoff_until}: ${state.last_error || ''}` };
      results.push(result);
      continue;
    }
    const runId = recordIngestionStart(db, source, sourceWindow);
    try {
      const keywords = options.keywords || distributedKeywords(config, source, state);
      const sourceConfig = configForSourceKeywords(config, source, keywords);
      const fetched = await FETCHERS[source](sourceConfig, sourceWindow, env, root);
      let inserted = 0;
      let updated = 0;
      const tx = db.transaction((items) => {
        for (const item of items) {
          if (!item.title || !item.canonicalUrl || !item.sourceItemId) continue;
          const scoring = scoreItem(item, config);
          const result = upsertItem(db, item, scoring, scoring.matchedKeywords);
          if (result.inserted) inserted += 1;
          else updated += 1;
        }
      });
      tx(fetched);
      const result = { source, status: 'success', inserted, updated, fetched: fetched.length, keywords };
      recordIngestionFinish(db, runId, result);
      markCollectionSourceSuccess(db, source, advanceBy(keywords), keywordsForSource(config, source).length);
      results.push(result);
    } catch (error) {
      const result = { source, status: 'error', inserted: 0, updated: 0, error: error.message };
      recordIngestionFinish(db, runId, result);
      updateCollectionSourceState(db, source, failureState(config, source, state, error));
      results.push(result);
    }
  }
  return { window, results };
}

function distributedKeywords(config, source, state = getEmptyState()) {
  const collection = config.scheduler?.collection || {};
  if (!collection.distributed) return null;
  const keywords = keywordsForSource(config, source);
  if (keywords.length <= 1) return keywords;
  if (isSequentialRetrySource(config, source)) return [keywords[Number(state.keyword_cursor || 0) % keywords.length]];
  const interval = Math.max(5, Number(collection.intervalMinutes || 90));
  const fullCycleHours = Math.max(1, Number(collection.fullCycleHours || 10));
  const slots = Math.max(keywords.length, Math.ceil((fullCycleHours * 60) / interval));
  const perSlot = Math.max(1, Math.ceil(keywords.length / slots));
  const slot = Number(state.keyword_cursor || 0) % keywords.length;
  const picked = [];
  for (let i = 0; i < perSlot; i += 1) picked.push(keywords[(slot + i) % keywords.length]);
  return [...new Set(picked)];
}

function isSequentialRetrySource(config, source) {
  const sources = config.scheduler?.collection?.sequentialRetrySources || ['arxiv', 'xrss'];
  return sources.includes(source);
}

function advanceBy(usedKeywords) {
  if (!usedKeywords) return 0;
  return Math.max(1, usedKeywords.length);
}

function isBackedOff(state, now = new Date()) {
  return state.backoff_until && new Date(state.backoff_until) > now;
}

function failureState(config, source, state, error) {
  const count = Number(state.failure_count || 0) + 1;
  const message = error.message || String(error);
  const minutes = backoffMinutes(config, source, count, message);
  return {
    keywordCursor: state.keyword_cursor || 0,
    failureCount: count,
    backoffUntil: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
    lastError: message.slice(0, 500)
  };
}

function backoffMinutes(config, source, failureCount, message) {
  const collection = config.scheduler?.collection || {};
  if (isSequentialRetrySource(config, source)) return Number(collection.keywordBackoffMinutes || 60);
  const base = Number(collection.backoffBaseMinutes || (source === 'xrss' ? 90 : 30));
  const max = Number(collection.backoffMaxMinutes || (source === 'xrss' ? 720 : 180));
  const multiplier = /403|429|rate|too many|forbidden/i.test(message) ? 2 : 1;
  return Math.min(max, Math.ceil(base * multiplier * (2 ** Math.min(failureCount - 1, 4))));
}

function getEmptyState() {
  return { keyword_cursor: 0, backoff_until: null, failure_count: 0, last_error: null };
}
