let currentMainSymbol = 'AAPL';
let mainChart = null;
let allStocks = [];
let allQuotes = {};
const BATCH_SIZE = 12;

// === LOCAL STORAGE (Без регистрации) ===
const getPortfolio = () => JSON.parse(localStorage.getItem('paperPortfolio')) || { cash: 10000, holdings: {} };
const savePortfolio = (p) => localStorage.setItem('paperPortfolio', JSON.stringify(p));
const getFavorites = () => JSON.parse(localStorage.getItem('favorites')) || [];
const saveFavorites = (f) => localStorage.setItem('favorites', JSON.stringify(f));

// === WEBSOCKET ===
let ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
ws.onmessage = (e) => {
  const { symbol, price } = JSON.parse(e.data);
  if (allQuotes[symbol]) allQuotes[symbol].price = price;
  if (symbol === currentMainSymbol) document.getElementById('mainPrice').textContent = price.toFixed(2);
  updatePortfolioUI(); // Обновляем стоимость портфеля на лету
};

// === ПОИСК С АВТОДОПОЛНЕНИЕМ ===
const searchInput = document.getElementById('symbolInput');
const autoList = document.getElementById('autocompleteList');

searchInput.addEventListener('input', function() {
  const val = this.value.toUpperCase();
  autoList.innerHTML = '';
  if (!val) { autoList.style.display = 'none'; return; }
  
  const matches = allStocks.filter(s => s.symbol.includes(val) || s.name.toUpperCase().includes(val)).slice(0, 8);
  if (!matches.length) { autoList.style.display = 'none'; return; }

  matches.forEach(m => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${m.symbol}</b> - ${m.name}`;
    div.onclick = () => {
      searchInput.value = m.symbol;
      autoList.style.display = 'none';
      loadMainStock(m.symbol, m.name);
    };
    autoList.appendChild(div);
  });
  autoList.style.display = 'block';
});

document.addEventListener('click', (e) => { if (e.target !== searchInput) autoList.style.display = 'none'; });

// === ГЛАВНЫЙ ЭКРАН (Анализ) ===
async function loadMainStock(symbol, name) {
  currentMainSymbol = symbol;
  document.getElementById('mainTicker').textContent = symbol;
  document.getElementById('mainCompany').textContent = name || symbol;
  
  // Проверка избранного
  const favs = getFavorites();
  const starBtn = document.getElementById('mainStarBtn');
  if (favs.includes(symbol)) starBtn.classList.add('active');
  else starBtn.classList.remove('active');

  loadMainChart('price'); // По умолчанию график цены

  try {
    const q = await fetch('/api/quote/' + symbol).then(r => r.json());
    document.getElementById('mainPrice').textContent = q.price ? q.price.toFixed(2) : '—';
    const ch = document.getElementById('mainChange');
    ch.textContent = (q.change >= 0 ? '+' : '') + q.change.toFixed(2) + ' (' + q.percent.toFixed(2) + '%)';
    ch.className = 'change ' + (q.change >= 0 ? 'up' : 'down');

    const f = await fetch('/api/fundamentals/' + symbol).then(r => r.json());
    const metrics = [
      { label: 'P/E', v: f.pe, b: 15, inv: false }, { label: 'P/S', v: f.ps, b: 3, inv: false },
      { label: 'EV/EBITDA', v: f.evEbitda, b: 8, inv: false }, { label: 'EBITDA Margin', v: f.ebitdaMargin, b: 15, inv: false },
      { label: 'Rev Growth', v: f.revenueGrowth, b: 5, inv: false }, { label: 'Debt/EBITDA', v: f.debtEbitda, b: 2.5, inv: true },
      { label: 'ROE', v: f.roe, b: 10, inv: false }
    ];
    document.getElementById('fundamentalData').innerHTML = metrics.map(m => {
      if (m.v == null) return `<div class="metric na"><span>${m.label}</span><span>—</span></div>`;
      const good = m.inv ? m.v < m.b : m.v > m.b;
      return `<div class="metric ${good ? 'good' : 'bad'}"><span>${m.label}</span><span>${Number(m.v).toFixed(2)}</span></div>`;
    }).join('');

    const res = await fetch('/api/candles/' + symbol).then(r => r.json());
    const ind = res.indicators;
    let rsiClass = ind.rsi > 70 ? 'bad' : (ind.rsi < 30 ? 'good' : '');
    document.getElementById('technicalData').innerHTML = `
      <div class="metric ${rsiClass}"><span>RSI (14)</span><span>${ind.rsi ? ind.rsi.toFixed(2) : '—'}</span></div>
      <div class="metric"><span>MACD</span><span>${ind.macd ? ind.macd.toFixed(3) : '—'}</span></div>
      <div class="metric"><span>Volume</span><span>${ind.volume ? ind.volume.toLocaleString('ru-RU') : '—'}</span></div>
    `;
  } catch (e) { console.error(e); }
}

async function loadMainChart(type) {
  const elId = "mainChart";
  document.getElementById(elId).innerHTML = '<div style="color:#8b949e; padding:20px;">Загрузка...</div>';
  if (mainChart) mainChart.destroy();
  
  if (type === 'price') {
    const res = await fetch('/api/candles/' + currentMainSymbol).then(r => r.json());
    const pts = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    mainChart = new CanvasJS.StockChart(elId, {
      theme: "dark2", backgroundColor: "transparent",
      charts: [{ data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] }],
      navigator: { enabled: true, slider: { color: "#30363d" } }
    });
  } else {
    // График P/E
    const res = await fetch('/api/historical-pe/' + currentMainSymbol).then(r => r.json());
    const pts = res.map(p => ({ x: new Date(p.x), y: p.y }));
    mainChart = new CanvasJS.Chart(elId, {
      theme: "dark2", backgroundColor: "transparent",
      title: { text: "Историческая динамика P/E (1 год)", fontColor: "#8b949e" },
      axisX: { valueFormatString: "MMM YYYY", labelFontColor: "#8b949e" },
      axisY: { labelFontColor: "#8b949e", gridColor: "#30363d" },
      data: [{ type: "line", dataPoints: pts, color: "#58a6ff", markerSize: 0 }]
    });
  }
  mainChart.render();
}

// === ИЗБРАННОЕ ===
function toggleFavorite(symbol) {
  let favs = getFavorites();
  if (favs.includes(symbol)) {
    favs = favs.filter(f => f !== symbol);
    document.getElementById('mainStarBtn').classList.remove('active');
  } else {
    favs.push(symbol);
    document.getElementById('mainStarBtn').classList.add('active');
  }
  saveFavorites(favs);
  renderFavorites();
}

async function renderFavorites() {
  const favs = getFavorites();
  const container = document.getElementById('favoritesContainer');
  container.innerHTML = favs.length ? '' : '<p style="color:#8b949e">Вы пока не добавили акции в избранное.</p>';
  for (const sym of favs) {
    const stock = allStocks.find(s => s.symbol === sym);
    if (stock) await createStockCard(stock, container);
  }
}

// === ПОРТФЕЛЬ (Paper Trading) ===
function openTradeModal(type) {
  document.getElementById('tradeModal').style.display = 'block';
  document.getElementById('tradeTitle').textContent = type === 'buy' ? `Купить ${currentMainSymbol}` : `Продать ${currentMainSymbol}`;
  document.getElementById('tradePrice').textContent = allQuotes[currentMainSymbol]?.price?.toFixed(2) || '0.00';
  document.getElementById('tradeShares').value = '';
  document.getElementById('tradeSubmitBtn').onclick = () => executeTrade(type);
}

function executeTrade(type) {
  const shares = parseFloat(document.getElementById('tradeShares').value);
  if (!shares || shares <= 0) return alert('Введите корректное количество');
  
  const price = allQuotes[currentMainSymbol]?.price;
  if (!price) return alert('Нет данных о цене');
  
  const p = getPortfolio();
  const totalCost = shares * price;

  if (type === 'buy') {
    if (p.cash < totalCost) return alert('Недостаточно средств!');
    p.cash -= totalCost;
    if (!p.holdings[currentMainSymbol]) p.holdings[currentMainSymbol] = { shares: 0, totalCost: 0 };
    p.holdings[currentMainSymbol].shares += shares;
    p.holdings[currentMainSymbol].totalCost += totalCost;
  } else {
    if (!p.holdings[currentMainSymbol] || p.holdings[currentMainSymbol].shares < shares) return alert('Недостаточно акций!');
    p.cash += totalCost;
    p.holdings[currentMainSymbol].shares -= shares;
    p.holdings[currentMainSymbol].totalCost -= (shares * (p.holdings[currentMainSymbol].totalCost / (p.holdings[currentMainSymbol].shares + shares)));
    if (p.holdings[currentMainSymbol].shares === 0) delete p.holdings[currentMainSymbol];
  }

  savePortfolio(p);
  closeModal('tradeModal');
  updatePortfolioUI();
}

function updatePortfolioUI() {
  const p = getPortfolio();
  document.getElementById('cashBalance').textContent = '$' + p.cash.toLocaleString('en-US', {minimumFractionDigits: 2});
  
  let stockValue = 0;
  let totalCost = 0;
  const tbody = document.querySelector('#holdingsTable tbody');
  tbody.innerHTML = '';

  for (const [sym, data] of Object.entries(p.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    const val = currPrice * data.shares;
    const cost = data.totalCost;
    const pnl = val - cost;
    
    stockValue += val;
    totalCost += cost;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${sym}</b></td>
      <td>${data.shares}</td>
      <td>$${(cost / data.shares).toFixed(2)}</td>
      <td>$${currPrice.toFixed(2)}</td>
      <td>$${val.toFixed(2)}</td>
      <td class="${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</td>
      <td><button class="btn-small btn-sell" onclick="loadMainStock('${sym}'); openTradeModal('sell')">Продать</button></td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('portfolioValue').textContent = '$' + stockValue.toLocaleString('en-US', {minimumFractionDigits: 2});
  const totalPnL = stockValue - totalCost;
  const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  const pnlEl = document.getElementById('portfolioPnL');
  pnlEl.textContent = `${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} (${totalPnLPercent.toFixed(2)}%)`;
  pnlEl.className = totalPnL >= 0 ? 'up' : 'down';
}

// === СРАВНЕНИЕ АКЦИЙ ===
function openCompareModal() {
  document.getElementById('compareModal').style.display = 'block';
  const s1 = document.getElementById('compare1');
  const s2 = document.getElementById('compare2');
  s1.innerHTML = ''; s2.innerHTML = '';
  allStocks.forEach(s => {
    s1.innerHTML += `<option value="${s.symbol}">${s.symbol} - ${s.name}</option>`;
    s2.innerHTML += `<option value="${s.symbol}">${s.symbol} - ${s.name}</option>`;
  });
  s1.value = 'AAPL'; s2.value = 'MSFT';
}

async function runComparison() {
  const sym1 = document.getElementById('compare1').value;
  const sym2 = document.getElementById('compare2').value;
  const resDiv = document.getElementById('comparisonResult');
  resDiv.innerHTML = 'Загрузка...';
  
  try {
    const [f1, f2, q1, q2] = await Promise.all([
      fetch('/api/fundamentals/' + sym1).then(r=>r.json()),
      fetch('/api/fundamentals/' + sym2).then(r=>r.json()),
      fetch('/api/quote/' + sym1).then(r=>r.json()),
      fetch('/api/quote/' + sym2).then(r=>r.json())
    ]);

    resDiv.innerHTML = `
      <table class="portfolio-table" style="margin-top:20px;">
        <thead><tr><th>Метрика</th><th>${sym1}</th><th>${sym2}</th></tr></thead>
        <tbody>
          <tr><td>Цена</td><td>$${q1.price?.toFixed(2)}</td><td>$${q2.price?.toFixed(2)}</td></tr>
          <tr><td>P/E</td><td>${f1.pe?.toFixed(2) || '—'}</td><td>${f2.pe?.toFixed(2) || '—'}</td></tr>
          <tr><td>P/S</td><td>${f1.ps?.toFixed(2) || '—'}</td><td>${f2.ps?.toFixed(2) || '—'}</td></tr>
          <tr><td>EV/EBITDA</td><td>${f1.evEbitda?.toFixed(2) || '—'}</td><td>${f2.evEbitda?.toFixed(2) || '—'}</td></tr>
          <tr><td>EBITDA Margin</td><td>${f1.ebitdaMargin?.toFixed(2) || '—'}%</td><td>${f2.ebitdaMargin?.toFixed(2) || '—'}%</td></tr>
          <tr><td>ROE</td><td>${f1.roe?.toFixed(2) || '—'}%</td><td>${f2.roe?.toFixed(2) || '—'}%</td></tr>
        </tbody>
      </table>
    `;
  } catch(e) { resDiv.innerHTML = '<span style="color:red">Ошибка сравнения</span>'; }
}

// === ГЕНЕРАЦИЯ КАРТОЧЕК СПИСКА ===
async function createStockCard(stock, container) {
  const div = document.createElement('div');
  div.className = 'watchlist-item';
  div.id = 'card-' + stock.symbol;
  div.onclick = () => { loadMainStock(stock.symbol, stock.name); switchTab('dashboard'); window.scrollTo(0,0); };
  
  div.innerHTML = `
    <div class="wl-header">
      <div><div class="wl-symbol">${stock.symbol}</div><div class="wl-company">${stock.name}</div></div>
      <div><div class="wl-price" id="wl-price-${stock.symbol}">—</div><div class="wl-change" id="wl-change-${stock.symbol}">—</div></div>
    </div>
    <div class="wl-chart" id="wl-chart-${stock.symbol}"></div>
  `;
  container.appendChild(div);
  loadMiniChart(stock.symbol);
}

async function loadMiniChart(symbol) {
  try {
    const q = await fetch('/api/quote/' + symbol).then(r=>r.json());
    allQuotes[symbol] = q;
    const priceEl = document.getElementById(`wl-price-${symbol}`);
    const changeEl = document.getElementById(`wl-change-${symbol}`);
    if (priceEl) { priceEl.textContent = q.price ? q.price.toFixed(2) : '—'; priceEl.className = 'wl-price ' + (q.change >= 0 ? 'up' : 'down'); }
    if (changeEl) { changeEl.textContent = q.percent ? `${q.percent > 0 ? '+' : ''}${q.percent.toFixed(2)}%` : '—'; }

    const res = await fetch('/api/candles/' + symbol).then(r=>r.json());
    const pts = res.candles.slice(-30).map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    new CanvasJS.Chart(`wl-chart-${symbol}`, {
      theme: "dark2", backgroundColor: "transparent", height: 100,
      axisX: { visible: false }, axisY: { visible: false },
      data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }]
    }).render();
  } catch(e) {}
}

// === ИНИЦИАЛИЗАЦИЯ ===
window.onload = async () => {
  allStocks = await fetch('/api/watchlist').then(r=>r.json());
  
  // Загружаем новости
  fetch('/api/news').then(r=>r.json()).then(news => {
    document.getElementById('newsList').innerHTML = news.map(n => `
      <div class="news-item">
        ${n.image ? `<img src="${n.image}" class="news-img">` : ''}
        <div><a href="${n.url}" target="_blank">${n.headline}</a><div style="font-size:11px;color:#8b949e;margin-top:4px;">CNBC • ${new Date(n.datetime*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</div></div>
      </div>
    `).join('');
  });

  // Загружаем Лидеров
  fetch('/api/gainers-losers').then(r=>r.json()).then(data => {
    document.getElementById('gainersList').innerHTML = data.gainers.map(s => `
      <div class="leader-item" onclick="loadMainStock('${s.symbol}', '${s.symbol}')"><span>${s.symbol}</span><span class="up">+${s.percent.toFixed(2)}%</span></div>
    `).join('');
    document.getElementById('losersList').innerHTML = data.losers.map(s => `
      <div class="leader-item" onclick="loadMainStock('${s.symbol}', '${s.symbol}')"><span>${s.symbol}</span><span class="down">${s.percent.toFixed(2)}%</span></div>
    `).join('');
  });

  // Главная акция
  loadMainStock('AAPL', 'Apple Inc.');
  updatePortfolioUI();
  renderFavorites();

  // Генерируем список из 100 акций (по 12 штук)
  const container = document.getElementById('watchlistContainer');
  let shown = 0;
  for (let i = 0; i < allStocks.length; i++) {
    const card = await createStockCard(allStocks[i], container);
    if (i >= 12) container.lastChild.classList.add('hidden');
  }
};

function showMoreStocks() {
  const hidden = document.querySelectorAll('#watchlistContainer .watchlist-item.hidden');
  let count = 0;
  hidden.forEach(el => {
    if (count < 12) {
      el.classList.remove('hidden');
      loadMiniChart(el.id.replace('card-', '')); // Грузим график только при показе
      count++;
    }
  });
  if (document.querySelectorAll('#watchlistContainer .watchlist-item.hidden').length === 0) {
    document.getElementById('showMoreBtn').style.display = 'none';
  }
}

// Вспомогательные функции UI
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  event.target.classList.add('active');
}
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
