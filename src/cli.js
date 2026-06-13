import process from 'node:process';
import { loadConfig } from './config.js';
import { getItemsForRescore, openDb, getStatus, replaceScoreAndMatches } from './db.js';
import { loadEnv } from './env.js';
import { buildTestCard, sendFeishu } from './feishu.js';
import { ingest } from './ingest.js';
import { runDigest } from './digest.js';
import { scoreItem } from './scoring.js';
import { runDailyAgent } from './agent.js';
import { startScheduler } from './scheduler.js';

const ROOT = process.cwd();

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  const env = loadEnv(ROOT);
  const config = await loadConfig(env, ROOT);
  const db = openDb(env, ROOT);

  if (command === 'init-db') {
    console.log('SQLite database initialized.');
    return;
  }
  if (command === 'ingest') {
    const result = await ingest(db, config, env, options, ROOT);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'digest') {
    const result = await runDigest(db, config, env, options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'preview') {
    const { previewDigest } = await import('./digest.js');
    console.log(JSON.stringify(await previewDigest(db, config, env, options), null, 2));
    return;
  }
  if (command === 'prepare') {
    const { prepareDigest } = await import('./digest.js');
    console.log(JSON.stringify(await prepareDigest(db, config, env, options), null, 2));
    return;
  }
  if (command === 'send-prepared') {
    const { sendPreparedDigest } = await import('./digest.js');
    console.log(JSON.stringify(await sendPreparedDigest(db, config, env, options), null, 2));
    return;
  }
  if (command === 'scheduler') {
    await startScheduler(ROOT);
    return;
  }
  if (command === 'product-preview') {
    const { previewProductAlerts } = await import('./productAlerts.js');
    console.log(JSON.stringify(await previewProductAlerts(db, config, env, options), null, 2));
    return;
  }
  if (command === 'product-send') {
    const { sendProductAlerts } = await import('./productAlerts.js');
    console.log(JSON.stringify(await sendProductAlerts(db, config, env, options), null, 2));
    return;
  }
  if (command === 'agent') {
    const result = await runDailyAgent(db, config, env, options, ROOT);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'send-test') {
    await sendFeishu(buildTestCard(), env);
    console.log('Sent Feishu test card.');
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify(getStatus(db), null, 2));
    return;
  }
  if (command === 'rescore') {
    const items = getItemsForRescore(db);
    const tx = db.transaction(() => {
      for (const row of items) {
        const item = rowToItem(row);
        const scoring = scoreItem(item, config);
        replaceScoreAndMatches(db, row.id, scoring, scoring.matchedKeywords);
      }
    });
    tx();
    console.log(`Rescored ${items.length} items.`);
    return;
  }
  printHelp();
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      options[key] = args[i + 1];
      i += 1;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node src/cli.js init-db
  node src/cli.js ingest [--source arxiv|github|xrss|twitter] [--since ISO] [--until ISO]
  node src/cli.js preview [--date YYYY-MM-DD]
  node src/cli.js prepare [--date YYYY-MM-DD] [--force]
  node src/cli.js send-prepared [--date YYYY-MM-DD] [--force]
  node src/cli.js product-preview [--lookback-hours 24]
  node src/cli.js product-send [--lookback-hours 24] [--dry-run]
  node src/cli.js scheduler
  node src/cli.js digest [--date YYYY-MM-DD] [--dry-run] [--force]
  node src/cli.js agent [legacy combined flow]
  node src/cli.js send-test
  node src/cli.js status
  node src/cli.js rescore`);
}

function rowToItem(row) {
  return {
    source: row.source,
    sourceType: row.source_type,
    sourceItemId: row.source_item_id,
    canonicalUrl: row.canonical_url,
    title: row.title,
    summary: row.summary,
    author: row.author,
    authorId: row.author_id,
    publishedAt: row.published_at,
    raw: JSON.parse(row.raw_json || '{}')
  };
}
