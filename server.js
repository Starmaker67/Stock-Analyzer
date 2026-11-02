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

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const BASE = 'https://finnhub.io/api/v1';
const PORT = process.env.PORT || 4000;

if (!FINNHUB_KEY) {
  console.error('❌ Нет FINNHUB_KEY в .env или переменных окружения');
  process.exit(1);
}

// СПИСОК ИЗ 50 АКЦИЙ
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

// ============================================================
// 2. КЭШ
// ============================================================
const cache = new Map();
const TTL = 60_000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.d;
  const d = await fn();
  cache.set(key, { d, t: Date.now() });
  return d;
}

// ============================================================
// 3. FINNHUB & YAHOO (Данные)
// ============================================================
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
    symbol: s,
    pe: m.peBasicExclExtraTTM,
    ps: m.psTTM, 
    evEbitda: m.currentEvEbitdaTTM || m.evEbitdaTTM,
    ebitdaMargin: m.ebitdaMarginTTM || m.operatingMarginTTM,
    revenueGrowth: m.revenueGrowthTTMYoy,
    debtEbitda: m.totalDebtToEbitda || m.netDebtToEbitda,
    roe: m.roeTTM 
  };
});

// Новости (CNBC RSS)
const parser = new Parser();
const getNews = () => cached('news:cnbc', async () => {
  try {
    const feed = await parser.parseURL('https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114');
    return feed.items.slice(0, 6).map(item => {
      let image = null;
      if (item.enclosure && item.enclosure.url) {
        image = item.enclosure.url;
      } else if (item.content) {
        const imgMatch = item.content.match(/<img[^>]+src="([^">]+)"/);
        if (imgMatch) image = imgMatch[1];
      }
      return {
        headline: item.title,
        source: 'CNBC',
        url: item.link,
        datetime: item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000),
        image: image
      };
    });
  } catch (error) {
    console.error('Ошибка загрузки новостей CNBC:', error.message);
    return [];
  }
});

// ============================================================
// 4. EXPRESS API
// ============================================================
const app = express();
app.use(cors());

app.get('/api/quote/:symbol', async (req, res) => {
  try { res.json(await getQuote(req.params.symbol)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/candles/:symbol', async (req, res) => {
  try { res.json(await getCandles(req.params.symbol, +req.query.days || 60)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fundamentals/:symbol', async (req, res) => {
  try { res.json(await getFundamentals(req.params.symbol)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news', async (req, res) => {
  try { res.json(await getNews()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/watchlist', (req, res) => {
  res.json(WATCHLIST.map(sym => ({ symbol: sym, name: COMPANY_NAMES[sym] || sym })));
});

// ============================================================
// 5. HTML-СТРАНИЦА (FRONTEND)
// ============================================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stock Analyzer | Starmaker67</title>
  <style>
    :root { --bg: #121212; --panel: #1e1e1e; --text: #e0e0e0; --up: #00c853; --down: #ff3d00; --accent: #2196f3; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 1400px; margin: auto; line-height: 1.5; }
    
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #333; padding-bottom: 15px; flex-wrap: wrap; gap: 15px; }
    .logo { font-size: 24px; font-weight: bold; color: var(--accent); }
    
    .search-box { display: flex; gap: 10px; }
    .search-box input { padding: 10px 15px; border-radius: 8px; border: 1px solid #333; background: var(--panel); color: white; font-size: 16px; text-transform: uppercase; width: 250px; }
    .search-box input:focus { outline: none; border-color: var(--accent); }
    .search-box button { padding: 10px 20px; border-radius: 8px; border: none; background: var(--accent); color: white; cursor: pointer; font-weight: bold; font-size: 16px; transition: 0.2s; }
    .search-box button:hover { background: #1976d2; }
    
    .main-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 30px; }
    @media (max-width: 1000px) { .main-grid { grid-template-columns: 1fr; } }
    
    .stock-card { background: var(--panel); border-radius: 12px; padding: 20px; }
    .stock-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 15px; }
    .ticker-name { font-size: 32px; font-weight: bold; }
    .company-name { color: #888; font-size: 16px; }
    .price { font-size: 42px; font-weight: bold; line-height: 1; }
    .change { font-size: 20px; font-weight: bold; margin-top: 5px; }
    .up { color: var(--up); } .down { color: var(--down); }
    
    .chart-container { height: 400px; margin-top: 15px; }
    
    .news-panel { background: var(--panel); border-radius: 12px; padding: 20px; max-height: 600px; overflow-y: auto; }
    .news-panel h3 { margin-top: 0; border-bottom: 1px solid #333; padding-bottom: 10px; position: sticky; top: 0; background: var(--panel); z-index: 10; }
    .news-item { display: flex; gap: 15px; padding: 15px 0; border-bottom: 1px solid #2a2a2a; align-items: flex-start; }
    .news-item:last-child { border-bottom: none; }
    
    .news-img { width: 80px; height: 60px; border-radius: 6px; object-fit: cover; background: #333; flex-shrink: 0; }
    .news-img-placeholder { width: 80px; height: 60px; border-radius: 6px; background: #333; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; color: #666; flex-shrink: 0; }
    
    .news-content { display: flex; flex-direction: column; gap: 5px; }
    .news-item a { color: var(--text); text-decoration: none; font-weight: 500; transition: 0.2s; line-height: 1.3; }
    .news-item a:hover { color: var(--accent); }
    .news-source { font-size: 12px; color: #888; }
    
    .analysis { background: var(--panel); border-radius: 12px; padding: 20px; margin-top: 20px; }
    .analysis h3 { margin-top: 0; border-bottom: 1px solid #333; padding-bottom: 10px; }
    .analysis h4 { color: #aaa; margin: 20px 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
    .metric { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2a2a2a; font-size: 14px; }
    .metric:last-child { border-bottom: none; }
    .metric.good { color: var(--up); }
    .metric.bad { color: var(--down); }
    .metric.na { color: #888; }
    
    .watchlist-section h2 { border-bottom: 1px solid #333; padding-bottom: 10px; margin-bottom: 20px; }
    .watchlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 20px; }
    
    .watchlist-item { background: var(--panel); border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 15px; border: 1px solid #2a2a2a; transition: 0.2s; cursor: pointer; }
    .watchlist-item:hover { border-color: #555; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .watchlist-item.hidden { display: none; }
    
    .wl-header { display: flex; justify-content: space-between; align-items: flex-start; }
    .wl-symbol { font-size: 24px; font-weight: bold; }
    .wl-company { font-size: 14px; color: #888; }
    .wl-price-container { text-align: right; }
    .wl-price { font-size: 24px; font-weight: bold; }
    .wl-change { font-size: 14px; font-weight: bold; }
    .wl-chart { height: 250px; }
    
    .show-more-container { text-align: center; margin-top: 30px; }
    .show-more-btn { padding: 12px 30px; background: transparent; border: 2px solid var(--accent); color: var(--accent); border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s; }
    .show-more-btn:hover { background: var(--accent); color: white; }
    
    .footer { text-align: center; padding: 40px 0 20px 0; color: #666; font-size: 14px; margin-top: 40px; border-top: 1px solid #333; }
  </style>
</head>
<body>

  <div class="top-bar">
    <div class="logo">Stock Analyzer</div>
    <div class="search-box">
      <input type="text" id="symbolInput" placeholder="Введите тикер (напр. NFLX)" onkeypress="if(event.key==='Enter') loadCustomSymbol()">
      <button onclick="loadCustomSymbol()">Найти</button>
    </div>
  </div>

  <div class="main-grid">
    <div>
      <div class="stock-card">
        <div class="stock-header">
          <div>
            <div class="ticker-name" id="mainTicker">AAPL</div>
            <div class="company-name" id="mainCompany">Apple Inc.</div>
          </div>
          <div style="text-align: right;">
            <div class="price" id="mainPrice">—</div>
            <div class="change" id="mainChange">—</div>
          </div>
        </div>
        <div class="chart-container" id="mainChart"></div>
      </div>
      
      <div class="analysis">
        <h3>Анализ акции</h3>
        <div id="mainAnalysis">Выберите акцию из списка...</div>
      </div>
    </div>

    <div>
      <div class="news-panel">
        <h3>Финансовые новости</h3>
        <div id="newsList">Загрузка...</div>
      </div>
    </div>
  </div>

  <div class="watchlist-section">
    <h2>Популярные акции (50 компаний)</h2>
    <div class="watchlist-grid" id="watchlistContainer"></div>
    
    <div class="show-more-container">
      <button class="show-more-btn" id="showMoreBtn" onclick="showMoreStocks()">Показать еще 8</button>
    </div>
  </div>

  <div class="footer">
    © 2026 Stock Analyzer. Автор: <b>Starmaker67</b>
  </div>

  <script src="https://canvasjs.com/assets/script/jquery-1.11.1.min.js"></script>
  <script src="https://cdn.canvasjs.com/canvasjs.stock.min.js"></script>
  <script>
    let currentMainSymbol = 'AAPL';
    // ВАЖНО: Безопасный WebSocket для Render (https -> wss)
    let ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    
    let mainChart = null;
    let allStocks = [];
    const BATCH_SIZE = 8;

    ws.onmessage = (e) => {
      const { symbol, price } = JSON.parse(e.data);
      if (symbol === currentMainSymbol) {
        document.getElementById('mainPrice').textContent = price.toFixed(2);
      }
    };

    async function loadMainStock(symbol, name) {
      currentMainSymbol = symbol;
      document.getElementById('mainTicker').textContent = symbol;
      document.getElementById('mainCompany').textContent = name || 'Загрузка...';
      document.getElementById('symbolInput').value = symbol;
      
      try {
        const q = await fetch('/api/quote/' + symbol).then(r => r.json());
        if (q.error) throw new Error('Тикер не найден');
        
        document.getElementById('mainPrice').textContent = q.price ? q.price.toFixed(2) : '—';
        const ch = document.getElementById('mainChange');
        ch.textContent = (q.change >= 0 ? '+' : '') + q.change.toFixed(2) + ' (' + q.percent.toFixed(2) + '%)';
        ch.className = 'change ' + (q.change >= 0 ? 'up' : 'down');

        const res = await fetch('/api/candles/' + symbol + '?days=60').then(r => r.json());
        if (!res.candles || !res.candles.length) throw new Error('Нет данных для графика');
        
        const points = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
        
        if (mainChart) mainChart.destroy();
        mainChart = new CanvasJS.StockChart("mainChart", {
          theme: "dark2",
          backgroundColor: "transparent",
          title: { text: symbol + " (60 дней)", fontColor: "#888" },
          charts: [{
            data: [{ type: 'candlestick', dataPoints: points, risingColor: '#00c853', fallingColor: '#ff3d00' }]
          }],
          navigator: { enabled: true, slider: { color: "#333" } }
        });
        mainChart.render();

        const f = await fetch('/api/fundamentals/' + symbol).then(r => r.json());
        const metrics = [
          { label: 'P/E', v: f.pe, b: 15, inv: false },
          { label: 'P/S', v: f.ps, b: 3, inv: false },
          { label: 'EV/EBITDA', v: f.evEbitda, b: 8, inv: false },
          { label: 'EBITDA Margin', v: f.ebitdaMargin, b: 15, inv: false },
          { label: 'Revenue Growth', v: f.revenueGrowth, b: 5, inv: false },
          { label: 'Debt/EBITDA', v: f.debtEbitda, b: 2.5, inv: true },
          { label: 'ROE', v: f.roe, b: 10, inv: false }
        ];

        let html = '<h4 style="margin-top:0;">Фундаментальные</h4>';
        html += metrics.map(m => {
          if (m.v == null) return '<div class="metric na"><span>' + m.label + '</span><span>—</span></div>';
          const good = m.inv ? m.v < m.b : m.v > m.b;
          return '<div class="metric ' + (good ? 'good' : 'bad') + '"><span>' + m.label + '</span><span>' + Number(m.v).toFixed(2) + '</span></div>';
        }).join('');

        const ind = res.indicators;
        html += '<h4>Технические</h4>';
        html += '<div class="metric"><span>RSI (14)</span><span>' + (ind.rsi ? ind.rsi.toFixed(2) : '—') + '</span></div>';
        html += '<div class="metric"><span>MACD</span><span>' + (ind.macd ? ind.macd.toFixed(3) : '—') + '</span></div>';
        html += '<div class="metric"><span>MACD Signal</span><span>' + (ind.macdSignal ? ind.macdSignal.toFixed(3) : '—') + '</span></div>';
        html += '<div class="metric"><span>MACD Hist</span><span>' + (ind.macdHistogram ? ind.macdHistogram.toFixed(3) : '—') + '</span></div>';
        html += '<div class="metric"><span>Объём (Volume)</span><span>' + (ind.volume ? ind.volume.toLocaleString('ru-RU') : '—') + '</span></div>';

        document.getElementById('mainAnalysis').innerHTML = html;
        
      } catch (err) {
        alert('Не удалось загрузить данные для тикера ' + symbol);
        console.error(err);
      }
    }

    function loadCustomSymbol() {
      const input = document.getElementById('symbolInput').value.toUpperCase().trim();
      if (!input) return;
      loadMainStock(input, input); 
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function initWatchlist() {
      allStocks = await fetch('/api/watchlist').then(r => r.json());
      const container = document.getElementById('watchlistContainer');
      
      for (const stock of allStocks) {
        const item = document.createElement('div');
        item.className = 'watchlist-item hidden';
        item.id = 'card-' + stock.symbol;
        
        item.innerHTML = \`
          <div class="wl-header">
            <div>
              <div class="wl-symbol">\${stock.symbol}</div>
              <div class="wl-company">\${stock.name}</div>
            </div>
            <div class="wl-price-container">
              <div class="wl-price" id="wl-price-\${stock.symbol}">—</div>
              <div class="wl-change" id="wl-change-\${stock.symbol}">—</div>
            </div>
          </div>
          <div class="wl-chart" id="wl-chart-\${stock.symbol}"></div>
        \`;
        container.appendChild(item);

        item.addEventListener('click', () => {
          loadMainStock(stock.symbol, stock.name);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
      
      showMoreStocks();
    }

    function showMoreStocks() {
      const container = document.getElementById('watchlistContainer');
      const allCards = container.querySelectorAll('.watchlist-item');
      
      let shown = 0;
      for (let i = 0; i < allCards.length; i++) {
        if (allCards[i].classList.contains('hidden')) {
          allCards[i].classList.remove('hidden');
          shown++;
          
          const symbol = allCards[i].id.replace('card-', '');
          loadStockData(symbol);
          
          if (shown >= BATCH_SIZE) break;
        }
      }

      const hiddenCount = container.querySelectorAll('.watchlist-item.hidden').length;
      if (hiddenCount === 0) {
        document.getElementById('showMoreBtn').style.display = 'none';
      } else {
        document.getElementById('showMoreBtn').textContent = 'Показать еще ' + Math.min(BATCH_SIZE, hiddenCount);
      }
    }

    async function loadStockData(symbol) {
      if (document.getElementById('wl-price-' + symbol).textContent !== '—') return;

      try {
        const q = await fetch('/api/quote/' + symbol).then(r => r.json());
        const priceEl = document.getElementById('wl-price-' + symbol);
        const changeEl = document.getElementById('wl-change-' + symbol);
        
        if (priceEl && q.price) {
          priceEl.textContent = q.price.toFixed(2);
          changeEl.textContent = (q.change >= 0 ? '+' : '') + q.percent.toFixed(2) + '%';
          changeEl.className = 'wl-change ' + (q.change >= 0 ? 'up' : 'down');
        }

        await new Promise(r => setTimeout(r, 200)); // Пауза для лимитов API

        const res = await fetch('/api/candles/' + symbol + '?days=30').then(r => r.json());
        const points = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
        
        new CanvasJS.Chart("wl-chart-" + symbol, {
          theme: "dark2",
          backgroundColor: "transparent",
          height: 250,
          axisX: { lineThickness: 0, tickLength: 0, labelFontSize: 10, valueFormatString: "DD MMM" },
          axisY: { lineThickness: 0, tickLength: 0, labelFontSize: 10, gridThickness: 0 },
          data: [{
            type: 'candlestick',
            dataPoints: points,
            risingColor: '#00c853',
            fallingColor: '#ff3d00'
          }]
        }).render();
      } catch (e) { 
        console.error('Ошибка загрузки ' + symbol, e); 
        document.getElementById('wl-price-' + symbol).textContent = 'Ошибка';
      }
    }

    async function loadNews() {
      try {
        const news = await fetch('/api/news').then(r => r.json());
        if (!news.length) throw new Error('Пусто');
        
        document.getElementById('newsList').innerHTML = news.map(n => {
          const date = new Date(n.datetime * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
          
          const imgHtml = n.image 
            ? \`<img src="\${n.image}" class="news-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" alt="news">\`
            : '';
          const placeholderHtml = \`<div class="news-img-placeholder" style="\${n.image ? 'display:none;' : 'display:flex;'}">\${n.source.charAt(0)}</div>\`;

          return \`
            <div class="news-item">
              \${imgHtml}
              \${placeholderHtml}
              <div class="news-content">
                <a href="\${n.url}" target="_blank">\${n.headline}</a>
                <div class="news-source">\${n.source} • \${date}</div>
              </div>
            </div>
          \`;
        }).join('');
      } catch (e) {
        document.getElementById('newsList').innerHTML = '<div class="news-item">Не удалось загрузить новости.</div>';
      }
    }

    window.onload = () => {
      loadMainStock('AAPL', 'Apple Inc.');
      initWatchlist();
      loadNews();
    };
  </script>
</body>
</html>`);
});

// ============================================================
// 6. WEBSOCKET И ЗАПУСК СЕРВЕРА
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
    // Подписываемся на первые 20 акций, чтобы не словить лимит бесплатного Finnhub
    WATCHLIST.slice(0, 20).forEach(s =>
      ws.send(JSON.stringify({ type: 'subscribe', symbol: s }))
    );
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'trade') m.data.forEach(t => broadcast({ symbol: t.s, price: t.p }));
  });
  ws.on('close', () => setTimeout(connectFinnhub, 3000));
  ws.on('error', (e) => console.error('Finnhub WS:', e.message));
}

// ВАЖНО: '0.0.0.0' нужен для Render, чтобы сервер принимал внешние запросы
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Сервер успешно запущен на порту ${PORT}`);
  console.log(`Локально: http://localhost:${PORT}\n`);
  connectFinnhub();
});
