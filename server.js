// ============================================================
// 1. ЗАВИСИМОСТИ
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const Parser = require('rss-parser');
const { RSI, MACD } = require('technicalindicators');
const path = require('path');

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';
const PORT = process.env.PORT || 4000;

if (!FINNHUB_KEY) {
  console.error('❌ Нет FINNHUB_KEY в .env или переменных окружения');
  process.exit(1);
}

const WATCHLIST = [
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD',
  'NFLX', 'DIS', 'JPM', 'V', 'WMT', 'KO', 'XOM', 'PFE', 'BA', 'INTC', 'CSCO', 'PYPL',
  'ADBE', 'CRM', 'ORCL', 'IBM', 'QCOM', 'TXN', 'AVGO', 'MU', 'AMAT', 'SBUX',
  'NKE', 'MCD', 'PG', 'JNJ', 'UNH', 'HD', 'CVX', 'ABBV', 'MRK', 'PEP',
  'T', 'VZ', 'CMCSA', 'TMUS', 'COST', 'LLY', 'ACN', 'DHR', 'NEE', 'LIN'
];

const COMPANY_NAMES = {
  'AAPL': 'Apple Inc.', 'MSFT': 'Microsoft Corp.', 'NVDA': 'NVIDIA Corp.', 'TSLA': 'Tesla Inc.',
  'AMZN': 'Amazon.com', 'GOOGL': 'Alphabet Inc.', 'META': 'Meta Platforms', 'AMD': 'Advanced Micro',
  'NFLX': 'Netflix Inc.', 'DIS': 'Walt Disney Co.', 'JPM': 'JPMorgan Chase', 'V': 'Visa Inc.',
  'WMT': 'Walmart Inc.', 'KO': 'Coca-Cola Co.', 'XOM': 'Exxon Mobil', 'PFE': 'Pfizer Inc.',
  'BA': 'Boeing Co.', 'INTC': 'Intel Corp.', 'CSCO': 'Cisco Systems', 'PYPL': 'PayPal Holdings',
  'ADBE': 'Adobe Inc.', 'CRM': 'Salesforce', 'ORCL': 'Oracle Corp.', 'IBM': 'IBM Corp.',
  'QCOM': 'Qualcomm', 'TXN': 'Texas Instruments', 'AVGO': 'Broadcom', 'MU': 'Micron Tech',
  'AMAT': 'Applied Materials', 'SBUX': 'Starbucks', 'NKE': 'Nike Inc.', 'MCD': 'McDonalds',
  'PG': 'Procter & Gamble', 'JNJ': 'Johnson & Johnson', 'UNH': 'UnitedHealth', 'HD': 'Home Depot',
  'CVX': 'Chevron', 'ABBV': 'AbbVie', 'MRK': 'Merck & Co.', 'PEP': 'PepsiCo', 'T': 'AT&T',
  'VZ': 'Verizon', 'CMCSA': 'Comcast', 'TMUS': 'T-Mobile', 'COST': 'Costco', 'LLY': 'Eli Lilly',
  'ACN': 'Accenture', 'DHR': 'Danaher', 'NEE': 'NextEra Energy', 'LIN': 'Linde plc'
};

const cache = new Map();
const TTL = 60_000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

const getQuote = (s) => cached(`q:${s}`, async () => {
  const { data } = await axios.get(`${BASE}/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return {
    symbol: s, price: data.c, change: data.d, percent: data.dp,
    high: data.h, low: data.l, open: data.o, prevClose: data.pc
  };
});

const getCandles = (s, days = 60) => cached(`c:${s}:${days}`, async () => {
  const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : '6mo';
  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${s}`,
    { params: { range, interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const r = data.chart.result[0];
  const q = r.indicators.quote[0];
  
  const closes = q.close.filter(c => c !== null);
  const volumes = q.volume.filter(v => v !== null);
  
  const rsiResult = RSI.calculate({ values: closes, period: 14 });
  const macdResult = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });

  const candles = r.timestamp.map((t, i) => ({
    x: t * 1000,
    o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i]
  })).filter(c => c.c !== null);

  const lastRsi = rsiResult.length ? rsiResult[rsiResult.length - 1] : null;
  const lastMacd = macdResult.length ? macdResult[macdResult.length - 1] : null;
  const lastVolume = volumes.length ? volumes[volumes.length - 1] : null;

  return {
    candles,
    indicators: {
      rsi: lastRsi,
      macd: lastMacd ? lastMacd.MACD : null,
      macdSignal: lastMacd ? lastMacd.signal : null,
      macdHistogram: lastMacd ? lastMacd.histogram : null,
      volume: lastVolume
    }
  };
});

const getFundamentals = (s) => cached(`f:${s}`, async () => {
  const { data } = await axios.get(
    `${BASE}/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`
  );
  const m = data.metric || {};
  return {
    symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, 
    evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM,
    ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM,
    revenueGrowth: m.revenueGrowthTTMYoy,
    debtEbitda: m.totalDebtToEbitda || m.netDebtToEbitda,
    roe: m.roeTTM 
  };
});

const parser = new Parser();
const getNews = () => cached('news:cnbc', async () => {
  try {
    const feed = await parser.parseURL('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114');
    return feed.items.slice(0, 6).map(item => {
      let image = null;
      if (item.enclosure && item.enclosure.url) image = item.enclosure.url;
      else if (item.content) {
        const imgMatch = item.content.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) image = imgMatch[1];
      }
      return {
        headline: item.title, source: 'CNBC', url: item.link,
        datetime: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
        image: image
      };
    });
  } catch (error) { return []; }
});

// ============================================================
// API И РАЗДАЧА СТАТИКИ
// ============================================================
const app = express();
app.use(cors());

// Раздаем файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quote/:symbol', async (req, res) => {
  try { res.json(await getQuote(req.params.symbol)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/candles/:symbol', async (req, res) => {
  try { res.json(await getCandles(req.params.symbol, +req.query.days || 60)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/fundamentals/:symbol', async (req, res) => {
  try { res.json(await getFundamentals(req.params.symbol)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/news', async (req, res) => {
  try { res.json(await getNews()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/watchlist', (req, res) => {
  res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym })));
});

// ============================================================
// WEBSOCKET И ЗАПУСК
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (s) => {
  clients.add(s);
  s.on('close', () => clients.delete(s));
});

function broadcast(p) {
  const msg = JSON.stringify(p);
  clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function connectFinnhub() {
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    WATCHLIST.slice(0, 20).forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p }));
  });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
  ws.on('error', (e) => console.error('Finnhub WS:', e.message));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
  console.log(`Локально: http://localhost:${PORT}\n`);
  connectFinnhub();
});