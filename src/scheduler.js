import { loadConfig } from './config.js';
import { openDb, recordSchedulerFinish, recordSchedulerStart } from './db.js';
import { loadEnv } from './env.js';
import { ingest } from './ingest.js';
import { prepareDigest, sendPreparedDigest } from './digest.js';
import { sendProductAlerts } from './productAlerts.js';

export async function startScheduler(root = process.cwd()) {
  const state = { running: new Set(), lastDaily: new Map() };
  console.log('Scheduler started.');
  await tick(root, state, true);
  setInterval(() => tick(root, state, false).catch((error) => console.error(error)), 60 * 1000);
}

async function tick(root, state, firstRun) {
  const env = loadEnv(root);
  const config = await loadConfig(env, root);
  const db = openDb(env, root);
  const scheduler = config.scheduler || {};
  if (scheduler.enabled === false) return;
  const now = new Date();
  if (scheduler.collection?.enabled !== false) {
    const interval = Math.max(5, Number(scheduler.collection?.intervalMinutes || 90));
    const key = 'collection';
    const last = state.lastDaily.get(key);
    if ((firstRun && scheduler.collection?.runOnStart) || !last || now - last >= interval * 60 * 1000) {
      state.lastDaily.set(key, now);
      const jitter = Math.max(0, Number(scheduler.collection?.jitterSeconds || 0)) * 1000;
      setTimeout(() => runLocked(db, state, 'collection', 'collection', () => ingest(db, config, env, {}, root)), jitter ? Math.floor(Math.random() * jitter) : 0);
    }
  }
  if (config.productAlerts?.enabled !== false) {
    const interval = Math.max(15, Number(config.productAlerts?.intervalMinutes || 120));
    const key = 'product-alert';
    const last = state.lastDaily.get(key);
    if (!last || now - last >= interval * 60 * 1000) {
      state.lastDaily.set(key, now);
      runLocked(db, state, 'product-alert', 'product_alert', () => sendProductAlerts(db, config, env, {}));
    }
  }
  const prepareTime = scheduler.prepare?.time || '08:30';
  if (isTimeMatch(now, config.timezone, prepareTime) && !alreadyRanToday(state, 'prepare', now, config.timezone, prepareTime)) {
    markRanToday(state, 'prepare', now, config.timezone, prepareTime);
    runLocked(db, state, 'prepare', 'digest_prepare', () => prepareDigest(db, config, env, { preparedBy: 'scheduler' }));
  }
  const sendTime = scheduler.send?.time || '09:00';
  if (isTimeMatch(now, config.timezone, sendTime) && !alreadyRanToday(state, 'send', now, config.timezone, sendTime)) {
    markRanToday(state, 'send', now, config.timezone, sendTime);
    runLocked(db, state, 'send', 'digest_send', () => sendPreparedDigest(db, config, env, {}));
  }
}

async function runLocked(db, state, name, type, fn) {
  if (state.running.has(name)) return;
  state.running.add(name);
  const id = recordSchedulerStart(db, name, type);
  try {
    const result = await fn();
    recordSchedulerFinish(db, id, { status: result?.skipped ? 'skipped' : 'success', result });
    console.log(`[scheduler] ${name} completed`);
  } catch (error) {
    recordSchedulerFinish(db, id, { status: 'error', error: error.message });
    console.error(`[scheduler] ${name} failed`, error.message);
  } finally {
    state.running.delete(name);
  }
}

function isTimeMatch(now, timezone, value) {
  const [hour, minute] = String(value).split(':').map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return parts.hour === hour && parts.minute === minute;
}

function dateKey(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function alreadyRanToday(state, name, now, timezone, timeValue) {
  return state.lastDaily.get(`${name}:${timeValue}`) === dateKey(now, timezone);
}

function markRanToday(state, name, now, timezone, timeValue) {
  state.lastDaily.set(`${name}:${timeValue}`, dateKey(now, timezone));
}
