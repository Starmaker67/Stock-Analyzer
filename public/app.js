let currentMainSymbol = 'AAPL';
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
  
  document.getElementById('mainPrice').textContent = '—';
  document.getElementById('mainChange').textContent = '—';
  document.getElementById('mainChange').className = 'change';
  document.getElementById('mainAnalysis').innerHTML = '<div class="loading-text"><div class="spinner"></div> Загрузка анализа...</div>';
  
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
    document.getElementById('mainChart').innerHTML = '';
    mainChart = new CanvasJS.StockChart("mainChart", {
      theme: "dark2",
      backgroundColor: "transparent",
      title: { text: symbol + " (60 дней)", fontColor: "#8b949e", fontSize: 14 },
      charts: [{
        data: [{ type: 'candlestick', dataPoints: points, risingColor: '#238636', fallingColor: '#da3633' }]
      }],
      navigator: { enabled: true, slider: { color: "#30363d" } }
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
    
    let rsiClass = '';
    if (ind.rsi) {
      if (ind.rsi > 70) rsiClass = 'bad';
      else if (ind.rsi < 30) rsiClass = 'good';
    }
    html += '<div class="metric ' + rsiClass + '"><span>RSI (14)</span><span>' + (ind.rsi ? ind.rsi.toFixed(2) : '—') + '</span></div>';
    
    html += '<div class="metric"><span>MACD</span><span>' + (ind.macd ? ind.macd.toFixed(3) : '—') + '</span></div>';
    html += '<div class="metric"><span>MACD Signal</span><span>' + (ind.macdSignal ? ind.macdSignal.toFixed(3) : '—') + '</span></div>';
    html += '<div class="metric"><span>MACD Hist</span><span>' + (ind.macdHistogram ? ind.macdHistogram.toFixed(3) : '—') + '</span></div>';
    html += '<div class="metric"><span>Объём (Volume)</span><span>' + (ind.volume ? ind.volume.toLocaleString('ru-RU') : '—') + '</span></div>';

    document.getElementById('mainAnalysis').innerHTML = html;
    
  } catch (err) {
    document.getElementById('mainAnalysis').innerHTML = '<div style="color:var(--down)">Ошибка загрузки данных</div>';
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
    
    item.innerHTML = `
      <div class="wl-header">
        <div>
          <div class="wl-symbol">${stock.symbol}</div>
          <div class="wl-company">${stock.name}</div>
        </div>
        <div class="wl-price-container">
          <div class="wl-price" id="wl-price-${stock.symbol}">—</div>
          <div class="wl-change" id="wl-change-${stock.symbol}">—</div>
        </div>
      </div>
      <div class="wl-chart" id="wl-chart-${stock.symbol}">
        <div class="loading-text"><div class="spinner"></div></div>
      </div>
    `;
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

    await new Promise(r => setTimeout(r, 200));

    const res = await fetch('/api/candles/' + symbol + '?days=30').then(r => r.json());
    const points = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    
    document.getElementById('wl-chart-' + symbol).innerHTML = '';
    
    new CanvasJS.Chart("wl-chart-" + symbol, {
      theme: "dark2",
      backgroundColor: "transparent",
      height: 200,
      axisX: { lineThickness: 0, tickLength: 0, labelFontSize: 10, valueFormatString: "DD MMM", labelFontColor: "#8b949e" },
      axisY: { lineThickness: 0, tickLength: 0, labelFontSize: 10, gridThickness: 0, labelFontColor: "#8b949e" },
      data: [{
        type: 'candlestick',
        dataPoints: points,
        risingColor: '#238636',
        fallingColor: '#da3633'
      }]
    }).render();
  } catch (e) { 
    console.error('Ошибка загрузки ' + symbol, e); 
    document.getElementById('wl-price-' + symbol).textContent = 'Ошибка';
    document.getElementById('wl-chart-' + symbol).innerHTML = '';
  }
}

async function loadNews() {
  try {
    const news = await fetch('/api/news').then(r => r.json());
    if (!news.length) throw new Error('Пусто');
    
    document.getElementById('newsList').innerHTML = news.map(n => {
      const date = new Date(n.datetime * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      
      const imgHtml = n.image 
        ? `<img src="${n.image}" class="news-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" alt="news">`
        : '';
      const placeholderHtml = `<div class="news-img-placeholder" style="${n.image ? 'display:none;' : 'display:flex;'}">${n.source.charAt(0)}</div>`;

      return `
        <div class="news-item">
          ${imgHtml