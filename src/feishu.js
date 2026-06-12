import crypto from 'node:crypto';
import { formatDate } from './time.js';
import { groupBy, truncate } from './utils.js';

const SOURCE_LABELS = {
  twitter: 'Twitter/X',
  xrss: 'X RSS',
  github: 'GitHub',
  arxiv: 'arXiv'
};

export function buildDigestCard(items, config, window, errors = []) {
  const keywordLine = config.keywords.map((keyword) => `<text_tag color=\"blue\">${escapeMd(keyword)}</text_tag>`).join(' ');
  const highCount = items.filter((item) => item.confidence === 'high').length;
  const mediumCount = items.filter((item) => item.confidence === 'medium').length;
  const elements = [
    {
      tag: 'markdown',
      content: `**窗口** ${window.date} 00:00-23:59 ${window.timezone}\n**条目** ${items.length} | **High** ${highCount} | **Medium** ${mediumCount}\n**关键词** ${keywordLine}`
    }
  ];
  if (items.length === 0) {
    elements.push({ tag: 'markdown', content: '前一天没有达到推送阈值的新内容。' });
  } else {
    for (const [source, group] of groupBy(items, (item) => item.source)) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `**${SOURCE_LABELS[source] || source}**` });
      for (const item of group) {
        const keywords = (item.matchedKeywords || []).join(', ') || '-';
        const analysis = item.llmAnalysis;
        const raw = analysisRaw(analysis);
        const body = analysis
          ? analysisBody(analysis, raw)
          : escapeMd(truncate(item.summary || '', 220));
        elements.push({
          tag: 'markdown',
          content: `[${escapeMd(item.title)}](${item.canonical_url})\n${body}\n来源：${escapeMd(item.author || SOURCE_LABELS[item.source] || item.source)} | 时间：${formatDate(item.published_at, config.timezone)} | 规则分：${item.confidence} ${item.score} | 关键词：${escapeMd(keywords)}`
        });
      }
    }
  }

  if (errors.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**采集提示**\n${errors.map((error) => `- ${escapeMd(error)}`).join('\n')}` });
  }

  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `Window UTC: ${window.start.toISOString()} - ${window.end.toISOString()}` }] });
  if (config.digest?.reportFooter) elements.push({ tag: 'markdown', content: escapeMd(config.digest.reportFooter) });

  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: digestTitle(config, window) }, template: 'blue' },
      elements
    }
  };
}

function analysisBody(analysis, raw) {
  return `**摘要**：${escapeMd(raw.factual_summary || analysis.summary)}\n**重点**：${escapeMd(raw.why_it_matters || analysis.strengths || analysis.reason || '-')}`;
}

function analysisRaw(analysis) {
  if (!analysis?.raw_json) return analysis || {};
  try { return JSON.parse(analysis.raw_json); } catch { return analysis || {}; }
}

function digestTitle(config, window) {
  const base = config.digest?.reportTitle || 'AI Agent Daily Digest';
  const suffix = config.digest?.reportTitleSuffix ? ` ${config.digest.reportTitleSuffix}` : '';
  return `${base}${suffix} | ${window.date}`;
}

export function buildTestCard() {
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'AI Agent Monitor Test' }, template: 'green' },
      elements: [{ tag: 'markdown', content: '飞书机器人配置正常。' }]
    }
  };
}

export async function sendFeishu(card, env) {
  if (!env.FEISHU_WEBHOOK_URL) throw new Error('FEISHU_WEBHOOK_URL is required.');
  const body = { ...card };
  if (env.FEISHU_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = crypto.createHmac('sha256', `${timestamp}\n${env.FEISHU_SECRET}`).digest('base64');
  }
  const response = await fetch(env.FEISHU_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Feishu webhook failed: ${response.status} ${text}`);
  try {
    const data = JSON.parse(text);
    if (data.code && data.code !== 0) throw new Error(`Feishu webhook error: ${text}`);
  } catch (error) {
    if (error.message.startsWith('Feishu webhook error')) throw error;
  }
}

function escapeMd(text) {
  return String(text || '').replace(/[<>—]/g, (char) => {
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    return '-';
  });
}
