const AUTHORITATIVE_ORGS = [
  { match: /\bopenai\b/i, label: 'OpenAI', category: 'company' },
  { match: /\banthropic\b/i, label: 'Anthropic', category: 'company' },
  { match: /\bdeepmind\b|\bgoogle research\b|\bgoogle ai\b/i, label: 'Google DeepMind/Research', category: 'company' },
  { match: /\bmeta ai\b|\bfair\b|\bfacebook ai\b/i, label: 'Meta AI', category: 'company' },
  { match: /\bmicrosoft research\b|\bmsr\b/i, label: 'Microsoft Research', category: 'company' },
  { match: /\bnvidia\b/i, label: 'NVIDIA', category: 'company' },
  { match: /\bapple\b/i, label: 'Apple', category: 'company' },
  { match: /\bamazon science\b|\baws ai\b/i, label: 'Amazon/AWS', category: 'company' },
  { match: /\bibm research\b|\bibm\b/i, label: 'IBM Research', category: 'company' },
  { match: /\bsalesforce research\b/i, label: 'Salesforce Research', category: 'company' },
  { match: /\bqwen\b|\balibaba\b|\bdamo\b/i, label: 'Qwen/Alibaba', category: 'company' },
  { match: /\bbaichuan\b/i, label: 'Baichuan', category: 'company' },
  { match: /\bmoonshot\b|\bkimi\b/i, label: 'Moonshot AI/Kimi', category: 'company' },
  { match: /\b01\.ai\b|\byi[- ]?large\b/i, label: '01.AI', category: 'company' },
  { match: /\bbytedance\b|\bseed\b/i, label: 'ByteDance Seed', category: 'company' },
  { match: /\btencent\b|\bhunyuan\b/i, label: 'Tencent Hunyuan', category: 'company' },
  { match: /\btsinghua\b/i, label: 'Tsinghua University', category: 'university' },
  { match: /\bpeking university\b|\bpku\b/i, label: 'Peking University', category: 'university' },
  { match: /\bstanford\b/i, label: 'Stanford', category: 'university' },
  { match: /\bmit\b|\bcsail\b/i, label: 'MIT/CSAIL', category: 'university' },
  { match: /\bberkeley\b|\buc berkeley\b/i, label: 'UC Berkeley', category: 'university' },
  { match: /\bcarnegie mellon\b|\bcmu\b/i, label: 'CMU', category: 'university' },
  { match: /\boxford\b/i, label: 'Oxford', category: 'university' },
  { match: /\bcambridge\b/i, label: 'Cambridge', category: 'university' },
  { match: /\beth zurich\b|\bethz\b/i, label: 'ETH Zurich', category: 'university' },
  { match: /\bucsd\b|\buc san diego\b/i, label: 'UC San Diego', category: 'university' },
  { match: /\buiuc\b|\billinois\b/i, label: 'UIUC', category: 'university' }
];

const GITHUB_ORGS = new Map([
  ['openai', 'OpenAI'],
  ['anthropics', 'Anthropic'],
  ['google-deepmind', 'Google DeepMind'],
  ['google-research', 'Google Research'],
  ['google', 'Google'],
  ['facebookresearch', 'Meta AI'],
  ['meta-llama', 'Meta AI'],
  ['microsoft', 'Microsoft'],
  ['microsoftresearch', 'Microsoft Research'],
  ['nvidia', 'NVIDIA'],
  ['apple', 'Apple'],
  ['aws', 'AWS'],
  ['ibm', 'IBM'],
  ['salesforce', 'Salesforce'],
  ['qwenlm', 'Qwen/Alibaba'],
  ['modelscope', 'ModelScope/Alibaba'],
  ['alibaba', 'Alibaba'],
  ['baichuan-inc', 'Baichuan'],
  ['moonshotai', 'Moonshot AI'],
  ['01-ai', '01.AI'],
  ['bytedance', 'ByteDance'],
  ['tencent', 'Tencent'],
  ['thudm', 'Tsinghua KEG/THUDM'],
  ['stanfordnlp', 'Stanford'],
  ['stanford-crfm', 'Stanford CRFM'],
  ['mit', 'MIT'],
  ['berkeley-ai-research', 'UC Berkeley BAIR']
]);

export function authoritySignal(item) {
  const raw = parseRaw(item.raw_json || item.raw);
  if (item.source === 'github') {
    const owner = String(item.author || raw.repo?.split('/')?.[0] || '').toLowerCase();
    if (GITHUB_ORGS.has(owner)) {
      return { label: GITHUB_ORGS.get(owner), category: 'github_org', reason: `GitHub owner: ${owner}` };
    }
  }
  const haystack = [item.title, item.summary, item.author, raw.authors, raw.repo].filter(Boolean).join(' ');
  for (const org of AUTHORITATIVE_ORGS) {
    if (org.match.test(haystack)) return { label: org.label, category: org.category, reason: 'matched title/summary/metadata' };
  }
  return null;
}

function parseRaw(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}
