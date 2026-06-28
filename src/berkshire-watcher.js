import fs from 'node:fs/promises';

const DEFAULT_PORTFOLIO = 'data/portfolio.json';
const DEFAULT_SOURCES = 'data/sources.json';
const DEFAULT_PROFILES_DIR = 'data/profiles';
const DEFAULT_TEMPLATES_DIR = 'data/templates';
const MAX_MESSAGE_LENGTH = 3900;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const portfolio = await readJson(args.portfolio || DEFAULT_PORTFOLIO);
  const items = await loadPortfolioItems(portfolio.items || []);
  const sources = await readOptionalJson(args.sources || DEFAULT_SOURCES, { groups: {} });
  const events = args.events
    ? await readJson(args.events)
    : await collectEvents(items, sources);

  const alerts = items
    .filter(item => item.status !== 'paused')
    .map(item => analyzeItem(item, events, sources))
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

  return dedupeEvents(all).slice(0, 80);
}

function buildQueries(item, sources) {
  const manual = Array.isArray(item.watch_queries) ? item.watch_queries : [];
  const fallback = [item.ticker, item.name, ...(item.themes || [])]
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
    headers: { 'User-Agent': 'berkshire-watcher/0.1' },
  });

  if (!response.ok) {
    console.warn(`Google News fetch failed for "${query}": ${response.status}`);
    return [];
  }

  return parseRss(await response.text());
}

function parseRss(xml) {
  const items = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemPattern.exec(xml))) {
    const block = match[1];
    items.push({
      title: decodeXml(extractXml(block, 'title')),
      summary: stripHtml(decodeXml(extractXml(block, 'description'))),
      source: decodeXml(extractXml(block, 'source')) || 'Google News',
      sourceDomain: domainFromUrl(decodeXml(extractXmlAttr(block, 'source', 'url'))),
      url: decodeXml(extractXml(block, 'link')),
    });
  }

  return items;
}

function analyzeItem(item, events, sources) {
  const scored = events
    .filter(event => event.portfolioTicker === item.ticker || eventMatchesItem(event, item))
    .map(event => scoreEvent(item, event, sources))
    .filter(result => result.score >= Number(process.env.MIN_T_SCORE || 5))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const top = scored[0];
  return {
    item,
    event: top.event,
    score: top.score,
    direction: top.direction,
    action: actionFor(item, top.score, top.direction),
    matches: top.matches,
  };
}

function eventMatchesItem(event, item) {
  const text = normalize(`${event.title} ${event.summary} ${event.query || ''}`);
  return [item.ticker, item.name, ...(item.themes || [])]
    .filter(Boolean)
    .some(value => text.includes(normalize(value)));
}

function scoreEvent(item, event, sources) {
  const text = normalize(`${event.title} ${event.summary} ${event.query || ''}`);
  const positiveMatches = matchList(item.positive_triggers || [], text);
  const negativeMatches = matchList(item.negative_triggers || [], text);
  const themeMatches = (item.themes || []).filter(theme => text.includes(normalize(theme)));
  const sectorMatches = [item.sector, item.subsector, ...(item.sector_cycle?.watch || [])]
    .filter(Boolean)
    .filter(value => text.includes(normalize(value)));
  const directMatch = [item.ticker, item.name].filter(Boolean).some(value => text.includes(normalize(value)));
  const queryMatch = event.query ? 1 : 0;
  const source = event.querySource || findKnownSource(event, item, sources);

  let score = 1 + queryMatch;
  if (directMatch) score += 3;
  score += Math.min(themeMatches.length, 2) * 2;
  score += Math.min(sectorMatches.length, 1) * 2;
  score += Math.min(positiveMatches.length + negativeMatches.length, 2) * 3;
  score += source?.tier === 1 ? 2 : source?.tier === 2 ? 1 : 0;

  const direction = classifyDirection(positiveMatches.length, negativeMatches.length);

  return {
    event,
    score: Math.min(10, score),
    direction,
    matches: {
      positive: positiveMatches,
      negative: negativeMatches,
      themes: themeMatches,
      sectors: sectorMatches,
      source,
    },
  };
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

function actionFor(item, score, direction) {
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
  const directionLabel = { positive: '긍정', negative: '부정', mixed: '혼합', unknown: '불명' }[direction] || '불명';
  const title = `[${item.ticker}]${item.name || item.ticker}`;
  const newsTitle = cleanNewsText(event.title, event.source);
  const newsSummary = cleanNewsText(event.summary, event.source);
  const translatedTitle = await translateNewsText(newsTitle);
  const translatedSummary = await translateNewsText(newsSummary);
  const summary = isSameNewsText(translatedTitle, translatedSummary) ? '' : translatedSummary;

  return [
    `${icon} T${score} · ${escapeHtml(title)} · ${directionLabel} · ${action}`,
    '',
    `<b>이슈</b>\n${escapeHtml(translatedTitle)}${summary ? `\n${escapeHtml(summary)}` : ''}`,
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

async function translateNewsText(text) {
  const value = String(text || '').trim();
  if (!value || /[가-힣]/.test(value) || process.env.TRANSLATE_NEWS === '0') return value;

  try {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.search = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: 'ko',
      dt: 't',
      q: value,
    });
    const response = await fetch(url, { headers: { 'User-Agent': 'berkshire-watcher/0.1' } });
    if (!response.ok) return value;
    const body = await response.json();
    return body?.[0]?.map(part => part?.[0] || '').join('') || value;
  } catch {
    return value;
  }
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

function formatSectorCycle(item) {
  if (!item.sector && !item.sector_cycle) return '- 아직 등록된 섹터 순환 설명이 없습니다.';

  const lines = [
    `- 섹터: ${escapeHtml([item.sector, item.subsector].filter(Boolean).join(' / '))}`,
  ];
  if (item.portfolios?.length) lines.push(`- 포트폴리오: ${escapeHtml(item.portfolios.join(' / '))}`);
  if (item.sector_cycle?.why) lines.push(`- 왜 봄: ${escapeHtml(item.sector_cycle.why)}`);
  if (item.sector_cycle?.positive?.length) lines.push(`- 긍정: ${escapeHtml(item.sector_cycle.positive.slice(0, 2).join(' / '))}`);
  if (item.sector_cycle?.negative?.length) lines.push(`- 부정: ${escapeHtml(item.sector_cycle.negative.slice(0, 2).join(' / '))}`);
  return lines.join('\n');
}

function formatChain(chain) {
  if (chain.length === 0) return '- 아직 등록된 체인 설명이 없습니다.';
  return chain.slice(0, 5)
    .map(step => `- ${escapeHtml(step.from)} → ${escapeHtml(step.to)}: ${escapeHtml(step.why)}`)
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
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
