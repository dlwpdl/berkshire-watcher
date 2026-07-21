import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PORTFOLIO = 'data/portfolio.json';
const DEFAULT_SOURCES = 'data/sources.json';
const DEFAULT_PROFILES_DIR = 'data/profiles';
const DEFAULT_TEMPLATES_DIR = 'data/templates';
const MAX_MESSAGE_LENGTH = 3900;
const USER_AGENT = 'Mozilla/5.0 berkshire-watcher/0.1';
const GENERAL_POSITIVE_TRIGGERS = [
  'wins lawsuit',
  'wins',
  'lawsuit dismissed',
  'dismisses lawsuit',
  'beats estimates',
  'raises guidance',
  'approved',
  'approval',
  'allow',
  'allowed to buy',
  'launches',
  'expands',
  'record revenue',
  'surges',
  'jumps',
  'rally',
  'upgrade',
  'benefit',
  '승소',
  '승인',
  '허용',
  '상향',
  '급등',
  '호조',
];
const GENERAL_NEGATIVE_TRIGGERS = [
  'faces lawsuit',
  'lawsuit alleges',
  'class action',
  'investigation',
  'probe',
  'antitrust',
  'restricted',
  'restrictions',
  'limited',
  'ban on',
  'banned',
  'delays',
  'delay',
  'cuts guidance',
  'misses estimates',
  'fall',
  'falls',
  'drops',
  'decline',
  'softer',
  'downgrade',
  'recall',
  '피소',
  '제소',
  '소송 제기',
  '조사',
  '제한',
  '금지',
  '하락',
  '둔화',
  '연기',
  '삭감',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    await selfTest();
    return;
  }
  if (!args.dryRun && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required unless --dry-run is used.');
  }

  const portfolio = await readJson(args.portfolio || DEFAULT_PORTFOLIO);
  const items = await loadPortfolioItems(portfolio.items || []);
  const sources = await readOptionalJson(args.sources || DEFAULT_SOURCES, { groups: {} });
  const statePath = process.env.ALERT_STATE_FILE || 'state/seen.json';
  const seen = args.dryRun ? new Set() : await loadSeen(statePath);
  const events = args.events
    ? await readJson(args.events)
    : await collectEvents(items, sources);

  const alerts = (await Promise.all(items
    .filter(item => item.status !== 'paused')
    .map(item => analyzeItem(item, events, sources, seen))))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  console.log(`[alerts] selected=${alerts.length} body=${alerts.filter(alert => alert.matches.content === 'article_body').length} rss=${alerts.filter(alert => alert.matches.content === 'rss_summary').length} title=${alerts.filter(alert => alert.matches.content === 'title_only').length}`);

  if (alerts.length === 0) {
    console.log('No portfolio alerts.');
    return;
  }

  const message = (await Promise.all(alerts.map(formatAlert))).join('\n\n---\n\n');
  console.log(message);

  if (!args.dryRun) {
    await sendTelegram(message);
    for (const alert of alerts) seen.add(alertKey(alert.item, alert.event));
    await saveSeen(statePath, seen);
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

async function loadSeen(statePath) {
  const state = await readOptionalJson(statePath, { seen: [] });
  return new Set(Array.isArray(state.seen) ? state.seen : []);
}

async function saveSeen(statePath, seen) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify({ seen: [...limitSeen(seen)] }, null, 2)}\n`);
}

function limitSeen(seen, max = 1000) {
  return new Set([...seen].slice(-max));
}

function alertKey(item, event) {
  const identity = event.discoveryUrl || event.url || `${normalize(event.title)}|${normalize(event.source)}`;
  return `${item.ticker}|${identity}`;
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
  let queryCount = 0;
  let queryFailures = 0;

  for (const item of items.filter(item => item.status !== 'paused')) {
    const queries = buildQueries(item, sources).slice(0, Number(process.env.MAX_QUERIES_PER_ITEM || 12));
    for (const query of queries) {
      queryCount += 1;
      const events = await fetchGoogleNews(query.query);
      if (events === null) {
        queryFailures += 1;
        continue;
      }
      all.push(...events.map(event => ({
        ...event,
        portfolioTicker: item.ticker,
        query: query.query,
      })));
      await sleep(300);
    }
  }

  if (queryCount > 0 && queryFailures === queryCount) {
    throw new Error(`All ${queryCount} Google News queries failed.`);
  }

  const recent = recentEvents(dedupeEvents(all)).slice(0, 80);
  const enriched = await enrichEvents(recent);
  const resolvedCount = enriched.filter(event => event.discoveryUrl && event.url !== event.discoveryUrl).length;
  const bodyCount = enriched.filter(event => event.body).length;
  console.log(`[news] queries=${queryCount} failed=${queryFailures} recent=${recent.length} resolved=${resolvedCount} bodies=${bodyCount}`);
  return enriched;
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
  const grouped = interleave(groups.map(group => sources.groups?.[group] || []));
  return uniqueBy([...(item.trusted_sources || []), ...grouped], source => `${source.domain || source.name}`.toLowerCase());
}

function interleave(lists) {
  const result = [];
  const max = Math.max(0, ...lists.map(list => list.length));
  for (let i = 0; i < max; i += 1) {
    for (const list of lists) {
      if (list[i]) result.push(list[i]);
    }
  }
  return result;
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(Number(process.env.NEWS_TIMEOUT_MS || 10000)),
    });
  } catch (error) {
    console.warn(`Google News fetch failed for "${query}": ${error.message}`);
    return null;
  }

  if (!response.ok) {
    console.warn(`Google News fetch failed for "${query}": ${response.status}`);
    return null;
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
    const body = articleUrl && !domainFromUrl(articleUrl).endsWith('news.google.com')
      ? await fetchArticleText(articleUrl)
      : '';
    return {
      ...event,
      discoveryUrl: event.discoveryUrl || event.url,
      url: articleUrl || event.url,
      articleChecked: true,
      ...(body ? { body } : {}),
    };
  } catch (error) {
    console.warn(`Article fetch failed for "${event.title}": ${error.message}`);
    return { ...event, discoveryUrl: event.discoveryUrl || event.url, articleChecked: true };
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
  const rpc = buildGoogleNewsDecodePayload(articleId, timestamp, signature);

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

function buildGoogleNewsDecodePayload(articleId, timestamp, signature) {
  const request = [
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    articleId,
    Number(timestamp),
    signature,
  ];
  return JSON.stringify([[['Fbv4je', JSON.stringify(request), null, 'generic']]]);
}

async function fetchArticleText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(Number(process.env.ARTICLE_TIMEOUT_MS || 8000)),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return '';

  const text = extractArticleText(await response.text());
  return isUsableArticleText(text) ? text : '';
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

function isUsableArticleText(text) {
  return String(text || '').trim().length >= 160;
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

async function analyzeItem(item, events, sources, seen = new Set()) {
  const minScore = Number(process.env.MIN_T_SCORE || 5);
  const scored = events
    .filter(event => !isLikelyNonNewsEvent(event))
    .filter(event => eventMatchesItem(event, item))
    .map(event => scoreEvent(item, event, sources))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  for (const candidate of scored) {
    if (seen.has(alertKey(item, candidate.event))) continue;
    let top = candidate;
    if (top.matches.content !== 'article_body' && !top.event.articleChecked) {
      const enriched = await enrichEvent(top.event);
      if (enriched !== top.event) top = scoreEvent(item, enriched, sources);
    }
    if (isLikelyNonNewsEvent(top.event)) continue;
    if (top.matches.content !== 'article_body' && (!top.matches.source || top.matches.source.tier > 2)) continue;
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
  if (directMatchForItem(item, normalize(eventIdentityText(event)))) return true;
  if (item.sector !== 'Leveraged ETF') return false;

  const text = normalize(eventContentText(event));
  const triggerMatches = matchList([
    ...(item.positive_triggers || []),
    ...(item.negative_triggers || []),
  ], text);
  const themeMatches = matchList(item.themes || [], text);
  return triggerMatches.length > 0 || themeMatches.length >= 2;
}

function directMatchForItem(item, text) {
  if (!isAmbiguousTicker(item) && tickerInText(item.ticker, text)) return true;

  const identityText = normalize(text).replace(/[^a-z0-9]+/g, ' ').trim();
  return [item.name, ...(item.aliases || [])]
    .filter(Boolean)
    .map(name => normalize(name).replace(/[^a-z0-9]+/g, ' ').trim())
    .some(name => name.length >= 4 && phraseInText(name, identityText));
}

function scoreEvent(item, event, sources) {
  const text = normalize(eventContentText(event));
  const itemPositiveMatches = matchList(item.positive_triggers || [], text);
  const itemNegativeMatches = matchList(item.negative_triggers || [], text);
  const generalPositiveMatches = matchPhrases(GENERAL_POSITIVE_TRIGGERS, text);
  const generalNegativeMatches = matchPhrases(GENERAL_NEGATIVE_TRIGGERS, text);
  const positiveMatches = uniqueBy([
    ...itemPositiveMatches,
    ...generalPositiveMatches,
  ], value => value);
  const negativeMatches = uniqueBy([
    ...itemNegativeMatches,
    ...generalNegativeMatches,
  ], value => value);
  const materialMatches = uniqueBy([...itemPositiveMatches, ...itemNegativeMatches], value => value);
  const themeMatches = (item.themes || []).filter(theme => text.includes(normalize(theme)));
  const sectorMatches = [item.sector, item.subsector, ...(item.sector_cycle?.watch || [])]
    .filter(Boolean)
    .filter(value => text.includes(normalize(value)));
  const directMatch = directMatchForItem(item, normalize(eventIdentityText(event)));
  const source = findKnownSource(event, item, sources);
  const quality = contentQuality(event);

  let score = 1;
  if (directMatch) score += 4;
  score += Math.min(materialMatches.length, 2) * 2;
  score += Math.min(themeMatches.length, 2);
  score += Math.min(sectorMatches.length, 1);
  if (source?.tier <= 2) score += 1;

  const direction = classifyDirection(
    itemPositiveMatches.length * 2 + generalPositiveMatches.length,
    itemNegativeMatches.length * 2 + generalNegativeMatches.length,
  );

  return {
    event,
    score: Math.min(10, score),
    direction,
    matches: {
      positive: positiveMatches,
      negative: negativeMatches,
      material: materialMatches,
      themes: themeMatches,
      sectors: sectorMatches,
      direct: directMatch,
      source,
      content: quality,
    },
  };
}

function eventContentText(event) {
  return [eventIdentityText(event), String(event.body || '').trim()].filter(Boolean).join(' ');
}

function eventIdentityText(event) {
  const title = cleanNewsText(event.title, event.source);
  const summary = cleanNewsText(event.summary, event.source);
  return [title, isSameNewsText(title, summary) ? '' : summary].filter(Boolean).join(' ');
}

function contentQuality(event) {
  const title = cleanNewsText(event.title, event.source);
  const summary = cleanNewsText(event.summary, event.source);
  if (isUsableArticleText(event.body)) return 'article_body';
  if (!summary || isSameNewsText(title, summary)) return 'title_only';
  return 'rss_summary';
}

function articleBodyRequired() {
  return process.env.REQUIRE_ARTICLE_BODY === '1';
}

function isLikelyNonNewsEvent(event) {
  const title = cleanNewsText(event.title, event.source);
  const summary = cleanNewsText(event.summary, event.source);
  const text = normalize([title, summary, event.body].filter(Boolean).join(' '));
  return /\bprice,\s+[^-]+,\s+live charts?,\s+and marketcap\b/i.test(title)
    || /(sponsored content|paid content|paid post|advertorial|partner content|promoted content|유료 광고|광고성 콘텐츠|협찬 콘텐츠)/.test(text)
    || isLikelyPromotionalCampaign(text);
}

function isLikelyPromotionalCampaign(text) {
  return /(coinbase cup|chance to win|win up to|get a chance to win|giveaway|sweepstakes|trading contest|trading competition|promo(?:tion)?|campaign|코인베이스 컵|획득의 기회|최대 .{0,20}받|이벤트|경품|프로모션)/.test(text)
    && /(trade|trading|perpetual|futures|usdc|\$|prize|bonus|reward|거래|무기한|선물|달러|상금|경품|획득|받자)/.test(text);
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
    return sourceDomain && (eventDomain === sourceDomain || eventDomain.endsWith(`.${sourceDomain}`))
      || sourceName && eventSource === sourceName;
  });
}

function matchList(values, text) {
  return values
    .map(value => typeof value === 'string' ? value : value.label)
    .filter(Boolean)
    .filter(value => text.includes(normalize(value)));
}

function matchPhrases(values, text) {
  return values
    .filter(Boolean)
    .filter(value => phraseInText(value, text));
}

function phraseInText(phrase, text) {
  const value = normalize(phrase);
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(value)}([^a-z0-9]|$)`).test(text);
}

function classifyDirection(positiveCount, negativeCount) {
  if (positiveCount > 0 && negativeCount > 0 && Math.abs(positiveCount - negativeCount) < 2) return 'mixed';
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'unknown';
}

function actionFor(item, score, direction, matches = {}) {
  if (!matches.source || matches.source.tier > 2) return '출처 확인';
  if (matches.content === 'title_only' && direction === 'positive') return '호재 원문 확인';
  if (matches.content === 'title_only' && direction === 'negative') return '악재 원문 확인';
  if (matches.content === 'title_only' && direction === 'mixed') return '혼재 원문 확인';
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
    `${icon} 중요도 T${score}/10 · ${escapeHtml(title)} · ${directionLabel} · ${action}`,
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
  const paragraphs = String(body || '').split(/\n+/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return truncateText(paragraphs.slice(0, 3).join(' '), 900);

  const text = paragraphs[0] || '';
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
  lines.push(matches.direct ? '- 관련성: 종목 직접 언급' : '- 관련성: 등록된 ETF 요인 일치');
  if (matches.material?.length) lines.push(`- 중요도 트리거: ${escapeHtml(matches.material.slice(0, 3).join(' / '))}`);
  if (matches.positive?.length) lines.push(`- 긍정: ${escapeHtml(matches.positive.slice(0, 3).join(' / '))}`);
  if (matches.negative?.length) lines.push(`- 부정: ${escapeHtml(matches.negative.slice(0, 3).join(' / '))}`);
  if (matches.themes?.length) lines.push(`- 테마: ${escapeHtml(matches.themes.slice(0, 3).join(' / '))}`);
  if (matches.sectors?.length) lines.push(`- 섹터: ${escapeHtml(matches.sectors.slice(0, 2).join(' / '))}`);
  if (matches.source?.name) {
    const warning = matches.source.tier > 2 ? ' · 교차확인 필요' : '';
    lines.push(`- 출처신뢰: ${escapeHtml(matches.source.name)} tier ${escapeHtml(matches.source.tier || '?')}${warning}`);
  } else {
    lines.push('- 출처신뢰: 미등록 · 교차확인 필요');
  }
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
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(Number(process.env.TELEGRAM_TIMEOUT_MS || 10000)),
    });

    if (!response.ok) {
      throw new Error(`Telegram API error ${response.status}: ${await response.text()}`);
    }
  }
  console.log(`[telegram] chunks=${chunks.length}`);
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
  return decodeXml(decodeXml(text.replace(/<[^>]*>/g, ' '))).replace(/\s+/g, ' ').trim();
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

async function selfTest() {
  const html = '<main><p>Short.</p><p>Nvidia said the new chip orders reached one billion dollars. The company added that customer testing has started. Investors are watching whether inference costs fall.</p></main>';
  const body = extractArticleText(html);
  assert.match(body, /new chip orders/);
  assert.equal(isUsableArticleText('A short navigation fragment that is not an article body.'), false);
  assert.equal(isUsableArticleText('A'.repeat(200)), true);
  assert.equal(contentQuality({ title: 'Nvidia orders', summary: 'Nvidia orders', body }), 'article_body');
  assert.equal(
    summarizeArticleBody('First sentence. Second sentence. Third sentence. Fourth sentence.'),
    'First sentence. Second sentence. Third sentence.',
  );
  assert.equal(
    summarizeArticleBody('NEW YORK, 12:07 p.m. EDT - U.S. trading begins.\nShares rose 1.2%.\nRevenue guidance increased.'),
    'NEW YORK, 12:07 p.m. EDT - U.S. trading begins. Shares rose 1.2%. Revenue guidance increased.',
  );
  assert.equal(stripHtml('Alphabet&amp;#x27;s guidance'), "Alphabet's guidance");
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
  assert.equal(isLikelyNonNewsEvent({
    title: 'Coinbase Cup India — Trade Perpetual Futures and get a chance to win up to $350K USDC - Coinbase',
    summary: 'Users can trade perpetual futures for a chance to win rewards.',
    source: 'Coinbase',
  }), true);
  assert.equal(isLikelyNonNewsEvent({
    title: '코인베이스 컵 인디아 — 무기한 선물 거래하고 최대 35만 달러 USDC 받자',
    summary: '코인베이스 컵 인디아 — 무기한 선물 거래하고 최대 $350K USDC 획득의 기회',
    source: 'Coinbase',
  }), true);
  assert.equal(isLikelyNonNewsEvent({
    title: 'Coinbase launches regulated perpetual futures for US customers - Coinbase',
    summary: 'The new product expands derivatives access for eligible US customers.',
    source: 'Coinbase',
  }), false);
  assert.equal(isLikelyNonNewsEvent({
    title: 'Robinhood expands its investing platform',
    body: 'Sponsored content. Sign up today and use promo code INVEST to receive a cash bonus.',
    source: 'Example Publisher',
  }), true);
  const testSources = { groups: { market_news: [{ name: 'Reuters', domain: 'reuters.com', tier: 1 }] } };
  const googleWin = scoreEvent(
    { ticker: 'GOOG', name: 'Google', themes: ['Gemini'], source_groups: ['market_news'] },
    { title: 'Google wins consumer lawsuit over Gemini data tracking', summary: 'Google wins consumer lawsuit over Gemini data tracking', source: 'Reuters', sourceDomain: 'reuters.com', query: 'Google Gemini' },
    testSources,
  );
  assert.equal(googleWin.direction, 'positive');
  assert.equal(googleWin.score, 7);
  assert.equal(actionFor({ status: 'holding' }, googleWin.score, googleWin.direction, googleWin.matches), '호재 원문 확인');
  assert.equal(actionFor(
    { status: 'holding' },
    7,
    'positive',
    { content: 'article_body' },
  ), '출처 확인');
  assert.equal(actionFor(
    { status: 'holding' },
    7,
    'positive',
    { content: 'article_body', source: { tier: 3 } },
  ), '출처 확인');
  assert.equal(actionFor(
    { status: 'holding' },
    7,
    'positive',
    { content: 'article_body', source: { tier: 2 } },
  ), '보유 유지');
  const hoodMixed = scoreEvent(
    { ticker: 'HOOD', name: 'Robinhood', positive_triggers: ['trading volume increased'] },
    {
      title: 'Robinhood prediction-market revenue could overtake crypto',
      body: 'Robinhood reported that trading volume increased from the prior month while crypto activity remained softer.',
      source: 'Example Publisher',
      sourceDomain: 'example.com',
    },
    testSources,
  );
  assert.equal(hoodMixed.direction, 'mixed');
  assert.match(formatAnalysisFactors(hoodMixed.matches), /출처신뢰: 미등록/);
  const importanceItem = { ticker: 'GOOG', name: 'Alphabet', source_groups: ['market_news'] };
  const neutralImportance = scoreEvent(
    importanceItem,
    { title: 'Alphabet updates its product roadmap', body: 'Alphabet described its product roadmap without changing financial guidance.', source: 'Reuters', sourceDomain: 'reuters.com' },
    testSources,
  );
  const generalSentimentImportance = scoreEvent(
    importanceItem,
    { title: 'Alphabet wins an industry award', body: 'Alphabet won an industry award for a recently released product.', source: 'Reuters', sourceDomain: 'reuters.com' },
    testSources,
  );
  assert.equal(generalSentimentImportance.score, neutralImportance.score);
  assert.equal(generalSentimentImportance.direction, 'positive');
  const profileSignalImportance = scoreEvent(
    { ...importanceItem, positive_triggers: ['raises guidance'] },
    { title: 'Alphabet raises guidance as demand improves', body: 'Alphabet raised its financial guidance as customer demand improved.', source: 'Reuters', sourceDomain: 'reuters.com' },
    testSources,
  );
  assert.ok(profileSignalImportance.score > generalSentimentImportance.score);
  assert.equal(scoreEvent(
    { ...importanceItem, positive_triggers: ['raises guidance'] },
    { title: 'Alphabet raises guidance despite shares falling', body: 'Alphabet raised guidance while its shares continued falling.', source: 'Reuters', sourceDomain: 'reuters.com' },
    testSources,
  ).direction, 'positive');
  const nvidiaLimited = scoreEvent(
    { ticker: 'NVDA', name: 'Nvidia', source_groups: ['market_news'] },
    { title: 'China plans to allow top AI firms to buy limited quantities of Nvidia H200 chips', summary: 'China plans to allow top AI firms to buy limited quantities of Nvidia H200 chips', source: 'Reuters', sourceDomain: 'reuters.com', query: 'Nvidia China' },
    testSources,
  );
  assert.equal(nvidiaLimited.direction, 'mixed');
  assert.equal(actionFor({ status: 'holding' }, nvidiaLimited.score, nvidiaLimited.direction, nvidiaLimited.matches), '혼재 원문 확인');
  const nvidiaRestricted = scoreEvent(
    { ticker: 'NVDA', name: 'Nvidia', source_groups: ['market_news'] },
    { title: 'Nvidia shares fall after China restrictions hit chip sales', summary: 'Nvidia shares fall after China restrictions hit chip sales', source: 'Reuters', sourceDomain: 'reuters.com', query: 'Nvidia China' },
    testSources,
  );
  assert.equal(nvidiaRestricted.direction, 'negative');
  assert.equal(actionFor({ status: 'holding' }, nvidiaRestricted.score, nvidiaRestricted.direction, nvidiaRestricted.matches), '악재 원문 확인');
  assert.equal(scoreEvent(
    { ticker: 'FAS', name: 'Direxion Daily Financial Bull 3X Shares' },
    { title: 'Awa Bank highlights regional strength as investors track Japan financials', summary: 'Awa Bank highlights regional strength as investors track Japan financials', source: 'Ad-hoc-news.de', query: 'banks financials' },
    testSources,
  ).direction, 'unknown');
  assert.deepEqual(sourcesForItem(
    { trusted_sources: [{ name: 'Trusted', domain: 'trusted.com' }], source_groups: ['a', 'b'] },
    { groups: { a: [{ name: 'A1', domain: 'a1.com' }, { name: 'A2', domain: 'a2.com' }], b: [{ name: 'B1', domain: 'b1.com' }] } },
  ).map(source => source.name), ['Trusted', 'A1', 'B1', 'A2']);
  assert.equal(tickerInText('LLY', 'historically benefited from the ecosystem'), false);
  assert.equal(tickerInText('COIN', 'stablecoin pressure'), false);
  assert.equal(tickerInText('COIN', 'Coinbase (COIN) shares moved'), true);
  assert.equal(isAmbiguousTicker({ ticker: 'O' }), true);
  assert.equal(isAmbiguousTicker({ ticker: 'KO' }), true);
  assert.equal(eventMatchesItem({ title: 'Ko Du-shim recalls an actor' }, { ticker: 'KO', name: 'Coca-Cola' }), false);
  assert.equal(eventMatchesItem({ title: 'Coca-Cola raises guidance' }, { ticker: 'KO', name: 'Coca-Cola' }), true);
  assert.equal(eventMatchesItem({ title: 'Markets open higher' }, { ticker: 'OPEN', ambiguous_ticker: true }), false);
  assert.equal(eventMatchesItem({ title: 'Studios take a cautious view of summer releases' }, { ticker: 'TTWO', name: 'Take-Two Interactive' }), false);
  assert.equal(eventMatchesItem({
    title: 'Circle shares fall after an analyst downgrade',
    summary: 'The stablecoin issuer faces more downside.',
    body: 'The report briefly compares Circle with Coinbase and other crypto companies.',
  }, { ticker: 'COIN', name: 'Coinbase' }), false);
  const metaForGoogle = await analyzeItem(
    { ticker: 'GOOG', name: 'Alphabet', themes: ['advertising'], positive_triggers: ['advertising growth'] },
    [{
      title: 'Meta Platforms stock rises on advertising growth',
      summary: 'Meta Platforms stock rises on advertising growth',
      source: 'Ad Hoc News',
      sourceDomain: 'ad-hoc-news.de',
      portfolioTicker: 'GOOG',
      query: 'Alphabet advertising growth',
      articleChecked: true,
    }],
    testSources,
  );
  assert.equal(metaForGoogle, null);
  const chipForHealthcare = await analyzeItem(
    { ticker: 'CURE', name: 'Direxion Daily Healthcare Bull 3X Shares', sector: 'Leveraged ETF', themes: ['healthcare sector'], positive_triggers: ['healthcare rally'] },
    [{
      title: 'Chip stocks fall as investors question the AI rally',
      summary: 'Chip stocks fall as investors question the AI rally',
      source: 'Reuters',
      sourceDomain: 'reuters.com',
      portfolioTicker: 'CURE',
      query: 'healthcare sector rally',
      articleChecked: true,
    }],
    testSources,
  );
  assert.equal(chipForHealthcare, null);
  const unknownHeadline = await analyzeItem(
    { ticker: 'GOOG', name: 'Alphabet', positive_triggers: ['raises guidance'] },
    [{
      title: 'Alphabet raises guidance',
      summary: 'Alphabet raises guidance',
      source: 'Ad Hoc News',
      sourceDomain: 'ad-hoc-news.de',
      portfolioTicker: 'GOOG',
      query: 'Alphabet earnings',
      articleChecked: true,
    }],
    testSources,
  );
  assert.equal(unknownHeadline, null);
  const unknownRssSummary = await analyzeItem(
    { ticker: 'GOOG', name: 'Alphabet', positive_triggers: ['raises guidance'] },
    [{
      title: 'Alphabet raises guidance',
      summary: 'The publisher says Alphabet raised its outlook after the quarter.',
      source: 'Ad Hoc News',
      sourceDomain: 'ad-hoc-news.de',
      portfolioTicker: 'GOOG',
      query: 'Alphabet earnings',
      articleChecked: true,
    }],
    testSources,
  );
  assert.equal(unknownRssSummary, null);
  assert.equal(findKnownSource(
    { source: 'Fake Reuters', sourceDomain: 'fakereuters.com' },
    { source_groups: ['market_news'] },
    testSources,
  ), undefined);
  const duplicateItem = { ticker: 'GOOG', name: 'Alphabet', positive_triggers: ['raises guidance'], source_groups: ['market_news'] };
  const duplicateEvent = {
    title: 'Alphabet raises guidance',
    summary: 'Alphabet raises guidance',
    source: 'Reuters',
    sourceDomain: 'reuters.com',
    url: 'https://reuters.com/alphabet-guidance',
    query: 'Alphabet earnings',
    articleChecked: true,
  };
  const nextEvent = {
    title: 'Alphabet announces cloud expansion',
    summary: 'Alphabet announces cloud expansion',
    source: 'Reuters',
    sourceDomain: 'reuters.com',
    url: 'https://reuters.com/alphabet-cloud',
    query: 'Alphabet cloud',
    articleChecked: true,
  };
  const nextAlert = await analyzeItem(
    duplicateItem,
    [duplicateEvent, nextEvent],
    testSources,
    new Set([alertKey(duplicateItem, duplicateEvent)]),
  );
  assert.equal(nextAlert.event.url, nextEvent.url);
  assert.deepEqual([...limitSeen(new Set(['a', 'b', 'c']), 2)], ['b', 'c']);
  const decodePayload = JSON.parse(buildGoogleNewsDecodePayload('article-id', '123', 'signature'));
  const decodeRequest = JSON.parse(decodePayload[0][0][1]);
  assert.equal(decodeRequest[0], 'garturlreq');
  assert.deepEqual(decodeRequest.slice(2), ['article-id', 123, 'signature']);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
