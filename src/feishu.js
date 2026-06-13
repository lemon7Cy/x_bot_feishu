import crypto from 'node:crypto';
import { authoritySignal } from './authority.js';
import { formatDate } from './time.js';
import { groupBy, truncate } from './utils.js';

const SOURCE_LABELS = {
  twitter: 'Twitter/X',
  xrss: 'X RSS',
  github: 'GitHub',
  arxiv: 'arXiv'
};

const TAG_COLOR = 'blue';

export function buildDigestCard(items, config, window, errors = []) {
  const keywordLine = config.keywords.map((keyword) => colorTag(keyword, 'orange')).join(' ');
  const highCount = items.filter((item) => item.confidence === 'high').length;
  const mediumCount = items.filter((item) => item.confidence === 'medium').length;
  const elements = [
    {
      tag: 'markdown',
      content: `${labelTag('窗口')} ${windowRange(window)} ${window.timezone}\n${labelTag('条目')} ${items.length} ${labelTag('High')} ${highCount} ${labelTag('Medium')} ${mediumCount}\n${labelTag('关键词')} ${keywordLine}`
    }
  ];
  if (items.length === 0) {
    elements.push({ tag: 'markdown', content: '当前统计窗口没有达到推送阈值的新内容。' });
  } else {
    for (const [source, group] of groupBy(items, (item) => item.source)) {
      elements.push({ tag: 'hr' });
      elements.push(platformTitle(SOURCE_LABELS[source] || source));
      for (const item of group) {
        const keywords = (item.matchedKeywords || []).join(', ') || '-';
        const analysis = item.llmAnalysis;
        const raw = analysisRaw(analysis);
        const body = analysis
          ? analysisBody(analysis, raw)
          : escapeMd(truncate(item.summary || '', 220));
        elements.push({
          tag: 'markdown',
          content: `[${escapeMd(item.title)}](${item.canonical_url})\n${body}\n${itemMetaLine(item, keywords, config)}`
        });
      }
    }
  }

  if (errors.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `${sectionTag('采集提示')}\n${errors.map((error) => `- ${escapeMd(error)}`).join('\n')}` });
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
  const category = categoryLabel(raw.category || analysis.category);
  const categoryLine = category ? `${labelTag('类别')} ${colorTag(category, category === 'AI产品' ? 'green' : 'blue')}\n` : '';
  return `${categoryLine}${labelTag('摘要')} ${escapeMd(raw.factual_summary || analysis.summary)}\n${labelTag('重点')} ${escapeMd(raw.why_it_matters || analysis.strengths || analysis.reason || '-')}`;
}

function categoryLabel(category) {
  const labels = { research: '论文研究', opensource: '开源项目', product: 'AI产品', social: '社媒线索', noise: '噪声' };
  return labels[String(category || '').toLowerCase()] || '';
}

function windowRange(window) {
  return `${formatDate(window.start, window.timezone)} - ${formatDate(window.end, window.timezone)}`;
}

function itemMetaLine(item, keywords, config) {
  const authority = authoritySignal(item);
  const authorityText = authority ? ` ${colorTag('权威来源', 'red')} ${escapeMd(authority.label)}` : '';
  return `${labelTag('来源')} ${escapeMd(item.author || SOURCE_LABELS[item.source] || item.source)} ${labelTag('时间')} ${formatDate(item.published_at, config.timezone)} ${labelTag('规则分')} ${item.confidence} ${item.score} ${labelTag('关键词')} ${escapeMd(keywords)}${authorityText}`;
}

function labelTag(text) {
  return `<text_tag color="${TAG_COLOR}">${escapeMd(text)}</text_tag>`;
}

function sectionTag(text) {
  return `<text_tag color="${TAG_COLOR}">${escapeMd(text)}</text_tag>`;
}

function colorTag(text, color) {
  return `<text_tag color="${color}">${escapeMd(text)}</text_tag>`;
}

function platformTitle(text) {
  return {
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${escapeMd(text)}**`
    }
  };
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
