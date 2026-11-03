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
  console.error('❌ Нет FINNHUB_KEY');
  process.exit(1);
}

// СПИСОК ИЗ 100 АКЦИЙ (Топовые компании США)
const WATCHLIST = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','AMD','NFLX','DIS',
  'JPM','V','WMT','KO','XOM','PFE','BA','INTC','CSCO','PYPL',
  'ADBE','CRM','ORCL','IBM','QCOM','TXN','AVGO','MU','AMAT','SBUX',
  'NKE','MCD','PG','JNJ','UNH','HD','CVX','ABBV','MRK','PEP',
  'T','VZ','CMCSA','TMUS','COST','LLY','ACN','DHR','NEE','LIN',
  'BMY','AMGN','GILD','CVS','MDT','HON','UNP','UPS','LMT','RTX',
  'CAT','DE','GE','MMM','F','GM','RIVN','LCID','NIO','PLTR',
  'SNOW','CRWD','PANW','NOW','WDAY','TEAM','DDOG','MDB','NET','ZS',
  'SQ','SHOP','MELI','SE','BABA','JD','PDD','BIDU','TCEHY','SONY',
  'TM','HMC','STLA','RACE','SPOT','UBER','LYFT','ABNB','BKNG','MAR'
];

const COMPANY_NAMES = {
  'AAPL':'Apple Inc.','MSFT':'Microsoft Corp.','NVDA':'NVIDIA Corp.','TSLA':'Tesla Inc.','AMZN':'Amazon.com',
  'GOOGL':'Alphabet Inc.','META':'Meta Platforms','AMD':'Advanced Micro','NFLX':'Netflix Inc.','DIS':'Walt Disney Co.',
  'JPM':'JPMorgan Chase','V':'Visa Inc.','WMT':'Walmart Inc.','KO':'Coca-Cola Co.','XOM':'Exxon Mobil',
  'PFE':'Pfizer Inc.','BA':'Boeing Co.','INTC':'Intel Corp.','CSCO':'Cisco Systems','PYPL':'PayPal Holdings',
  'ADBE':'Adobe Inc.','CRM':'Salesforce','ORCL':'Oracle Corp.','IBM':'IBM Corp.','QCOM':'Qualcomm',
  'TXN':'Texas Instruments','AVGO':'Broadcom','MU':'Micron Tech','AMAT':'Applied Materials','SBUX':'Starbucks',
  'NKE':'Nike Inc.','MCD':'McDonalds','PG':'Procter & Gamble','JNJ':'Johnson & Johnson','UNH':'UnitedHealth',
  'HD':'Home Depot','CVX':'Chevron','ABBV':'AbbVie','MRK':'Merck & Co.','PEP':'PepsiCo',
  'T':'AT&T','VZ':'Verizon','CMCSA':'Comcast','TMUS':'T-Mobile','COST':'Costco',
  'LLY':'Eli Lilly','ACN':'Accenture','DHR':'Danaher','NEE':'NextEra Energy','LIN':'Linde plc',
  'BMY':'Bristol-Myers','AMGN':'Amgen','GILD':'Gilead Sciences','CVS':'CVS Health','MDT':'Medtronic',
  'HON':'Honeywell','UNP':'Union Pacific','UPS':'UPS','LMT':'Lockheed Martin','RTX':'Raytheon',
  'CAT':'Caterpillar','DE':'Deere & Co.','GE':'General Electric','MMM':'3M','F':'Ford Motor',
  'GM':'General Motors','RIVN':'Rivian','LCID':'Lucid Group','NIO':'NIO Inc.','PLTR':'Palantir',
  'SNOW':'Snowflake','CRWD':'CrowdStrike','PANW':'Palo Alto','NOW':'ServiceNow','WDAY':'Workday',
  'TEAM':'Atlassian','DDOG':'Datadog','MDB':'MongoDB','NET':'Cloudflare','ZS':'Zscaler',
  'SQ':'Block Inc.','SHOP':'Shopify','MELI':'MercadoLibre','SE':'Sea Limited','BABA':'Alibaba',
  'JD':'JD.com','PDD':'PDD Holdings','BIDU':'Baidu','TCEHY':'Tencent','SONY':'Sony Group',
  'TM':'Toyota Motor','HMC':'Honda Motor','STLA':'Stellantis','RACE':'Ferrari','SPOT':'Spotify',
  'UBER':'Uber Tech','LYFT':'Lyft Inc.','ABNB':'Airbnb','BKNG':'Booking Holdings','MAR':'Marriott Int.'
};

// УМНОЕ КЕШИРОВАНИЕ (Разный TTL для разных данных)
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

// Фундаментал кешируем на 12 часов (отчеты меняются раз в квартал)
const getFundamentals = (s) => cached(`f:${s}`, 12 * 60 * 60 * 1000, async () => {
  const { data } = await axios.get(`${BASE}/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`);
  const m = data.metric || {};
  return {
    symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, 
    evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM,
    ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM,
    revenueGrowth: m.revenueGrowthTTMYoy,
    debtEbitda: m.totalDebtToEbitda || m.netDebtToEbitda,
    roe: m.roeTTM, marketCap: m.marketCapitalization
  };
});

// Котировки кешируем на 1 минуту
const getQuote = (s) => cached(`q:${s}`, 60000, async () => {
  const { data } = await axios.get(`${BASE}/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return { symbol: s, price: data.c, change: data.d, percent: data.dp, high: data.h, low: data.l, open: data.o };
});

// График и индикаторы
const getCandles = (s, days = 60) => cached(`c:${s}:${days}`, 60000, async () => {
  const range = days <= 30 ? '1mo' : days <= 90 ? '3mo' : '1y';
  const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}`, { 
    params: { range, interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } 
  });
  const r = data.chart.result[0];
  const q = r.indicators.quote[0];
  const closes = q.close.filter(c => c !== null);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

  return {
    candles: r.timestamp.map((t, i) => ({ x: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(c => c.c !== null),
    indicators: {
      rsi: rsi.length ? rsi[rsi.length-1] : null,
      macd: macd.length ? macd[macd.length-1].MACD : null,
      macdSignal: macd.length ? macd[macd.length-1].signal : null,
      macdHistogram: macd.length ? macd[macd.length-1].histogram : null,
      volume: q.volume[q.volume.length-1]
    }
  };
});

// Историческая динамика P/E (симуляция на основе цены)
const getHistoricalPE = (s) => cached(`hpe:${s}`, 12 * 60 * 60 * 1000, async () => {
  const fund = await getFundamentals(s);
  const candles = await getCandles(s, 365); // 1 год
  if (!fund.pe) return [];
  const currentPrice = candles.candles[candles.candles.length - 1].c;
  
  return candles.candles.map(c => ({
    x: c.x,
    y: (c.c / currentPrice) * fund.pe // Пропорционально изменению цены
  }));
});

// Новости
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

// Лидеры роста и падения
const getGainersLosers = () => cached('gainers', 60000, async () => {
  const quotes = await Promise.all(WATCHLIST.slice(0, 50).map(getQuote)); // Берем 50 для скорости
  const valid = quotes.filter(q => q.price && q.percent !== null);
  valid.sort((a, b) => b.percent - a.percent);
  return {
    gainers: valid.slice(0, 3),
    losers: valid.slice(-3).reverse()
  };
});

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quote/:symbol', async (req, res) => { try { res.json(await getQuote(req.params.symbol)); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/candles/:symbol', async (req, res) => { try { res.json(await getCandles(req.params.symbol)); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/fundamentals/:symbol', async (req, res) => { try { res.json(await getFundamentals(req.params.symbol)); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/historical-pe/:symbol', async (req, res) => { try { res.json(await getHistoricalPE(req.params.symbol)); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/news', async (req, res) => { try { res.json(await getNews()); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/gainers-losers', async (req, res) => { try { res.json(await getGainersLosers()); } catch (e) { res.status(500).json({error:e.message}); }});
app.get('/api/watchlist', (req, res) => { res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym }))); });

// WebSocket для реального времени
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