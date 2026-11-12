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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Списки акций
const WATCHLIST = ['AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','AMD','NFLX','DIS','ADBE','CRM','ORCL','IBM','QCOM','TXN','AVGO','MU','AMAT','SBUX','INTC','CSCO','PYPL','SNOW','CRWD','PANW','NOW','WDAY','TEAM','DDOG','JPM','V','MA','BAC','WFC','C','GS','MS','AXP','BLK','SCHW','USB','PNC','COF','BK','JNJ','UNH','PFE','ABBV','MRK','TMO','ABT','DHR','BMY','AMGN','GILD','CVS','MDT','LLY','ZTS','WMT','KO','PEP','COST','MCD','NKE','PG','HD','LOW','TGT','TJX','DG','DLTR','EL','CL','XOM','CVX','COP','SLB','BA','CAT','DE','GE','MMM','HON','UNP','UPS','LMT','RTX','LUV','T','VZ','CMCSA','TMUS','CHTR','SPOT','UBER','LYFT','ABNB','BKNG'];
const COMPANY_NAMES = { 'AAPL':'Apple Inc.','MSFT':'Microsoft Corp.','NVDA':'NVIDIA Corp.','TSLA':'Tesla Inc.','AMZN':'Amazon.com','GOOGL':'Alphabet Inc.','META':'Meta Platforms','AMD':'Advanced Micro','NFLX':'Netflix Inc.','DIS':'Walt Disney Co.','ADBE':'Adobe Inc.','CRM':'Salesforce','ORCL':'Oracle Corp.','IBM':'IBM Corp.','QCOM':'Qualcomm','TXN':'Texas Instruments','AVGO':'Broadcom','MU':'Micron Tech','AMAT':'Applied Materials','SBUX':'Starbucks','INTC':'Intel Corp.','CSCO':'Cisco Systems','PYPL':'PayPal Holdings','SNOW':'Snowflake','CRWD':'CrowdStrike','PANW':'Palo Alto','NOW':'ServiceNow','WDAY':'Workday','TEAM':'Atlassian','DDOG':'Datadog','JPM':'JPMorgan Chase','V':'Visa Inc.','MA':'Mastercard','BAC':'Bank of America','WFC':'Wells Fargo','C':'Citigroup','GS':'Goldman Sachs','MS':'Morgan Stanley','AXP':'American Express','BLK':'BlackRock','SCHW':'Charles Schwab','USB':'U.S. Bancorp','PNC':'PNC Financial','COF':'Capital One','BK':'Bank of NY Mellon','JNJ':'Johnson & Johnson','UNH':'UnitedHealth','PFE':'Pfizer Inc.','ABBV':'AbbVie','MRK':'Merck & Co.','TMO':'Thermo Fisher','ABT':'Abbott Labs','DHR':'Danaher','BMY':'Bristol-Myers','AMGN':'Amgen','GILD':'Gilead Sciences','CVS':'CVS Health','MDT':'Medtronic','LLY':'Eli Lilly','ZTS':'Zoetis','WMT':'Walmart Inc.','KO':'Coca-Cola Co.','PEP':'PepsiCo','COST':'Costco','MCD':'McDonalds','NKE':'Nike Inc.','PG':'Procter & Gamble','HD':'Home Depot','LOW':'Lowes','TGT':'Target','TJX':'TJX Companies','DG':'Dollar General','DLTR':'Dollar Tree','EL':'Estee Lauder','CL':'Colgate-Palmolive','XOM':'Exxon Mobil','CVX':'Chevron','COP':'ConocoPhillips','SLB':'Schlumberger','BA':'Boeing Co.','CAT':'Caterpillar','DE':'Deere & Co.','GE':'General Electric','MMM':'3M','HON':'Honeywell','UNP':'Union Pacific','UPS':'UPS','LMT':'Lockheed Martin','RTX':'Raytheon','LUV':'Southwest Airlines','T':'AT&T','VZ':'Verizon','CMCSA':'Comcast','TMUS':'T-Mobile','CHTR':'Charter Comm.','SPOT':'Spotify','UBER':'Uber Tech','LYFT':'Lyft Inc.','ABNB':'Airbnb','BKNG':'Booking Holdings' };

// Кэш
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

// --- АДАПТЕРЫ РЫНКОВ ---
const getQuote = (s) => cached(`q:${s}`, 60000, async () => {
  const { data } = await axios.get(`${BASE}/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return { symbol: s, price: data.c, change: data.d, percent: data.dp, market: 'US' };
});

async function getMoexQuote(symbol) {
  try {
    const { data } = await axios.get(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${symbol}.json`);
    const marketData = data.marketdata;
    if (!marketData || !marketData.data || marketData.data.length === 0) return null;
    const priceIndex = marketData.columns.indexOf('LAST');
    const price = marketData.data[0][priceIndex];
    return price ? { symbol: symbol, price: price, change: 0, percent: 0, market: 'RU' } : null;
  } catch (e) { return null; }
}

// --- ОСТАЛЬНЫЕ ДАННЫЕ ---
const getFundamentals = (s) => cached(`f:${s}`, 86400000, async () => {
  const { data } = await axios.get(`${BASE}/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`);
  const m = data.metric || {};
  return { symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM, ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM, roe: m.roeTTM, marketCap: m.marketCapitalization };
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

const app = express();
app.use(cors()); app.use(express.json()); app.use(express.static(path.join(__dirname, 'public')));

// --- API ЭНДПОИНТЫ ---
app.get('/api/quote/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const usQuote = await getQuote(sym);
  if (usQuote && usQuote.price) return res.json(usQuote);
  const ruQuote = await getMoexQuote(sym);
  if (ruQuote) return res.json(ruQuote);
  res.status(404).json({ error: 'Не найдено' });
});
app.get('/api/candles/:symbol', async (req, res) => { res.json(await getCandles(req.params.symbol)); });
app.get('/api/fundamentals/:symbol', async (req, res) => { res.json(await getFundamentals(req.params.symbol)); });
app.get('/api/tech-radar/:symbol', async (req, res) => { res.json(await getTechRadar(req.params.symbol)); });
app.get('/api/news', async (req, res) => { res.json(await getNews()); });
app.get('/api/watchlist', (req, res) => { res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym }))); });

// --- АВТОРИЗАЦИЯ (БЕЗ ХЭШИРОВАНИЯ) ---
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Заполните все поля' });
  const { data: existing } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Этот Email уже занят' });
  const { data, error } = await supabase.from('users').insert([{ email, password, username }]).select().single();
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json(data);
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (error || !user || user.password !== password) return res.status(400).json({ error: 'Неверный Email или пароль' });
  res.json(user);
});

app.post('/api/update-portfolio', async (req, res) => {
  const { email, portfolio, returnPercent } = req.body;
  try {
    const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    let badges = user.badges || [];
    if (returnPercent > 50 && !badges.includes('🐺 Волк с Уолл-Стрит')) badges.push('🐺 Волк с Уолл-Стрит');
    if (returnPercent > 10 && !badges.includes('📈 Первая прибыль')) badges.push('📈 Первая прибыль');
    await supabase.from('users').update({ portfolio, return_percent: returnPercent, badges }).eq('email', email);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('*').order('return_percent', { ascending: false }).limit(10);
  res.json(data || []);
});

// --- ЛИМИТНЫЕ ЗАЯВКИ ---
app.get('/api/orders/:email', async (req, res) => {
  const { data } = await supabase.from('orders').select('*').eq('email', req.params.email).order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/orders', async (req, res) => {
  const { email, symbol, type, target_price, shares, market } = req.body;
  const { data, error } = await supabase.from('orders').insert([{ email, symbol, type, target_price, shares, market }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/orders/:id', async (req, res) => {
  await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', req.params.id);
  res.json({ success: true });
});

// ФОНОВАЯ ПРОВЕРКА ОРДЕРОВ (каждую минуту)
setInterval(async () => {
  try {
    const { data: orders } = await supabase.from('orders').select('*').eq('status', 'PENDING');
    if (!orders || orders.length === 0) return;

    for (const order of orders) {
      let currentPrice = null;
      if (order.market === 'RU') {
        const q = await getMoexQuote(order.symbol);
        if (q) currentPrice = q.price;
      } else {
        const q = await getQuote(order.symbol);
        if (q) currentPrice = q.price;
      }
      if (!currentPrice) continue;

      const shouldExecute = 
        (order.type === 'buy' && currentPrice <= order.target_price) ||
        (order.type === 'sell' && currentPrice >= order.target_price);

      if (shouldExecute) {
        const { data: user } = await supabase.from('users').select('*').eq('email', order.email).single();
        if (!user) continue;

        let portfolio = user.portfolio;
        const totalCost = order.shares * currentPrice;

        if (order.type === 'buy') {
          if (portfolio.cash < totalCost) {
            await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id);
            continue;
          }
          portfolio.cash -= totalCost;
          if (!portfolio.holdings[order.symbol]) portfolio.holdings[order.symbol] = { shares: 0, totalCost: 0 };
          portfolio.holdings[order.symbol].shares += order.shares;
          portfolio.holdings[order.symbol].totalCost += totalCost;
        } else {
          if (!portfolio.holdings[order.symbol] || portfolio.holdings[order.symbol].shares < order.shares) {
            await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id);
            continue;
          }
          portfolio.cash += totalCost;
          portfolio.holdings[order.symbol].shares -= order.shares;
          if (portfolio.holdings[order.symbol].shares === 0) delete portfolio.holdings[order.symbol];
        }

        portfolio.history.push({ date: new Date().toISOString(), type: order.type.toUpperCase(), symbol: order.symbol, shares: order.shares, price: currentPrice, total: totalCost });
        await supabase.from('users').update({ portfolio }).eq('email', order.email);
        await supabase.from('orders').update({ status: 'FILLED' }).eq('id', order.id);
      }
    }
  } catch (err) { console.error('Ошибка ордеров:', err.message); }
}, 60000);

// WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });
function broadcast(p) { const msg = JSON.stringify(p); clients.forEach(c => { if (c.readyState === 1) c.send(msg); }); }
function connectFinnhub() {
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => {
    WATCHLIST.slice(0, 50).forEach((s, i) => setTimeout(() => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })), i * 150));
  });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p })); });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
}
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on ${PORT}`); connectFinnhub(); });