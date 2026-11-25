'use strict';
const Parser = require('rss-parser');
const { getJson } = require('./http');
const { getOrLoad } = require('./cache');
const log = require('./logger');

const TTL = {
  quoteUS: 30_000,
  quoteEU: 30_000,
  quoteRU: 30_000,
  quoteCrypto: 15_000,
  quoteFx: 60_000,
  candles: 30 * 60_000,
  fundamentals: 24 * 60 * 60_000,
  news: 10 * 60_000,
  fxRate: 6 * 60 * 60_000,
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Последнее состояние каждого источника. Нужно для /api/diagnostics:
 * без этого «нет данных» одинаково выглядит и при блокировке источника,
 * и при отсутствии символа, и при сетевой ошибке.
 */
const providerStatus = {};

function mark(name, ok, detail) {
  providerStatus[name] = {
    ok,
    detail: detail ? String(detail).slice(0, 200) : null,
    at: new Date().toISOString(),
  };
}

function getProviderStatus() {
  return { ...providerStatus };
}

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/**
 * Yahoo — единственный источник, который отдаёт и котировки EU, и дневные свечи.
 * Запрос идёт в два хоста подряд: query1 иногда отвечает 429 с дата-центровых IP.
 */
async function yahooChart(symbol, params, timeout = 12_000) {
  let lastError = 'unknown';
  for (const host of YAHOO_HOSTS) {
    try {
      const data = await getJson(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}`, { params, timeout });
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      if (result) {
        mark('yahoo', true);
        return result;
      }
      lastError = (data && data.chart && data.chart.error && data.chart.error.description) || 'empty result';
    } catch (err) {
      lastError = (err && err.message) || String(err);
    }
  }
  mark('yahoo', false, lastError);
  log.warn('providers', `Yahoo не ответил по ${symbol}`, lastError);
  return null;
}

function moexTimeToIso(value) {
  if (!value || typeof value !== 'string') return null;
  // ISS отдаёт московское время без зоны: "2026-11-24 23:50:41"
  const parsed = new Date(`${value.replace(' ', 'T')}+03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Москва = UTC+3, отдельного DST нет. */
function parseMoexTimestamp(value) {
  if (!value || typeof value !== 'string') return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}+03:00`);
  return Number.isFinite(ms) ? ms : null;
}

/* --------------------------------------------------------------- котировки */

async function fetchUsQuote(symbol) {
  const data = await getJson('https://finnhub.io/api/v1/quote', {
    params: { symbol, token: process.env.FINNHUB_KEY },
  });
  const price = num(data && data.c);
  // Finnhub на неизвестный тикер отвечает 200 и нулями — это не «цена 0», а «нет данных»
  if (!price || price <= 0) {
    mark('finnhub', false, `пустой ответ по ${symbol}`);
    return null;
  }
  mark('finnhub', true);
  return {
    symbol,
    market: 'US',
    price,
    change: num(data.d),
    percent: num(data.dp),
    currency: 'USD',
    source: 'Finnhub',
    delayed: false,
    asOf: data.t ? new Date(data.t * 1000).toISOString() : new Date().toISOString(),
  };
}

async function fetchEuQuote(symbol) {
  // range=1d обязателен: при 5d/1mo chartPreviousClose — это закрытие ПЕРЕД началом
  // окна, и процент изменения получался неверным (SAP.DE: -5.6% вместо +2.0%).
  const result = await yahooChart(symbol, { range: '1d', interval: '1d' });
  if (!result) return null;

  const meta = result.meta || {};
  const price = num(meta.regularMarketPrice);
  if (!price || price <= 0) return null;

  const previousClose = num(meta.chartPreviousClose) ?? num(meta.previousClose);
  const change = previousClose ? price - previousClose : null;
  const percent = previousClose ? (change / previousClose) * 100 : null;

  return {
    symbol,
    market: 'EU',
    price,
    change,
    percent,
    currency: meta.currency || 'EUR',
    source: 'Yahoo Finance',
    delayed: true,
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString(),
  };
}

async function fetchRuQuote(symbol) {
  const data = await getJson(
    `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(symbol)}.json`,
    { params: { 'iss.meta': 'off' } },
  );

  const cols = data && data.marketdata && data.marketdata.columns;
  const row = data && data.marketdata && data.marketdata.data && data.marketdata.data[0];
  if (!cols || !row) {
    mark('moex', false, `нет строки marketdata по ${symbol}`);
    return null;
  }

  const value = (name) => {
    const index = cols.indexOf(name);
    return index >= 0 ? row[index] : null;
  };

  // LAST бывает null вне торговой сессии — раньше из-за этого весь RU-рынок отдавал 404.
  const price =
    num(value('LAST')) ??
    num(value('LCURRENTPRICE')) ??
    num(value('MARKETPRICE')) ??
    num(value('CLOSINGAUCTIONPRICE')) ??
    num(value('LCLOSEPRICE'));
  if (!price || price <= 0) return null;

  const percent = num(value('LASTTOPREVPRICE'));
  const change = num(value('CHANGE'));

  return {
    symbol,
    market: 'RU',
    price,
    change,
    percent,
    currency: 'RUB',
    source: 'MOEX ISS',
    delayed: true, // ISS для TQBR по умолчанию с задержкой ~15 минут
    asOf: moexTimeToIso(value('SYSTIME')) || new Date().toISOString(),
    volume: num(value('VOLTODAY')),
  };
}

async function fetchCryptoQuote(symbol) {
  const pair = symbol.replace(/^BINANCE:/, '');
  const data = await getJson('https://api.binance.com/api/v3/ticker/24hr', {
    params: { symbol: pair },
  });
  const price = num(data && data.lastPrice);
  if (!price || price <= 0) return null;

  mark('binance', true);
  return {
    symbol,
    market: 'CRYPTO',
    price,
    change: num(data.priceChange),
    percent: num(data.priceChangePercent),
    currency: 'USD',
    source: 'Binance',
    delayed: false,
    asOf: new Date(Number(data.closeTime) || Date.now()).toISOString(),
    volume: num(data.quoteVolume),
  };
}

async function frankfurterRate(base, quote, date) {
  const path = date ? `https://api.frankfurter.app/${date}` : 'https://api.frankfurter.app/latest';
  try {
    const data = await getJson(path, { params: { from: base, to: quote } });
    const rate = num(data && data.rates && data.rates[quote]);
    mark('frankfurter', !!(rate && rate > 0), rate ? null : `нет курса ${base}/${quote}`);
    return rate && rate > 0 ? { rate, date: data.date } : null;
  } catch (err) {
    mark('frankfurter', false, err && err.message);
    throw err;
  }
}

async function fetchFxQuote(symbol) {
  const base = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  if (!/^[A-Z]{6}$/.test(symbol)) return null;

  const today = await frankfurterRate(base, quote);
  if (!today) return null;

  const previousDate = new Date(`${today.date}T00:00:00Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const previous = await frankfurterRate(base, quote, previousDate.toISOString().slice(0, 10));

  const change = previous ? today.rate - previous.rate : null;
  const percent = previous && previous.rate ? (change / previous.rate) * 100 : null;

  return {
    symbol,
    market: 'FOREX',
    price: today.rate,
    change,
    percent,
    currency: quote,
    source: 'ECB (Frankfurter)',
    delayed: true,
    asOf: new Date(`${today.date}T00:00:00Z`).toISOString(),
  };
}

const QUOTE_FETCHERS = {
  US: { fn: fetchUsQuote, ttl: TTL.quoteUS },
  EU: { fn: fetchEuQuote, ttl: TTL.quoteEU },
  RU: { fn: fetchRuQuote, ttl: TTL.quoteRU },
  CRYPTO: { fn: fetchCryptoQuote, ttl: TTL.quoteCrypto },
  FOREX: { fn: fetchFxQuote, ttl: TTL.quoteFx },
};

async function getQuote(symbol, market) {
  const fetcher = QUOTE_FETCHERS[market];
  if (!fetcher) return null;
  return getOrLoad(`quote:${market}:${symbol}`, fetcher.ttl, () => fetcher.fn(symbol));
}

/* ------------------------------------------------------------------ свечи */

function yahooRangeForDays(days) {
  if (days <= 31) return '1mo';
  if (days <= 93) return '3mo';
  if (days <= 186) return '6mo';
  if (days <= 366) return '1y';
  if (days <= 732) return '2y';
  return '5y';
}

async function fetchRuCandles(symbol, days) {
  const till = new Date();
  const from = new Date(till.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const data = await getJson(
    `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(symbol)}/candles.json`,
    { params: { from: iso(from), till: iso(till), interval: 24, 'iss.meta': 'off' } },
  );

  const block = data && data.candles;
  if (!block || !block.columns || !Array.isArray(block.data)) return [];

  const cols = block.columns;
  const at = (row, name) => {
    const index = cols.indexOf(name);
    return index >= 0 ? row[index] : null;
  };

  return block.data
    .map((row) => ({
      x: parseMoexTimestamp(at(row, 'begin')),
      o: num(at(row, 'open')),
      h: num(at(row, 'high')),
      l: num(at(row, 'low')),
      c: num(at(row, 'close')),
      v: num(at(row, 'volume')),
    }))
    .filter((c) => Number.isFinite(c.x) && c.o && c.h && c.l && c.c);
}

async function fetchCryptoCandles(symbol, days) {
  const pair = symbol.replace(/^BINANCE:/, '');
  const data = await getJson('https://api.binance.com/api/v3/klines', {
    params: { symbol: pair, interval: '1d', limit: Math.min(Math.max(days, 5), 1000) },
  });
  if (!Array.isArray(data)) return [];
  return data.map((row) => ({
    x: Number(row[0]),
    o: num(row[1]),
    h: num(row[2]),
    l: num(row[3]),
    c: num(row[4]),
    v: num(row[5]),
  })).filter((c) => c.c);
}

async function fetchYahooCandles(symbol, days, market) {
  let yahooSymbol = symbol;
  if (market === 'CRYPTO') yahooSymbol = symbol.replace(/^BINANCE:/, '').replace(/USDT$/, '-USD');
  if (market === 'FOREX') yahooSymbol = `${symbol}=X`;

  const result = await yahooChart(yahooSymbol, { range: yahooRangeForDays(days), interval: '1d' });
  if (!result || !Array.isArray(result.timestamp)) return [];

  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote) return [];

  return result.timestamp
    .map((time, index) => ({
      x: time * 1000,
      o: num(quote.open && quote.open[index]),
      h: num(quote.high && quote.high[index]),
      l: num(quote.low && quote.low[index]),
      c: num(quote.close && quote.close[index]),
      v: num(quote.volume && quote.volume[index]),
    }))
    .filter((c) => c.c && Number.isFinite(c.x));
}

async function getCandles(symbol, market, days = 365) {
  const providers = { RU: 'moex', CRYPTO: 'binance', US: 'yahoo', EU: 'yahoo', FOREX: 'yahoo' };
  return getOrLoad(`candles:${market}:${symbol}:${days}`, TTL.candles, async () => {
    let candles = [];
    try {
      if (market === 'RU') {
        candles = await fetchRuCandles(symbol, days);
        mark('moex', candles.length > 0, candles.length ? null : 'пустой ответ');
      } else if (market === 'CRYPTO') {
        candles = await fetchCryptoCandles(symbol, days);
        mark('binance', candles.length > 0, candles.length ? null : 'пустой ответ');
      } else {
        candles = await fetchYahooCandles(symbol, days, market);
      }
    } catch (err) {
      mark(providers[market] || 'unknown', false, err && err.message);
      return { candles: [], provider: providers[market] || 'unknown', error: String((err && err.message) || err), fetchedAt: new Date().toISOString() };
    }

    return {
      candles,
      provider: providers[market] || 'unknown',
      error: candles.length ? null : 'источник не вернул свечи',
      fetchedAt: new Date().toISOString(),
    };
  });
}

/* -------------------------------------------------------- фундаментальные */

const emptyFundamentals = (symbol, reason) => ({
  symbol,
  available: false,
  reason,
  pe: null,
  ps: null,
  evEbitda: null,
  operatingMargin: null,
  grossMargin: null,
  revenueGrowth: null,
  debtEquity: null,
  roe: null,
  metrics: [],
});

/**
 * Бесплатный тариф Finnhub отдаёт НЕ все метрики: ebitdaMarginTTM и totalDebtToEbitda
 * отсутствуют, зато есть operatingMarginTTM и totalDebt/totalEquityAnnual.
 * Раньше код подставлял operatingMargin вместо EBITDA margin — это фактическая ошибка.
 * Теперь отдаём ровно то, что есть, с честными названиями.
 */
function buildMetricList(values) {
  const definitions = [
    { key: 'pe', label: 'P/E', unit: 'x' },
    { key: 'ps', label: 'P/S', unit: 'x' },
    { key: 'evEbitda', label: 'EV/EBITDA', unit: 'x' },
    { key: 'operatingMargin', label: 'Operating Margin', unit: '%' },
    { key: 'grossMargin', label: 'Gross Margin', unit: '%' },
    { key: 'revenueGrowth', label: 'Revenue Growth (YoY)', unit: '%' },
    { key: 'debtEquity', label: 'Debt/Equity', unit: 'x' },
    { key: 'roe', label: 'ROE', unit: '%' },
  ];

  return definitions.map((definition) => ({
    ...definition,
    value: values[definition.key] === undefined ? null : values[definition.key],
  }));
}

async function fetchUsFundamentals(symbol) {
  const data = await getJson('https://finnhub.io/api/v1/stock/metric', {
    params: { symbol, metric: 'all', token: process.env.FINNHUB_KEY },
  });
  const m = (data && data.metric) || {};
  const values = {
    pe: num(m.peBasicExclExtraTTM),
    ps: num(m.psTTM),
    evEbitda: num(m.evEbitdaTTM) ?? num(m.currentEvEbitdaTTM),
    operatingMargin: num(m.operatingMarginTTM),
    grossMargin: num(m.grossMarginTTM),
    revenueGrowth: num(m.revenueGrowthTTMYoy),
    debtEquity: num(m['totalDebt/totalEquityAnnual']) ?? num(m['totalDebt/totalEquityQuarterly']),
    roe: num(m.roeTTM),
  };

  const hasAny = Object.values(values).some((v) => v !== null);
  if (!hasAny) return emptyFundamentals(symbol, 'provider_unavailable');

  return {
    symbol,
    available: true,
    market: 'US',
    ...values,
    metrics: buildMetricList(values),
    source: 'Finnhub',
    asOf: new Date().toISOString(),
  };
}

async function getFundamentals(symbol, market) {
  if (market !== 'US') {
    // Eulerpool блокирует бесплатные запросы Cloudflare-челленджем (403),
    // Finnhub на EU-тикеры отвечает 403 на бесплатном тарифе.
    // Честнее сказать «нет данных», чем рисовать семь прочерков как результат анализа.
    return emptyFundamentals(symbol, market === 'EU' ? 'provider_unavailable' : 'not_applicable');
  }
  return getOrLoad(`fund:${symbol}`, TTL.fundamentals, async () => {
    try {
      return await fetchUsFundamentals(symbol);
    } catch (err) {
      log.warn('providers', `фундаментал ${symbol} не получен`, String(err && err.message));
      return emptyFundamentals(symbol, 'provider_unavailable');
    }
  });
}

/* -------------------------------------------------------------------- FX */

/** Курс для пересчёта в базовую валюту. Пары с RUB берём у Yahoo (MOEX до открытия сессии пуст), остальное — ECB. */
async function getFxRate(from, to) {
  const base = String(from || '').toUpperCase();
  const quote = String(to || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) return null;
  if (base === quote) return { rate: 1, source: 'identity', asOf: new Date().toISOString() };

  return getOrLoad(`fx:${base}:${quote}`, TTL.fxRate, async () => {
    if (base === 'RUB' || quote === 'RUB') {
      const other = base === 'RUB' ? quote : base;
      const rubPerUnit = await getRubRate(other);
      if (!rubPerUnit) return null;

      const rate = base === 'RUB' ? 1 / rubPerUnit.rate : rubPerUnit.rate;
      return { rate, source: rubPerUnit.source, asOf: rubPerUnit.asOf };
    }

    const direct = await frankfurterRate(base, quote);
    if (!direct) return null;
    return { rate: direct.rate, source: 'ECB', asOf: new Date(`${direct.date}T00:00:00Z`).toISOString() };
  });
}

/**
 * Сколько рублей за одну единицу валюты.
 * Основной источник — Yahoo (работает круглосуточно), MOEX — запасной на случай сбоя Yahoo.
 */
async function getRubRate(currency) {
  return getOrLoad(`fx:${currency}:RUB`, TTL.fxRate, async () => {
    const yahooSymbol = currency === 'USD' ? 'RUB=X' : `${currency}RUB=X`;

    try {
      const data = await getJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,
        { params: { range: '1d', interval: '1d' } },
      );
      const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      const rate = num(meta && meta.regularMarketPrice);
      if (rate && rate > 0) {
        return {
          rate,
          source: 'Yahoo Finance',
          asOf: meta.regularMarketTime
            ? new Date(meta.regularMarketTime * 1000).toISOString()
            : new Date().toISOString(),
        };
      }
    } catch (err) {
      log.warn('providers', `курс ${yahooSymbol} не получен`, String(err && err.message));
    }

    if (currency !== 'USD') return null;

    // Запасной путь: биржевой курс MOEX доступен только в торговую сессию.
    const data = await getJson(
      'https://iss.moex.com/iss/engines/currency/markets/selt/boards/CETS/securities/USD000UTSTOM.json',
      { params: { 'iss.meta': 'off' } },
    );
    const cols = data && data.marketdata && data.marketdata.columns;
    const row = data && data.marketdata && data.marketdata.data && data.marketdata.data[0];
    if (!cols || !row) return null;

    const value = (name) => {
      const index = cols.indexOf(name);
      return index >= 0 ? row[index] : null;
    };
    const rate = num(value('LAST')) ?? num(value('MARKETPRICE'));
    if (!rate || rate <= 0) return null;

    return { rate, source: 'MOEX', asOf: moexTimeToIso(value('SYSTIME')) || new Date().toISOString() };
  });
}

/* ------------------------------------------------------------------ новости */

const parser = new Parser({ timeout: 10_000 });

async function getNews() {
  return getOrLoad('news:cnbc', TTL.news, async () => {
    const feed = await parser.parseURL('https://www.cnbc.com/id/100003114/device/rss/rss.html');
    return (feed.items || []).slice(0, 6).map((item) => {
      let image = null;
      if (item.enclosure && item.enclosure.url) image = item.enclosure.url;
      else if (typeof item.content === 'string') {
        const match = item.content.match(/<img[^>]+src="([^">]+)"/);
        if (match) image = match[1];
      }
      return { headline: item.title || '', url: item.link || '', image, publishedAt: item.isoDate || null };
    });
  });
}

module.exports = {
  getQuote,
  getCandles,
  getFundamentals,
  getFxRate,
  getNews,
  getProviderStatus,
  TTL,
};
