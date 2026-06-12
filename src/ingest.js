import { recordIngestionFinish, recordIngestionStart, upsertItem } from './db.js';
import { scoreItem } from './scoring.js';
import { ingestionWindow, sourceIngestionWindow } from './time.js';
import { fetchArxiv } from './sources/arxiv.js';
import { fetchGitHub } from './sources/github.js';
import { fetchTwitter } from './sources/twitter.js';
import { fetchXRss } from './sources/xrss.js';

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
    const runId = recordIngestionStart(db, source, sourceWindow);
    try {
      const fetched = await FETCHERS[source](config, sourceWindow, env, root);
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
      const result = { source, status: 'success', inserted, updated, fetched: fetched.length };
      recordIngestionFinish(db, runId, result);
      results.push(result);
    } catch (error) {
      const result = { source, status: 'error', inserted: 0, updated: 0, error: error.message };
      recordIngestionFinish(db, runId, result);
      results.push(result);
    }
  }
  return { window, results };
}
