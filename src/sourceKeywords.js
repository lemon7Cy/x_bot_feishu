export function keywordsForSource(config, source) {
  const specific = config.sourceKeywords?.[source];
  const baseKeywords = Array.isArray(specific) && specific.length > 0 ? specific : config.keywords;
  const productKeywords = config.productIntel?.enabled === false ? [] : config.productIntel?.keywords || [];
  const keywords = [...(baseKeywords || []), ...productKeywords];
  return [...new Set((keywords || []).map((item) => String(item).trim()).filter(Boolean))];
}

export function configForSourceKeywords(config, source, keywords) {
  return { ...config, keywords: keywords?.length ? keywords : keywordsForSource(config, source) };
}
