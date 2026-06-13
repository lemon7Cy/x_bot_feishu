export function keywordsForSource(config, source) {
  const specific = config.sourceKeywords?.[source];
  const keywords = Array.isArray(specific) && specific.length > 0 ? specific : config.keywords;
  return [...new Set((keywords || []).map((item) => String(item).trim()).filter(Boolean))];
}

export function configForSourceKeywords(config, source, keywords) {
  return { ...config, keywords: keywords?.length ? keywords : keywordsForSource(config, source) };
}
