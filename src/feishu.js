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
  if (config.digest?.summaryInfo) {
    elements.push({ tag: 'markdown', content: `${sectionTag('汇总说明')}\n${escapeMd(config.digest.summaryInfo)}` });
  }
  if (items.length === 0) {
    elements.push({ tag: 'markdown', content: '当前统计窗口没有达到推送阈值的新内容。' });
  } else {
    for (const [bucket, group] of groupBy(items, contentGroup)) {
      elements.push({ tag: 'hr' });
      elements.push(platformTitle(bucket));
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

function contentGroup(item) {
  const raw = analysisRaw(item.llmAnalysis);
  const category = String(raw.category || item.llmAnalysis?.category || '').toLowerCase();
  if (category === 'product') return '产品动态';
  if (category === 'social') return '社媒线索';
  return '信息情报';
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
  const retries = Math.max(0, Number(env.FEISHU_RETRIES ?? 3));
  const delays = retryDelays(env.FEISHU_RETRY_DELAYS_MS);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await sendFeishuOnce(card, env);
      return;
    } catch (error) {
      if (attempt >= retries || !isTransientFeishuError(error)) throw error;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      console.warn(`[feishu] transient send failure, retry ${attempt + 1}/${retries} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
}

async function sendFeishuOnce(card, env) {
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
  if (!response.ok) {
    const error = new Error(`Feishu webhook failed: ${response.status} ${text}`);
    error.feishuStatus = response.status;
    error.transient = response.status === 429 || response.status >= 500;
    throw error;
  }
  try {
    const data = JSON.parse(text);
    if (data.code && data.code !== 0) {
      const error = new Error(`Feishu webhook error: ${text}`);
      error.feishuCode = Number(data.code);
      error.transient = isTransientFeishuCode(error.feishuCode);
      throw error;
    }
  } catch (error) {
    if (error.message.startsWith('Feishu webhook error')) throw error;
  }
}

function isTransientFeishuCode(code) {
  return [19006].includes(Number(code));
}

function isTransientFeishuError(error) {
  if (error.transient) return true;
  return /fetch failed|network|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(error.message || '');
}

function retryDelays(value) {
  const configured = String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return configured.length > 0 ? configured : [5000, 15000, 30000];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeMd(text) {
  return String(text || '').replace(/[<>—]/g, (char) => {
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    return '-';
  });
}
