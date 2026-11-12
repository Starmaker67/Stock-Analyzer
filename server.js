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
const EULERPOOL_KEY = process.env.EULERPOOL_KEY;
const FCS_API_KEY = process.env.FCS_API_KEY;
const PORT = process.env.PORT || 4000;

if (!FINNHUB_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Отсутствуют критически важные переменные окружения!');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MARKETS = {
  US: ['AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','AMD','NFLX','DIS','ADBE','CRM','ORCL','IBM','QCOM','TXN','AVGO','MU','AMAT','SBUX','INTC','CSCO','PYPL','JPM','V','MA','BAC','WFC','JNJ','UNH','PFE','ABBV','MRK','WMT','KO','PEP','COST','MCD','NKE','PG','XOM','CVX','BA','CAT','GE','T','VZ','UBER','ABNB','COIN'],
  EU: ['SAP.DE', 'ASML.AS', 'SHEL.L', 'NESN.SW', 'LVMH.PA', 'MC.PA', 'OR.PA', 'DTE.DE', 'BMW.DE', 'AIR.PA', 'SIE.DE', 'ALV.DE', 'SAN.MC', 'ENEL.MI', 'TTE.PA', 'SU.PA', 'AI.PA', 'BNP.PA', 'CS.PA', 'DG.PA', 'EL.PA', 'RI.PA', 'KER.PA', 'UG.PA', 'VIE.PA', 'ENGI.PA', 'BAS.DE', 'BAYN.DE', 'CON.DE', 'DBK.DE', 'FRE.DE', 'IFX.DE', 'LIN.DE', 'MRK.DE', 'RWE.DE', 'VOW3.DE', 'ADS.DE', 'HEN3.DE', 'FME.DE', 'SY1.DE', 'ABI.BR', 'KBC.BR', 'UCB.BR', 'INGA.AS', 'HEIA.AS', 'PHIA.AS', 'AD.AS', 'RAND.AS', 'WKL.AS', 'DSFIR.AS'],
  RU: ['SBER', 'GAZP', 'LKOH', 'YDEX', 'TATN', 'GMKN', 'ROSN', 'NVTK', 'PLZL', 'VTBR', 'SNGS', 'MOEX', 'ALRS', 'CHMF', 'MAGN', 'MTLR', 'NLMK', 'POLY', 'RUAL', 'AFLT', 'FESH', 'FLOT', 'FEES', 'HYDR', 'IRAO', 'AFKS', 'RTKM', 'MGTS', 'MTSS', 'BSPB', 'CBOM', 'SFIN', 'SMLT', 'LSRG', 'PIKK', 'ZAYM', 'LENT', 'AGRO', 'RAGR', 'DZRL', 'KZOS', 'PHOR', 'AKRN', 'UNAC', 'NMTP', 'VSMZ', 'SGZH', 'ELTZ', 'KMAZ', 'APTK'],
  CRYPTO: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BNBUSDT', 'BINANCE:XRPUSDT', 'BINANCE:ADAUSDT', 'BINANCE:DOGEUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:DOTUSDT', 'BINANCE:LINKUSDT'],
  FOREX: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY']
};

const COMPANY_NAMES = {
  'AAPL':'Apple Inc.','MSFT':'Microsoft','NVDA':'NVIDIA','TSLA':'Tesla','AMZN':'Amazon','GOOGL':'Alphabet','META':'Meta','AMD':'AMD','NFLX':'Netflix','DIS':'Disney','ADBE':'Adobe','CRM':'Salesforce','ORCL':'Oracle','IBM':'IBM','QCOM':'Qualcomm','TXN':'Texas Instruments','AVGO':'Broadcom','MU':'Micron','AMAT':'Applied Materials','SBUX':'Starbucks','INTC':'Intel','CSCO':'Cisco','PYPL':'PayPal','JPM':'JPMorgan','V':'Visa','MA':'Mastercard','BAC':'Bank of America','WFC':'Wells Fargo','JNJ':'J&J','UNH':'UnitedHealth','PFE':'Pfizer','ABBV':'AbbVie','MRK':'Merck','WMT':'Walmart','KO':'Coca-Cola','PEP':'PepsiCo','COST':'Costco','MCD':'McDonalds','NKE':'Nike','PG':'P&G','XOM':'Exxon Mobil','CVX':'Chevron','BA':'Boeing','CAT':'Caterpillar','GE':'GE','T':'AT&T','VZ':'Verizon','UBER':'Uber','ABNB':'Airbnb','COIN':'Coinbase',
  'SAP.DE':'SAP SE', 'ASML.AS':'ASML', 'SHEL.L':'Shell', 'NESN.SW':'Nestle', 'LVMH.PA':'LVMH', 'MC.PA':'LVMH (MC)', 'OR.PA':"L'Oreal", 'DTE.DE':'Deutsche Telekom', 'BMW.DE':'BMW', 'AIR.PA':'Airbus', 'SIE.DE':'Siemens', 'ALV.DE':'Allianz', 'SAN.MC':'Santander', 'ENEL.MI':'Enel', 'TTE.PA':'TotalEnergies', 'SU.PA':'Schneider Electric', 'AI.PA':'Air Liquide', 'BNP.PA':'BNP Paribas', 'CS.PA':'AXA', 'DG.PA':'Vinci', 'EL.PA':'EssilorLuxottica', 'RI.PA':'Pernod Ricard', 'KER.PA':'Kering', 'UG.PA':'Peugeot', 'VIE.PA':'Veolia', 'ENGI.PA':'Engie', 'BAS.DE':'BASF', 'BAYN.DE':'Bayer', 'CON.DE':'Continental', 'DBK.DE':'Deutsche Bank', 'FRE.DE':'Fresenius', 'IFX.DE':'Infineon', 'LIN.DE':'Linde', 'MRK.DE':'Merck KGaA', 'RWE.DE':'RWE', 'VOW3.DE':'Volkswagen', 'ADS.DE':'Adidas', 'HEN3.DE':'Henkel', 'FME.DE':'Fresenius Medical', 'SY1.DE':'Symrise', 'ABI.BR':'AB InBev', 'KBC.BR':'KBC Group', 'UCB.BR':'UCB', 'INGA.AS':'ING Groep', 'HEIA.AS':'Heineken', 'PHIA.AS':'Philips', 'AD.AS':'Ahold Delhaize', 'RAND.AS':'Randstad', 'WKL.AS':'Wolters Kluwer', 'DSFIR.AS':'DSM Firmenich',
  'SBER':'Сбербанк', 'GAZP':'Газпром', 'LKOH':'Лукойл', 'YDEX':'Яндекс', 'TATN':'Татнефть', 'GMKN':'Норникель', 'ROSN':'Роснефть', 'NVTK':'Новатэк', 'PLZL':'Полюс', 'VTBR':'ВТБ', 'SNGS':'Сургутнефтегаз', 'MOEX':'Мосбиржа', 'ALRS':'Алроса', 'CHMF':'Северсталь', 'MAGN':'ММК', 'MTLR':'Мечел', 'NLMK':'НЛМК', 'POLY':'Полиметалл', 'RUAL':'Русал', 'AFLT':'Аэрофлот', 'FESH':'ДВМП', 'FLOT':'Совкомфлот', 'FEES':'Россети', 'HYDR':'РусГидро', 'IRAO':'Интер РАО', 'AFKS':'АФК Система', 'RTKM':'Ростелеком', 'MGTS':'МГТС', 'MTSS':'МТС', 'BSPB':'Банк СПб', 'CBOM':'МКБ', 'SFIN':'ЭсЭфАй', 'SMLT':'Самолет', 'LSRG':'ЛСР', 'PIKK':'ПИК', 'ZAYM':'Займер', 'LENT':'Лента', 'AGRO':'Русагро', 'RAGR':'РусАгро', 'DZRL':'Дзержинскхиммаш', 'KZOS':'Казаньоргсинтез', 'PHOR':'ФосАгро', 'AKRN':'Акрон', 'UNAC':'ОАК', 'NMTP':'НМТП', 'VSMZ':'Выксунский метзавод', 'SGZH':'Сегежа', 'ELTZ':'ЭлТел', 'KMAZ':'КАМАЗ', 'APTK':'Аптечная сеть 36,6',
  'BINANCE:BTCUSDT': 'Bitcoin', 'BINANCE:ETHUSDT': 'Ethereum', 'BINANCE:SOLUSDT': 'Solana', 'BINANCE:BNBUSDT': 'BNB', 'BINANCE:XRPUSDT': 'Ripple', 'BINANCE:ADAUSDT': 'Cardano', 'BINANCE:DOGEUSDT': 'Dogecoin', 'BINANCE:AVAXUSDT': 'Avalanche', 'BINANCE:DOTUSDT': 'Polkadot', 'BINANCE:LINKUSDT': 'Chainlink',
  'EURUSD': 'EUR/USD', 'GBPUSD': 'GBP/USD', 'USDJPY': 'USD/JPY', 'AUDUSD': 'AUD/USD', 'USDCAD': 'USD/CAD', 'USDCHF': 'USD/CHF', 'NZDUSD': 'NZD/USD', 'EURGBP': 'EUR/GBP', 'EURJPY': 'EUR/JPY', 'GBPJPY': 'GBP/JPY'
};

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  try {
    const d = await fn();
    if (d) cache.set(key, { d, t: Date.now() });
    return d;
  } catch (e) { return null; }
}

const getQuote = (s, market) => cached(`q:${s}`, 60000, async () => {
  if (market === 'RU') {
    const { data } = await axios.get(`https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${s}.json`);
    const md = data.marketdata;
    if (!md || !md.data || md.data.length === 0) return null;
    const price = md.data[0][md.columns.indexOf('LAST')];
    return price ? { symbol: s, price, change: 0, percent: 0, currency: 'RUB', market } : null;
  }
  if (market === 'EU') {
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const meta = data.chart.result[0].meta;
    return { symbol: s, price: meta.regularMarketPrice, change: meta.regularMarketPrice - meta.chartPreviousClose, percent: ((meta.regularMarketPrice - meta.chartPreviousClose)/meta.chartPreviousClose)*100, currency: meta.currency, market };
  }
  if (market === 'CRYPTO' || market === 'FOREX') {
    const fcsSymbol = market === 'CRYPTO' ? s.replace('BINANCE:', '') : s;
    const { data } = await axios.get(`https://fcsapi.com/api-v3/forex/latest?symbol=${fcsSymbol}&access_key=${FCS_API_KEY}`);
    if (!data.response || !data.response[0]) return null;
    const price = parseFloat(data.response[0].c);
    const open = parseFloat(data.response[0].o);
    return { symbol: s, price, change: price - open, percent: ((price - open) / open) * 100, currency: 'USD', market };
  }
  const { data } = await axios.get(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${FINNHUB_KEY}`);
  return { symbol: s, price: data.c, change: data.d, percent: data.dp, currency: 'USD', market };
});

const getFundamentals = (s, market) => cached(`f:${s}`, 86400000, async () => {
  if (market === 'EU') {
    try {
      const { data } = await axios.get(`https://api.eulerpool.com/api/v1/fundamentals/${s}?api_key=${EULERPOOL_KEY}`);
      return { symbol: s, pe: data.peRatio, ps: data.psRatio, evEbitda: data.evEbitda, ebitdaMargin: data.ebitdaMargin, revenueGrowth: data.revenueGrowth, debtEbitda: data.debtEbitda, roe: data.roe };
    } catch(e) { return { symbol: s }; }
  }
  if (market === 'US') {
    const { data } = await axios.get(`https://finnhub.io/api/v1/stock/metric?symbol=${s}&metric=all&token=${FINNHUB_KEY}`);
    const m = data.metric || {};
    return { symbol: s, pe: m.peBasicExclExtraTTM, ps: m.psTTM, evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM, ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM, revenueGrowth: m.revenueGrowthTTMYoy, debtEbitda: m.totalDebtToEbitda || m.netDebtToEbitda, roe: m.roeTTM };
  }
  return { symbol: s, pe: null, ps: null, evEbitda: null, ebitdaMargin: null, revenueGrowth: null, debtEbitda: null, roe: null };
});

const getCandles = (s, market, days = 60) => cached(`c:${s}:${days}`, 60000, async () => {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - days);
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);
  let rawCandles = [];

  if (market === 'RU') {
    const url = `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${s}/candles.json?from=${fromStr}&till=${toStr}&interval=24`;
    const { data } = await axios.get(url);
    const candlesData = data.candles;
    if (candlesData && candlesData.data && candlesData.data.length > 0) {
      const cols = candlesData.columns;
      rawCandles = candlesData.data.map(row => ({
        x: new Date(row[cols.indexOf('begin')]).getTime(),
        o: row[cols.indexOf('open')], h: row[cols.indexOf('high')], l: row[cols.indexOf('low')], c: row[cols.indexOf('close')]
      })).filter(c => c.o && c.h && c.l && c.c);
    }
  } else {
    let yahooSym = s;
    if (market === 'CRYPTO') yahooSym = s.replace('BINANCE:', '').replace('USDT', '-USD');
    if (market === 'FOREX') yahooSym = `${s}=X`;
    const { data } = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}`, { params: { range: '1y', interval: '1d' }, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const r = data.chart.result[0];
    if (r) {
      const q = r.indicators.quote[0];
      rawCandles = r.timestamp.map((t, i) => ({ x: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(c => c.c !== null);
    }
  }
  if (rawCandles.length === 0) return { candles: [], indicators: {} };

  const closes = rawCandles.map(c => c.c);
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const sma50 = SMA.calculate({ values: closes, period: 50 });
  const sma200 = SMA.calculate({ values: closes, period: 200 });

  return {
    candles: rawCandles,
    indicators: {
      rsi: rsi.length ? rsi[rsi.length-1] : null, macd: macd.length ? macd[macd.length-1].MACD : null,
      macdSignal: macd.length ? macd[macd.length-1].signal : null, macdHistogram: macd.length ? macd[macd.length-1].histogram : null,
      volume: null, sma50: sma50.length ? sma50[sma50.length-1] : null,
      sma200: sma200.length ? sma200[sma200.length-1] : null, currentPrice: closes[closes.length-1]
    }
  };
});

const getTechRadar = (s, market) => cached(`tr:${s}`, 60000, async () => {
  const data = await getCandles(s, market, 365);
  if (!data || !data.indicators || !data.indicators.currentPrice) return { score: 0, verdict: 'Нет данных' };
  const ind = data.indicators;
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
      return { headline: item.title, url: item.link, image };
    });
  } catch (e) { return []; }
});

const app = express();
app.use(cors()); app.use(express.json()); app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/quote/:market/:symbol', async (req, res) => { const q = await getQuote(req.params.symbol.toUpperCase(), req.params.market); q ? res.json(q) : res.status(404).json({error: 'Not found'}); });
app.get('/api/candles/:market/:symbol', async (req, res) => { res.json(await getCandles(req.params.symbol.toUpperCase(), req.params.market)); });
app.get('/api/fundamentals/:market/:symbol', async (req, res) => { res.json(await getFundamentals(req.params.symbol.toUpperCase(), req.params.market)); });
app.get('/api/tech-radar/:market/:symbol', async (req, res) => { res.json(await getTechRadar(req.params.symbol.toUpperCase(), req.params.market)); });
app.get('/api/news', async (req, res) => { res.json(await getNews()); });
app.get('/api/watchlist', (req, res) => { 
  res.json({
    US: MARKETS.US.map(s => ({ symbol: s, name: COMPANY_NAMES[s] || s })), EU: MARKETS.EU.map(s => ({ symbol: s, name: COMPANY_NAMES[s] || s })),
    RU: MARKETS.RU.map(s => ({ symbol: s, name: COMPANY_NAMES[s] || s })), CRYPTO: MARKETS.CRYPTO.map(s => ({ symbol: s, name: COMPANY_NAMES[s] || s })),
    FOREX: MARKETS.FOREX.map(s => ({ symbol: s, name: COMPANY_NAMES[s] || s }))
  }); 
});
app.get('/api/heatmap/:market', async (req, res) => {
  const market = req.params.market;
  const symbols = MARKETS[market] ? MARKETS[market].slice(0, 20) : [];
  const results = await Promise.all(symbols.map(async (s) => {
    const q = await getQuote(s, market);
    if (q && q.percent !== undefined && q.percent !== null) return { symbol: s, percent: q.percent, price: q.price };
    return null;
  }));
  res.json(results.filter(r => r !== null));
});

// Supabase Auth, Portfolio, Orders (без изменений)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, username } = req.body;
  if (!email || !password || !username) return res.status(400).json({ error: 'Заполните поля' });
  const { data: existing } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Email занят' });
  const { data, error } = await supabase.from('users').insert([{ email, password, username }]).select().single();
  if (error) return res.status(500).json({ error: 'Ошибка БД' });
  res.json(data);
});
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (!user || user.password !== password) return res.status(400).json({ error: 'Неверные данные' });
  res.json(user);
});
app.post('/api/update-portfolio', async (req, res) => {
  const { email, portfolio, returnPercent } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
  if (user) {
    let badges = user.badges || [];
    if (returnPercent > 50 && !badges.includes('🐺 Волк с Уолл-Стрит')) badges.push('🐺 Волк с Уолл-Стрит');
    if (returnPercent > 10 && !badges.includes('📈 Первая прибыль')) badges.push('📈 Первая прибыль');
    await supabase.from('users').update({ portfolio, return_percent: returnPercent, badges }).eq('email', email);
  }
  res.json({ success: true });
});
app.get('/api/leaderboard', async (req, res) => {
  const { data } = await supabase.from('users').select('*').order('return_percent', { ascending: false }).limit(10);
  res.json(data || []);
});
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
setInterval(async () => {
  try {
    const { data: orders } = await supabase.from('orders').select('*').eq('status', 'PENDING');
    if (!orders || orders.length === 0) return;
    for (const order of orders) {
      const q = await getQuote(order.symbol, order.market);
      if (!q || !q.price) continue;
      const shouldExec = (order.type === 'buy' && q.price <= order.target_price) || (order.type === 'sell' && q.price >= order.target_price);
      if (shouldExec) {
        const { data: user } = await supabase.from('users').select('*').eq('email', order.email).single();
        if (!user) continue;
        let p = user.portfolio;
        const cost = order.shares * q.price;
        if (order.type === 'buy') {
          if (p.cash < cost) { await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id); continue; }
          p.cash -= cost;
          if (!p.holdings[order.symbol]) p.holdings[order.symbol] = { shares: 0, totalCost: 0 };
          p.holdings[order.symbol].shares += order.shares; p.holdings[order.symbol].totalCost += cost;
        } else {
          if (!p.holdings[order.symbol] || p.holdings[order.symbol].shares < order.shares) { await supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id); continue; }
          p.cash += cost; p.holdings[order.symbol].shares -= order.shares;
          if (p.holdings[order.symbol].shares === 0) delete p.holdings[order.symbol];
        }
        p.history.push({ date: new Date().toISOString(), type: order.type.toUpperCase(), symbol: order.symbol, shares: order.shares, price: q.price, total: cost });
        await supabase.from('users').update({ portfolio: p }).eq('email', order.email);
        await supabase.from('orders').update({ status: 'FILLED' }).eq('id', order.id);
      }
    }
  } catch (err) {}
}, 60000);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
wss.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });
function broadcast(p) { const msg = JSON.stringify(p); clients.forEach(c => { if (c.readyState === 1) c.send(msg); }); }
function connectFinnhub() {
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  ws.on('open', () => { MARKETS.US.slice(0, 50).forEach((s, i) => setTimeout(() => ws.send(JSON.stringify({ type: 'subscribe', symbol: s })), i * 150)); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p })); });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
}
server.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Server on ${PORT}`); connectFinnhub(); });