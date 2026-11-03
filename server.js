require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const Parser = require('rss-parser');
const { RSI, MACD, SMA } = require('technicalindicators');
const path = require('path');
const { JSONFilePreset } = require('lowdb/node');

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';
const PORT = process.env.PORT || 4000;

const WATCHLIST = ['AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','AMD','NFLX','DIS','JPM','V','WMT','KO','XOM','PFE','BA','INTC','CSCO','PYPL','ADBE','CRM','ORCL','IBM','QCOM','TXN','AVGO','MU','AMAT','SBUX','NKE','MCD','PG','JNJ','UNH','HD','CVX','ABBV','MRK','PEP','T','VZ','CMCSA','TMUS','COST','LLY','ACN','DHR','NEE','LIN'];
const COMPANY_NAMES = { 'AAPL':'Apple Inc.','MSFT':'Microsoft Corp.','NVDA':'NVIDIA Corp.','TSLA':'Tesla Inc.','AMZN':'Amazon.com','GOOGL':'Alphabet Inc.','META':'Meta Platforms','AMD':'Advanced Micro','NFLX':'Netflix Inc.','DIS':'Walt Disney Co.','JPM':'JPMorgan Chase','V':'Visa Inc.','WMT':'Walmart Inc.','KO':'Coca-Cola Co.','XOM':'Exxon Mobil','PFE':'Pfizer Inc.','BA':'Boeing Co.','INTC':'Intel Corp.','CSCO':'Cisco Systems','PYPL':'PayPal Holdings','ADBE':'Adobe Inc.','CRM':'Salesforce','ORCL':'Oracle Corp.','IBM':'IBM Corp.','QCOM':'Qualcomm','TXN':'Texas Instruments','AVGO':'Broadcom','MU':'Micron Tech','AMAT':'Applied Materials','SBUX':'Starbucks','NKE':'Nike Inc.','MCD':'McDonalds','PG':'Procter & Gamble','JNJ':'Johnson & Johnson','UNH':'UnitedHealth','HD':'Home Depot','CVX':'Chevron','ABBV':'AbbVie','MRK':'Merck & Co.','PEP':'PepsiCo','T':'AT&T','VZ':'Verizon','CMCSA':'Comcast','TMUS':'T-Mobile','COST':'Costco','LLY':'Eli Lilly','ACN':'Accenture','DHR':'Danaher','NEE':'NextEra Energy','LIN':'Linde plc' };

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

// БАЗА ДАННЫХ (Файл db.json)
let db;
(async () => {
  db = await JSONFilePreset('db.json', { users: [] });
})();

const getFundamentals = (s) => cached(`f:${s}`, 86400000, async () => {
  const { data } = await axios.get(`${BASE}/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`);
  const m = data.metric || {};
  return {
    symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM,
    ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM, revenueGrowth: m.revenueGrowthTTMYoy,
    debtEbitda: m.totalDebtToEbitda || m.netDebtToEbitda, roe: m.roeTTM, marketCap: m.marketCapitalization
  };
});

const getQuote = (s) => cached(`q:${s}`, 60000, async () => {
  const { data } = await axios.get(`${BASE}/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return { symbol: s, price: data.c, change: data.d, percent: data.dp, high: data.h, low: data.l, open: data.o };
});

const getCandles = (s, days = 60) => cached(`c:${s}:${days}`, 60000, async () => {
  const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : '1y';
  const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}`, { params: { range, interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const r = data.chart.result[0]; const q = r.indicators.quote[0];
  const closes = q.close.filter(c => c !== null);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const sma50 = SMA.calculate({ values: closes, period: 50 });
  const sma200 = SMA.calculate({ values: closes, period: 200 });

  return {
    candles: r.timestamp.map((t, i) => ({ x: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(c => c.c !== null),
    indicators: {
      rsi: rsi.length ? rsi[rsi.length-1] : null,
      macd: macd.length ? macd[macd.length-1].MACD : null,
      macdSignal: macd.length ? macd[macd.length-1].signal : null,
      macdHistogram: macd.length ? macd[macd.length-1].histogram : null,
      volume: q.volume[q.volume.length-1],
      sma50: sma50.length ? sma50[sma50.length-1] : null,
      sma200: sma200.length ? sma200[sma200.length-1] : null,
      currentPrice: closes[closes.length-1]
    }
  };
});

// DCF КАЛЬКУЛЯТОР (Упрощенный метод Грэма/мультипликаторов)
const getFairValue = (s) => cached(`fv:${s}`, 86400000, async () => {
  const q = await getQuote(s);
  const f = await getFundamentals(s);
  if (!q.price || !f.pe) return { current: q.price, fair: null, status: 'Нет данных' };
  
  // Упрощенная формула: Справедливый P/E = 15 (среднерыночный). FV = Текущая цена * (15 / Текущий P/E)
  const targetPE = 15; 
  const fair = (q.price / f.pe) * targetPE;
  const diff = ((fair - q.price) / q.price) * 100;
  
  return {
    current: q.price,
    fair: fair,
    diff: diff,
    status: diff > 10 ? 'Недооценена' : diff < -10 ? 'Переоценена' : 'Справедливая цена'
  };
});

// ТЕХНИЧЕСКИЙ РАДАР (Подсчет 10 индикаторов)
const getTechRadar = (s) => cached(`tr:${s}`, 60000, async () => {
  const data = await getCandles(s, 365);
  const ind = data.indicators;
  const p = ind.currentPrice;
  let score = 0; // От -10 до +10
  
  if (ind.rsi < 30) score += 2; else if (ind.rsi > 70) score -= 2; // Перепродан/Перекуплен
  if (ind.macd > ind.macdSignal) score += 2; else score -= 2; // Пересечение MACD
  if (p > ind.sma50) score += 2; else score -= 2; // Выше/ниже SMA50
  if (p > ind.sma200) score += 2; else score -= 2; // Выше/ниже SMA200
  if (ind.macdHistogram > 0) score += 2; else score -= 2; // Импульс

  let verdict = 'Нейтрально';
  if (score >= 6) verdict = 'Активно покупать';
  else if (score >= 2) verdict = 'Покупать';
  else if (score <= -6) verdict = 'Активно продавать';
  else if (score <= -2) verdict = 'Продавать';

  return { score, verdict };
});

const parser = new Parser();
const getNews = () => cached('news', 600000, async () => {
  try {
    const feed = await parser.parseURL('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114');
    return feed.items.slice(0, 6).map(item => {
      let image = null;
      if (item.enclosure?.url) image = item.enclosure.url;
      else if (item.content) { const m = item.content.match(/<img[^>]+src="([^">]+)"/); if (m) image = m[1]; }
      return { headline: item.title, source: 'CNBC', url: item.link, datetime: Math.floor(new Date(item.pubDate).getTime() / 1000), image };
    });
  } catch (e) { return []; }
});

// HEATMAP ДАННЫЕ
const getHeatmap = () => cached('heatmap', 60000, async () => {
  const res = [];
  for (const s of WATCHLIST.slice(0, 30)) { // Берем 30 для скорости
    const q = await getQuote(s);
    const f = await getFundamentals(s);
    if (q.price && q.percent !== null) res.push({ symbol: s, percent: q.percent, marketCap: f.marketCap || 100000 });
  }
  return res;
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quote/:symbol', async (req, res) => { res.json(await getQuote(req.params.symbol)); });
app.get('/api/candles/:symbol', async (req, res) => { res.json(await getCandles(req.params.symbol)); });
app.get('/api/fundamentals/:symbol', async (req, res) => { res.json(await getFundamentals(req.params.symbol)); });
app.get('/api/fair-value/:symbol', async (req, res) => { res.json(await getFairValue(req.params.symbol)); });
app.get('/api/tech-radar/:symbol', async (req, res) => { res.json(await getTechRadar(req.params.symbol)); });
app.get('/api/heatmap', async (req, res) => { res.json(await getHeatmap()); });
app.get('/api/news', async (req, res) => { res.json(await getNews()); });
app.get('/api/watchlist', (req, res) => { res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym }))); });

// РЕГИСТРАЦИЯ И ЛИДЕРБОРД
app.post('/api/register', async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Введите имя' });
  if (db.data.users.find(u => u.username === username)) return res.status(400).json({ error: 'Имя занято' });
  
  const newUser = { username, portfolio: { cash: 10000, holdings: {} }, returnPercent: 0, badges: [] };
  db.data.users.push(newUser);
  await db.write();
  res.json(newUser);
});

app.post('/api/update-portfolio', async (req, res) => {
  const { username, portfolio, returnPercent } = req.body;
  const user = db.data.users.find(u => u.username === username);
  if (user) {
    user.portfolio = portfolio;
    user.returnPercent = returnPercent;
    // Выдача бейджей
    if (returnPercent > 50 && !user.badges.includes('🐺 Волк с Уолл-Стрит')) user.badges.push('🐺 Волк с Уолл-Стрит');
    if (returnPercent > 10 && !user.badges.includes('📈 Первая прибыль')) user.badges.push('📈 Первая прибыль');
    await db.write();
  }
  res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
  const sorted = [...db.data.users].sort((a, b) => b.returnPercent - a.returnPercent);
  res.json(sorted.slice(0, 10));
});

// WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });
function broadcast(p) { const msg = JSON.stringify(p); clients.forEach(c => { if (c.readyState === 1) c.send(msg); }); }
function connectFinnhub() {
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => { WATCHLIST.slice(0, 20).forEach(s => ws.send(JSON.stringify({ type: 'subscribe', symbol: s }))); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p })); });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
}
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on ${PORT}`); connectFinnhub(); });