require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const Parser = require('rss-parser');
const { RSI, MACD, SMA } = require('technicalindicators');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BASE = 'https://finnhub.io/api/v1';
const PORT = process.env.PORT || 4000;

if (!FINNHUB_KEY || !SUPABASE_URL || !SUPABASE_KEY) { 
  console.error('❌ Нет переменных окружения (FINNHUB_KEY, SUPABASE_URL, SUPABASE_KEY)'); 
  process.exit(1); 
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WATCHLIST = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','AMD','NFLX','DIS',
  'ADBE','CRM','ORCL','IBM','QCOM','TXN','AVGO','MU','AMAT','SBUX',
  'INTC','CSCO','PYPL','SNOW','CRWD','PANW','NOW','WDAY','TEAM','DDOG',
  'JPM','V','MA','BAC','WFC','C','GS','MS','AXP','BLK','SCHW','USB','PNC','COF','BK',
  'JNJ','UNH','PFE','ABBV','MRK','TMO','ABT','DHR','BMY','AMGN','GILD','CVS','MDT','LLY','ZTS',
  'WMT','KO','PEP','COST','MCD','NKE','PG','HD','LOW','TGT','TJX','DG','DLTR','EL','CL',
  'XOM','CVX','COP','SLB','BA','CAT','DE','GE','MMM','HON','UNP','UPS','LMT','RTX','LUV',
  'T','VZ','CMCSA','TMUS','CHTR','SPOT','UBER','LYFT','ABNB','BKNG'
];

const COMPANY_NAMES = {
  'AAPL':'Apple Inc.','MSFT':'Microsoft Corp.','NVDA':'NVIDIA Corp.','TSLA':'Tesla Inc.','AMZN':'Amazon.com',
  'GOOGL':'Alphabet Inc.','META':'Meta Platforms','AMD':'Advanced Micro','NFLX':'Netflix Inc.','DIS':'Walt Disney Co.',
  'ADBE':'Adobe Inc.','CRM':'Salesforce','ORCL':'Oracle Corp.','IBM':'IBM Corp.','QCOM':'Qualcomm',
  'TXN':'Texas Instruments','AVGO':'Broadcom','MU':'Micron Tech','AMAT':'Applied Materials','SBUX':'Starbucks',
  'INTC':'Intel Corp.','CSCO':'Cisco Systems','PYPL':'PayPal Holdings','SNOW':'Snowflake','CRWD':'CrowdStrike',
  'PANW':'Palo Alto','NOW':'ServiceNow','WDAY':'Workday','TEAM':'Atlassian','DDOG':'Datadog',
  'JPM':'JPMorgan Chase','V':'Visa Inc.','MA':'Mastercard','BAC':'Bank of America','WFC':'Wells Fargo',
  'C':'Citigroup','GS':'Goldman Sachs','MS':'Morgan Stanley','AXP':'American Express','BLK':'BlackRock',
  'SCHW':'Charles Schwab','USB':'U.S. Bancorp','PNC':'PNC Financial','COF':'Capital One','BK':'Bank of NY Mellon',
  'JNJ':'Johnson & Johnson','UNH':'UnitedHealth','PFE':'Pfizer Inc.','ABBV':'AbbVie','MRK':'Merck & Co.',
  'TMO':'Thermo Fisher','ABT':'Abbott Labs','DHR':'Danaher','BMY':'Bristol-Myers','AMGN':'Amgen',
  'GILD':'Gilead Sciences','CVS':'CVS Health','MDT':'Medtronic','LLY':'Eli Lilly','ZTS':'Zoetis',
  'WMT':'Walmart Inc.','KO':'Coca-Cola Co.','PEP':'PepsiCo','COST':'Costco','MCD':'McDonalds',
  'NKE':'Nike Inc.','PG':'Procter & Gamble','HD':'Home Depot','LOW':'Lowes','TGT':'Target',
  'TJX':'TJX Companies','DG':'Dollar General','DLTR':'Dollar Tree','EL':'Estee Lauder','CL':'Colgate-Palmolive',
  'XOM':'Exxon Mobil','CVX':'Chevron','COP':'ConocoPhillips','SLB':'Schlumberger','BA':'Boeing Co.',
  'CAT':'Caterpillar','DE':'Deere & Co.','GE':'General Electric','MMM':'3M','HON':'Honeywell',
  'UNP':'Union Pacific','UPS':'UPS','LMT':'Lockheed Martin','RTX':'Raytheon','LUV':'Southwest Airlines',
  'T':'AT&T','VZ':'Verizon','CMCSA':'Comcast','TMUS':'T-Mobile','CHTR':'Charter Comm.',
  'SPOT':'Spotify','UBER':'Uber Tech','LYFT':'Lyft Inc.','ABNB':'Airbnb','BKNG':'Booking Holdings'
};

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

const getFundamentals = (s) => cached(`f:${s}`, 86400000, async () => {
  const { data } = await axios.get(`${BASE}/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`);
  const m = data.metric || {};
  return { symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM, ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM, roe: m.roeTTM, marketCap: m.marketCapitalization };
});

const getQuote = (s) => cached(`q:${s}`, 60000, async () => {
  const { data } = await axios.get(`${BASE}/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return { symbol: s, price: data.c, change: data.d, percent: data.dp, high: data.h, low: data.l, open: data.o };
});

const getCandles = (s, days = 60) => cached(`c:${s}:${days}`, 60000, async () => {
  const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : '1y';
  const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}`, { params: { range, interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } });
  const r = data.chart.result[0]; 
  if (!r) return { candles: [], indicators: {} };
  const q = r.indicators.quote[0];
  const closes = q.close.filter(c => c !== null);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const sma50 = SMA.calculate({ values: closes, period: 50 });
  const sma200 = SMA.calculate({ values: closes, period: 200 });

  return {
    candles: r.timestamp.map((t, i) => ({ x: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(c => c.c !== null),
    indicators: {
      rsi: rsi.length ? rsi[rsi.length-1] : null, macd: macd.length ? macd[macd.length-1].MACD : null,
      macdSignal: macd.length ? macd[macd.length-1].signal : null, macdHistogram: macd.length ? macd[macd.length-1].histogram : null,
      volume: q.volume[q.volume.length-1], sma50: sma50.length ? sma50[sma50.length-1] : null,
      sma200: sma200.length ? sma200[sma200.length-1] : null, currentPrice: closes[closes.length-1]
    }
  };
});

const getFairValue = (s) => cached(`fv:${s}`, 86400000, async () => {
  const q = await getQuote(s); const f = await getFundamentals(s);
  if (!q.price || !f.pe || f.pe <= 0) return { current: q.price, fair: null };
  const fair = (q.price / f.pe) * 15; 
  const diff = ((fair - q.price) / q.price) * 100;
  return { current: q.price, fair, diff, status: diff > 10 ? 'Недооценена' : diff < -10 ? 'Переоценена' : 'Справедливая' };
});

const getHistoricalPE = (s) => cached(`hpe:${s}`, 86400000, async () => {
  const f = await getFundamentals(s); const c = await getCandles(s, 365);
  if (!f.pe || !c.candles.length) return [];
  const currentPrice = c.candles[c.candles.length - 1].c;
  return c.candles.map(candle => ({ x: candle.x, y: (candle.c / currentPrice) * f.pe }));
});

const getTechRadar = (s) => cached(`tr:${s}`, 60000, async () => {
  const data = await getCandles(s, 365);
  const ind = data.indicators;
  if (!ind.currentPrice) return { score: 0, verdict: 'Нет данных' };
  let score = 0;
  if (ind.rsi < 30) score += 2; else if (ind.rsi > 70) score -= 2;
  if (ind.macd > ind.macdSignal) score += 2; else score -= 2;
  if (ind.currentPrice > ind.sma50) score += 2; else score -= 2;
  if (ind.currentPrice > ind.sma200) score += 2; else score -= 2;
  if (ind.macdHistogram > 0) score += 2; else score -= 2;

  let verdict = 'Нейтрально';
  if (score >= 6) verdict = 'Активно покупать'; else if (score >= 2) verdict = 'Покупать';
  else if (score <= -6) verdict = 'Активно продавать'; else if (score <= -2) verdict = 'Продавать';
  return { score, verdict };
});

const parser = new Parser();
const getNews = () => cached('news', 600000, async () => {
  try {
    const feed = await parser.parseURL('https://www.cnbc.com/id/100003114/device/rss/rss.html');
    return feed.items.slice(0, 6).map(item => {
      let image = null; if (item.enclosure?.url) image = item.enclosure.url; else if (item.content) { const m = item.content.match(/<img[^>]+src="([^">]+)"/); if (m) image = m[1]; }
      return { headline: item.title, source: 'CNBC', url: item.link, datetime: Math.floor(new Date(item.pubDate).getTime() / 1000), image };
    });
  } catch (e) { return []; }
});

const getHeatmap = () => cached('heatmap', 60000, async () => {
  const promises = WATCHLIST.slice(0, 30).map(async (s) => {
    try { const q = await getQuote(s); const f = await getFundamentals(s); if (q.price && q.percent !== null) return { symbol: s, percent: q.percent, marketCap: f.marketCap || 100000 }; } catch(e) { return null; }
  });
  return (await Promise.all(promises)).filter(r => r !== null);
});

const app = express();
app.use(cors()); app.use(express.json()); app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quote/:symbol', async (req, res) => { res.json(await getQuote(req.params.symbol)); });
app.get('/api/candles/:symbol', async (req, res) => { res.json(await getCandles(req.params.symbol)); });
app.get('/api/fundamentals/:symbol', async (req, res) => { res.json(await getFundamentals(req.params.symbol)); });
app.get('/api/fair-value/:symbol', async (req, res) => { res.json(await getFairValue(req.params.symbol)); });
app.get('/api/historical-pe/:symbol', async (req, res) => { res.json(await getHistoricalPE(req.params.symbol)); });
app.get('/api/tech-radar/:symbol', async (req, res) => { res.json(await getTechRadar(req.params.symbol)); });
app.get('/api/heatmap', async (req, res) => { res.json(await getHeatmap()); });
app.get('/api/news', async (req, res) => { res.json(await getNews()); });
app.get('/api/watchlist', (req, res) => { res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym }))); });

// АВТОРИЗАЦИЯ И БД (SUPABASE)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Заполните все поля' });

  const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
  if (existing) return res.status(400).json({ error: 'Этот Email уже занят' });

  const { data, error } = await supabase.from('users').insert([{ email, password, username }]).select().single();
  if (error) return res.status(500).json({ error: 'Ошибка регистрации' });
  res.json(data);
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.from('users').select('*').eq('email', email).eq('password', password).single();
  if (error || !data) return res.status(400).json({ error: 'Неверный Email или пароль' });
  res.json(data);
});

app.post('/api/update-portfolio', async (req, res) => {
  const { email, portfolio, returnPercent } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  
  if (user) {
    let badges = user.badges || [];
    if (returnPercent > 50 && !badges.includes('🐺 Волк с Уолл-Стрит')) badges.push('🐺 Волк с Уолл-Стрит');
    if (returnPercent > 10 && !badges.includes('📈 Первая прибыль')) badges.push('📈 Первая прибыль');

    await supabase.from('users').update({ 
      portfolio: portfolio, 
      return_percent: returnPercent,
      badges: badges
    }).eq('email', email);
  }
  res.json({ success: true });
});

app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('*').order('return_percent', { ascending: false }).limit(10);
  res.json(data || []);
});

// WEBSOCKET
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });
function broadcast(p) { const msg = JSON.stringify(p); clients.forEach(c => { if (c.readyState === 1) c.send(msg); }); }
function connectFinnhub() {
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    const symbolsToSubscribe = WATCHLIST.slice(0, 50);
    symbolsToSubscribe.forEach((s, index) => {
      setTimeout(() => { ws.send(JSON.stringify({ type: 'subscribe', symbol: s })); }, index * 50);
    });
  });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p })); });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
  ws.on('error', (e) => console.error('Finnhub WS Error:', e.message));
}
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on ${PORT}`); connectFinnhub(); });