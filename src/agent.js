import { ingest } from './ingest.js';
import { runDigest } from './digest.js';

export async function runDailyAgent(db, config, env, options = {}, root = process.cwd()) {
  const now = new Date();
  const policy = config.agentPolicy || {};
  const lookback = policy.lookbackHours || {};
  const windows = {
    arxiv: hoursWindow(lookback.arxiv || 168, now),
    github: hoursWindow(lookback.github || 36, now),
    xrss: hoursWindow(lookback.xrss || 24, now)
  };
  const sources = ['arxiv', 'github', 'xrss'].filter((source) => config.sources?.[source]);
  const ingestions = [];
  for (const source of sources) {
    ingestions.push(await ingest(db, config, env, { source, since: windows[source].since.toISOString(), until: windows[source].until.toISOString() }, root));
  }
  const digestConfig = applyAgentDigestPolicy(config);
  const digest = await runDigest(db, digestConfig, env, { date: options.date, dryRun: options.dryRun, force: options.force });
  return { mode: 'daily-agent', policy, ingestions, digest };
}

function applyAgentDigestPolicy(config) {
  const policy = config.agentPolicy || {};
  return {
    ...config,
    digest: {
      ...config.digest,
      maxItems: policy.maxItems || config.digest?.maxItems,
      maxItemsPerSource: Math.max(...Object.values(policy.sourceQuota || { default: config.digest?.maxItemsPerSource || 10 })),
      llmMaxCandidates: policy.llmMaxCandidates || config.digest?.llmMaxCandidates,
      llmMaxCandidatesPerSource: policy.llmMaxCandidatesPerSource || config.digest?.llmMaxCandidatesPerSource,
      llmMinRating: policy.llmMinRating || config.digest?.llmMinRating,
      sourceQuota: policy.sourceQuota || config.digest?.sourceQuota
    }
  };
}

function hoursWindow(hours, now) {
  return { since: new Date(now.getTime() - hours * 60 * 60 * 1000), until: now };
}
