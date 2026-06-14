import fs from 'node:fs/promises';
import { DEFAULT_CONFIG } from './config.js';
import { loadEnv, resolveFromRoot } from './env.js';

const UI_ENV_KEYS = [
  'FEISHU_WEBHOOK_URL',
  'FEISHU_SECRET',
  'GITHUB_TOKEN',
  'CONFIG_PATH',
  'DB_PATH',
  'PYTHON_BIN',
  'TWSCRAPE_DB_PATH'
];

export async function readSettings(root = process.cwd()) {
  const env = loadEnv(root);
  const config = await readConfigFile(env, root);
  return {
    env: Object.fromEntries(UI_ENV_KEYS.map((key) => [key, env[key] || ''])),
    config
  };
}

export async function saveSettings(settings, root = process.cwd()) {
  const env = loadEnv(root);
  const configPath = env.CONFIG_PATH || settings.env?.CONFIG_PATH || './config.json';
  const nextConfig = normalizeConfig(settings.config || {});
  await fs.writeFile(resolveFromRoot(root, configPath), `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');

  const nextEnv = {};
  for (const key of UI_ENV_KEYS) {
    const value = settings.env?.[key];
    if (value !== undefined) nextEnv[key] = String(value || '');
  }
  await writeEnvFile(nextEnv, root);
  return readSettings(root);
}

async function readConfigFile(env, root) {
  const filePath = resolveFromRoot(root, env.CONFIG_PATH || './config.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_CONFIG;
    throw error;
  }
}

function normalizeConfig(config) {
  return mergeConfig(DEFAULT_CONFIG, {
    ...config,
    keywords: normalizeList(config.keywords),
    blockedKeywords: normalizeList(config.blockedKeywords),
    ingestion: {
      ...config.ingestion,
      sourceLookbackHours: {
        arxiv: Number(config.ingestion?.sourceLookbackHours?.arxiv || 168),
        github: Number(config.ingestion?.sourceLookbackHours?.github || config.ingestion?.lookbackHours || 2),
        xrss: Number(config.ingestion?.sourceLookbackHours?.xrss || 6),
        twitter: Number(config.ingestion?.sourceLookbackHours?.twitter || config.ingestion?.lookbackHours || 2)
      }
    },
    digest: {
      ...config.digest,
      window: 'rolling_prepare_time'
    },
    productIntel: {
      ...config.productIntel,
      enabled: config.productIntel?.enabled !== false,
      keywords: normalizeList(config.productIntel?.keywords)
    },
    productAlerts: {
      ...config.productAlerts,
      enabled: false,
      intervalMinutes: Number(config.productAlerts?.intervalMinutes || 120),
      lookbackHours: Number(config.productAlerts?.lookbackHours || 24),
      maxItemsPerRun: Number(config.productAlerts?.maxItemsPerRun || 3),
      llmMaxCandidates: Number(config.productAlerts?.llmMaxCandidates || 12),
      minRating: config.productAlerts?.minRating || 'B',
      minConfidence: config.productAlerts?.minConfidence || 'medium',
      minRelevance: Number(config.productAlerts?.minRelevance || 80),
      requireEvidence: config.productAlerts?.requireEvidence !== false,
      sendMode: config.productAlerts?.sendMode || 'batch'
    },
    twitter: {
      ...config.twitter,
      trustedAccounts: normalizeList(config.twitter?.trustedAccounts)
    },
    xrss: {
      ...config.xrss,
      instances: normalizeList(config.xrss?.instances)
    },
    github: {
      ...config.github,
      trustedRepos: normalizeList(config.github?.trustedRepos)
    }
  });
}

function mergeConfig(base, override = {}) {
  return {
    ...base,
    ...override,
    ingestion: { ...base.ingestion, ...override.ingestion },
    sourceKeywords: { ...base.sourceKeywords, ...override.sourceKeywords },
    productIntel: { ...base.productIntel, ...override.productIntel },
    productAlerts: { ...base.productAlerts, ...override.productAlerts },
    digest: { ...base.digest, ...override.digest },
    scheduler: {
      ...base.scheduler,
      ...override.scheduler,
      collection: { ...base.scheduler.collection, ...override.scheduler?.collection },
      prepare: { ...base.scheduler.prepare, ...override.scheduler?.prepare },
      send: { ...base.scheduler.send, ...override.scheduler?.send }
    },
    webui: { ...base.webui, ...override.webui },
    agentPolicy: {
      ...base.agentPolicy,
      ...override.agentPolicy,
      lookbackHours: { ...base.agentPolicy.lookbackHours, ...override.agentPolicy?.lookbackHours },
      fallbackLookbackHours: { ...base.agentPolicy.fallbackLookbackHours, ...override.agentPolicy?.fallbackLookbackHours },
      sourceQuota: { ...base.agentPolicy.sourceQuota, ...override.agentPolicy?.sourceQuota }
    },
    sources: { ...base.sources, ...override.sources },
    github: { ...base.github, ...override.github },
    twitter: { ...base.twitter, ...override.twitter },
    xrss: { ...base.xrss, ...override.xrss },
    scoring: { ...base.scoring, ...override.scoring }
  };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

async function writeEnvFile(values, root) {
  const existing = await readEnvLines(root);
  const managed = {
    FEISHU_WEBHOOK_URL: values.FEISHU_WEBHOOK_URL || '',
    FEISHU_SECRET: values.FEISHU_SECRET || '',
    GITHUB_TOKEN: values.GITHUB_TOKEN || '',
    CONFIG_PATH: values.CONFIG_PATH || './config.json',
    DB_PATH: values.DB_PATH || './data/monitor.sqlite',
    PYTHON_BIN: values.PYTHON_BIN || './.venv/bin/python',
    TWSCRAPE_DB_PATH: values.TWSCRAPE_DB_PATH || './data/twscrape/accounts.db'
  };
  const managedKeys = new Set(Object.keys(managed));
  const lines = existing.filter((line) => {
    const key = line.split('=')[0];
    return key && !managedKeys.has(key);
  });
  lines.unshift('# Generated by local WebUI. Do not commit this file.');
  for (const [key, value] of Object.entries(managed)) lines.push(`${key}=${quoteEnv(value)}`);
  await fs.writeFile(resolveFromRoot(root, '.env'), `${lines.join('\n')}\n`, 'utf8');
}

async function readEnvLines(root) {
  try {
    return (await fs.readFile(resolveFromRoot(root, '.env'), 'utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function quoteEnv(value) {
  if (!value) return '';
  return String(value).replace(/\n/g, '').replace(/"/g, '\\"');
}
