import fs from 'node:fs/promises';
import { resolveFromRoot } from './env.js';

export const DEFAULT_CONFIG = {
  keywords: ['Agent Harness', 'A2A', 'Agentic'],
  sourceKeywords: {
    arxiv: ['Agent', 'Agentic', 'A2A', 'MCP', 'Tool Calling', 'Multi-Agent'],
    github: ['Agent', 'Agentic', 'A2A', 'MCP', 'Workflow', 'AI Coding'],
    xrss: ['A2A', 'MCP', 'Agentic', 'Agent Harness', 'Tool Calling']
  },
  blockedKeywords: ['giveaway', 'airdrop'],
  timezone: 'Asia/Shanghai',
  ingestion: {
    lookbackHours: 2,
    sourceLookbackHours: {
      arxiv: 168,
      github: 2,
      xrss: 6,
      twitter: 2
    },
    maxItemsPerSource: 100
  },
  digest: {
    sendHour: 9,
    prepareHour: 8,
    reportTitle: 'AI Agent Daily Digest',
    reportTitleSuffix: '',
    reportFooter: '',
    summaryInfo: '',
    window: 'rolling_prepare_time',
    minConfidence: 'medium',
    maxItems: 30,
    maxItemsPerSource: 10,
    useLlm: true,
    llmMaxCandidates: 8,
    llmMaxCandidatesPerSource: 10,
    llmMinRating: 'B',
    preventEmptySend: true,
    sourceQuota: {
      arxiv: 5,
      github: 4,
      xrss: 4
    }
  },
  scheduler: {
    enabled: true,
    timezone: 'Asia/Shanghai',
    collection: { enabled: true, intervalMinutes: 90, runOnStart: false, jitterSeconds: 20, distributed: true, fullCycleHours: 10 },
    prepare: { enabled: true, time: '08:30' },
    send: { enabled: true, time: '09:00' }
  },
  webui: { preset: 'balanced' },
  agentPolicy: {
    dailyWindow: 'previous_natural_day',
    lookbackHours: {
      arxiv: 168,
      github: 36,
      xrss: 24
    },
    fallbackLookbackHours: {
      xrss: 48
    },
    maxItems: 8,
    sourceQuota: {
      arxiv: 3,
      github: 3,
      xrss: 4
    },
    llmMaxCandidates: 20,
    llmMaxCandidatesPerSource: 8,
    llmMinRating: 'B'
  },
  sources: { arxiv: true, github: true, xrss: false, twitter: false },
  github: {
    searchTypes: ['repositories', 'issues'],
    minStarsForBoost: 50,
    trustedRepos: []
  },
  twitter: {
    provider: 'twscrape',
    language: 'en',
    excludeRetweets: true,
    limit: 100,
    trustedAccounts: [],
    minLikesForBoost: 20,
    minRepostsForBoost: 5
  },
  xrss: {
    instances: ['https://xcancel.com', 'https://nitter.poast.org', 'https://nitter.privacyredirect.com'],
    language: 'en',
    excludeRetweets: true,
    limit: 50
  },
  scoring: {
    highThreshold: 70,
    mediumThreshold: 45
  }
};

export async function loadConfig(env, root = process.cwd()) {
  const configPath = env.CONFIG_PATH || './config.json';
  try {
    const raw = await fs.readFile(resolveFromRoot(root, configPath), 'utf8');
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_CONFIG;
    throw error;
  }
}

function mergeConfig(base, override = {}) {
  return {
    ...base,
    ...override,
    sourceKeywords: { ...base.sourceKeywords, ...override.sourceKeywords },
    ingestion: { ...base.ingestion, ...override.ingestion },
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
