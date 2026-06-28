import fs from 'node:fs/promises';

const DEFAULT_PORTFOLIO = 'data/portfolio.json';
const MAX_MESSAGE_LENGTH = 3900;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const portfolio = await readJson(args.portfolio || DEFAULT_PORTFOLIO);
  const events = args.events
    ? await readJson(args.events)
    : await collectEvents(portfolio.items || []);

  const alerts = (portfolio.items || [])
    .filter(item => item.status !== 'paused')
    .map(item => analyzeItem(item, events))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  if (alerts.length === 0) {
    console.log('No portfolio alerts.');
    return;
  }

  const message = alerts.map(formatAlert).join('\n\n---\n\n');
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
    else if (args[i] === '--events') parsed.events = args[++i];
  }
  return parsed;
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function collectEvents(items) {
  const all = [];

  for (const item of items.filter(item => item.status !== 'paused')) {
    const queries = buildQueries(item).slice(0, 6);
    for (const query of queries) {
      const events = await fetchGoogleNews(query.query);
      all.push(...events.map(event => ({
        ...event,
        portfolioTicker: item.ticker,
        query: query.query,
        queryWhy: query.why,
      })));
      await sleep(300);
    }
  }

  return dedupeEvents(all).slice(0, 80);
}

function buildQueries(item) {
  const manual = Array.isArray(item.watch_queries) ? item.watch_queries : [];
  const fallback = [item.ticker, item.name, ...(item.themes || [])]
    .filter(Boolean)
    .map(query => ({ query, why: '기본 감시 쿼리' }));
  return uniqueBy([...manual, ...fallback], entry => entry.query.toLowerCase());
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
      url: decodeXml(extractXml(block, 'link')),
      publishedAt: decodeXml(extractXml(block, 'pubDate')),
    });
  }

  return items;
}

function analyzeItem(item, events) {
  const scored = events
    .filter(event => event.portfolioTicker === item.ticker || eventMatchesItem(event, item))
    .map(event => scoreEvent(item, event))
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

function scoreEvent(item, event) {
  const text = normalize(`${event.title} ${event.summary} ${event.query || ''}`);
  const positiveMatches = matchList(item.positive_triggers || [], text);
  const negativeMatches = matchList(item.negative_triggers || [], text);
  const themeMatches = (item.themes || []).filter(theme => text.includes(normalize(theme)));
  const directMatch = [item.ticker, item.name].filter(Boolean).some(value => text.includes(normalize(value)));
  const queryMatch = event.query ? 1 : 0;

  let score = 1 + queryMatch;
  if (directMatch) score += 3;
  score += Math.min(themeMatches.length, 2) * 2;
  score += Math.min(positiveMatches.length + negativeMatches.length, 2) * 3;

  const direction = classifyDirection(positiveMatches.length, negativeMatches.length);

  return {
    event,
    score: Math.min(10, score),
    direction,
    matches: {
      positive: positiveMatches,
      negative: negativeMatches,
      themes: themeMatches,
    },
  };
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

function formatAlert(alert) {
  const { item, event, score, direction, action } = alert;
  const icon = { positive: '🟢', negative: '🔴', mixed: '🟡', unknown: '⚪' }[direction] || '⚪';
  const directionLabel = { positive: '긍정', negative: '부정', mixed: '혼합', unknown: '불명' }[direction] || '불명';

  return [
    `${icon} T${score} · ${item.ticker} · ${directionLabel} · ${action}`,
    '',
    `무슨 일:\n${event.title}${event.summary ? `\n${event.summary}` : ''}`,
    '',
    `왜 중요:\n${item.why_it_matters || `${item.name || item.ticker}의 주요 감시 요인과 연결됩니다.`}`,
    '',
    `큰그림:\n${formatChain(item.chain || [])}`,
    '',
    `같이 봐야 할 종목:\n${formatRelated(item.related_tickers || [])}`,
    '',
    `확인할 데이터:\n${formatIndicators(item.key_indicators || [])}`,
    '',
    `내 판단:\n${judgementSentence(item, direction, action)}`,
    '',
    `출처:\n${event.source || 'Unknown'}${event.url ? ` · ${event.url}` : ''}`,
  ].join('\n');
}

function formatChain(chain) {
  if (chain.length === 0) return '- 아직 등록된 체인 설명이 없습니다.';
  return chain.slice(0, 5)
    .map(step => `- ${step.from} → ${step.to}: ${step.why}`)
    .join('\n');
}

function formatRelated(related) {
  if (related.length === 0) return '- 아직 등록된 관련 종목이 없습니다.';
  return related.slice(0, 6)
    .map(entry => `- ${entry.ticker}${entry.name ? ` (${entry.name})` : ''}: ${entry.why}`)
    .join('\n');
}

function formatIndicators(indicators) {
  if (indicators.length === 0) return '- 아직 등록된 확인 데이터가 없습니다.';
  return indicators.slice(0, 3)
    .map(entry => [
      `- ${entry.name}`,
      `  왜 봄: ${entry.why}`,
      `  긍정: ${entry.positive}`,
      `  부정: ${entry.negative}`,
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
        link_preview_options: { is_disabled: true },
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API error ${response.status}: ${await response.text()}`);
    }
  }
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

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
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
