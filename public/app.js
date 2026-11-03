let currentMainSymbol = 'AAPL';
let mainChart = null;
let allStocks = [];
let allQuotes = {};
let gaugeChart = null;
let pieChart = null;
let currentUser = localStorage.getItem('username') || null;
let localPortfolio = JSON.parse(localStorage.getItem('portfolio')) || { cash: 10000, holdings: {}, history: [] };

let ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
ws.onmessage = (e) => {
  const { symbol, price } = JSON.parse(e.data);
  if (!allQuotes[symbol]) allQuotes[symbol] = {}; // Защита от ошибки
  allQuotes[symbol].price = price;
  
  if (symbol === currentMainSymbol) document.getElementById('mainPrice').textContent = price.toFixed(2);
  updatePortfolioUI();
};

// ИСПРАВЛЕННОЕ ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  if (btn) btn.classList.add('active'); // Подсвечиваем кнопку, на которую нажали
  if (tabId === 'leaderboard') loadLeaderboard();
}

// ОСТАЛЬНОЙ КОД...
async function loadMainStock(symbol, name) {
  currentMainSymbol = symbol;
  document.getElementById('mainTicker').textContent = symbol;
  document.getElementById('mainCompany').textContent = name || symbol;
  
  loadMainChart('price');
  loadFairValue(symbol);
  loadTechRadar(symbol);

  try {
    const q = await fetch('/api/quote/' + symbol).then(r => r.json());
    allQuotes[symbol] = q;
    document.getElementById('mainPrice').textContent = q.price ? q.price.toFixed(2) : '—';
    const ch = document.getElementById('mainChange');
    ch.textContent = (q.change >= 0 ? '+' : '') + (q.change?.toFixed(2) || 0) + ' (' + (q.percent?.toFixed(2) || 0) + '%)';
    ch.className = 'change ' + (q.change >= 0 ? 'up' : 'down');

    const f = await fetch('/api/fundamentals/' + symbol).then(r => r.json());
    const metrics = [{label:'P/E',v:f.pe,b:15,inv:false},{label:'P/S',v:f.ps,b:3,inv:false},{label:'EV/EBITDA',v:f.evEbitda,b:8,inv:false},{label:'ROE',v:f.roe,b:10,inv:false},{label:'Debt/EBITDA',v:f.debtEbitda,b:2.5,inv:true}];
    document.getElementById('fundamentalData').innerHTML = metrics.map(m => {
      if (m.v == null) return `<div class="metric na"><span>${m.label}</span><span>—</span></div>`;
      const good = m.inv ? m.v < m.b : m.v > m.b;
      return `<div class="metric ${good?'good':'bad'}"><span>${m.label}</span><span>${Number(m.v).toFixed(2)}</span></div>`;
    }).join('');
  } catch(e) { console.error("Ошибка загрузки главной акции", e); }
}

async function loadFairValue(symbol) {
  const fv = await fetch('/api/fair-value/' + symbol).then(r => r.json());
  const box = document.getElementById('fairValueBox');
  if (!fv.fair) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  let cls = 'fair-value-box', text = '';
  if (fv.diff > 10) { cls += ' under'; text = `🟢 Недооценена на ${fv.diff.toFixed(1)}%`; }
  else if (fv.diff < -10) { cls += ' over'; text = `🔴 Переоценена на ${Math.abs(fv.diff).toFixed(1)}%`; }
  else { text = `⚪ Справедливая цена (отклонение ${fv.diff.toFixed(1)}%)`; }
  box.className = cls;
  box.innerHTML = `<b>Текущая цена:</b> $${fv.current.toFixed(2)} | <b>Справедливая:</b> $${fv.fair.toFixed(2)}<br><span style="font-weight:bold">${text}</span>`;
}

async function loadTechRadar(symbol) {
  const tr = await fetch('/api/tech-radar/' + symbol).then(r => r.json());
  document.getElementById('radarVerdict').textContent = tr.verdict;
  document.getElementById('radarVerdict').style.color = tr.score > 0 ? 'var(--up)' : tr.score < 0 ? 'var(--down)' : '#8b949e';

  if (gaugeChart) gaugeChart.destroy();
  gaugeChart = new CanvasJS.Chart("gaugeContainer", {
    theme: "dark2", backgroundColor: "transparent",
    data: [{
      type: "doughnut", startAngle: -90, endAngle: 90, radius: "100%",
      dataPoints: [
        { y: 33, color: "#da3633" }, { y: 34, color: "#8b949e" }, { y: 33, color: "#238636" }
      ]
    }]
  });
  gaugeChart.render();
}

async function loadMainChart(type) {
  document.getElementById('mainChart').innerHTML = '';
  if (mainChart) mainChart.destroy();
  if (type === 'price') {
    const res = await fetch('/api/candles/' + currentMainSymbol).then(r => r.json());
    const pts = res.candles.map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    mainChart = new CanvasJS.StockChart("mainChart", {
      theme: "dark2", backgroundColor: "transparent",
      charts: [{ data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] }],
      navigator: { enabled: true }
    });
  } else {
    // ИСПРАВЛЕНО: Используем эндпоинт historical-pe
    const res = await fetch('/api/historical-pe/' + currentMainSymbol).then(r => r.json());
    const pts = res.map(p => ({ x: new Date(p.x), y: p.y }));
    mainChart = new CanvasJS.Chart("mainChart", {
      theme: "dark2", backgroundColor: "transparent",
      title: { text: "Динамика P/E (1 год)", fontColor: "#8b949e" },
      data: [{ type: "line", dataPoints: pts, color: "#58a6ff", markerSize: 0 }]
    });
  }
  mainChart.render();
}

function openTradeModal(type) {
  document.getElementById('tradeModal').style.display = 'block';
  document.getElementById('tradeTitle').textContent = type === 'buy' ? `Купить ${currentMainSymbol}` : `Продать ${currentMainSymbol}`;
  document.getElementById('tradePrice').textContent = allQuotes[currentMainSymbol]?.price?.toFixed(2) || '0.00';
  document.getElementById('tradeShares').value = '';
  document.getElementById('tradeSubmitBtn').onclick = () => executeTrade(type);
}

function executeTrade(type) {
  const shares = parseFloat(document.getElementById('tradeShares').value);
  const price = allQuotes[currentMainSymbol]?.price;
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
  updatePortfolioUI();
  syncPortfolio();
}

function calcReturnPercent() {
  let stockValue = 0, totalCost = 0;
  for (const [sym, data] of Object.entries(localPortfolio.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    stockValue += currPrice * data.shares;
    totalCost += data.totalCost;
  }
  if (totalCost === 0) return 0;
  return ((stockValue - totalCost) / totalCost) * 100;
}

function updatePortfolioUI() {
  document.getElementById('cashBalance').textContent = '$' + localPortfolio.cash.toLocaleString('en-US', {minimumFractionDigits: 2});
  let stockValue = 0, totalCost = 0;
  const tbody = document.querySelector('#holdingsTable tbody');
  tbody.innerHTML = '';
  const pieData = [{ label: 'Cash', value: localPortfolio.cash }];

  for (const [sym, data] of Object.entries(localPortfolio.holdings)) {
    const currPrice = allQuotes[sym]?.price || 0;
    const val = currPrice * data.shares;
    const cost = data.totalCost;
    const pnl = val - cost;
    stockValue += val; totalCost += cost;
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
  const totalPnL = stockValue - totalCost;
  document.getElementById('portfolioPnL').textContent = `$${totalPnL.toFixed(2)}`;
  document.getElementById('portfolioPnL').className = totalPnL >= 0 ? 'up' : 'down';

  if (pieChart) pieChart.destroy();
  const ctx = document.getElementById('diversificationChart');
  if (ctx) {
    pieChart = new Chart(ctx, {
      type: 'doughnut',
      data: { labels: pieData.map(d => d.label), datasets: [{ data: pieData.map(d => d.value), backgroundColor: ['#58a6ff','#238636','#da3633','#e3b341','#a371f7','#8b949e','#f0883e'] }] },
      options: { plugins: { legend: { labels: { color: '#c9d1d9' } } } }
    });
  }
}

function exportCSV() {
  let csv = "Дата,Тип,Тикер,Кол-во,Цена,Итого\n";
  localPortfolio.history.forEach(h => { csv += `${h.date},${h.type},${h.symbol},${h.shares},${h.price.toFixed(2)},${h.total.toFixed(2)}\n`; });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "report.csv"; link.click();
}

async function loadLeaderboard() {
  const users = await fetch('/api/leaderboard').then(r => r.json());
  document.querySelector('#leaderboardTable tbody').innerHTML = users.map((u, i) => `
    <tr>
      <td>#${i+1}</td><td>${u.username} ${u.username === currentUser ? '(Вы)' : ''}</td>
      <td class="${u.returnPercent >= 0 ? 'up' : 'down'}">${u.returnPercent > 0 ? '+' : ''}${u.returnPercent.toFixed(2)}%</td>
      <td>${u.badges.join(' ')}</td>
    </tr>
  `).join('');
}

async function loadHeatmap() {
  const data = await fetch('/api/heatmap').then(r => r.json());
  document.getElementById('heatmapContainer').innerHTML = data.map(d => {
    const color = d.percent > 0 ? `rgba(35, 134, 54, ${Math.min(Math.abs(d.percent)/5, 1)})` : `rgba(218, 54, 51, ${Math.min(Math.abs(d.percent)/5, 1)})`;
    const size = Math.min(Math.max(d.marketCap / 1000000, 1), 3); 
    return `<div class="heat-tile" style="background:${color}; flex-grow: ${size};" onclick="loadMainStock('${d.symbol}', '${d.symbol}')">
      <div class="heat-symbol">${d.symbol}</div><div>${d.percent > 0 ? '+' : ''}${d.percent.toFixed(2)}%</div>
    </div>`;
  }).join('');
}

async function loadNews() {
  const container = document.getElementById('newsList');
  container.innerHTML = Array(4).fill(0).map(() => `<div class="skeleton-item"><div class="skeleton-img"></div><div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>`).join('');
  try {
    const news = await fetch('/api/news').then(r => r.json());
    container.innerHTML = news.map(n => `<div class="news-item">${n.image ? `<img src="${n.image}" class="news-img">` : ''}<div><a href="${n.url}" target="_blank">${n.headline}</a><div style="font-size:11px;color:#8b949e;margin-top:4px;">CNBC • ${new Date(n.datetime*1000).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</div></div></div>`).join('');
  } catch(e) { container.innerHTML = '<p>Ошибка новостей</p>'; }
}

window.onload = async () => {
  checkAuth();
  allStocks = await fetch('/api/watchlist').then(r=>r.json());
  loadNews(); loadHeatmap(); loadMainStock('AAPL', 'Apple Inc.'); updatePortfolioUI();

  const container = document.getElementById('watchlistContainer');
  for (let i = 0; i < allStocks.length; i++) {
    const div = document.createElement('div');
    div.className = 'watchlist-item' + (i >= 12 ? ' hidden' : '');
    div.id = 'card-' + allStocks[i].symbol;
    div.onclick = () => { loadMainStock(allStocks[i].symbol, allStocks[i].name); switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn')); window.scrollTo(0,0); };
    div.innerHTML = `<div class="wl-header"><div><div class="wl-symbol">${allStocks[i].symbol}</div><div class="wl-company">${allStocks[i].name}</div></div><div><div class="wl-price" id="wl-price-${allStocks[i].symbol}">—</div><div class="wl-change" id="wl-change-${allStocks[i].symbol}">—</div></div></div><div class="wl-chart" id="wl-chart-${allStocks[i].symbol}"></div>`;
    container.appendChild(div);
    if (i < 12) loadMiniChart(allStocks[i].symbol);
  }
};

function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function openModal(id) { document.getElementById(id).style.display = 'block'; }
function showMoreStocks() {
  const hidden = document.querySelectorAll('#watchlistContainer .watchlist-item.hidden');
  let count = 0;
  hidden.forEach(el => { if (count < 12) { el.classList.remove('hidden'); loadMiniChart(el.id.replace('card-', '')); count++; } });
  if (document.querySelectorAll('#watchlistContainer .watchlist-item.hidden').length === 0) document.getElementById('showMoreBtn').style.display = 'none';
}

async function loadMiniChart(symbol) {
  try {
    const q = await fetch('/api/quote/' + symbol).then(r=>r.json()); allQuotes[symbol] = q;
    document.getElementById(`wl-price-${symbol}`).textContent = q.price ? q.price.toFixed(2) : '—';
    document.getElementById(`wl-change-${symbol}`).textContent = q.percent ? `${q.percent > 0 ? '+' : ''}${q.percent.toFixed(2)}%` : '—';
    const res = await fetch('/api/candles/' + symbol).then(r=>r.json());
    const pts = res.candles.slice(-30).map(p => ({ x: new Date(p.x), y: [p.o, p.h, p.l, p.c] }));
    new CanvasJS.Chart(`wl-chart-${symbol}`, { theme: "dark2", backgroundColor: "transparent", height: 140, padding: 0, axisX: { visible: false }, axisY: { visible: false }, data: [{ type: 'candlestick', dataPoints: pts, risingColor: '#238636', fallingColor: '#da3633' }] }).render();
  } catch(e) {}
}

// АВТОРИЗАЦИЯ (Функции)
function checkAuth() {
  if (currentUser) { document.getElementById('loginBtn').style.display = 'none'; document.getElementById('userInfo').style.display = 'block'; document.getElementById('displayUsername').textContent = currentUser; }
  else { document.getElementById('loginBtn').style.display = 'block'; document.getElementById('userInfo').style.display = 'none'; }
}
function login() {
  const username = document.getElementById('authUsername').value.trim();
  if (!username) return alert('Введите ник');
  fetch('/api/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username}) })
    .then(r => r.json()).then(data => {
      if (data.error) return alert(data.error);
      currentUser = username; localStorage.setItem('username', currentUser);
      closeModal('authModal'); checkAuth(); syncPortfolio();
    });
}
function logout() { currentUser = null; localStorage.removeItem('username'); checkAuth(); }
function syncPortfolio() {
  if (!currentUser) return;
  fetch('/api/update-portfolio', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username: currentUser, portfolio: localPortfolio, returnPercent: calcReturnPercent() }) });
}