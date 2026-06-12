const state = { settings: null };
const PRESETS = {
  conservative: { interval: 120, minConfidence: 'high', maxItems: 8, llmMinRating: 'A', lookback: { arxiv: 168, github: 36, xrss: 12 }, quota: { arxiv: 3, github: 3, xrss: 2 }, llmMaxCandidates: 12 },
  balanced: { interval: 90, minConfidence: 'medium', maxItems: 12, llmMinRating: 'B', lookback: { arxiv: 168, github: 72, xrss: 24 }, quota: { arxiv: 5, github: 4, xrss: 4 }, llmMaxCandidates: 20 },
  broad: { interval: 180, minConfidence: 'medium', maxItems: 20, llmMinRating: 'B', lookback: { arxiv: 240, github: 120, xrss: 48 }, quota: { arxiv: 6, github: 6, xrss: 5 }, llmMaxCandidates: 35 }
};

const $ = (id) => document.getElementById(id);

init().catch(showError);

async function init() {
  await loadSettings();
  await loadStatus();
  $('saveSettings').onclick = guard(saveSettings, 'feishuMessage');
  $('testFeishu').onclick = guard(testFeishu, 'feishuMessage');
  $('addKeyword').onclick = () => addListItem('keywords', $('keywordInput'));
  $('addBlocked').onclick = () => addListItem('blockedKeywords', $('blockedInput'));
  $('testArxiv').onclick = guard(() => testSource('arxiv'), 'sourceMessage');
  $('testGithub').onclick = guard(() => testSource('github'), 'sourceMessage');
  $('testXrss').onclick = guard(() => testSource('xrss'), 'sourceMessage');
  $('strategyPreset').onchange = applyPresetToForm;
  $('runIngest').onclick = guard(runIngest, 'actionMessage');
  $('previewDigest').onclick = guard(previewDigest, 'actionMessage');
  $('prepareDigest').onclick = guard(prepareDigestAction, 'actionMessage');
  $('sendDigest').onclick = guard(sendDigest, 'actionMessage');
  $('refreshStatus').onclick = guard(loadStatus);
}

async function loadSettings() {
  const res = await api('/api/settings');
  state.settings = res.data;
  renderSettings();
}

function renderSettings() {
  const { env, config } = state.settings;
  $('feishuUrl').value = env.FEISHU_WEBHOOK_URL || '';
  $('feishuSecret').value = env.FEISHU_SECRET || '';
  $('sourceArxiv').checked = Boolean(config.sources.arxiv);
  $('sourceGithub').checked = Boolean(config.sources.github);
  $('sourceXrss').checked = Boolean(config.sources.xrss);
  $('strategyPreset').value = config.webui?.preset || 'balanced';
  $('collectionInterval').value = config.scheduler?.collection?.intervalMinutes || 90;
  $('prepareTime').value = config.scheduler?.prepare?.time || '08:30';
  $('sendTime').value = config.scheduler?.send?.time || '09:00';
  $('reportTitle').value = config.digest.reportTitle || 'AI Agent Daily Digest';
  $('reportTitleSuffix').value = config.digest.reportTitleSuffix || '';
  $('summaryInfo').value = config.digest.summaryInfo || '';
  $('minConfidence').value = config.digest.minConfidence;
  $('maxItems').value = config.digest.maxItems;
  $('llmMinRating').value = config.digest.llmMinRating || 'B';
  renderChips('keywords', config.keywords);
  renderChips('blockedKeywords', config.blockedKeywords);
}

function applyPresetToForm() {
  const preset = PRESETS[$('strategyPreset').value] || PRESETS.balanced;
  $('collectionInterval').value = preset.interval;
  $('minConfidence').value = preset.minConfidence;
  $('maxItems').value = preset.maxItems;
  $('llmMinRating').value = preset.llmMinRating;
}

function renderChips(kind, items) {
  const box = $(kind);
  box.innerHTML = '';
  for (const item of items || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = item;
    const btn = document.createElement('button');
    btn.textContent = 'x';
    btn.onclick = () => {
      state.settings.config[kind] = state.settings.config[kind].filter((value) => value !== item);
      renderChips(kind, state.settings.config[kind]);
    };
    chip.appendChild(btn);
    box.appendChild(chip);
  }
}

function addListItem(kind, input) {
  const value = input.value.trim();
  if (!value) return;
  state.settings.config[kind] = [...new Set([...(state.settings.config[kind] || []), value])];
  input.value = '';
  renderChips(kind, state.settings.config[kind]);
}

async function saveSettings() {
  const settings = collectSettings();
  const res = await api('/api/settings', { method: 'POST', body: settings });
  state.settings = res.data;
  renderSettings();
  showMessage('feishuMessage', '配置已保存');
}

async function testFeishu() {
  const settings = collectSettings();
  await api('/api/feishu/test', { method: 'POST', body: { env: settings.env } });
  showMessage('feishuMessage', '测试通知已发送，请检查飞书群');
}

async function testSource(source) {
  await saveSettings();
  const keyword = pickTestKeyword(source);
  $('sourceResult').textContent = `正在测试 ${source}...`;
  const res = await api('/api/source/test', { method: 'POST', body: { source, keyword, limit: 5, hours: 24 } });
  $('sourceResult').textContent = JSON.stringify(res.data, null, 2);
  showMessage('sourceMessage', `${source} 测试爬取完成，返回 ${res.data.count} 条`);
}

function pickTestKeyword(source) {
  const keywords = state.settings.config.keywords || [];
  if (source === 'xrss') return keywords.find((item) => item.length > 3 && item.toLowerCase() !== 'agent') || 'Agentic';
  return keywords[0] || 'Agentic';
}

async function runIngest() {
  await saveSettings();
  const source = $('manualSource').value;
  $('actionResult').textContent = '正在采集...';
  const res = await api('/api/ingest/run', { method: 'POST', body: { source } });
  $('actionResult').textContent = JSON.stringify(res.data, null, 2);
  await loadStatus();
  showMessage('actionMessage', '采集完成');
}

async function previewDigest() {
  await saveSettings();
  const date = $('digestDate').value;
  $('actionResult').textContent = '正在预览报告...';
  const res = await api('/api/digest/preview', { method: 'POST', body: { date } });
  $('actionResult').textContent = formatAgentResult(res.data);
  showMessage('actionMessage', '报告预览已生成');
}

async function prepareDigestAction() {
  await saveSettings();
  const date = $('digestDate').value;
  $('actionResult').textContent = '正在准备报告并写入去重记录...';
  const res = await api('/api/digest/prepare', { method: 'POST', body: { date } });
  $('actionResult').textContent = formatAgentResult(res.data);
  await loadStatus();
  showMessage('actionMessage', resultMessage(res.data, '报告已准备'));
}

async function sendDigest() {
  await saveSettings();
  const date = $('digestDate').value;
  $('actionResult').textContent = '正在推送已准备报告...';
  const res = await api('/api/digest/send', { method: 'POST', body: { date, force: false } });
  $('actionResult').textContent = JSON.stringify(res.data, null, 2);
  await loadStatus();
  showMessage('actionMessage', resultMessage(res.data, '已推送准备好的报告'));
}

function formatAgentResult(data) {
  const digest = data.digest || data;
  const trace = digest.llmTrace;
  if (!trace) return JSON.stringify(data, null, 2);
  const lines = [];
  lines.push(`Agent mode: ${data.mode || 'digest'}`);
  lines.push(`Candidates: total=${digest.candidateCount ?? '-'} selected_for_llm=${digest.selectedCandidateCount ?? '-'}`);
  lines.push(`LLM: enabled=${trace.enabled} model=${trace.model || '-'} analyzed=${trace.analyzed || 0} cached=${trace.cached || 0} retry_errors=${trace.retryableErrors || 0}`);
  lines.push(`Ratings: ${JSON.stringify(trace.ratings || {})}`);
  lines.push(`Approved items: ${digest.items?.length || digest.itemCount || 0}`);
  lines.push('');
  lines.push('LLM events:');
  for (const event of trace.events || []) {
    lines.push(`- [${event.level}] ${event.source || '-'} #${event.itemId || '-'} ${event.rating || ''} ${event.relevance ?? ''}`.trim());
    if (event.title) lines.push(`  title: ${event.title}`);
    if (event.reason) lines.push(`  reason: ${event.reason}`);
  }
  lines.push('');
  lines.push('Raw:');
  lines.push(JSON.stringify(data, null, 2));
  return lines.join('\n');
}

function collectSettings() {
  const next = structuredClone(state.settings);
  next.env.FEISHU_WEBHOOK_URL = $('feishuUrl').value.trim();
  next.env.FEISHU_SECRET = $('feishuSecret').value.trim();
  next.config.sources.arxiv = $('sourceArxiv').checked;
  next.config.sources.github = $('sourceGithub').checked;
  next.config.sources.xrss = $('sourceXrss').checked;
  next.config.sources.twitter = false;
  const presetName = $('strategyPreset').value || 'balanced';
  const preset = PRESETS[presetName] || PRESETS.balanced;
  next.config.webui = { ...(next.config.webui || {}), preset: presetName };
  next.config.scheduler = next.config.scheduler || {};
  next.config.scheduler.enabled = true;
  next.config.scheduler.timezone = next.config.timezone || 'Asia/Shanghai';
  next.config.scheduler.collection = { ...(next.config.scheduler.collection || {}), enabled: true, intervalMinutes: Number($('collectionInterval').value || preset.interval), runOnStart: false };
  next.config.scheduler.prepare = { ...(next.config.scheduler.prepare || {}), enabled: true, time: $('prepareTime').value || '08:30' };
  next.config.scheduler.send = { ...(next.config.scheduler.send || {}), enabled: true, time: $('sendTime').value || '09:00' };
  next.config.ingestion.lookbackHours = 2;
  next.config.ingestion.sourceLookbackHours = { ...preset.lookback, twitter: 2 };
  next.config.digest.reportTitle = $('reportTitle').value.trim() || 'AI Agent Daily Digest';
  next.config.digest.reportTitleSuffix = $('reportTitleSuffix').value.trim();
  next.config.digest.summaryInfo = $('summaryInfo').value.trim();
  next.config.digest.sendHour = Number(($('sendTime').value || '09:00').split(':')[0]);
  next.config.digest.prepareHour = Number(($('prepareTime').value || '08:30').split(':')[0]);
  next.config.digest.minConfidence = $('minConfidence').value;
  next.config.digest.maxItems = Number($('maxItems').value || 30);
  next.config.digest.maxItemsPerSource = Math.max(...Object.values(preset.quota));
  next.config.digest.llmMinRating = $('llmMinRating').value || preset.llmMinRating;
  next.config.digest.llmMaxCandidates = preset.llmMaxCandidates;
  next.config.digest.llmMaxCandidatesPerSource = 8;
  next.config.digest.sourceQuota = preset.quota;
  next.config.agentPolicy = next.config.agentPolicy || {};
  next.config.agentPolicy.dailyWindow = 'previous_natural_day';
  next.config.agentPolicy.lookbackHours = preset.lookback;
  next.config.agentPolicy.fallbackLookbackHours = { xrss: 48 };
  next.config.agentPolicy.maxItems = next.config.digest.maxItems;
  next.config.agentPolicy.sourceQuota = preset.quota;
  next.config.agentPolicy.llmMaxCandidates = preset.llmMaxCandidates;
  next.config.agentPolicy.llmMaxCandidatesPerSource = 8;
  next.config.agentPolicy.llmMinRating = next.config.digest.llmMinRating;
  return next;
}

async function loadStatus() {
  const res = await api('/api/status');
  $('statusBox').textContent = JSON.stringify(res.data, null, 2);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showNotice(message) {
  const el = $('notice');
  el.textContent = message;
  el.className = 'notice';
}

function showError(error, targetId) {
  if (targetId) {
    showMessage(targetId, error.message || String(error), true);
    return;
  }
  const el = $('notice');
  el.textContent = error.message || String(error);
  el.className = 'notice error';
}

function showMessage(targetId, message, isError = false) {
  const el = $(targetId);
  if (!el) return;
  el.textContent = message;
  el.className = `inline-message${isError ? ' error' : ''}`;
}

function resultMessage(data, fallback) {
  const digest = data.digest || data;
  if (digest?.skipped && digest.reason === 'digest already sent') return '这一天的报告已经推送过，系统不会重新准备或重复推送。';
  if (digest?.skipped && digest.reason === 'digest already prepared') return `这一天的报告已经准备好，条目数：${digest.itemCount || 0}`;
  if (digest?.skipped) return `已跳过：${digest.reason || '没有通过 LLM 的内容'}`;
  if (digest?.prepared) return `${fallback}，条目数：${digest.itemCount || digest.items?.length || 0}`;
  if (digest?.sent) return `${fallback}，条目数：${digest.itemCount}`;
  if (digest?.dryRun) return `${fallback}，预览条目数：${digest.items?.length || 0}`;
  return fallback;
}

function guard(fn, targetId) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      showError(error, targetId);
    }
  };
}
