import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreItem } from '../src/scoring.js';
import { matchKeywords } from '../src/utils.js';

test('matchKeywords uses word boundaries for English terms', () => {
  assert.deepEqual(matchKeywords('reagent benchmark', ['agent']), []);
  assert.deepEqual(matchKeywords('agent-based workflow', ['agent']), ['agent']);
  assert.deepEqual(matchKeywords('MCP-compatible server', ['MCP']), ['MCP']);
  assert.deepEqual(matchKeywords('randommcpserver', ['MCP']), []);
});

test('scoreItem does not boost substring-only keyword hits', () => {
  const item = {
    source: 'github',
    sourceType: 'repo',
    title: 'reagent benchmark',
    summary: 'chemistry tooling',
    author: 'dev',
    raw: { stars: 120 }
  };
  const result = scoreItem(item, { keywords: ['agent'], github: { minStarsForBoost: 50 }, scoring: { highThreshold: 70, mediumThreshold: 45 } });
  assert.equal(result.matchedKeywords.length, 0);
  assert.equal(result.reasons.some((reason) => reason.rule.startsWith('keyword:')), false);
});

test('scoreItem still matches phrase and source query keywords', () => {
  const item = {
    source: 'github',
    sourceType: 'repo',
    title: 'Claude Code workflow tools',
    summary: 'Agent harness for AI coding',
    author: 'dev',
    raw: { stars: 500, keyword: 'MCP' }
  };
  const result = scoreItem(item, { keywords: ['Claude Code', 'AI Coding', 'MCP'], github: { minStarsForBoost: 50 }, scoring: { highThreshold: 70, mediumThreshold: 45 } });
  assert.deepEqual(result.matchedKeywords.map((match) => `${match.keyword}:${match.field}`), ['Claude Code:title', 'AI Coding:summary', 'MCP:source_query']);
  assert.equal(result.confidence, 'high');
});
