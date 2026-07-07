import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const DEFAULT_PORTFOLIO = 'data/portfolio.json';
const DEFAULT_SOURCES = 'data/sources.json';
const DEFAULT_PROFILES_DIR = 'data/profiles';
const DEFAULT_TEMPLATES_DIR = 'data/templates';
const MAX_MESSAGE_LENGTH = 3900;
const USER_AGENT = 'Mozilla/5.0 berkshire-watcher/0.1';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    selfTest();
    return;
  }

  const portfolio = await readJson(args.portfolio || DEFAULT_PORTFOLIO);
  const items = await loadPortfolioItems(portfolio.items || []);
  const sources = await readOptionalJson(args.sources || DEFAULT_SOURCES, { groups: {} });
  const events = args.events
    ? await readJson(args.events)
    : await collectEvents(items, sources);

  const alerts = (await Promise.all(items
    .filter(item => item.status !== 'paused')
    .map(item => analyzeItem(item, events, sources))))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (alerts.length === 0) {
    console.log('No portfolio alerts.');
    return;
  }

  const message = (await Promise.all(alerts.map(formatAlert))).join('\n\n---\n\n');
  console.log(message);

  if (!args.dryRun && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendTelegram(message);
  }
}

function parseArgs(args) {
  const parsed = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') parsed.dryRun = true;
    else if (args[i] === '--self-test') parsed.selfTest = true;
    else if (args[i] === '--portfolio') parsed.portfolio = args[++i];
    else if (args[i] === '--sources') parsed.sources = args[++i];
    else if (args[i] === '--events') parsed.events = args[++i];
  }
  return parsed;
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function readOptionalJson(path, fallback) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function loadPortfolioItems(items) {
  return Promise.all(items.map(async item => {
    const profile = await readOptionalJson(`${DEFAULT_PROFILES_DIR}/${item.profile || item.ticker}.json`, {});
    const templateName = item.template || profile.template;
    const template = templateName
      ? await readOptionalJson(`${DEFAULT_TEMPLATES_DIR}/${templateName}.json`, {})
      : {};

    return mergeItem(template, profile, item);
  }));
}

function mergeItem(...parts) {
  return parts.reduce((merged, part) => mergeValue(merged, part || {}), {});
}

function mergeValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return uniqueBy([...right, ...left], value => JSON.stringify(value));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const merged = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value;
    }
    return merged;
  }
  return right;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

async function collectEvents(items, sources) {
  const all = [];

  for (const item of items.filter(item => item.status !== 'paused')) {
    const queries = buildQueries(item, sources).slice(0, Number(process.env.MAX_QUERIES_PER_ITEM || 12));
    for (const query of queries) {
      const events = await fetchGoogleNews(query.query);
      all.push(...events.map(event => ({
        ...event,
        portfolioTicker: item.ticker,
        query: query.query,
        querySource: query.source || null,
      })));
      await sleep(300);
    }
  }

  return enrichEvents(recentEvents(dedupeEvents(all)).slice(0, 80));
}

function buildQueries(item, sources) {
  const manual = Array.isArray(item.watch_queries) ? item.watch_queries : [];
  const fallback = [isAmbiguousTicker(item) ? null : item.ticker, item.name, ...(item.themes || [])]
    .filter(Boolean)
    .map(query => ({ query, why: '기본 감시 쿼리' }));
  const sourceQueries = buildSourceQueries(item, manual, sources);
  return uniqueBy([...manual, ...sourceQueries, ...fallback], entry => entry.query.toLowerCase());
}

function buildSourceQueries(item, manualQueries, sources) {
  const baseQueries = manualQueries.slice(0, 2);
  const selectedSources = sourcesForItem(item, sources)
    .filter(source => source.domain)
    .slice(0, Number(process.env.MAX_SOURCE_FILTERS || 5));

  return selectedSources.flatMap(source => baseQueries.map(query => ({
    query: `${query.query} site:${source.domain}`,
    why: `${query.why} · ${source.name} 기준`,
    source,
  })));
}

function sourcesForItem(item, sources) {
  const groups = item.source_groups || sources.default_groups || [];
  const grouped = groups.flatMap(group => sources.groups?.[group] || []);
  return uniqueBy([...(item.trusted_sources || []), ...grouped], source => `${source.domain || source.name}`.toLowerCase());
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    console.warn(`Google News fetch failed for "${query}": ${response.status}`);
    return [];
  }

  return parseRss(await response.text());
}

async function enrichEvents(events) {
  const limit = Number(process.env.MAX_ARTICLE_FETCHES || 30);
  const enriched = [];

  for (const event of events) {
    if (enriched.length >= limit) {
      enriched.push(event);
      continue;
    }

    enriched.push(await enrichEvent(event));
    await sleep(150);
  }

  return enriched;
}

async function enrichEvent(event) {
  try {
    const articleUrl = await resolveArticleUrl(event.url);
    const body = articleUrl ? await fetchArticleText(articleUrl) : '';
    return { ...event, url: articleUrl || event.url, articleChecked: true, ...(body ? { body } : {}) };
  } catch (error) {
    console.warn(`Article fetch failed for "${event.title}": ${error.message}`);
    return { ...event, articleChecked: true };
  }
}

async function resolveArticleUrl(url) {
  if (!url || !domainFromUrl(url).endsWith('news.google.com')) return url;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(Number(process.env.ARTICLE_TIMEOUT_MS || 8000)),
  });
  if (!response.ok) return url;

  const html = await response.text();
  const articleId = html.match(/data-n-a-id="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  if (!articleId || !timestamp || !signature) return url;

  return decodeGoogleNewsUrl(articleId, timestamp, signature) || url;
}

async function decodeGoogleNewsUrl(articleId, timestamp, signature) {
  const rpc = JSON.stringify([[[
    'Fbv4je',
    JSON.stringify([
      'garturlreq',
      [['en-US', 'US', ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'], null, null, 1, 1, 'US:en', null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]]],
      'en-US',
      'US',
      1,
      [2, 3, 4, 8],
      1,
      0,
      '655000234',
      0,
      0,
      null,
      0,
      articleId,
      Number(timestamp),
      signature,
    ]),
    null,
    'generic',
  ]]]);

  const response = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({ 'f.req': rpc }),
    signal: AbortSignal.timeout(Number(process.env.ARTICLE_TIMEOUT_MS || 8000)),
  });
  if (!response.ok) return '';

  const text = await response.text();
  const payload = JSON.parse(text.slice(text.indexOf('[')));
  const result = JSON.parse(payload.find(entry => entry[1] === 'Fbv4je')?.[2] || '[]');
  return result[1] || '';
}

async function fetchArticleText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(Number(process.env.ARTICLE_TIMEOUT_MS || 8000)),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return '';

  return extractArticleText(await response.text());
}

function extractArticleText(html) {
  const block = extractHtmlBlock(html, 'article') || extractHtmlBlock(html, 'main') || html;
  const cleaned = block
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  const paragraphs = uniqueBy(
    [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(match => stripHtml(match[1]))
      .filter(isArticleParagraph),
    paragraph => paragraph,
  );

  return truncateText(paragraphs.join('\n'), Number(process.env.MAX_ARTICLE_CHARS || 6000));
}

function extractHtmlBlock(html, tag) {
  return html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
}

function isArticleParagraph(text) {
  const value = String(text || '').trim();
  return value.length >= 40
    && !/^(advertisement|subscribe|sign up|by submitting|all rights reserved)\b/i.test(value)
    && !/(privacy policy|cookie policy|terms of service)/i.test(value);
}

function parseRss(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml))) {
    const block = match[1];
    const event = {
      title: decodeXml(extractXml(block, 'title')),
      summary: stripHtml(decodeXml(extractXml(block, 'description'))),
      source: decodeXml(extractXml(block, 'source')) || 'Google News',
      sourceDomain: domainFromUrl(decodeXml(extractXmlAttr(block, 'source', 'url'))),
      url: decodeXml(extractXml(block, 'link')),
      publishedAt: toIsoDate(decodeXml(extractXml(block, 'pubDate'))),
    };

    if (!isLikelyNonNewsEvent(event)) items.push(event);
  }

  return items;
}

function recentEvents(events, now = Date.now()) {
  return events
    .filter(event => isRecentEvent(event, now))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function isRecentEvent(event, now = Date.now()) {
  const maxAgeHours = Number(process.env.NEWS_MAX_AGE_HOURS || 48);
  const published = Date.parse(event.publishedAt || '');
  return Number.isFinite(published)
    && published <= now + 5 * 60 * 1000
    && now - published <= maxAgeHours * 60 * 60 * 1000;
}

async function analyzeItem(item, events, sources) {
  const minScore = Number(process.env.MIN_T_SCORE || 5);
  const scored = events
    .filter(event => event.portfolioTicker === item.ticker || eventMatchesItem(event, item))
    .map(event => scoreEvent(item, event, sources))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  for (const candidate of scored) {
    let top = candidate;
    if (top.matches.content !== 'article_body' && !top.event.articleChecked) {
      const enriched = await enrichEvent(top.event);
      if (enriched !== top.event) top = scoreEvent(item, enriched, sources);
    }
    if (top.score < minScore) continue;
    if (articleBodyRequired() && top.matches.content !== 'article_body') continue;

    return {
      item,
      event: top.event,
      score: top.score,
      direction: top.direction,
      action: actionFor(item, top.score, top.direction, top.matches),
      matches: top.matches,
    };
  }

  return null;
}

function eventMatchesItem(event, item) {
  const text = normalize(eventContentText(event));
  return (!isAmbiguousTicker(item) && tickerInText(item.ticker, text))
    || [item.name, ...(item.themes || [])]
    .filter(Boolean)
    .some(value => text.includes(normalize(value)));
}

function scoreEvent(item, event, sources) {
  const text = normalize(eventContentText(event));
  const positiveMatches = matchList(item.positive_triggers || [], text);
  const negativeMatches = matchList(item.negative_triggers || [], text);
  const themeMatches = (item.themes || []).filter(theme => text.includes(normalize(theme)));
  const sectorMatches = [item.sector, item.subsector, ...(item.sector_cycle?.watch || [])]
    .filter(Boolean)
    .filter(value => text.includes(normalize(value)));
  const directMatch = (!isAmbiguousTicker(item) && tickerInText(item.ticker, text))
    || (item.name ? text.includes(normalize(item.name)) : false);
  const queryMatch = event.query ? 1 : 0;
  const source = event.querySource || findKnownSource(event, item, sources);
  const quality = contentQuality(event);

  let score = 1 + queryMatch;
  if (directMatch) score += 4;
  score += Math.min(themeMatches.length, 2) * 2;
  score += Math.min(sectorMatches.length, 1) * 2;
  score += Math.min(positiveMatches.length + negativeMatches.length, 2) * 3;
  score += source?.tier === 1 ? 2 : source?.tier === 2 ? 1 : 0;

  const direction = classifyDirection(positiveMatches.length, negativeMatches.length);
  const cappedScore = quality === 'title_only'
    ? Math.min(score, source ? 6 : 5)
    : score;

  return {
    event,
    score: Math.min(10, cappedScore),
    direction,
    matches: {
      positive: positiveMatches,
      negative: negativeMatches,
      themes: themeMatches,
      sectors: sectorMatches,
      source,
      content: quality,
    },
  };
}

function eventContentText(event) {
  const title = cleanNewsText(event.title, event.source);
  const summary = cleanNewsText(event.summary, event.source);
  const body = String(event.body || '').trim();
  return [title, isSameNewsText(title, summary) ? '' : summary, body].filter(Boolean).join(' ');
}

function contentQuality(event) {
  const title = cleanNewsText(event.title, event.source);
  const summary = cleanNewsText(event.summary, event.source);
  if (event.body) return 'article_body';
  if (!summary || isSameNewsText(title, summary)) return 'title_only';
  return 'rss_summary';
}

function articleBodyRequired() {
  return process.env.REQUIRE_ARTICLE_BODY === '1';
}

function isLikelyNonNewsEvent(event) {
  return /\bprice,\s+[^-]+,\s+live charts?,\s+and marketcap\b/i.test(cleanNewsText(event.title, event.source));
}

function isAmbiguousTicker(item) {
  return item.ambiguous_ticker || String(item.ticker || '').trim().length <= 2;
}

function findKnownSource(event, item, sources) {
  const knownSources = sourcesForItem(item, sources);
  const eventSource = normalize(event.source);
  const eventDomain = normalize(event.sourceDomain);

  return knownSources.find(source => {
    const sourceName = normalize(source.name);
    const sourceDomain = normalize(source.domain);
    return sourceDomain && eventDomain.includes(sourceDomain)
      || sourceName && eventSource.includes(sourceName);
  });
}

function matchList(values, text) {
  return values
    .map(value => typeof value === 'string' ? value : value.label)
    .filter(Boolean)
    .filter(value => text.includes(normalize(value)));
}

function classifyDirection(positiveCount, negativeCount) {
  if (positiveCount > 0 && negativeCount > 0) return 'mixed';
  if (positiveCount > 0) return 'positive';
  if (negativeCount > 0) return 'negative';
  return 'unknown';
}

function actionFor(item, score, direction, matches = {}) {
  if (matches.content === 'title_only') return '원문 확인';
  if (direction === 'negative' && score >= 9) return '위험 신호';
  if (direction === 'negative' && score >= 7) return '다시 고려';
  if (direction === 'negative') return '주의';
  if (direction === 'positive' && score >= 8) {
    return item.status === 'holding' ? '강한 홀드 신호' : '보유 고려';
  }
  if (direction === 'positive') return item.status === 'holding' ? '보유 유지' : '관심 유지';
  if (direction === 'mixed') return '다시 살펴보기';
  return '지켜보기';
}

async function formatAlert(alert) {
  const { item, event, score, direction, action } = alert;
  const icon = { positive: '🟢', negative: '🔴', mixed: '🟡', unknown: '⚪' }[direction] || '⚪';
  const directionLabel = {
    positive: '긍정',
    negative: '부정',
    mixed: '혼합(긍정/부정 동시)',
    unknown: '불명',
  }[direction] || '불명';
  const title = `[${item.ticker}]${item.name || item.ticker}`;
  const newsTitle = cleanNewsText(event.title, event.source);
  const newsSummary = cleanNewsText(event.summary, event.source);
  const translatedTitle = await translateNewsText(newsTitle);
  const translatedSummary = await summarizeNewsText(event, newsSummary);
  const summary = event.body
    ? translatedSummary
    : !translatedSummary || isSameNewsText(translatedTitle, translatedSummary)
    ? fallbackSummary(alert)
    : translatedSummary;

  return [
    `${icon} T${score}/10 · ${escapeHtml(title)} · ${directionLabel} · ${action}`,
    '',
    `<b>제목</b>\n${escapeHtml(translatedTitle)}`,
    '',
    `<b>내용</b>\n${escapeHtml(summary)}`,
    '',
    `<b>분석요인</b>\n${formatAnalysisFactors(alert.matches || {})}`,
    '',
    `<b>의미</b>\n${escapeHtml(item.why_it_matters || `${item.name || item.ticker}의 주요 감시 요인과 연결됩니다.`)}`,
    '',
    `<b>흐름</b>\n${formatSectorCycle(item)}`,
    '',
    `<b>연결</b>\n${formatChain(item.chain || [])}`,
    '',
    `<b>관련주</b>\n${formatRelated(item.related_tickers || [])}`,
    '',
    `<b>체크</b>\n${formatIndicators(item.key_indicators || [])}`,
    '',
    `<b>판단</b>\n${escapeHtml(judgementSentence(item, direction, action))}`,
    '',
    `<b>출처</b>\n${formatEventSource(event, alert.matches?.source)}`,
  ].join('\n');
}

function fallbackSummary(alert) {
  const { event } = alert;
  const queryText = event.query ? ` 감시 쿼리: ${event.query}.` : '';
  return `본문을 확보하지 못해 제목/RSS 요약만 표시합니다. 원문 확인이 필요합니다.${queryText}`;
}

function summarizeArticleBody(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+(?=\s|$)/g) || [];
  return truncateText((sentences.slice(0, 3).map(sentence => sentence.trim()).join(' ') || text), 900);
}

async function summarizeNewsText(event, rssSummary) {
  if (event.body && miniMaxEnabled() && process.env.TRANSLATE_NEWS !== '0') {
    const summary = await summarizeArticleWithMiniMax(event.title, event.body);
    if (summary) return summary;
  }

  return translateNewsText(event.body ? summarizeArticleBody(event.body) : rssSummary);
}

async function translateNewsText(text) {
  const value = String(text || '').trim();
  if (!value || /[가-힣]/.test(value) || process.env.TRANSLATE_NEWS === '0') return value;

  if (miniMaxEnabled()) {
    const translated = await miniMaxChat([
      'Translate this news text into natural Korean.',
      'Keep tickers, numbers, company names, and quoted product names intact.',
      'Return only the translation.',
      '',
      value,
    ].join('\n'), 700);
    if (translated) return translated;
  }

  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: 'ko',
      dt: 't',
      q: value,
    });
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) return value;
    const body = await response.json();
    return body?.[0]?.map(part => part?.[0] || '').join('') || value;
  } catch {
    return value;
  }
}

async function summarizeArticleWithMiniMax(title, body) {
  return miniMaxChat([
    '아래 기사 본문만 근거로 한국어 요약을 작성해.',
    '추측하지 말고 기사에 나온 사실만 써.',
    '투자자가 바로 읽을 수 있게 2~3문장으로 간결하게 써.',
    '티커, 회사명, 숫자, 제품명은 보존해.',
    '',
    `제목: ${title}`,
    '',
    `본문: ${truncateText(body, 6000)}`,
  ].join('\n'), 900);
}

async function miniMaxChat(prompt, maxTokens) {
  try {
    const apiUrl = process.env.MINIMAX_API_URL || `${(process.env.MINIMAX_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.MINIMAX_MODEL || 'minimaxai/minimax-m3',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        top_p: 0.95,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(Number(process.env.MINIMAX_TIMEOUT_MS || 20000)),
    });
    if (!response.ok) return '';

    const body = await response.json();
    return String(body.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

function miniMaxEnabled() {
  return Boolean(process.env.MINIMAX_API_KEY);
}

function formatEventSource(event, source) {
  const label = escapeHtml(event.source || source?.name || 'Unknown');
  const linked = event.url ? `<a href="${escapeHtml(event.url)}">${label}</a>` : label;
  if (!source?.why) return linked;
  return `${linked} · ${escapeHtml(source.why)}`;
}

function formatAnalysisFactors(matches) {
  const lines = [];
  if (matches.positive?.length) lines.push(`- 긍정: ${escapeHtml(matches.positive.slice(0, 3).join(' / '))}`);
  if (matches.negative?.length) lines.push(`- 부정: ${escapeHtml(matches.negative.slice(0, 3).join(' / '))}`);
  if (matches.themes?.length) lines.push(`- 테마: ${escapeHtml(matches.themes.slice(0, 3).join(' / '))}`);
  if (matches.sectors?.length) lines.push(`- 섹터: ${escapeHtml(matches.sectors.slice(0, 2).join(' / '))}`);
  if (matches.source?.name) lines.push(`- 출처신뢰: ${escapeHtml(matches.source.name)} tier ${escapeHtml(matches.source.tier || '?')}`);
  if (matches.content === 'title_only') lines.push('- 본문: 제목 중심이라 원문 확인 필요');
  if (matches.content === 'rss_summary') lines.push('- 본문: RSS 요약 반영');
  if (matches.content === 'article_body') lines.push('- 본문: 원문 본문 반영');
  return lines.length ? lines.join('\n') : '- 직접 트리거보다는 등록된 감시 쿼리/출처 신뢰도로 잡힌 이슈입니다.';
}

function cleanNewsText(text, source) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || !source) return value;

  const escapedSource = escapeRegExp(source);
  value = value.replace(new RegExp(`\\s+-\\s+${escapedSource}$`, 'i'), '');
  value = value.replace(new RegExp(`\\s+${escapedSource}$`, 'i'), '');
  return value.trim();
}

function isSameNewsText(a, b) {
  return normalize(a).replace(/[^a-z0-9가-힣]+/g, '') === normalize(b).replace(/[^a-z0-9가-힣]+/g, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tickerInText(ticker, text) {
  const value = normalize(ticker);
  const haystack = normalize(text);
  if (!value) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(value)}([^a-z0-9]|$)`).test(haystack);
}

function formatSectorCycle(item) {
  if (!item.sector && !item.sector_cycle) return '- 아직 등록된 섹터 순환 설명이 없습니다.';

  const sector = [item.sector, item.subsector].filter(Boolean).join(' / ');
  const lines = [];
  if (sector) lines.push(`- ${escapeHtml(sector)} 흐름 안에서 봅니다.`);
  if (item.portfolios?.length) lines.push(`- 이 종목은 ${escapeHtml(item.portfolios.join(', '))} 관점에서도 함께 봅니다.`);
  if (item.sector_cycle?.why) lines.push(`- ${escapeHtml(item.sector_cycle.why)}`);
  if (item.sector_cycle?.positive?.length) {
    lines.push(`- 좋게 볼 때는 ${escapeHtml(item.sector_cycle.positive.slice(0, 2).join(', '))} 같은 신호가 같이 나와야 합니다.`);
  }
  if (item.sector_cycle?.negative?.length) {
    lines.push(`- 반대로 다음 신호가 보이면 투자 논리를 다시 확인해야 합니다: ${escapeHtml(item.sector_cycle.negative.slice(0, 2).join(', '))}.`);
  }
  return lines.join('\n');
}

function formatChain(chain) {
  if (chain.length === 0) return '- 아직 등록된 체인 설명이 없습니다.';
  return chain.slice(0, 5)
    .map(step => `- ${escapeHtml(step.from)} 흐름은 ${escapeHtml(step.to)}에 바로 이어집니다. ${escapeHtml(step.why)}`)
    .join('\n');
}

function formatRelated(related) {
  if (related.length === 0) return '- 아직 등록된 관련 종목이 없습니다.';
  return related.slice(0, 7)
    .map(entry => `- <a href="${tradingViewUrl(entry)}">${escapeHtml(entry.ticker)}</a>${entry.name ? ` (${escapeHtml(entry.name)})` : ''}: ${escapeHtml(entry.why)}`)
    .join('\n');
}

function formatIndicators(indicators) {
  if (indicators.length === 0) return '- 아직 등록된 확인 데이터가 없습니다.';
  return indicators.slice(0, 3)
    .map(entry => [
      `- ${escapeHtml(entry.name)}`,
      `  왜 봄: ${escapeHtml(entry.why)}`,
      `  긍정: ${escapeHtml(entry.positive)}`,
      `  부정: ${escapeHtml(entry.negative)}`,
    ].join('\n'))
    .join('\n');
}

function judgementSentence(item, direction, action) {
  if (direction === 'positive') {
    return item.status === 'holding'
      ? `${action}. 다만 가격이 먼저 과열됐는지는 같이 확인해야 합니다.`
      : `${action}. 바로 매수보다 가격과 핵심 데이터 확인이 먼저입니다.`;
  }
  if (direction === 'negative') {
    return item.status === 'holding'
      ? `${action}. 보유 이유가 그대로인지 확인하고, 관련 데이터가 나빠지는지 봐야 합니다.`
      : `${action}. 관심종목이면 진입을 서두를 이유가 약합니다.`;
  }
  if (direction === 'mixed') {
    return `${action}. 좋은 요인과 나쁜 요인이 같이 있어서 다음 데이터 확인 전까지 단정하지 않는 편이 낫습니다.`;
  }
  return `${action}. 아직 방향이 뚜렷하지 않아 배경 정보로만 봅니다.`;
}

async function sendTelegram(text) {
  for (const chunk of splitMessage(text)) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API error ${response.status}: ${await response.text()}`);
    }
  }
}

function tradingViewUrl(entry) {
  const symbol = entry.tradingview_symbol || inferTradingViewSymbol(entry.ticker);
  return `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;
}

function inferTradingViewSymbol(ticker) {
  const value = String(ticker || '').toUpperCase();
  if (value.endsWith('.AX')) return `ASX-${value.slice(0, -3)}`;
  if (value.endsWith('.HK')) return `HKEX-${value.slice(0, -3)}`;
  if (value.endsWith('.KS')) return `KRX-${value.slice(0, -3)}`;
  if (value.endsWith('.T')) return `TSE-${value.slice(0, -2)}`;
  return value.replace('.', '-');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitMessage(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    const splitAt = rest.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    const index = splitAt > 0 ? splitAt : MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, index));
    rest = rest.slice(index).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function extractXml(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : '';
}

function extractXmlAttr(block, tag, attr) {
  const match = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"[^>]*>`));
  return match ? match[1] : '';
}

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateText(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const index = value.lastIndexOf(' ', max);
  return `${value.slice(0, index > max * 0.6 ? index : max).trim()}...`;
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toIsoDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEvents(events) {
  return uniqueBy(events, event => event.url || `${event.title}:${event.source}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function selfTest() {
  const html = '<main><p>Short.</p><p>Nvidia said the new chip orders reached one billion dollars. The company added that customer testing has started. Investors are watching whether inference costs fall.</p></main>';
  const body = extractArticleText(html);
  assert.match(body, /new chip orders/);
  assert.equal(contentQuality({ title: 'Nvidia orders', summary: 'Nvidia orders', body }), 'article_body');
  assert.equal(
    summarizeArticleBody('First sentence. Second sentence. Third sentence. Fourth sentence.'),
    'First sentence. Second sentence. Third sentence.',
  );
  assert.match(formatSectorCycle({
    sector: 'Technology',
    sector_cycle: { positive: ['demand'], negative: ['slowdown'] },
  }), /좋게 볼 때는 demand/);
  assert.equal(formatChain([{ from: 'A', to: 'B', why: 'C.' }]), '- A 흐름은 B에 바로 이어집니다. C.');
  assert.deepEqual(
    recentEvents([
      { title: 'old', publishedAt: '2026-06-29T00:00:00.000Z' },
      { title: 'new', publishedAt: '2026-07-01T00:00:00.000Z' },
    ], Date.parse('2026-07-02T00:00:00.000Z')).map(event => event.title),
    ['new'],
  );
  assert.equal(isLikelyNonNewsEvent({ title: 'Open USD Price, OUSD Price, Live Charts, and Marketcap - Coinbase', source: 'Coinbase' }), true);
  assert.equal(tickerInText('LLY', 'historically benefited from the ecosystem'), false);
  assert.equal(tickerInText('COIN', 'stablecoin pressure'), false);
  assert.equal(tickerInText('COIN', 'Coinbase (COIN) shares moved'), true);
  assert.equal(isAmbiguousTicker({ ticker: 'O' }), true);
  assert.equal(isAmbiguousTicker({ ticker: 'KO' }), true);
  assert.equal(eventMatchesItem({ title: 'Ko Du-shim recalls an actor' }, { ticker: 'KO', name: 'Coca-Cola' }), false);
  assert.equal(eventMatchesItem({ title: 'Coca-Cola raises guidance' }, { ticker: 'KO', name: 'Coca-Cola' }), true);
  assert.equal(eventMatchesItem({ title: 'Markets open higher' }, { ticker: 'OPEN', ambiguous_ticker: true }), false);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
