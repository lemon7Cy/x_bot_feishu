import { keywordMatches, matchKeywords } from './utils.js';
import { authoritySignal } from './authority.js';

export function scoreItem(item, config) {
  let score = 0;
  const reasons = [];
  const matched = collectMatches(item, config.keywords || []);

  for (const match of matched) {
    const points = keywordPoints(match);
    score += points;
    reasons.push({ rule: `keyword:${match.field}`, points, detail: match.keyword });
  }
  if (new Set(matched.map((match) => match.keyword)).size > 1) {
    score += 5;
    reasons.push({ rule: 'keyword:multiple', points: 5, detail: 'multiple configured keywords' });
  }

  if (item.source === 'arxiv') add(15, 'source:arxiv', 'paper');
  if (item.source === 'github' && item.sourceType === 'repo') {
    const stars = Number(item.raw?.stars || 0);
    if (stars >= 1000) add(45, 'github:stars:very_hot', String(stars));
    else if (stars >= 500) add(35, 'github:stars:hot', String(stars));
    else if (stars >= 100) add(25, 'github:stars:popular', String(stars));
    else if (stars >= (config.github?.minStarsForBoost || 50)) add(15, 'github:stars:noticed', String(stars));
    else if (stars < 10) add(-25, 'github:stars:too_low', String(stars));
    else add(-10, 'github:stars:low', String(stars));
  }
  if (item.source === 'github' && item.sourceType !== 'repo') add(-20, 'github:discussion:not_project', item.sourceType);
  if (item.source === 'github') {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    if (text.includes('config files for my github profile')) add(-40, 'github:profile_repo', 'profile repository');
    if (text.includes('no description')) add(-15, 'github:no_description', 'missing description');
    if (text.includes('for fun') || text.includes('test repo')) add(-15, 'github:toy_signal', 'toy/test wording');
  }
  if (item.source === 'twitter') {
    const trusted = config.twitter?.trustedAccounts || [];
    if (trusted.includes(String(item.author || '').replace(/^@/, ''))) add(8, 'twitter:trusted_account', item.author);
    const likes = Number(item.raw?.likeCount || 0);
    const reposts = Number(item.raw?.repostCount || 0);
    if (likes >= (config.twitter?.minLikesForBoost || 20) || reposts >= (config.twitter?.minRepostsForBoost || 5)) {
      add(5, 'twitter:engagement', `likes=${likes} reposts=${reposts}`);
    }
  }
  if (item.source === 'xrss') add(5, 'source:x_rss', item.raw?.instance || 'rss');
  const authority = authoritySignal({ ...item, raw_json: JSON.stringify(item.raw || {}) });
  if (authority) add(8, 'authority:source', authority.label);
  const productSignals = collectProductSignals(`${item.title} ${item.summary} ${item.raw?.keyword || ''}`, config);
  for (const signal of productSignals) add(signal.points, signal.rule, signal.detail);

  const blocked = matchKeywords(`${item.title} ${item.summary}`, config.blockedKeywords || []);
  for (const keyword of blocked) add(-30, 'blocked_keyword', keyword);
  if (!item.author) add(-10, 'metadata:missing_author', 'missing author');

  const high = config.scoring?.highThreshold ?? 70;
  const medium = config.scoring?.mediumThreshold ?? 45;
  const confidence = score >= high ? 'high' : score >= medium ? 'medium' : 'low';
  return { score, confidence, reasons, matchedKeywords: matched };

  function add(points, rule, detail) {
    score += points;
    reasons.push({ rule, points, detail });
  }
}

function collectProductSignals(text, config) {
  if (config.productIntel?.enabled === false) return [];
  const value = String(text || '').toLowerCase();
  const signals = [];
  const productTerms = [
    ['product hunt', 15, 'product:product_hunt'],
    ['launch', 10, 'product:launch'],
    ['introducing', 10, 'product:introducing'],
    ['now supports', 10, 'product:supports'],
    ['mcp support', 14, 'product:mcp_support'],
    ['agent platform', 14, 'product:agent_platform'],
    ['ai coding', 12, 'product:ai_coding'],
    ['ai workflow', 10, 'product:workflow'],
    ['browser agent', 10, 'product:browser_agent'],
    ['changelog', 8, 'product:changelog'],
    ['release', 8, 'product:release']
  ];
  for (const [term, points, rule] of productTerms) {
    if (keywordMatches(value, term)) signals.push({ points, rule, detail: term });
  }
  const spamTerms = ['claim free', 'presale', 'airdrop', 'giveaway', 'earn rewards', 'token sale'];
  for (const term of spamTerms) {
    if (keywordMatches(value, term)) signals.push({ points: -35, rule: 'product:spam_signal', detail: term });
  }
  return signals;
}

function keywordPoints(match) {
  const keyword = match.keyword.toLowerCase();
  if (match.field === 'source_query') return 5;
  if (keyword === 'agent' || keyword === 'harness') return match.field === 'title' ? 8 : 4;
  return match.field === 'title' ? 25 : 15;
}

function collectMatches(item, keywords) {
  const matches = [];
  for (const keyword of matchKeywords(item.title, keywords)) matches.push({ keyword, field: 'title' });
  for (const keyword of matchKeywords(item.summary, keywords)) {
    if (!matches.some((match) => match.keyword === keyword && match.field === 'summary')) matches.push({ keyword, field: 'summary' });
  }
  if (item.raw?.keyword && keywords.includes(item.raw.keyword) && !matches.some((match) => match.keyword === item.raw.keyword)) {
    matches.push({ keyword: item.raw.keyword, field: 'source_query' });
  }
  return matches;
}
