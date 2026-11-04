let currentMainSymbol = 'AAPL';
let mainChart = null;
let gaugeChart = null;
let pieChart = null;
let allStocks = [];
let allQuotes = {};

let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;
let localPortfolio = JSON.parse(localStorage.getItem('portfolio')) || { cash: 10000, holdings: {}, history: [] };
let favorites = JSON.parse(localStorage.getItem('favorites')) || [];

// WebSocket
let ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
let updateTimeout = null;

ws.onmessage = (e) => {
  const { symbol, price } = JSON.parse(e.data);
  if (!allQuotes[symbol]) allQuotes[symbol] = {};
  allQuotes[symbol].price = price;
  
  if (symbol === currentMainSymbol) {
    const pEl = document.getElementById('mainPrice');
    if (pEl) pEl.textContent = price.toFixed(2);
  }
  const miniPriceEl = document.getElementById(`wl-price-${symbol}`);
  if (miniPriceEl) miniPriceEl.textContent = price.toFixed(2);

  // Плавное обновление портфеля
  if (updateTimeout) return;
  updateTimeout = setTimeout(() => {
    updatePortfolioUI();
    updateTimeout = null;
  }, 1000);
};

// app.js
function switchTab(tabId, btn) {
  // ... (ваш существующий код)
  if (tabId === 'leaderboard') loadLeaderboard();
  if (tabId === 'favorites') renderFavorites();
  if (tabId === 'portfolio') {
    // ФИКС: Сначала ждем загрузки цен, потом обновляем UI
    fetchPortfolioQuotes().then(() => updatePortfolioUI());
  }
}
// ГЛАВНЫЙ ЭКРАН
async function loadMainStock(symbol, name) {
  currentMainSymbol = symbol;
  document.getElementById('mainTicker').textContent = symbol;
  document.getElementById('mainCompany').textContent = name || symbol;
  document.getElementById('symbolInput').value = symbol;
  
  const starBtn = document.getElementById('mainStarBtn');
  if (favorites.includes(symbol)) starBtn.classList.add('active');
  else starBtn.classList.remove('active');

  loadMainChart('price');
  loadFairValue(symbol);
  loadTechRadar(symbol);

  try {
    const q = await fetch('/api/quote/' + symbol).then(r => r.json());
    allQuotes[symbol] = q;
    document.getElementById('mainPrice').textContent = q.price ? q.price.toFixed(2) : '—';
    const ch = document.getElementById('mainChange');
    const changeVal = q.change || 0;
    ch.textContent = (changeVal >= 0 ? '+' : '') + changeVal.toFixed(2) + ' (' + (q.percent || 0).toFixed(2) + '%)';
    ch.className = 'change ' + (changeVal >= 0 ? 'up' : 'down');

    const f = await fetch('/api/fundamentals/' + symbol).then(r => r.json());
    const fMetrics = [
      { label: 'P/E', v: f.pe, b: 15, inv: false }, { label: 'P/S', v: f.ps, b: 3, inv: false },
      { label: 'EV/EBITDA', v: f.evEbitda, b: 8, inv: false }, { label: 'ROE', v: f.roe, b: 10, inv: false },
      { label: 'Debt/EBITDA', v: f.debtEbitda, b: 2.5, inv: true }
    ];
    document.getElementById('fundamentalData').innerHTML = fMetrics.map(m => {
      if (m.v == null) return `<div class="metric na"><span>${m.label}</span><span>—</span></div>`;
      const good = m.inv ? m.v < m.b : m.v > m.b;
      return `<div class="metric ${good ? 'good' : 'bad'}"><span>${m.label}</span><span>${Number(m.v).toFixed(2)}</span></div>`;
    }).join('');

    const c = await fetch('/api/candles/' + symbol).then(r => r.json());
    const ind = c.indicators;
    let rsiClass = ind.rsi > 70 ? 'bad' : (ind.rsi < 30 ? 'good' : '');
    document.getElementById('technicalData').innerHTML = `
      <div class="metric ${rsiClass}"><span>RSI (14)</span><span>${ind.rsi ? ind.rsi.toFixed(2) : '—'}</span></div>
      <div class="metric"><span>MACD</span><span>${ind.macd ? ind.macd.toFixed(3) : '—'}</span></div>
      <div class="metric"><span>MACD Signal</span><span>${ind.macdSignal ? ind.macdSignal.toFixed(3) : '—'}</span></div>
      <div class="metric"><span>Volume</span><span>${ind.volume ? ind.volume.toLocaleString('ru-RU') : '—'}</span></div>
    `;
  } catch(e) { console.error(e); }
}

// 🔥 НОВАЯ ФУНКЦИЯ: Загружает цены для активов в портфеле
// app.js
let isFetchingQuotes = false; // Флаг для защиты от параллельных запросов

async function fetchPortfolioQuotes() {
  if (isFetchingQuotes) return;
  const holdings = Object.keys(localPortfolio.holdings);
  if (holdings.length === 0) return;

  isFetchingQuotes = true;
  let updated = false;
  
  for (const sym of holdings) {
    try {
      // Всегда запрашиваем свежую цену с сервера (для всех акций портфеля)
      const q = await fetch('/api/quote/' + sym).then(r => r.json());
      if (q && q.price) {
        allQuotes[sym] = q;
        updated = true;
      }
    } catch(e) { console.error('Ошибка загрузки цены для ' + sym); }
  }
  
  isFetchingQuotes = false;
  if (updated) updatePortfolioUI();
}
function calcReturnPercent() {
  let stockValue = 0;
  for (const [sym, data] of Object.entries(localPortfolio.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    stockValue += currPrice * data.shares;
  }
  const totalValue = localPortfolio.cash + stockValue;
  return ((totalValue - 10000) / 10000) * 100;
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
    pieData.push({ label: sym, value: val });

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${sym}</b></td><td>${data.shares}</td>
      <td>$${(cost/data.shares).toFixed(2)}</td><td>$${currPrice.toFixed(2)}</td>
      <td>$${val.toFixed(2)}</td><td class="${pnl>=0?'up':'down'}">$${pnl.toFixed(2)}</td>
      <td><button class="btn-small btn-sell" onclick="loadMainStock('${sym}'); openTradeModal('sell')">Продать</button></td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('portfolioValue').textContent = '$' + stockValue.toLocaleString('en-US', {minimumFractionDigits: 2});
  
  const totalValue = localPortfolio.cash + stockValue;
  const profit = totalValue - 10000;
  const returnPercent = (profit / 10000) * 100;
  
  const pnlEl = document.getElementById('portfolioPnL');
  pnlEl.textContent = `${profit >= 0 ? '+' : ''}$${profit.toFixed(2)} (${returnPercent.toFixed(2)}%)`;
  pnlEl.className = profit >= 0 ? 'up' : 'down';

  const ctx = document.getElementById('diversificationChart');
  if (ctx) {
    // Если все активы по нулям (загружаются), диаграмма покажет только кэш
    if (pieChart) {
      pieChart.data.labels = pieData.map(d => d.label);
      pieChart.data.datasets[0].data = pieData.map(d => d.value);
      pieChart.update();
    } else {
      pieChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: pieData.map(d => d.label), datasets: [{ data: pieData.map(d => d.value), backgroundColor: ['#58a6ff','#238636','#da3633','#e3b341','#a371f7','#8b949e','#f0883e'], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#c9d1d9' } } } }
      });
    }
  }
}

function openProfile() {
  if (!currentUser) return;
  document.getElementById('profUsername').textContent = currentUser.username;
  document.getElementById('profEmail').textContent = currentUser.email;
  document.getElementById('profReturn').textContent = document.getElementById('portfolioPnL').textContent;
  document.getElementById('profReturn').className = document.getElementById('portfolioPnL').className;
  document.getElementById('profCash').textContent = document.getElementById('cashBalance').textContent;
  document.getElementById('profBadges').textContent = currentUser.badges ? currentUser.badges.join(' ') : '🏅 Начинающий';
  openModal('profileModal');
}

function register() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value.trim();
  const username = document.getElementById('authUsername').value.trim();
  if (!email || !password || !username) return alert('Заполните все поля!');
  
  fetch('/api/auth/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password, username }) })
    .then(r => r.json()).then(data => {
      if (data.error) return alert(data.error);
      currentUser = data; localStorage.setItem('currentUser', JSON.stringify(currentUser));
      closeModal('authModal'); checkAuth(); syncPortfolio();
    });
}

function login() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value.trim();
  if (!email || !password) return alert('Введите Email и пароль!');

  fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email, password }) })
    .then(r => r.json()).then(data => {
      if (data.error) return alert(data.error);
      currentUser = data; localStorage.setItem('currentUser', JSON.stringify(currentUser));
      closeModal('authModal'); checkAuth(); syncPortfolio();
    });
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
  fetch('/api/update-portfolio', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ email: currentUser.email, portfolio: localPortfolio, returnPercent: calcReturnPercent() }) });
}

async function loadMainChart(type) {
  const el = document.getElementById('mainChart'); el.innerHTML = ''; if (mainChart) mainChart.destroy();
  try {
    if (type === 'price') {
      const res = await fetch('/api/candles/' + currentMainSymbol).then(r => r.json());
      const pts = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
      mainChart = new CanvasJS.StockChart("mainChart", { theme: "dark2", backgroundColor: "transparent", charts: [{ data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] }], navigator: { enabled: true, slider: { color: "#30363d" } } });
    } else {
      const res = await fetch('/api/historical-pe/' + currentMainSymbol).then(r => r.json());
      const pts = res.map(p => ({ x: new Date(p.x), y: p.y }));
      mainChart = new CanvasJS.Chart("mainChart", { theme: "dark2", backgroundColor: "transparent", title: { text: "Динамика P/E (1 год)", fontColor: "#8b949e" }, data: [{ type: "line", dataPoints: pts, color: "#58a6ff", markerSize: 0 }] });
    }
    mainChart.render();
  } catch(e) { console.error(e); }
}

async function loadFairValue(symbol) {
  const fv = await fetch('/api/fair-value/' + symbol).then(r => r.json()); const box = document.getElementById('fairValueBox');
  if (!fv.fair) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  let cls = 'fair-value-box', text = '';
  if (fv.diff > 10) { cls += ' under'; text = `🟢 Недооценена на ${fv.diff.toFixed(1)}%`; }
  else if (fv.diff < -10) { cls += ' over'; text = `🔴 Переоценена на ${Math.abs(fv.diff).toFixed(1)}%`; }
  else { text = `⚪ Справедливая цена (отклонение ${fv.diff.toFixed(1)}%)`; }
  box.className = cls; box.innerHTML = `<b>Текущая цена:</b> $${fv.current.toFixed(2)} | <b>Справедливая:</b> $${fv.fair.toFixed(2)}<br><span style="font-weight:bold">${text}</span>`;
}

async function loadTechRadar(symbol) {
  const tr = await fetch('/api/tech-radar/' + symbol).then(r => r.json()); const vEl = document.getElementById('radarVerdict');
  vEl.textContent = tr.verdict; vEl.style.color = tr.score > 0 ? 'var(--up)' : tr.score < 0 ? 'var(--down)' : '#8b949e';
  if (gaugeChart) gaugeChart.destroy();
  gaugeChart = new CanvasJS.Chart("gaugeContainer", { theme: "dark2", backgroundColor: "transparent", data: [{ type: "doughnut", startAngle: -90, endAngle: 90, radius: "100%", dataPoints: [{ y: 33, color: "#da3633" }, { y: 34, color: "#8b949e" }, { y: 33, color: "#238636" }] }] });
  gaugeChart.render();
}

function toggleFavorite(symbol) {
  if (favorites.includes(symbol)) { favorites = favorites.filter(f => f !== symbol); document.getElementById('mainStarBtn').classList.remove('active'); }
  else { favorites.push(symbol); document.getElementById('mainStarBtn').classList.add('active'); }
  localStorage.setItem('favorites', JSON.stringify(favorites)); renderFavorites();
}

async function renderFavorites() {
  const container = document.getElementById('favoritesContainer');
  container.innerHTML = favorites.length ? '' : '<p style="color:#8b949e">Вы пока не добавили акции в избранное.</p>';
  for (const sym of favorites) { const stock = allStocks.find(s => s.symbol === sym); if (stock) createCard(stock, container); }
}

function openTradeModal(type) {
  document.getElementById('tradeModal').style.display = 'block'; document.getElementById('tradeTitle').textContent = type === 'buy' ? `Купить ${currentMainSymbol}` : `Продать ${currentMainSymbol}`;
  document.getElementById('tradePrice').textContent = allQuotes[currentMainSymbol]?.price?.toFixed(2) || '0.00'; document.getElementById('tradeShares').value = '';
  document.getElementById('tradeSubmitBtn').onclick = () => executeTrade(type);
}

function executeTrade(type) {
  const shares = parseFloat(document.getElementById('tradeShares').value); const price = allQuotes[currentMainSymbol]?.price;
  if (!shares || shares <= 0 || !price) return alert('Ошибка ввода'); const totalCost = shares * price;
  if (type === 'buy') {
    if (localPortfolio.cash < totalCost) return alert('Мало денег!');
    localPortfolio.cash -= totalCost;
    if (!localPortfolio.holdings[currentMainSymbol]) localPortfolio.holdings[currentMainSymbol] = { shares: 0, totalCost: 0 };
    localPortfolio.holdings[currentMainSymbol].shares += shares; localPortfolio.holdings[currentMainSymbol].totalCost += totalCost;
    localPortfolio.history.push({ date: new Date().toISOString(), type: 'BUY', symbol: currentMainSymbol, shares, price, total: totalCost });
  } else {
    if (!localPortfolio.holdings[currentMainSymbol] || localPortfolio.holdings[currentMainSymbol].shares < shares) return alert('Мало акций!');
    localPortfolio.cash += totalCost; localPortfolio.holdings[currentMainSymbol].shares -= shares;
    localPortfolio.history.push({ date: new Date().toISOString(), type: 'SELL', symbol: currentMainSymbol, shares, price, total: totalCost });
    if (localPortfolio.holdings[currentMainSymbol].shares === 0) delete localPortfolio.holdings[currentMainSymbol];
  }
  localStorage.setItem('portfolio', JSON.stringify(localPortfolio)); 
  closeModal('tradeModal'); 
  fetchPortfolioQuotes(); // <-- Запрашиваем цену купленной акции
  updatePortfolioUI(); 
  syncPortfolio();
}

function exportCSV() {
  let csv = "Дата,Тип,Тикер,Кол-во,Цена,Итого\n";
  localPortfolio.history.forEach(h => { csv += `${h.date},${h.type},${h.symbol},${h.shares},${h.price.toFixed(2)},${h.total.toFixed(2)}\n`; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "report.csv"; link.click();
}

async function loadLeaderboard() {
  const users = await fetch('/api/leaderboard').then(r => r.json());
  document.querySelector('#leaderboardTable tbody').innerHTML = users.map((u, i) => `<tr><td>#${i+1}</td><td>${u.username} ${currentUser && u.email === currentUser.email ? '(Вы)' : ''}</td><td class="${u.returnPercent >= 0 ? 'up' : 'down'}">${u.returnPercent > 0 ? '+' : ''}${u.returnPercent.toFixed(2)}%</td><td>${u.badges.join(' ')}</td></tr>`).join('');
}

async function loadHeatmap() {
  const data = await fetch('/api/heatmap').then(r => r.json());
  document.getElementById('heatmapContainer').innerHTML = data.map(d => {
    const color = d.percent > 0 ? `rgba(35, 134, 54, ${Math.min(Math.abs(d.percent)/5, 1)})` : `rgba(218, 54, 51, ${Math.min(Math.abs(d.percent)/5, 1)})`;
    const size = Math.min(Math.max(d.marketCap / 1000000, 1), 3); 
    return `<div class="heat-tile" style="background:${color}; flex-grow: ${size};" onclick="loadMainStock('${d.symbol}', '${d.symbol}')"><div class="heat-symbol">${d.symbol}</div><div>${d.percent > 0 ? '+' : ''}${d.percent.toFixed(2)}%</div></div>`;
  }).join('');
}

async function loadNews() {
  const container = document.getElementById('newsList');
  container.innerHTML = Array(4).fill(0).map(() => `<div class="skeleton-item"><div class="skeleton-img"></div><div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>`).join('');
  try {
    const news = await fetch('/api/news').then(r => r.json());
    if(!news.length) throw new Error("No news");
    container.innerHTML = news.map(n => `
      <div class="news-item" style="display:flex; gap:10px; margin-bottom:10px; border-bottom:1px solid #30363d; padding-bottom:10px;">
        ${n.image ? `<img src="${n.image}" style="width:60px; height:60px; border-radius:6px; object-fit:cover;">` : ''}
        <div>
          <a href="${n.url}" target="_blank" style="color:#c9d1d9; font-size:13px; text-decoration:none; font-weight:500;">${n.headline}</a>
          <div style="font-size:11px; color:#8b949e; margin-top:4px;">CNBC • ${new Date(n.datetime*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
      </div>
    `).join('');
  } catch(e) { container.innerHTML = '<p>Нет новостей</p>'; }
}

const searchInput = document.getElementById('symbolInput'); const autoList = document.getElementById('autocompleteList');
searchInput.addEventListener('input', function() {
  const val = this.value.toUpperCase(); autoList.innerHTML = ''; if (!val) { autoList.style.display = 'none'; return; }
  const matches = allStocks.filter(s => s.symbol.includes(val) || s.name.toUpperCase().includes(val)).slice(0, 8);
  matches.forEach(m => { const div = document.createElement('div'); div.innerHTML = `<b>${m.symbol}</b> - ${m.name}`; div.onclick = () => { searchInput.value = m.symbol; autoList.style.display = 'none'; loadMainStock(m.symbol, m.name); }; autoList.appendChild(div); });
  autoList.style.display = matches.length ? 'block' : 'none';
});
document.addEventListener('click', (e) => { if (e.target !== searchInput) autoList.style.display = 'none'; });

async function createCard(stock, container) {
  const div = document.createElement('div'); div.className = 'watchlist-item'; div.id = 'card-' + stock.symbol;
  div.onclick = () => { loadMainStock(stock.symbol, stock.name); switchTab('dashboard', document.querySelector('.tab-btn')); window.scrollTo(0,0); };
  div.innerHTML = `<div class="wl-header"><div><div class="wl-symbol">${stock.symbol}</div><div class="wl-company">${stock.name}</div></div><div><div class="wl-price" id="wl-price-${stock.symbol}">—</div><div class="wl-change" id="wl-change-${stock.symbol}">—</div></div></div><div class="wl-chart" id="wl-chart-${stock.symbol}"></div>`;
  container.appendChild(div); loadMiniChart(stock.symbol);
}

async function loadMiniChart(symbol) {
  try {
    const q = await fetch('/api/quote/' + symbol).then(r=>r.json()); allQuotes[symbol] = q;
    const pEl = document.getElementById(`wl-price-${symbol}`); const cEl = document.getElementById(`wl-change-${symbol}`);
    if (pEl) pEl.textContent = q.price ? q.price.toFixed(2) : '—';
    if (cEl) { 
      cEl.textContent = q.percent ? `${q.percent > 0 ? '+' : ''}${q.percent.toFixed(2)}%` : '—'; 
      cEl.className = 'wl-change ' + (q.percent >= 0 ? 'up' : 'down');
    }
    const res = await fetch('/api/candles/' + symbol).then(r=>r.json());
    const pts = res.candles.slice(-30).map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    const chartEl = document.getElementById(`wl-chart-${symbol}`);
    if (chartEl) { 
        chartEl.innerHTML = '';
        new CanvasJS.Chart(`wl-chart-${symbol}`, { 
            theme: "dark2", backgroundColor: "transparent", height: 120, width: chartEl.clientWidth, padding: 0, 
            axisX: { visible: false }, axisY: { visible: false }, 
            data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] 
        }).render(); 
    }
  } catch(e) {}
}

// app.js
let portfolioTimer = null; // Храним ID таймера

window.onload = async () => {
  checkAuth(); 
  allStocks = await fetch('/api/watchlist').then(r=>r.json());
  loadNews(); loadHeatmap(); loadMainStock('AAPL', 'Apple Inc.'); 
  
  await fetchPortfolioQuotes();
  updatePortfolioUI(); 
  renderFavorites();

  // ФИКС: Очищаем старый таймер, если он был, и запускаем новый
  if (portfolioTimer) clearInterval(portfolioTimer);
  portfolioTimer = setInterval(fetchPortfolioQuotes, 30000); // Раз в 30 секунд

  const container = document.getElementById('watchlistContainer');
  // ... остальной код for-loop
};

function showMoreStocks() {
  const hidden = document.querySelectorAll('#watchlistContainer .watchlist-item.hidden');
  let count = 0;
  hidden.forEach(el => { if (count < 12) { el.classList.remove('hidden'); loadMiniChart(el.id.replace('card-', '')); count++; } });
  if (document.querySelectorAll('#watchlistContainer .watchlist-item.hidden').length === 0) document.getElementById('showMoreBtn').style.display = 'none';
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function openModal(id) { document.getElementById(id).style.display = 'block'; }