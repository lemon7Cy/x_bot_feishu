import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterTrace, limitDigestItems } from '../src/digest.js';

function item(id, source, rating, relevance, options = {}) {
  return {
    id,
    source,
    score: options.score || 70,
    confidence: options.confidence || 'medium',
    llmAnalysis: {
      rating,
      relevance,
      raw_json: JSON.stringify({ hallucination_risk: options.risk || 'low', evidence: options.evidence ?? ['source evidence'], category: options.category || 'info' })
    }
  };
}

test('buildFilterTrace filters rating, hallucination risk, and missing evidence', () => {
  const trace = buildFilterTrace([
    item(1, 'github', 'A', 90),
    item(2, 'github', 'C', 70),
    item(3, 'xrss', 'B', 82, { risk: 'high' }),
    item(4, 'arxiv', 'B', 70, { evidence: [] })
  ], { digest: { llmMinRating: 'B' } });
  assert.deepEqual(trace.items.map((entry) => entry.id), [1]);
  assert.equal(trace.dropped.rating_C, 1);
  assert.equal(trace.dropped.high_hallucination_risk, 1);
  assert.equal(trace.dropped.missing_evidence, 1);
});

test('limitDigestItems allows source backfill while keeping product/social caps', () => {
  const config = {
    digest: {
      maxItems: 4,
      maxItemsPerSource: 2,
      sourceQuota: { arxiv: 2, github: 1, xrss: 1 },
      allowSourceBackfill: true,
      contentMix: { infoMinRatio: 0.5, productMaxRatio: 0.25, socialMaxItems: 1 }
    }
  };
  const limited = limitDigestItems([
    item(1, 'github', 'A', 95),
    item(2, 'github', 'A', 94),
    item(3, 'github', 'B', 93),
    item(4, 'xrss', 'B', 90, { category: 'product' }),
    item(5, 'xrss', 'B', 89, { category: 'product' }),
    item(6, 'xrss', 'B', 88, { category: 'social' })
  ], config);
  assert.deepEqual(limited.map((entry) => entry.id), [1, 4, 2, 3]);
  assert.equal(limited.includes(5), false);
});
