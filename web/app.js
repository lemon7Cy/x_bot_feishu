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
  startBeijingClock();
  $('saveSettings').onclick = guard(saveSettings, 'feishuMessage');
  $('testFeishu').onclick = guard(testFeishu, 'feishuMessage');
  $('addKeyword').onclick = () => addListItem('keywords', $('keywordInput'));
  $('addBlocked').onclick = () => addListItem('blockedKeywords', $('blockedInput'));
  $('testArxiv').onclick = guard(() => testSource('arxiv'), 'sourceMessage');
  $('testGithub').onclick = guard(() => testSource('github'), 'sourceMessage');
  $('testXrss').onclick = guard(() => testSource('xrss'), 'sourceMessage');
  $('testLlm').onclick = guard(testLlm, 'sourceMessage');
  $('strategyPreset').onchange = applyPresetToForm;
  $('runIngest').onclick = guard(runIngest, 'actionMessage');
  $('previewDigest').onclick = guard(previewDigest, 'actionMessage');
  $('prepareDigest').onclick = guard(prepareDigestAction, 'actionMessage');
  $('sendDigest').onclick = guard(sendDigest, 'actionMessage');
  $('queryDigestStatus').onclick = guard(queryDigestStatus, 'digestStatusMessage');
  $('markDigestUnsent').onclick = guard(markDigestUnsent, 'digestStatusMessage');
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
  $('prepareBadge').textContent = config.scheduler?.prepare?.time || '08:30';
  $('sendBadge').textContent = config.scheduler?.send?.time || '09:00';
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

async function testLlm() {
  $('sourceResult').textContent = '正在测试 LLM 连通性...';
  const res = await api('/api/llm/test', { method: 'POST' });
  $('sourceResult').textContent = JSON.stringify(res.data, null, 2);
  showMessage('sourceMessage', `LLM 连通正常，耗时 ${res.data.latencyMs}ms，模型：${res.data.model}`);
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
  $('actionResult').textContent = '正在创建预览任务...';
  const res = await api('/api/digest/preview/jobs', { method: 'POST', body: { date } });
  showMessage('actionMessage', `预览任务已创建：#${res.data.jobId}`);
  await pollPreviewJob(res.data.jobId);
}

async function pollPreviewJob(jobId) {
  for (;;) {
    const res = await api(`/api/digest/preview/jobs/${jobId}`);
    const job = res.data;
    $('actionResult').textContent = formatJob(job);
    if (job.status === 'completed') {
      $('actionResult').textContent = `${formatJob(job)}\n\n${formatAgentResult(job.result)}`;
      showMessage('actionMessage', '报告预览已生成');
      return;
    }
    if (job.status === 'failed') throw new Error(job.error || '预览任务失败');
    await sleep(2000);
  }
}

function formatJob(job) {
  const lines = [];
  lines.push(`任务 #${job.id}：${job.status}`);
  lines.push(`创建：${job.createdAt}`);
  lines.push(`更新：${job.updatedAt}`);
  lines.push('');
  lines.push('进度：');
  for (const item of job.progress || []) lines.push(`- ${item}`);
  return lines.join('\n');
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

async function queryDigestStatus() {
  const date = $('statusDate').value;
  const suffix = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await api(`/api/digest/status${suffix}`);
  $('digestStatusResult').textContent = formatDigestStatus(res.data);
  showMessage('digestStatusMessage', digestStatusMessage(res.data));
}

async function markDigestUnsent() {
  const date = $('statusDate').value;
  const res = await api('/api/digest/mark-unsent', { method: 'POST', body: { date } });
  $('digestStatusResult').textContent = JSON.stringify(res.data, null, 2);
  showMessage('digestStatusMessage', res.data.changed ? '已改为未推送，可重新推送测试。' : `未修改：${res.data.reason}`);
}

function formatDigestStatus(data) {
  const digest = data.digest;
  const lines = [];
  lines.push(`北京时间：${data.beijingNow}`);
  lines.push(`日报日期：${data.window.date}`);
  lines.push(`窗口：${data.window.start} - ${data.window.end}`);
  lines.push(`准备时间：${data.scheduler?.prepare?.time || '-'}`);
  lines.push(`推送时间：${data.scheduler?.send?.time || '-'}`);
  if (!digest) {
    lines.push('状态：未生成');
  } else {
    lines.push(`状态：${digest.status}`);
    lines.push(`条目数：${digest.item_count}`);
    lines.push(`已生成：${digest.prepared_at || '-'}`);
    lines.push(`计划推送：${digest.send_due_at || '-'}`);
    lines.push(`已推送：${digest.sent_at || '-'}`);
    if (digest.error || digest.sent_error) lines.push(`错误：${digest.error || digest.sent_error}`);
  }
  lines.push('');
  lines.push('Raw:');
  lines.push(JSON.stringify(data, null, 2));
  return lines.join('\n');
}

function digestStatusMessage(data) {
  if (!data.digest) return `${data.window.date} 日报还没有生成`;
  if (data.digest.status === 'sent') return `${data.window.date} 日报已推送，条目数：${data.digest.item_count}`;
  if (data.digest.status === 'prepared') return `${data.window.date} 日报已生成但未推送，条目数：${data.digest.item_count}`;
  return `${data.window.date} 日报状态：${data.digest.status}`;
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
  $('statusBox').textContent = formatStatus(res.data);
}

function formatStatus(data) {
  const lines = [];
  lines.push('数据总量');
  for (const row of data.itemCounts || []) lines.push(`- ${sourceName(row.source)}：${row.count}`);
  lines.push('');
  lines.push('评分分布');
  for (const row of data.scoreCounts || []) lines.push(`- ${row.confidence}：${row.count}`);
  lines.push('');
  lines.push('最近采集');
  for (const row of data.latestIngestions || []) {
    lines.push(`- ${sourceName(row.source)} ${row.status}：新增 ${row.inserted_count}，更新 ${row.updated_count}，开始 ${fmtCnTime(row.started_at)}`);
    if (row.error) lines.push(`  错误：${row.error}`);
  }
  lines.push('');
  lines.push('最近日报');
  for (const row of data.latestDigest || []) {
    lines.push(`- #${row.id} ${row.status}：${row.item_count} 条，生成 ${fmtCnTime(row.prepared_at)}，推送 ${fmtCnTime(row.sent_at)}`);
    if (row.error) lines.push(`  错误：${row.error}`);
  }
  lines.push('');
  lines.push('最近定时任务');
  for (const row of data.latestSchedulerRuns || []) {
    lines.push(`- ${row.job_name} / ${row.job_type}：${row.status}，${fmtCnTime(row.started_at)} -> ${fmtCnTime(row.finished_at)}`);
    if (row.error) lines.push(`  错误：${row.error}`);
  }
  lines.push('');
  lines.push('最近 LLM 分析');
  for (const row of data.latestLlmAnalyses || []) lines.push(`- ${sourceName(row.source)} #${row.item_id} ${row.rating}/${row.relevance}：${row.title}`);
  return lines.join('\n');
}

function sourceName(source) {
  return { arxiv: 'arXiv', github: 'GitHub', xrss: 'X RSS', twitter: 'Twitter/X' }[source] || source;
}

function fmtCnTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startBeijingClock() {
  const tick = () => {
    $('beijingClock').textContent = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date());
  };
  tick();
  setInterval(tick, 1000);
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
