import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveFromRoot } from './env.js';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_type TEXT,
    source_item_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    author TEXT,
    author_id TEXT,
    published_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT,
    UNIQUE(source, source_item_id),
    UNIQUE(canonical_url)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_published_at ON items(published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_items_source_published_at ON items(source, published_at)`,
  `CREATE TABLE IF NOT EXISTS item_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    field TEXT,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    UNIQUE(item_id, keyword, field)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_matches_keyword ON item_matches(keyword)`,
  `CREATE TABLE IF NOT EXISTS item_scores (
    item_id INTEGER PRIMARY KEY,
    score INTEGER NOT NULL,
    confidence TEXT NOT NULL,
    reasons_json TEXT NOT NULL,
    scored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_scores_confidence ON item_scores(confidence, score)`,
  `CREATE TABLE IF NOT EXISTS ingestion_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    since_at TEXT,
    until_at TEXT,
    status TEXT NOT NULL,
    inserted_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS digest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    timezone TEXT NOT NULL,
    sent_at TEXT,
    status TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    card_json TEXT,
    error TEXT,
    UNIQUE(window_start, window_end, timezone)
  )`,
  `CREATE TABLE IF NOT EXISTS digest_items (
    digest_run_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    PRIMARY KEY(digest_run_id, item_id),
    FOREIGN KEY(digest_run_id) REFERENCES digest_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS llm_analyses (
    item_id INTEGER PRIMARY KEY,
    rating TEXT NOT NULL,
    relevance INTEGER NOT NULL,
    summary TEXT NOT NULL,
    innovation TEXT,
    strengths TEXT,
    reason TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL,
    analyzed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`,
  `ALTER TABLE digest_runs ADD COLUMN prepared_at TEXT`,
  `ALTER TABLE digest_runs ADD COLUMN send_due_at TEXT`,
  `ALTER TABLE digest_runs ADD COLUMN prepared_by TEXT`,
  `ALTER TABLE digest_runs ADD COLUMN sent_error TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_digest_items_item_id ON digest_items(item_id)`,
  `CREATE TABLE IF NOT EXISTS scheduler_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    result_json TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduler_runs_job_started ON scheduler_runs(job_name, started_at)`,
  `UPDATE digest_runs SET prepared_at = COALESCE(prepared_at, sent_at), prepared_by = COALESCE(prepared_by, 'migration') WHERE prepared_at IS NULL AND sent_at IS NOT NULL`
];

export function openDb(env, root = process.cwd()) {
  const dbPath = resolveFromRoot(root, env.DB_PATH || './data/monitor.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(MIGRATIONS[0]);
  const applied = db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version);
  const tx = db.transaction(() => {
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      if (applied.includes(i + 1)) continue;
      try {
        db.exec(MIGRATIONS[i]);
      } catch (error) {
        if (!/duplicate column name/i.test(error.message)) throw error;
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)').run(i + 1);
    }
  });
  tx();
}

export function recordIngestionStart(db, source, window) {
  return db.prepare(`INSERT INTO ingestion_runs(source, started_at, since_at, until_at, status) VALUES (?, ?, ?, ?, 'running')`)
    .run(source, new Date().toISOString(), window.since.toISOString(), window.until.toISOString()).lastInsertRowid;
}

export function recordIngestionFinish(db, id, result) {
  db.prepare(`UPDATE ingestion_runs SET finished_at=?, status=?, inserted_count=?, updated_count=?, error=? WHERE id=?`)
    .run(new Date().toISOString(), result.status, result.inserted || 0, result.updated || 0, result.error || null, id);
}

export function upsertItem(db, item, scoreResult, matchedKeywords) {
  const existing = db.prepare('SELECT id FROM items WHERE source=? AND source_item_id=?').get(item.source, item.sourceItemId);
  const rawJson = JSON.stringify(item.raw || {});
  if (existing) {
    db.prepare(`UPDATE items SET source_type=?, canonical_url=?, title=?, summary=?, author=?, author_id=?, published_at=?, fetched_at=CURRENT_TIMESTAMP, raw_json=? WHERE id=?`)
      .run(item.sourceType, item.canonicalUrl, item.title, item.summary || '', item.author || '', item.authorId || '', item.publishedAt, rawJson, existing.id);
    replaceScoreAndMatches(db, existing.id, scoreResult, matchedKeywords);
    return { id: existing.id, inserted: false };
  }
  const info = db.prepare(`INSERT OR IGNORE INTO items(source, source_type, source_item_id, canonical_url, title, summary, author, author_id, published_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(item.source, item.sourceType, item.sourceItemId, item.canonicalUrl, item.title, item.summary || '', item.author || '', item.authorId || '', item.publishedAt, rawJson);
  const id = info.lastInsertRowid || db.prepare('SELECT id FROM items WHERE canonical_url=?').get(item.canonicalUrl)?.id;
  if (!id) return { id: null, inserted: false };
  replaceScoreAndMatches(db, id, scoreResult, matchedKeywords);
  return { id, inserted: Boolean(info.changes) };
}

export function replaceScoreAndMatches(db, itemId, scoreResult, matchedKeywords) {
  db.prepare('DELETE FROM item_matches WHERE item_id=?').run(itemId);
  const insertMatch = db.prepare('INSERT OR IGNORE INTO item_matches(item_id, keyword, field) VALUES (?, ?, ?)');
  for (const match of matchedKeywords) insertMatch.run(itemId, match.keyword, match.field || 'text');
  db.prepare(`INSERT INTO item_scores(item_id, score, confidence, reasons_json, scored_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(item_id) DO UPDATE SET score=excluded.score, confidence=excluded.confidence, reasons_json=excluded.reasons_json, scored_at=CURRENT_TIMESTAMP`)
    .run(itemId, scoreResult.score, scoreResult.confidence, JSON.stringify(scoreResult.reasons));
}

export function getItemsForRescore(db) {
  return db.prepare('SELECT * FROM items ORDER BY id').all();
}

export function queryDigestItems(db, window, config, options = {}) {
  const min = config.digest?.minConfidence || 'medium';
  const allowed = min === 'high' ? ['high'] : ['high', 'medium'];
  const placeholders = allowed.map(() => '?').join(',');
  const excludeDigested = options.excludeDigested !== false;
  const ignoreDigestRunId = options.ignoreDigestRunId || 0;
  const repeatFilter = excludeDigested ? 'AND NOT EXISTS (SELECT 1 FROM digest_items di WHERE di.item_id = items.id AND di.digest_run_id != ?)' : '';
  const params = [window.start.toISOString(), window.end.toISOString(), ...allowed];
  if (excludeDigested) params.push(ignoreDigestRunId);
  return db.prepare(`SELECT items.*, item_scores.score, item_scores.confidence, item_scores.reasons_json
    FROM items JOIN item_scores ON item_scores.item_id = items.id
    WHERE items.published_at >= ? AND items.published_at < ? AND item_scores.confidence IN (${placeholders})
    ${repeatFilter}
    ORDER BY CASE item_scores.confidence WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, item_scores.score DESC, items.published_at DESC`)
    .all(...params);
}

export function getItemAnalysis(db, itemId, model) {
  return db.prepare('SELECT * FROM llm_analyses WHERE item_id=? AND model=?').get(itemId, model);
}

export function saveItemAnalysis(db, itemId, model, analysis) {
  db.prepare(`INSERT INTO llm_analyses(item_id, rating, relevance, summary, innovation, strengths, reason, tags_json, model, analyzed_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      rating=excluded.rating,
      relevance=excluded.relevance,
      summary=excluded.summary,
      innovation=excluded.innovation,
      strengths=excluded.strengths,
      reason=excluded.reason,
      tags_json=excluded.tags_json,
      model=excluded.model,
      analyzed_at=CURRENT_TIMESTAMP,
      raw_json=excluded.raw_json`)
    .run(
      itemId,
      analysis.rating,
      Number(analysis.relevance || 0),
      analysis.summary || '',
      analysis.innovation || '',
      analysis.strengths || '',
      analysis.reason || '',
      JSON.stringify(analysis.tags || []),
      model,
      JSON.stringify(analysis)
    );
}

export function attachAnalyses(db, items) {
  const stmt = db.prepare('SELECT * FROM llm_analyses WHERE item_id=? ORDER BY analyzed_at DESC LIMIT 1');
  return items.map((item) => ({ ...item, llmAnalysis: stmt.get(item.id) || null }));
}

export function getDigestRun(db, window) {
  return db.prepare('SELECT * FROM digest_runs WHERE window_start=? AND window_end=? AND timezone=?')
    .get(window.start.toISOString(), window.end.toISOString(), window.timezone);
}

export function saveDigestRun(db, window, status, items, card, error = null) {
  const existing = getDigestRun(db, window);
  const cardJson = card ? JSON.stringify(card) : null;
  if (existing) {
    db.prepare(`UPDATE digest_runs SET sent_at=?, status=?, item_count=?, card_json=?, error=? WHERE id=?`)
      .run(status === 'sent' ? new Date().toISOString() : null, status, items.length, cardJson, error, existing.id);
    db.prepare('DELETE FROM digest_items WHERE digest_run_id=?').run(existing.id);
    insertDigestItems(db, existing.id, items);
    return existing.id;
  }
  const id = db.prepare(`INSERT INTO digest_runs(window_start, window_end, timezone, sent_at, status, item_count, card_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(window.start.toISOString(), window.end.toISOString(), window.timezone, status === 'sent' ? new Date().toISOString() : null, status, items.length, cardJson, error).lastInsertRowid;
  insertDigestItems(db, id, items);
  return id;
}

export function savePreparedDigestRun(db, window, items, card, metadata = {}) {
  const existing = getDigestRun(db, window);
  const cardJson = JSON.stringify(card);
  const now = new Date().toISOString();
  const sendDueAt = metadata.sendDueAt || null;
  const preparedBy = metadata.preparedBy || 'manual';
  if (existing) {
    db.prepare(`UPDATE digest_runs SET prepared_at=?, send_due_at=?, prepared_by=?, sent_at=NULL, status='prepared', item_count=?, card_json=?, error=NULL, sent_error=NULL WHERE id=?`)
      .run(now, sendDueAt, preparedBy, items.length, cardJson, existing.id);
    db.prepare('DELETE FROM digest_items WHERE digest_run_id=?').run(existing.id);
    insertDigestItems(db, existing.id, items);
    return existing.id;
  }
  const id = db.prepare(`INSERT INTO digest_runs(window_start, window_end, timezone, prepared_at, send_due_at, prepared_by, status, item_count, card_json) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`)
    .run(window.start.toISOString(), window.end.toISOString(), window.timezone, now, sendDueAt, preparedBy, items.length, cardJson).lastInsertRowid;
  insertDigestItems(db, id, items);
  return id;
}

export function getPreparedDigestRun(db, window) {
  return db.prepare(`SELECT * FROM digest_runs WHERE window_start=? AND window_end=? AND timezone=? AND status IN ('prepared','sent')`)
    .get(window.start.toISOString(), window.end.toISOString(), window.timezone);
}

export function getLatestPreparedDigestRun(db) {
  return db.prepare(`SELECT * FROM digest_runs WHERE status='prepared' ORDER BY prepared_at DESC LIMIT 1`).get();
}

export function markDigestSent(db, id) {
  db.prepare(`UPDATE digest_runs SET status='sent', sent_at=?, sent_error=NULL, error=NULL WHERE id=?`).run(new Date().toISOString(), id);
}

export function markDigestSendError(db, id, error) {
  db.prepare(`UPDATE digest_runs SET status='send_error', sent_error=?, error=? WHERE id=?`).run(error, error, id);
}

export function recordSchedulerStart(db, jobName, jobType) {
  return db.prepare(`INSERT INTO scheduler_runs(job_name, job_type, started_at, status) VALUES (?, ?, ?, 'running')`)
    .run(jobName, jobType, new Date().toISOString()).lastInsertRowid;
}

export function recordSchedulerFinish(db, id, result) {
  db.prepare(`UPDATE scheduler_runs SET finished_at=?, status=?, result_json=?, error=? WHERE id=?`)
    .run(new Date().toISOString(), result.status, result.result ? JSON.stringify(result.result) : null, result.error || null, id);
}

function insertDigestItems(db, digestRunId, items) {
  const stmt = db.prepare('INSERT OR IGNORE INTO digest_items(digest_run_id, item_id) VALUES (?, ?)');
  for (const item of items) stmt.run(digestRunId, item.id);
}

export function getStatus(db) {
  return {
    itemCounts: db.prepare('SELECT source, count(*) AS count FROM items GROUP BY source').all(),
    scoreCounts: db.prepare('SELECT confidence, count(*) AS count FROM item_scores GROUP BY confidence').all(),
    latestIngestions: db.prepare(`SELECT id, source, started_at, finished_at, since_at, until_at, status, inserted_count, updated_count,
      CASE WHEN error IS NULL THEN NULL ELSE substr(error, 1, 360) END AS error
      FROM ingestion_runs ORDER BY id DESC LIMIT 10`).all(),
    latestDigest: db.prepare(`SELECT id, window_start, window_end, timezone, prepared_at, send_due_at, sent_at, status, item_count,
      CASE WHEN error IS NULL THEN NULL ELSE substr(error, 1, 360) END AS error
      FROM digest_runs ORDER BY id DESC LIMIT 5`).all(),
    latestSchedulerRuns: db.prepare(`SELECT id, job_name, job_type, started_at, finished_at, status,
      CASE WHEN error IS NULL THEN NULL ELSE substr(error, 1, 360) END AS error
      FROM scheduler_runs ORDER BY id DESC LIMIT 10`).all(),
    latestLlmAnalyses: db.prepare(`SELECT llm_analyses.item_id, items.source, items.title, llm_analyses.rating, llm_analyses.relevance,
      substr(llm_analyses.summary, 1, 120) AS summary,
      substr(llm_analyses.reason, 1, 160) AS reason,
      json_extract(llm_analyses.raw_json, '$.hallucination_risk') AS hallucination_risk,
      json_extract(llm_analyses.raw_json, '$.evidence') AS evidence,
      llm_analyses.model, llm_analyses.analyzed_at
      FROM llm_analyses JOIN items ON items.id = llm_analyses.item_id
      ORDER BY llm_analyses.analyzed_at DESC LIMIT 12`).all()
  };
}
