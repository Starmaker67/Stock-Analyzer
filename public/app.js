let currentMainSymbol = 'AAPL';
let currentMainMarket = 'US';
let currentMarket = 'US'; 
let mainChart = null, gaugeChart = null, pieChart = null;
let allMarkets = { US: [], EU: [], RU: [], CRYPTO: [], FOREX: [] };
let allQuotes = {}; 
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;
let localPortfolio = JSON.parse(localStorage.getItem('portfolio')) || { cash: 10000, holdings: {}, history: [] };
let favorites = JSON.parse(localStorage.getItem('favorites')) || [];
let isFetchingQuotes = false;

// WebSocket
let ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
let updateTimeout = null;
ws.onmessage = (e) => {
  const { symbol, price } = JSON.parse(e.data);
  if (!allQuotes[symbol]) allQuotes[symbol] = {};
  allQuotes[symbol].price = price;
  if (symbol === currentMainSymbol && currentMainMarket === 'US') {
    const pEl = document.getElementById('mainPrice');
    if (pEl) pEl.textContent = price.toFixed(2);
  }
  const miniPriceEl = document.getElementById(`wl-price-${symbol}`);
  if (miniPriceEl) miniPriceEl.textContent = price.toFixed(2);
  if (updateTimeout) return;
  updateTimeout = setTimeout(() => { updatePortfolioUI(); updateTimeout = null; }, 1000);
};

// Навигация
function switchTab(tabId, btn) {
  if ((tabId === 'portfolio' || tabId === 'orders') && !currentUser) {
    alert('Пожалуйста, войдите в аккаунт!');
    openModal('authModal');
    return;
  }
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-tabs .tab-btn').forEach(el => el.classList.remove('active'));
  const target = document.getElementById('tab-' + tabId);
  if (target) target.classList.add('active');
  if (btn) btn.classList.add('active');
  
  if (tabId === 'leaderboard') loadLeaderboard();
  if (tabId === 'portfolio') { updatePortfolioUI(); fetchPortfolioQuotes(); }
  if (tabId === 'orders') loadOrders();
}

function switchMarket(market, btn) {
  currentMarket = market;
  document.querySelectorAll('.market-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderWatchlist();
  loadHeatmap(market);
}

// Список акций
function renderWatchlist() {
  const container = document.getElementById('watchlistContainer');
  container.innerHTML = '';
  const stocks = allMarkets[currentMarket] || [];
  stocks.slice(0, 12).forEach((stock, i) => createCard(stock, currentMarket, container, i));
  document.getElementById('showMoreBtn').style.display = stocks.length > 12 ? 'block' : 'none';
}

function showMoreStocks() {
  const container = document.getElementById('watchlistContainer');
  const stocks = allMarkets[currentMarket] || [];
  const currentCount = container.children.length;
  const nextBatch = stocks.slice(currentCount, currentCount + 12);
  nextBatch.forEach((stock, i) => createCard(stock, currentMarket, container, i));
  if (container.children.length >= stocks.length) document.getElementById('showMoreBtn').style.display = 'none';
}

function createCard(stock, market, container, index) {
  const div = document.createElement('div'); 
  div.className = 'watchlist-item';
  div.onclick = () => { 
    loadMainStock(stock.symbol, stock.name, market); 
    switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn')); 
    window.scrollTo(0,0); 
  };
  const displaySymbol = stock.symbol.replace('BINANCE:', '').replace('USDT', '');
  div.innerHTML = `
    <div class="wl-header">
      <div><div class="wl-symbol">${displaySymbol}</div><div class="wl-company">${stock.name}</div></div>
      <div><div class="wl-price" id="wl-price-${stock.symbol}">—</div><div class="wl-change" id="wl-change-${stock.symbol}">—</div></div>
    </div>
    <div class="wl-analysis" id="wl-analysis-${stock.symbol}" style="margin-top:10px; font-size:13px; min-height:40px; color:#8b949e;">Загрузка...</div>
  `;
  container.appendChild(div);
  setTimeout(() => {
    fetchQuoteForCard(stock.symbol, market);
    loadCardAnalysis(stock.symbol, market);
  }, index * 150);
}

async function fetchQuoteForCard(symbol, market) {
  try {
    const q = await fetch(`/api/quote/${market}/${symbol}`).then(r => r.json());
    if (q.error) return;
    allQuotes[symbol] = q;
    const pEl = document.getElementById(`wl-price-${symbol}`); 
    const cEl = document.getElementById(`wl-change-${symbol}`);
    if (pEl) pEl.textContent = q.price ? q.price.toFixed(2) : '—';
    if (cEl && q.percent !== undefined) { 
      cEl.textContent = `${q.percent > 0 ? '+' : ''}${q.percent.toFixed(2)}%`; 
      cEl.className = 'wl-change ' + (q.percent >= 0 ? 'up' : 'down'); 
    }
  } catch(e) {}
}

async function loadCardAnalysis(symbol, market) {
  const container = document.getElementById(`wl-analysis-${symbol}`);
  if (!container) return;
  try {
    const [radar, fundamentals] = await Promise.all([ 
      fetch(`/api/tech-radar/${market}/${symbol}`).then(r => r.json()), 
      fetch(`/api/fundamentals/${market}/${symbol}`).then(r => r.json()) 
    ]);
    const vColor = radar.score > 0 ? 'var(--up)' : (radar.score < 0 ? 'var(--down)' : '#8b949e');
    const pe = fundamentals.pe ? Number(fundamentals.pe).toFixed(2) : '—';
    container.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;"><span>Радар:</span><span style="color:${vColor}; font-weight:bold;">${radar.verdict}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>P/E:</span><span>${pe}</span></div>
    `;
  } catch (e) { container.innerHTML = '<span style="color:var(--down)">Нет данных</span>'; }
}

// Главный экран
async function loadMainStock(symbol, name, market) {
  currentMainSymbol = symbol;
  currentMainMarket = market;
  const displaySymbol = symbol.replace('BINANCE:', '').replace('USDT', '');
  document.getElementById('mainTicker').textContent = displaySymbol;
  document.getElementById('mainCompany').textContent = name || displaySymbol;
  document.getElementById('symbolInput').value = displaySymbol;
  const starBtn = document.getElementById('mainStarBtn');
  if (favorites.includes(symbol)) starBtn.classList.add('active');
  else starBtn.classList.remove('active');

  loadMainChart('price');
  loadTechRadar(symbol, market);

  try {
    const q = await fetch(`/api/quote/${market}/${symbol}`).then(r => r.json());
    if (q.error) throw new Error('Не найдено');
    allQuotes[symbol] = q;
    document.getElementById('mainPrice').textContent = q.price ? q.price.toFixed(2) : '—';
    const ch = document.getElementById('mainChange');
    const changeVal = q.change || 0;
    const percentVal = q.percent || 0;
    ch.textContent = (changeVal >= 0 ? '+' : '') + changeVal.toFixed(2) + ' (' + percentVal.toFixed(2) + '%)';
    ch.className = 'change ' + (changeVal >= 0 ? 'up' : 'down');

    const f = await fetch(`/api/fundamentals/${market}/${symbol}`).then(r => r.json());
    const fMetrics = [
      { label: 'P/E', v: f.pe, b: 15, inv: false }, { label: 'P/S', v: f.ps, b: 3, inv: false },
      { label: 'EV/EBITDA', v: f.evEbitda, b: 8, inv: false }, { label: 'EBITDA Margin', v: f.ebitdaMargin, b: 15, inv: false },
      { label: 'Rev Growth', v: f.revenueGrowth, b: 5, inv: false }, { label: 'Debt/EBITDA', v: f.debtEbitda, b: 2.5, inv: true },
      { label: 'ROE', v: f.roe, b: 10, inv: false }
    ];
    document.getElementById('fundamentalData').innerHTML = fMetrics.map(m => {
      if (m.v == null) return `<div class="metric na"><span>${m.label}</span><span>—</span></div>`;
      const good = m.inv ? m.v < m.b : m.v > m.b;
      return `<div class="metric ${good ? 'good' : 'bad'}"><span>${m.label}</span><span>${Number(m.v).toFixed(2)}</span></div>`;
    }).join('');

    const c = await fetch(`/api/candles/${market}/${symbol}`).then(r => r.json());
    if (c.indicators && c.indicators.rsi) {
      const ind = c.indicators;
      document.getElementById('technicalData').innerHTML = `
        <div class="metric"><span>RSI (14)</span><span>${ind.rsi.toFixed(2)}</span></div>
        <div class="metric"><span>MACD</span><span>${ind.macd ? ind.macd.toFixed(3) : '—'}</span></div>
        <div class="metric"><span>MACD Hist</span><span>${ind.macdHistogram ? ind.macdHistogram.toFixed(3) : '—'}</span></div>
        <div class="metric"><span>Volume</span><span>${ind.volume ? ind.volume.toLocaleString() : '—'}</span></div>
      `;
    } else {
      document.getElementById('technicalData').innerHTML = '<div class="metric na">Нет данных графика</div>';
    }
  } catch(e) { 
    document.getElementById('fundamentalData').innerHTML = '<div class="metric na">Ошибка загрузки</div>';
    document.getElementById('technicalData').innerHTML = '<div class="metric na">Ошибка загрузки</div>';
  }
}

async function loadMainChart(type) {
  const el = document.getElementById('mainChart'); 
  const targetSymbol = currentMainSymbol; 
  const targetMarket = currentMainMarket;
  el.innerHTML = '<div style="color:#8b949e; padding:20px;">Загрузка графика...</div>'; 
  if (mainChart) mainChart.destroy();
  try {
    const res = await fetch(`/api/candles/${targetMarket}/${targetSymbol}`).then(r => r.json());
    if (targetSymbol !== currentMainSymbol) return; 
    if (!res.candles || res.candles.length === 0) throw new Error('Нет данных');
    el.innerHTML = '';
    const pts = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    mainChart = new CanvasJS.StockChart("mainChart", { 
      theme: "dark2", backgroundColor: "transparent", 
      charts: [{ data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] }], 
      navigator: { enabled: true } 
    });
    mainChart.render();
  } catch(e) { 
    if (targetSymbol === currentMainSymbol) el.innerHTML = '<div style="color:#8b949e; text-align:center; padding:20px;">График недоступен</div>'; 
  }
}

async function loadTechRadar(symbol, market) {
  try {
    const tr = await fetch(`/api/tech-radar/${market}/${symbol}`).then(r => r.json()); 
    if (symbol !== currentMainSymbol) return;
    const vEl = document.getElementById('radarVerdict');
    vEl.textContent = tr.verdict; 
    vEl.style.color = tr.score > 0 ? 'var(--up)' : tr.score < 0 ? 'var(--down)' : '#8b949e';
    if (gaugeChart) gaugeChart.destroy();
    gaugeChart = new CanvasJS.Chart("gaugeContainer", { 
      theme: "dark2", backgroundColor: "transparent", 
      data: [{ type: "doughnut", startAngle: -90, endAngle: 90, radius: "100%", dataPoints: [{ y: 33, color: "#da3633" }, { y: 34, color: "#8b949e" }, { y: 33, color: "#238636" }] }] 
    });
    gaugeChart.render();
  } catch(e) {}
}

// Портфель
function findMarketForSymbol(sym) {
  for (const [market, list] of Object.entries(allMarkets)) {
    if (list.some(s => s.symbol === sym)) return market;
  }
  return 'US'; 
}

function calcReturnPercent() {
  let stockValue = 0;
  for (const [sym, data] of Object.entries(localPortfolio.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    stockValue += currPrice * data.shares;
  }
  return ((localPortfolio.cash + stockValue - 10000) / 10000) * 100;
}

function updatePortfolioUI() {
  document.getElementById('cashBalance').textContent = '$' + localPortfolio.cash.toLocaleString('en-US', {minimumFractionDigits: 2});
  let stockValue = 0;
  const tbody = document.querySelector('#holdingsTable tbody'); 
  if (!tbody) return; 
  tbody.innerHTML = '';
  const pieData = [{ label: 'Cash', value: localPortfolio.cash }];
  for (const [sym, data] of Object.entries(localPortfolio.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    const val = currPrice * data.shares;
    const cost = data.totalCost;
    const pnl = val - cost;
    stockValue += val; 
    const displaySymbol = sym.replace('BINANCE:', '').replace('USDT', '');
    pieData.push({ label: displaySymbol, value: val });
    tbody.innerHTML += `
      <tr>
        <td><b>${displaySymbol}</b></td><td>${data.shares}</td>
        <td>$${(cost/data.shares).toFixed(2)}</td><td>$${currPrice.toFixed(2)}</td>
        <td>$${val.toFixed(2)}</td><td class="${pnl>=0?'up':'down'}">$${pnl.toFixed(2)}</td>
        <td><button class="btn-small btn-sell" onclick="sellFromPortfolio('${sym}')">Продать</button></td>
      </tr>`;
  }
  document.getElementById('portfolioValue').textContent = '$' + stockValue.toLocaleString('en-US', {minimumFractionDigits: 2});
  const totalValue = localPortfolio.cash + stockValue;
  const profit = totalValue - 10000;
  const pnlEl = document.getElementById('portfolioPnL');
  pnlEl.textContent = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${((profit/10000)*100).toFixed(2)}%)`;
  pnlEl.className = profit >= 0 ? 'up' : 'down';

  const ctx = document.getElementById('diversificationChart');
  if (ctx) {
    if (pieChart) { pieChart.data.labels = pieData.map(d => d.label); pieChart.data.datasets[0].data = pieData.map(d => d.value); pieChart.update(); } 
    else { pieChart = new Chart(ctx, { type: 'doughnut', data: { labels: pieData.map(d => d.label), datasets: [{ data: pieData.map(d => d.value), backgroundColor: ['#58a6ff','#238636','#da3633','#e3b341','#a371f7'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#c9d1d9' } } } } }); }
  }
}

async function sellFromPortfolio(symbol) {
  const market = findMarketForSymbol(symbol);
  try {
    const q = await fetch(`/api/quote/${market}/${symbol}`).then(r => r.json());
    if (q && q.price) allQuotes[symbol] = q;
  } catch(e) {}
  currentMainSymbol = symbol;
  currentMainMarket = market;
  document.getElementById('mainTicker').textContent = symbol.replace('BINANCE:', '').replace('USDT', '');
  switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn'));
  loadMainStock(symbol, symbol, market);
  openTradeModal('sell');
}

async function fetchPortfolioQuotes() {
  if (isFetchingQuotes) return;
  const holdings = Object.keys(localPortfolio.holdings); 
  if (holdings.length === 0) return;
  isFetchingQuotes = true;
  for (const sym of holdings) { 
    try { 
      const market = findMarketForSymbol(sym);
      const q = await fetch(`/api/quote/${market}/${sym}`).then(r => r.json()); 
      if (q && q.price) allQuotes[sym] = q; 
    } catch(e) {} 
  }
  isFetchingQuotes = false;
  updatePortfolioUI();
}

// Тепловая карта
async function loadHeatmap(market) {
  const container = document.getElementById('heatmapContainer');
  const titleSpan = document.getElementById('heatmapMarketName');
  const marketNames = { US: 'США', EU: 'Европа', RU: 'Россия', CRYPTO: 'Крипта', FOREX: 'Валюты' };
  if (titleSpan) titleSpan.textContent = `(${marketNames[market] || market})`;
  if (!container) return;
  container.innerHTML = '<div style="color:#8b949e; width:100%; text-align:center; padding:20px;">Загрузка...</div>';

  try {
    const data = await fetch(`/api/heatmap/${market}`).then(r => r.json());
    if (!data || data.length === 0) {
      container.innerHTML = '<div style="color:#8b949e; width:100%; text-align:center; padding:20px;">Нет данных</div>';
      return;
    }
    container.innerHTML = data.map(d => {
      const intensity = Math.min(Math.abs(d.percent) / 3, 1);
      const bgColor = d.percent >= 0 ? `rgba(35, 134, 54, ${0.3 + intensity * 0.7})` : `rgba(218, 54, 51, ${0.3 + intensity * 0.7})`;
      const displaySymbol = d.symbol.replace('BINANCE:', '').replace('USDT', '');
      const percentText = (d.percent > 0 ? '+' : '') + d.percent.toFixed(2) + '%';
      return `
        <div class="heat-tile" style="background:${bgColor};" onclick="loadMainStock('${d.symbol}', '${d.symbol}', '${market}'); switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn')); window.scrollTo(0,0);">
          <div class="heat-symbol">${displaySymbol}</div>
          <div>${percentText}</div>
          <div class="heat-price">$${d.price ? d.price.toFixed(2) : '—'}</div>
          <div class="tooltip-text">${displaySymbol} • ${percentText}<br>Цена: $${d.price ? d.price.toFixed(2) : '—'}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--down); width:100%; text-align:center; padding:20px;">Ошибка загрузки</div>';
  }
}

// Сделки и Ордера
function openTradeModal(type) {
  document.getElementById('tradeModal').style.display = 'block'; 
  document.getElementById('tradeTitle').textContent = type === 'buy' ? `Купить ${currentMainSymbol.replace('BINANCE:', '').replace('USDT', '')}` : `Продать ${currentMainSymbol.replace('BINANCE:', '').replace('USDT', '')}`;
  document.getElementById('tradePrice').textContent = allQuotes[currentMainSymbol]?.price?.toFixed(2) || '0.00'; 
  document.getElementById('tradeShares').value = '';
  document.getElementById('tradeSubmitBtn').onclick = () => executeTrade(type);
}

function executeTrade(type) {
  const shares = parseFloat(document.getElementById('tradeShares').value), price = allQuotes[currentMainSymbol]?.price;
  if (!shares || shares <= 0 || !price) return alert('Ошибка ввода'); 
  const totalCost = shares * price;
  if (type === 'buy') {
    if (localPortfolio.cash < totalCost) return alert('Мало денег!');
    localPortfolio.cash -= totalCost;
    if (!localPortfolio.holdings[currentMainSymbol]) localPortfolio.holdings[currentMainSymbol] = { shares: 0, totalCost: 0 };
    localPortfolio.holdings[currentMainSymbol].shares += shares; 
    localPortfolio.holdings[currentMainSymbol].totalCost += totalCost;
    localPortfolio.history.push({ date: new Date().toISOString(), type: 'BUY', symbol: currentMainSymbol, shares, price, total: totalCost });
  } else {
    if (!localPortfolio.holdings[currentMainSymbol] || localPortfolio.holdings[currentMainSymbol].shares < shares) return alert('Мало акций!');
    localPortfolio.cash += totalCost; 
    localPortfolio.holdings[currentMainSymbol].shares -= shares;
    localPortfolio.history.push({ date: new Date().toISOString(), type: 'SELL', symbol: currentMainSymbol, shares, price, total: totalCost });
    if (localPortfolio.holdings[currentMainSymbol].shares === 0) delete localPortfolio.holdings[currentMainSymbol];
  }
  localStorage.setItem('portfolio', JSON.stringify(localPortfolio)); 
  closeModal('tradeModal'); 
  fetchPortfolioQuotes(); 
  updatePortfolioUI(); 
  syncPortfolio();
}

function openLimitModal() {
  document.getElementById('limitModal').style.display = 'block';
  document.getElementById('limitSymbol').textContent = currentMainSymbol.replace('BINANCE:', '').replace('USDT', '');
  document.getElementById('limitTargetPrice').value = allQuotes[currentMainSymbol]?.price?.toFixed(2) || '';
  document.getElementById('limitShares').value = '';
}

async function submitLimitOrder() {
  if (!currentUser) return alert('Войдите в аккаунт!');
  const type = document.getElementById('limitType').value;
  const target = parseFloat(document.getElementById('limitTargetPrice').value);
  const shares = parseInt(document.getElementById('limitShares').value);
  if (!target || !shares || shares <= 0) return alert('Заполните поля!');
  await fetch('/api/orders', {
    method: 'POST', 
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ email: currentUser.email, symbol: currentMainSymbol, type, target_price: target, shares, market: currentMainMarket })
  });
  closeModal('limitModal'); 
  alert('Заявка создана!');
}

async function loadOrders() {
  if (!currentUser) return;
  const orders = await fetch(`/api/orders/${currentUser.email}`).then(r => r.json());
  const tbody = document.querySelector('#ordersTable tbody');
  if(orders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Нет активных заявок</td></tr>';
      return;
  }
  tbody.innerHTML = orders.map(o => {
    const date = new Date(o.created_at).toLocaleString('ru-RU');
    const statusText = o.status === 'PENDING' ? 'Ожидает' : (o.status === 'FILLED' ? 'Исполнена' : 'Отменена');
    const statusColor = o.status === 'PENDING' ? '#e3b341' : (o.status === 'FILLED' ? 'var(--up)' : 'var(--down)');
    const cancelBtn = o.status === 'PENDING' ? `<button class="btn-small btn-sell" onclick="cancelOrder(${o.id})">Отменить</button>` : '—';
    return `<tr>
      <td>${date}</td><td><b>${o.symbol.replace('BINANCE:', '').replace('USDT', '')}</b></td>
      <td>${o.type === 'buy' ? 'Покупка' : 'Продажа'}</td><td>${o.shares}</td>
      <td>$${o.target_price.toFixed(2)}</td><td style="color:${statusColor};">${statusText}</td><td>${cancelBtn}</td>
    </tr>`;
  }).join('');
}

async function cancelOrder(id) { 
  await fetch(`/api/orders/${id}`, { method: 'DELETE' }); 
  loadOrders(); 
}

// Авторизация и Лидерборд
function processAuth(data) {
  currentUser = data; 
  localStorage.setItem('currentUser', JSON.stringify(currentUser));
  if (data.portfolio) localPortfolio = data.portfolio; 
  else localPortfolio = { cash: 10000, holdings: {}, history: [] };
  localStorage.setItem('portfolio', JSON.stringify(localPortfolio));
  closeModal('authModal'); 
  checkAuth(); 
  updatePortfolioUI(); 
  fetchPortfolioQuotes(); 
  syncPortfolio();
}

function register() {
  const email = document.getElementById('authEmail').value.trim(), password = document.getElementById('authPassword').value.trim(), username = document.getElementById('authUsername').value.trim();
  if (!email || !password || !username) return alert('Заполните все поля!');
  fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password, username }) })
  .then(r => r.json()).then(data => { if (data.error) return alert(data.error); processAuth(data); });
}

function login() {
  const email = document.getElementById('authEmail').value.trim(), password = document.getElementById('authPassword').value.trim();
  if (!email || !password) return alert('Введите Email и пароль!');
  fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password }) })
  .then(r => r.json()).then(data => { if (data.error) return alert(data.error); processAuth(data); });
}

function logout() { currentUser = null; localStorage.removeItem('currentUser'); checkAuth(); }

function checkAuth() {
  if (currentUser) { 
    document.getElementById('loginBtn').style.display = 'none'; 
    document.getElementById('userInfo').style.display = 'block'; 
    document.getElementById('displayUsername').textContent = currentUser.username; 
  } else { 
    document.getElementById('loginBtn').style.display = 'block'; 
    document.getElementById('userInfo').style.display = 'none'; 
  }
}

function syncPortfolio() { 
  if (!currentUser) return; 
  fetch('/api/update-portfolio', { 
    method: 'POST', 
    headers: {'Content-Type': 'application/json'}, 
    body: JSON.stringify({ email: currentUser.email, portfolio: localPortfolio, returnPercent: calcReturnPercent() }) 
  }); 
}

async function loadLeaderboard() {
  const users = await fetch('/api/leaderboard').then(r => r.json()); 
  const tbody = document.querySelector('#leaderboardTable tbody');
  if (!users || users.length === 0) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Пусто</td></tr>'; return; }
  tbody.innerHTML = users.map((u, i) => {
    const isMe = currentUser && u.email === currentUser.email;
    return `<tr style="${isMe ? 'background: rgba(88, 166, 255, 0.1);' : ''}">
      <td>#${i+1}</td><td>${u.username} ${isMe ? '(Вы)' : ''}</td>
      <td class="${u.return_percent >= 0 ? 'up' : 'down'}">${(u.return_percent || 0).toFixed(2)}%</td><td>${u.badges ? u.badges.join(' ') : '—'}</td>
    </tr>`;
  }).join('');
}

// Новости, Избранное, Профиль, Поиск
async function loadNews() {
  const container = document.getElementById('newsList'); 
  container.innerHTML = 'Загрузка...';
  try {
    const news = await fetch('/api/news').then(r => r.json());
    container.innerHTML = news.map(n => `
      <div class="news-item" style="display:flex; gap:10px; margin-bottom:10px; border-bottom:1px solid #30363d; padding-bottom:10px;">
        ${n.image ? `<img src="${n.image}" style="width:60px; height:60px; border-radius:6px; object-fit:cover;">` : ''}
        <div><a href="${n.url}" target="_blank" style="color:#c9d1d9; font-size:13px; text-decoration:none;">${n.headline}</a></div>
      </div>
    `).join('');
  } catch(e) { container.innerHTML = 'Нет новостей'; }
}

function toggleFavorite(symbol) {
  if (favorites.includes(symbol)) { favorites = favorites.filter(f => f !== symbol); document.getElementById('mainStarBtn').classList.remove('active'); } 
  else { favorites.push(symbol); document.getElementById('mainStarBtn').classList.add('active'); }
  localStorage.setItem('favorites', JSON.stringify(favorites)); 
  renderFavorites();
}

async function renderFavorites() {
  const container = document.getElementById('favoritesContainer'); 
  if(!container) return;
  container.innerHTML = favorites.length ? '' : '<p style="color:#8b949e">Пусто</p>';
  favorites.forEach((sym, i) => { 
    const market = findMarketForSymbol(sym);
    const stock = allMarkets[market].find(s => s.symbol === sym); 
    if (stock) createCard(stock, market, container, i); 
  });
}

function openProfile() {
  if (!currentUser) return;
  document.getElementById('profUsername').textContent = currentUser.username; 
  document.getElementById('profEmail').textContent = currentUser.email;
  document.getElementById('profReturn').textContent = document.getElementById('portfolioPnL').textContent; 
  document.getElementById('profReturn').className = document.getElementById('portfolioPnL').className;
  document.getElementById('profCash').textContent = document.getElementById('cashBalance').textContent;
  openModal('profileModal');
}

const searchInput = document.getElementById('symbolInput'), autoList = document.getElementById('autocompleteList');
searchInput.addEventListener('input', function() {
  const val = this.value.toUpperCase(); autoList.innerHTML = ''; if (!val) { autoList.style.display = 'none'; return; }
  let allSymbols = [];
  for (const [market, list] of Object.entries(allMarkets)) list.forEach(item => allSymbols.push({ ...item, market }));
  const matches = allSymbols.filter(s => s.symbol.replace('BINANCE:', '').replace('USDT', '').includes(val) || s.name.toUpperCase().includes(val)).slice(0, 8);
  matches.forEach(m => { 
    const div = document.createElement('div'); 
    const cleanSym = m.symbol.replace('BINANCE:', '').replace('USDT', '');
    div.innerHTML = `<b>${cleanSym}</b> - ${m.name} <span style="color:#58a6ff; font-size:12px;">(${m.market})</span>`; 
    div.onclick = () => { searchInput.value = cleanSym; autoList.style.display = 'none'; loadMainStock(m.symbol, m.name, m.market); }; 
    autoList.appendChild(div); 
  });
  autoList.style.display = matches.length ? 'block' : 'none';
});
document.addEventListener('click', (e) => { if (e.target !== searchInput) autoList.style.display = 'none'; });

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function openModal(id) { document.getElementById(id).style.display = 'block'; }

window.onload = async () => {
  checkAuth(); 
  allMarkets = await fetch('/api/watchlist').then(r=>r.json());
  loadNews(); 
  loadMainStock('AAPL', 'Apple Inc.', 'US'); 
  await fetchPortfolioQuotes(); 
  updatePortfolioUI();
  if (currentUser) syncPortfolio();
  
  switchMarket('US', document.querySelector('.market-btn'));
  setInterval(fetchPortfolioQuotes, 30000); // Автообновление портфеля для не-US рынков
};