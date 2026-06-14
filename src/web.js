import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { deleteDigestRun, getStatus, openDb } from './db.js';
import { loadEnv, resolveFromRoot } from './env.js';
import { ingest } from './ingest.js';
import { prepareDigest, previewDigest, runDigest, sendPreparedDigest } from './digest.js';
import { previewProductAlerts } from './productAlerts.js';
import { readSettings, saveSettings } from './settingsStore.js';
import { startScheduler } from './scheduler.js';
import { digestWindow } from './time.js';
import { fetchArxiv } from './sources/arxiv.js';
import { fetchGitHub } from './sources/github.js';
import { fetchXRss } from './sources/xrss.js';
import { fetchTwitter } from './sources/twitter.js';

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const jobs = new Map();
let jobSeq = 0;
if (process.env.WEB_SCHEDULER === '1') startScheduler(ROOT).catch((error) => console.error(error));

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WebUI running at http://${HOST}:${PORT}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, { ok: true, data: await readSettings(ROOT) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, data: await saveSettings(body, ROOT) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/feishu/test') {
    sendJson(res, 410, { ok: false, error: 'Feishu test sending is disabled. Only prepared daily digest sending is allowed.' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/twitter/add-cookie') {
    const body = await readBody(req);
    const result = await addTwitterCookie(body);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/twitter/test') {
    const body = await readBody(req);
    const result = await testTwitterFetch(body);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/source/test') {
    const body = await readBody(req);
    const result = await testSourceFetch(body);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/llm/test') {
    const result = await testLlmConnection();
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/twitter/accounts') {
    const result = await getTwitterAccounts();
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const env = loadEnv(ROOT);
    await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    sendJson(res, 200, { ok: true, data: getStatus(db) });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/digest/status') {
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = getDigestStatus(db, config, url.searchParams.get('date') || undefined);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/digest/diagnose') {
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = diagnoseDigest(db, config, url.searchParams.get('date') || undefined);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/mark-unsent') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = markDigestUnsent(db, config, body.date || undefined);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/delete') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const window = digestWindow(config, body.date || undefined);
    const result = deleteDigestRun(db, window);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ingest/run') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = await ingest(db, config, env, { source: body.source || undefined }, ROOT);
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/preview') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = await previewDigest(db, config, env, { date: body.date || undefined });
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/preview/jobs') {
    const body = await readBody(req);
    const job = createPreviewJob(body);
    sendJson(res, 200, { ok: true, data: { jobId: job.id } });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/digest/preview/jobs/')) {
    const id = url.pathname.split('/').pop();
    const job = jobs.get(`preview:${id}`);
    if (!job) {
      sendJson(res, 404, { ok: false, error: 'Job not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: job });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/send') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = await sendPreparedDigest(db, config, env, { date: body.date || undefined, force: Boolean(body.force) });
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/digest/prepare') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = await prepareDigest(db, config, env, { date: body.date || undefined, preparedBy: 'webui' });
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/product/preview') {
    const body = await readBody(req);
    const env = loadEnv(ROOT);
    const config = await loadConfig(env, ROOT);
    const db = openDb(env, ROOT);
    const result = await previewProductAlerts(db, config, env, { lookbackHours: body.lookbackHours || undefined });
    sendJson(res, 200, { ok: true, data: result });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/product/send') {
    sendJson(res, 410, { ok: false, error: 'Product alert sending is disabled. Product intel can only be included in the daily digest.' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/run') {
    sendJson(res, 410, { ok: false, error: 'Combined agent sending is disabled. Use collection, prepare, then send prepared daily digest.' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/jobs') {
    sendJson(res, 410, { ok: false, error: 'Combined agent jobs are disabled. Use digest preview/prepare/send endpoints.' });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/agent/jobs/')) {
    const id = url.pathname.split('/').pop();
    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { ok: false, error: 'Job not found' });
      return;
    }
    sendJson(res, 200, { ok: true, data: job });
    return;
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
}

function createPreviewJob(options) {
  const id = String(++jobSeq);
  const job = {
    id,
    type: 'digest_preview',
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: ['queued'],
    result: null,
    error: null
  };
  jobs.set(`preview:${id}`, job);
  setImmediate(async () => {
    try {
      updateJob(job, 'running', '加载配置和数据库');
      const env = loadEnv(ROOT);
      const config = await loadConfig(env, ROOT);
      const db = openDb(env, ROOT);
      updateJob(job, 'running', '筛选候选内容并准备 LLM 分析');
      job.result = await previewDigest(db, config, env, {
        date: options.date || undefined,
        onProgress: (event) => updateJob(job, 'running', event.message || event.stage || 'running')
      });
      updateJob(job, 'completed', '预览报告生成完成');
    } catch (error) {
      job.error = error.stack || error.message || String(error);
      updateJob(job, 'failed', error.message || String(error));
    }
  });
  return job;
}

function updateJob(job, status, message) {
  job.status = status;
  job.updatedAt = new Date().toISOString();
  job.progress.push(`${new Date().toISOString()} ${message}`);
}

async function testSourceFetch(body) {
  const env = loadEnv(ROOT);
  const config = await loadConfig(env, ROOT);
  const source = String(body.source || '').trim();
  const keyword = String(body.keyword || config.keywords?.[0] || 'Agentic').trim();
  const limit = Math.max(1, Math.min(Number(body.limit || 5), 20));
  const hours = Math.max(1, Math.min(Number(body.hours || 24), 168));
  const testConfig = { ...config, keywords: [keyword] };
  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  let items;
  if (source === 'arxiv') items = await fetchArxiv(testConfig, { since, until }, env, ROOT);
  else if (source === 'github') items = await fetchGitHub(testConfig, { since, until }, env, ROOT);
  else if (source === 'xrss') items = await fetchXRss(testConfig, { since, until }, env, ROOT);
  else throw new Error('source must be arxiv, github, or xrss');
  return { source, keyword, since: since.toISOString(), until: until.toISOString(), count: items.length, items: items.slice(0, limit) };
}

function getDigestStatus(db, config, date) {
  const window = digestWindow(config, date);
  const row = db.prepare(`SELECT id, window_start, window_end, timezone, prepared_at, send_due_at, sent_at, status, item_count, error, sent_error
    FROM digest_runs WHERE window_start=? AND window_end=? AND timezone=?`)
    .get(window.start.toISOString(), window.end.toISOString(), window.timezone);
  return { window, digest: row || null, beijingNow: beijingNow(), scheduler: config.scheduler || {} };
}

function diagnoseDigest(db, config, date) {
  const status = getDigestStatus(db, config, date);
  const digest = status.digest;
  const decision = digestDecision(digest);
  return {
    ...status,
    windowMode: config.digest?.window || 'previous_natural_day',
    decision,
    suggestions: digestSuggestions(decision.reason)
  };
}

function digestDecision(digest) {
  if (!digest) {
    return {
      canPrepare: true,
      canSend: false,
      reason: 'not_prepared',
      message: '当前窗口还没有生成日报，需要先准备报告。'
    };
  }
  if (digest.status === 'sent') {
    return {
      canPrepare: false,
      canSend: false,
      reason: 'already_sent',
      message: '当前窗口已经推送过，定时器会跳过。'
    };
  }
  if (digest.status === 'prepared') {
    return {
      canPrepare: false,
      canSend: true,
      reason: 'prepared_not_sent',
      message: '当前窗口已生成且尚未推送，可以发送。'
    };
  }
  if (digest.status === 'send_error') {
    return {
      canPrepare: false,
      canSend: true,
      reason: 'send_error_retryable',
      message: '上次飞书发送失败，可以重试推送。'
    };
  }
  if (digest.status === 'skipped') {
    return {
      canPrepare: true,
      canSend: false,
      reason: 'prepared_skipped_empty',
      message: '上次没有筛出可推送内容，如需重试可删除记录后重新准备。'
    };
  }
  return {
    canPrepare: true,
    canSend: false,
    reason: `status_${digest.status}`,
    message: `当前日报状态为 ${digest.status}，建议查看错误或删除后重试。`
  };
}

function digestSuggestions(reason) {
  const map = {
    not_prepared: ['点击「准备报告」立即生成', '或等待下一个 Prepare 时间自动生成'],
    already_sent: ['如果想重发同一份报告，点击「标记今日未推送」', '如果想重新生成新报告，点击「删除日报记录」后再准备'],
    prepared_not_sent: ['等待 Send 时间自动推送', '或点击「推送已准备报告」立即推送'],
    send_error_retryable: ['检查飞书 webhook/签名配置', '点击「推送已准备报告」重试'],
    prepared_skipped_empty: ['降低最低评级或增加候选数后重新准备', '也可以等待下一轮采集后再准备']
  };
  return map[reason] || ['查看 Raw 状态和最近定时任务日志'];
}

function markDigestUnsent(db, config, date) {
  const window = digestWindow(config, date);
  const row = db.prepare(`SELECT id, status, item_count FROM digest_runs WHERE window_start=? AND window_end=? AND timezone=?`)
    .get(window.start.toISOString(), window.end.toISOString(), window.timezone);
  if (!row) return { window, changed: false, reason: 'No digest found.' };
  db.prepare(`UPDATE digest_runs SET status='prepared', sent_at=NULL, sent_error=NULL, error=NULL WHERE id=?`).run(row.id);
  return { window, changed: true, digestRunId: row.id, previousStatus: row.status, status: 'prepared', itemCount: row.item_count };
}

function beijingNow() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

async function testLlmConnection() {
  const env = loadEnv(ROOT);
  const missing = ['VIDEO_LLM_BASE_URL', 'VIDEO_LLM_MODEL', 'VIDEO_LLM_API_KEY'].filter((key) => !env[key]);
  if (missing.length > 0) throw new Error(`LLM 配置缺失：${missing.join(', ')}`);

  const baseUrl = env.VIDEO_LLM_BASE_URL.replace(/\/$/, '');
  const timeoutMs = Math.min(Number(env.VIDEO_LLM_TIMEOUT_MS || 30000), 60000);
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.VIDEO_LLM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: env.VIDEO_LLM_MODEL,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'Return a short JSON object only.' },
          { role: 'user', content: 'Return {"ok":true} to test connectivity.' }
        ]
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LLM request failed ${response.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    return {
      ok: true,
      model: env.VIDEO_LLM_MODEL,
      baseUrl,
      latencyMs: Date.now() - started,
      reply: data.choices?.[0]?.message?.content || ''
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function testTwitterFetch(body) {
  const env = loadEnv(ROOT);
  const config = await loadConfig(env, ROOT);
  const keyword = String(body.keyword || config.keywords?.[0] || 'Agentic').trim();
  const limit = Math.max(1, Math.min(Number(body.limit || 5), 20));
  const hours = Math.max(1, Math.min(Number(body.hours || 24), 72));
  const testConfig = {
    ...config,
    keywords: [keyword],
    twitter: { ...config.twitter, limit }
  };
  const until = new Date();
  const since = new Date(until.getTime() - hours * 60 * 60 * 1000);
  const accounts = await getTwitterAccounts().catch((error) => ({ error: error.message }));
  const items = await fetchTwitter(testConfig, { since, until }, env, ROOT);
  const hints = [];
  if (accounts.stdout && /\s0\s+1\s/.test(accounts.stdout)) {
    hints.push('账号池里存在 logged_in=0 的账号，cookie 可能没有被 twscrape 识别为已登录。');
  }
  if (items.length === 0) {
    hints.push('返回 0 条不一定代表关键词没有结果，也可能是 twscrape/X 前端接口当前不可用。');
  }
  return { keyword, since: since.toISOString(), until: until.toISOString(), count: items.length, hints, accounts, items: items.slice(0, limit) };
}

async function getTwitterAccounts() {
  const env = loadEnv(ROOT);
  const python = env.PYTHON_BIN || 'python3';
  const dbPath = resolveFromRoot(ROOT, env.TWSCRAPE_DB_PATH || './data/twscrape/accounts.db');
  const commands = twscrapeCommands(python);
  let lastError;
  for (const command of commands) {
    try {
      const result = await runCommand(command.bin, ['--db', dbPath, 'accounts'], 30000);
      return { ...result, command: command.bin };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('twscrape command not found');
}

async function addTwitterCookie(body) {
  if (!body.username || !body.cookie) throw new Error('username and cookie are required');
  const env = loadEnv(ROOT);
  const python = env.PYTHON_BIN || 'python3';
  const dbPath = resolveFromRoot(ROOT, env.TWSCRAPE_DB_PATH || './data/twscrape/accounts.db');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const commands = twscrapeCommands(python);
  let lastError;
  for (const command of commands) {
    try {
      const result = await runCommand(command.bin, ['--db', dbPath, 'add_cookie', body.username, body.cookie], 60000);
      return { ...result, command: command.bin };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('twscrape command not found');
}

function twscrapeCommands(python) {
  const commands = [];
  if (python && python !== 'python3') {
    const resolvedPython = resolveFromRoot(ROOT, python);
    const localBin = path.join(path.dirname(resolvedPython), 'twscrape');
    if (existsSync(localBin)) commands.push({ bin: localBin });
  }
  commands.push({ bin: 'twscrape' });
  return commands;
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function contentType(filePath) {
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/html; charset=utf-8';
}
