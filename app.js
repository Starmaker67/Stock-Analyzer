'use strict';

/* ============================================================ состояние */

const state = {
  currentMainSymbol: 'AAPL',
  currentMainMarket: 'US',
  currentMarket: 'US',
  markets: { US: [], EU: [], RU: [], CRYPTO: [], FOREX: [] },
  quotes: {},
  user: null,
  portfolio: { cash: 10000, holdings: {}, history: [] },
  favorites: safeParse(localStorage.getItem('favorites'), []),
  fx: { 'RUB:USD': null, 'EUR:USD': null },
  fetchingQuotes: false,
};

let mainChart = null;
let pieChart = null;

function safeParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (_) {
    return fallback;
  }
}

const $ = (id) => document.getElementById(id);
const currencySymbol = (code) => ({ USD: '$', EUR: '€', RUB: '₽', JPY: '¥', GBP: '£' }[code] || '');

function fmtPrice(value) {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (Math.abs(value) >= 1) return value.toFixed(2);
  return value.toFixed(6);
}

function fmtMoney(value, currency = 'USD') {
  if (!Number.isFinite(value)) return '—';
  return `${currencySymbol(currency)}${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function displaySymbol(symbol) {
  return String(symbol).replace(/^BINANCE:/, '').replace(/USDT$/, '');
}

/* ============================================================= WebSocket */

let ws = null;
let wsRetry = 1000;

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(protocol + location.host + '/ws');

  ws.onopen = () => {
    wsRetry = 1000;
    setConnectionState(true);
  };

  ws.onmessage = (event) => {
    try {
      const { symbol, price } = JSON.parse(event.data);
      if (!symbol || !Number.isFinite(price)) return;
      state.quotes[symbol] = { ...(state.quotes[symbol] || {}), price };

      if (symbol === state.currentMainSymbol) {
        const priceEl = $('mainPrice');
        if (priceEl) priceEl.textContent = fmtPrice(price);
      }
      const cardEl = $(`wl-price-${symbol}`);
      if (cardEl) cardEl.textContent = fmtPrice(price);
    } catch (_) {
      /* битое сообщение не должно ломать поток */
    }
  };

  ws.onclose = () => {
    setConnectionState(false);
    setTimeout(connectWs, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 30_000);
  };

  ws.onerror = () => { /* обработчик нужен, иначе браузер шумит в консоли */ };
}

function setConnectionState(online) {
  const banner = $('connBanner');
  if (banner) banner.style.display = online ? 'none' : 'block';
}

/* ================================================================ навигация */

function switchTab(tabId, btn) {
  if ((tabId === 'portfolio' || tabId === 'orders') && !state.user) {
    openModal('authModal');
    return;
  }
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.nav-tabs .tab-btn').forEach((el) => el.classList.remove('active'));
  const target = $(`tab-${tabId}`);
  if (target) target.classList.add('active');
  if (btn) btn.classList.add('active');

  if (tabId === 'leaderboard') loadLeaderboard();
  if (tabId === 'portfolio') { updatePortfolioUI(); fetchPortfolioQuotes(); }
  if (tabId === 'orders') loadOrders();
}

function switchMarket(market, btn) {
  state.currentMarket = market;
  document.querySelectorAll('.market-btn').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderWatchlist();
  loadHeatmap(market);
}

/* =============================================================== watchlist */

function renderWatchlist() {
  const container = $('watchlistContainer');
  if (!container) return;
  container.innerHTML = '';
  const stocks = state.markets[state.currentMarket] || [];
  stocks.slice(0, 12).forEach((stock, index) => createCard(stock, container, index));
  const moreBtn = $('showMoreBtn');
  if (moreBtn) moreBtn.style.display = stocks.length > 12 ? 'block' : 'none';
}

function showMoreStocks() {
  const container = $('watchlistContainer');
  const stocks = state.markets[state.currentMarket] || [];
  const nextBatch = stocks.slice(container.children.length, container.children.length + 12);
  nextBatch.forEach((stock, index) => createCard(stock, container, index));
  if (container.children.length >= stocks.length && $('showMoreBtn')) {
    $('showMoreBtn').style.display = 'none';
  }
}

function createCard(stock, container, index, idPrefix = 'wl') {
  const card = document.createElement('div');
  card.className = 'watchlist-item';
  const symbolId = `${idPrefix}-price-${stock.symbol}`;
  const changeId = `${idPrefix}-change-${stock.symbol}`;
  const analysisId = `${idPrefix}-analysis-${stock.symbol}`;

  card.innerHTML = `
    <div class="wl-header">
      <div>
        <div class="wl-symbol">${esc(displaySymbol(stock.symbol))}</div>
        <div class="wl-company">${esc(stock.name)}</div>
      </div>
      <div>
        <div class="wl-price" id="${esc(symbolId)}">—</div>
        <div class="wl-change" id="${esc(changeId)}">—</div>
      </div>
    </div>
    <div class="wl-analysis" id="${esc(analysisId)}">Загрузка…</div>
  `;

  card.onclick = () => {
    loadMainStock(stock.symbol, stock.name, stock.market || state.currentMarket);
    switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn'));
    window.scrollTo(0, 0);
  };

  container.appendChild(card);
  setTimeout(() => {
    fetchQuoteForCard(stock, idPrefix);
    loadCardAnalysis(stock, idPrefix);
  }, index * 120);
}

async function fetchQuoteForCard(stock, idPrefix = 'wl') {
  try {
    const response = await fetch(`/api/quote/${stock.market || state.currentMarket}/${encodeURIComponent(stock.symbol)}`);
    if (!response.ok) return;
    const quote = await response.json();
    state.quotes[stock.symbol] = quote;

    const priceEl = $(`${idPrefix}-price-${stock.symbol}`);
    const changeEl = $(`${idPrefix}-change-${stock.symbol}`);
    if (priceEl) priceEl.textContent = fmtPrice(quote.price);
    if (changeEl && Number.isFinite(quote.percent)) {
      changeEl.textContent = fmtPercent(quote.percent);
      changeEl.className = `wl-change ${quote.percent >= 0 ? 'up' : 'down'}`;
    }
  } catch (_) {
    /* карточка останется с прочерком */
  }
}

async function loadCardAnalysis(stock, idPrefix = 'wl') {
  const container = $(`${idPrefix}-analysis-${stock.symbol}`);
  if (!container) return;

  try {
    const market = stock.market || state.currentMarket;
    const [radar, fundamentals] = await Promise.all([
      fetch(`/api/tech-radar/${market}/${encodeURIComponent(stock.symbol)}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/fundamentals/${market}/${encodeURIComponent(stock.symbol)}`).then((r) => (r.ok ? r.json() : null)),
    ]);

    const color = radar && radar.score > 0 ? 'var(--up)' : radar && radar.score < 0 ? 'var(--down)' : 'var(--muted)';
    const pe = fundamentals && fundamentals.available && Number.isFinite(fundamentals.pe)
      ? fundamentals.pe.toFixed(2)
      : '—';

    container.innerHTML = `
      <div class="wl-row"><span>Радар</span><span style="color:${color}; font-weight:600;">${esc(radar ? radar.verdict : '—')}</span></div>
      <div class="wl-row"><span>P/E</span><span>${esc(pe)}</span></div>
    `;
  } catch (_) {
    container.innerHTML = '<span class="muted">Нет данных</span>';
  }
}

/* ============================================================ главный экран */

async function loadMainStock(symbol, name, market) {
  state.currentMainSymbol = symbol;
  state.currentMainMarket = market;

  $('mainTicker').textContent = displaySymbol(symbol);
  $('mainCompany').textContent = name || displaySymbol(symbol);
  $('symbolInput').value = displaySymbol(symbol);

  const starBtn = $('mainStarBtn');
  if (starBtn) starBtn.classList.toggle('active', state.favorites.includes(symbol));

  loadMainChart();
  loadTechRadar(symbol, market);

  try {
    const response = await fetch(`/api/quote/${market}/${encodeURIComponent(symbol)}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Нет данных');
    }
    const quote = await response.json();
    state.quotes[symbol] = quote;

    $('mainPrice').textContent = fmtPrice(quote.price);
    const changeEl = $('mainChange');
    const change = Number.isFinite(quote.change) ? quote.change : null;
    const percent = Number.isFinite(quote.percent) ? quote.percent : null;
    changeEl.textContent = `${change !== null ? `${change > 0 ? '+' : ''}${change.toFixed(2)}` : '—'} (${percent !== null ? fmtPercent(percent) : '—'})`;
    changeEl.className = `change ${percent !== null && percent < 0 ? 'down' : 'up'}`;

    const note = $('mainDataNote');
    if (note) {
      const parts = [`${currencySymbol(quote.currency)} ${quote.currency}`];
      if (quote.source) parts.push(quote.source);
      if (quote.delayed) parts.push('задержка');
      if (quote.asOf) parts.push(new Date(quote.asOf).toLocaleString('ru-RU'));
      note.textContent = parts.join(' · ');
    }
  } catch (error) {
    $('mainPrice').textContent = '—';
    $('mainChange').textContent = error.message || 'Нет данных';
    $('mainChange').className = 'change';
  }

  await Promise.all([loadFundamentals(symbol, market), loadTechnical(symbol, market)]);
}

async function loadFundamentals(symbol, market) {
  const container = $('fundamentalData');
  if (!container) return;
  container.innerHTML = '<div class="metric"><span>Загрузка…</span><span></span></div>';

  try {
    const response = await fetch(`/api/fundamentals/${market}/${encodeURIComponent(symbol)}`);
    const data = await response.json();

    if (!data.available) {
      const reason = data.reason === 'not_applicable'
        ? 'Для этого класса активов фундаментальные мультипликаторы не рассчитываются.'
        : 'Источник фундаментальных данных недоступен. Мы не показываем прочерки вместо анализа.';
      container.innerHTML = `<div class="metric na" style="display:block; line-height:1.5;">${esc(reason)}</div>`;
      return;
    }

    // Показываем ровно те метрики, которые вернул источник: без выдуманных «норм»
    // и без подмены EBITDA margin на operating margin.
    const metrics = Array.isArray(data.metrics) ? data.metrics : [];
    if (!metrics.length) {
      container.innerHTML = '<div class="metric na" style="display:block;">Данные не получены</div>';
      return;
    }

    container.innerHTML = metrics.map((metric) => {
      const value = Number.isFinite(metric.value) ? metric.value.toFixed(2) : null;
      const display = value === null ? '—' : metric.unit === '%' ? `${value}%` : `${value}×`;
      return `<div class="metric ${value === null ? 'na' : ''}" data-metric="${metric.key}"><span>${esc(metric.label)}</span><span>${display}</span></div>`;
    }).join('');
  } catch (_) {
    container.innerHTML = '<div class="metric na">Ошибка загрузки</div>';
  }
}

async function loadTechnical(symbol, market) {
  const container = $('technicalData');
  if (!container) return;
  container.innerHTML = '<div class="metric"><span>Загрузка…</span><span></span></div>';

  try {
    const response = await fetch(`/api/candles/${market}/${encodeURIComponent(symbol)}?days=365`);
    if (!response.ok) throw new Error('Нет свечей');
    const data = await response.json();
    const indicators = data.indicators;
    if (!indicators) throw new Error('Нет индикаторов');

    const row = (label, key, value, suffix = '') => {
      const display = Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : '—';
      return `<div class="metric" data-metric="${key}"><span>${label}</span><span>${display}</span></div>`;
    };

    container.innerHTML = [
      row('RSI (14)', 'rsi', indicators.rsi),
      row('MACD', 'macd', indicators.macd, ''),
      row('MACD Hist', 'macdHistogram', indicators.macdHistogram, ''),
      row('SMA 50', 'sma50', indicators.sma50),
      row('SMA 200', 'sma200', indicators.sma200),
      Number.isFinite(indicators.volume)
        ? `<div class="metric" data-metric="volume"><span>Объём</span><span>${Math.round(indicators.volume).toLocaleString('ru-RU')}</span></div>`
        : '<div class="metric na" data-metric="volume"><span>Объём</span><span>—</span></div>',
      Number.isFinite(indicators.avgVolume20)
        ? `<div class="metric" data-metric="avgVolume"><span>Ср. объём (20)</span><span>${Math.round(indicators.avgVolume20).toLocaleString('ru-RU')}</span></div>`
        : '',
    ].join('');
  } catch (_) {
    container.innerHTML = '<div class="metric na">Ошибка загрузки</div>';
  }
}

async function loadMainChart() {
  const targetSymbol = state.currentMainSymbol;
  const targetMarket = state.currentMainMarket;
  const container = $('mainChart');
  if (!container) return;

  container.innerHTML = '<div class="muted" style="padding:20px;">Загрузка графика…</div>';
  if (mainChart) {
    try { mainChart.destroy(); } catch (_) { /* ignore */ }
    mainChart = null;
  }

  try {
    const response = await fetch(`/api/candles/${targetMarket}/${encodeURIComponent(targetSymbol)}?days=365`);
    if (!response.ok) throw new Error('Нет свечей');
    const data = await response.json();
    if (targetSymbol !== state.currentMainSymbol) return;
    if (!data.candles || !data.candles.length) throw new Error('Пусто');

    container.innerHTML = '';
    const points = data.candles.map((candle) => ({ x: new Date(candle.x), y: [candle.o, candle.h, candle.l, candle.c] }));

    mainChart = new CanvasJS.StockChart(container, {
      theme: 'dark2',
      backgroundColor: 'transparent',
      animationEnabled: false,
      charts: [{
        data: [{
          type: 'candlestick',
          dataPoints: points,
          risingColor: '#238636',
          fallingColor: '#da3633',
        }],
      }],
      navigator: { enabled: true },
    });
    mainChart.render();
  } catch (_) {
    if (targetSymbol === state.currentMainSymbol) {
      container.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">График недоступен</div>';
    }
  }
}

async function loadTechRadar(symbol, market) {
  try {
    const response = await fetch(`/api/tech-radar/${market}/${encodeURIComponent(symbol)}`);
    if (!response.ok) return;
    const radar = await response.json();
    if (symbol !== state.currentMainSymbol) return;

    const verdictEl = $('radarVerdict');
    verdictEl.textContent = radar.verdict;
    verdictEl.style.color = radar.score > 0 ? 'var(--up)' : radar.score < 0 ? 'var(--down)' : 'var(--muted)';

    renderGauge(radar.score);
    const detail = $('radarDetail');
    if (detail) {
      if (radar.buy + radar.sell + radar.neutral === 0) {
        detail.textContent = 'Недостаточно данных для сигналов';
      } else {
        detail.innerHTML = `Покупать: <b class="up">${radar.buy}</b> · Нейтрально: <b>${radar.neutral}</b> · Продавать: <b class="down">${radar.sell}</b>`;
      }
    }
  } catch (_) {
    /* радар необязателен */
  }
}

/** Живой гейдж: раньше здесь всегда рисовались три равных сектора. */
function renderGauge(score) {
  const container = $('gaugeContainer');
  if (!container) return;
  const clamped = Math.max(-1, Math.min(1, Number(score) || 0));
  const angle = -90 + (clamped + 1) * 90; // -90° … +90°
  const color = clamped > 0.17 ? 'var(--up)' : clamped < -0.17 ? 'var(--down)' : 'var(--muted)';

  container.innerHTML = `
    <div class="gauge">
      <svg viewBox="0 0 200 110" role="img" aria-label="Сигнал радара">
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="#da3633" stroke-width="14" stroke-linecap="round" opacity="0.35"/>
        <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#gaugeGrad)" stroke-width="14" stroke-linecap="round" opacity="0.15"/>
        <g transform="rotate(${angle} 100 100)">
          <line x1="100" y1="100" x2="100" y2="34" stroke="${color}" stroke-width="4" stroke-linecap="round"/>
        </g>
        <circle cx="100" cy="100" r="6" fill="${color}"/>
      </svg>
    </div>
  `;
}

/* ================================================================= портфель */

function findMarketForSymbol(symbol) {
  for (const [market, list] of Object.entries(state.markets)) {
    if (list.some((item) => item.symbol === symbol)) return market;
  }
  return null;
}

function currencyOfSymbol(symbol) {
  const market = findMarketForSymbol(symbol);
  return { US: 'USD', EU: 'EUR', RU: 'RUB', CRYPTO: 'USD', FOREX: 'USD' }[market] || 'USD';
}

async function loadFxRates() {
  const pairs = [['RUB', 'USD'], ['EUR', 'USD']];
  await Promise.all(pairs.map(async ([from, to]) => {
    try {
      const response = await fetch(`/api/fx?from=${from}&to=${to}`);
      if (!response.ok) return;
      const data = await response.json();
      state.fx[`${from}:${to}`] = data.rate;
    } catch (_) { /* без курса покажем приблизительно */ }
  }));
}

function toUsd(value, currency) {
  if (currency === 'USD') return value;
  const rate = state.fx[`${currency}:USD`];
  return Number.isFinite(rate) ? value * rate : null;
}

function portfolioValuation() {
  let stockUsd = 0;
  let partial = false;

  const rows = Object.entries(state.portfolio.holdings).map(([symbol, position]) => {
    const quote = state.quotes[symbol];
    const currency = currencyOfSymbol(symbol);
    const price = quote && Number.isFinite(quote.price) ? quote.price : null;
    const value = price !== null ? price * position.shares : 0;
    const valueUsd = toUsd(value, currency);
    if (valueUsd === null) partial = true;
    else stockUsd += valueUsd;

    const cost = Number(position.totalCost) || 0;
    const pnl = value - cost;
    return { symbol, position, currency, price, value, valueUsd, cost, pnl };
  });

  const total = state.portfolio.cash + stockUsd;
  return { rows, stockUsd, total, partial, profit: total - 10000 };
}

function updatePortfolioUI() {
  const cashEl = $('cashBalance');
  if (cashEl) cashEl.textContent = fmtMoney(state.portfolio.cash, 'USD');

  const valuation = portfolioValuation();
  const tbody = document.querySelector('#holdingsTable tbody');
  if (tbody) {
    tbody.innerHTML = valuation.rows.length
      ? valuation.rows.map((row) => `
        <tr>
          <td><b>${esc(displaySymbol(row.symbol))}</b></td>
          <td>${row.position.shares}</td>
          <td>${fmtMoney(row.position.shares ? row.cost / row.position.shares : 0, row.currency)}</td>
          <td>${fmtMoney(row.price, row.currency)}</td>
          <td>${fmtMoney(row.value, row.currency)}</td>
          <td class="${row.pnl >= 0 ? 'up' : 'down'}">${fmtMoney(row.pnl, row.currency)}</td>
          <td><button class="btn-small btn-sell" data-sell="${esc(row.symbol)}">Продать</button></td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="muted" style="text-align:center;">Пока нет активов</td></tr>';
  }

  const valueEl = $('portfolioValue');
  if (valueEl) valueEl.textContent = fmtMoney(valuation.stockUsd, 'USD');

  const pnlEl = $('portfolioPnL');
  if (pnlEl) {
    const suffix = valuation.partial ? ' *' : '';
    pnlEl.textContent = `${valuation.profit >= 0 ? '+' : ''}${fmtMoney(valuation.profit, 'USD')} (${fmtPercent((valuation.profit / 10000) * 100)})${suffix}`;
    pnlEl.className = valuation.profit >= 0 ? 'up' : 'down';
  }

  renderPie(valuation);
}

function renderPie(valuation) {
  const canvas = $('diversificationChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const labels = ['Кэш', ...valuation.rows.map((row) => displaySymbol(row.symbol))];
  const values = [state.portfolio.cash, ...valuation.rows.map((row) => row.valueUsd ?? row.value)];
  const palette = ['#58a6ff', '#238636', '#da3633', '#e3b341', '#a371f7', '#39c5cf', '#f778ba', '#ffa657'];

  if (pieChart) {
    pieChart.data.labels = labels;
    pieChart.data.datasets[0].data = values;
    pieChart.data.datasets[0].backgroundColor = labels.map((_, index) => palette[index % palette.length]);
    pieChart.update();
    return;
  }

  pieChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: labels.map((_, i) => palette[i % palette.length]), borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c9d1d9' } } },
    },
  });
}

async function fetchPortfolioQuotes() {
  if (state.fetchingQuotes) return;
  const symbols = Object.keys(state.portfolio.holdings);
  if (!symbols.length) return;

  state.fetchingQuotes = true;
  try {
    await Promise.all(symbols.map(async (symbol) => {
      const market = findMarketForSymbol(symbol);
      if (!market) return;
      try {
        const response = await fetch(`/api/quote/${market}/${encodeURIComponent(symbol)}`);
        if (response.ok) state.quotes[symbol] = await response.json();
      } catch (_) { /* пропускаем один тикер — остальные обновятся */ }
    }));
  } finally {
    state.fetchingQuotes = false;
  }
  updatePortfolioUI();
}

function calcReturnPercent() {
  const valuation = portfolioValuation();
  return ((valuation.total - 10000) / 10000) * 100;
}

async function sellFromPortfolio(symbol) {
  const market = findMarketForSymbol(symbol) || 'US';
  switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn'));
  await loadMainStock(symbol, displaySymbol(symbol), market);
  openTradeModal('sell');
}

/* ------------------------------------------------------------------ сделки */

function openTradeModal(type) {
  $('tradeModal').style.display = 'block';
  $('tradeTitle').textContent = `${type === 'buy' ? 'Купить' : 'Продать'} ${displaySymbol(state.currentMainSymbol)}`;
  const quote = state.quotes[state.currentMainSymbol];
  $('tradePrice').textContent = quote ? fmtPrice(quote.price) : '0';
  $('tradeShares').value = '';
  $('tradeSubmitBtn').onclick = () => executeTrade(type);
}

async function executeTrade(type) {
  if (!state.user) {
    openModal('authModal');
    return;
  }
  const shares = Number.parseFloat($('tradeShares').value);
  const quote = state.quotes[state.currentMainSymbol];
  const price = quote && quote.price;

  if (!Number.isFinite(shares) || shares <= 0) return alert('Укажите количество больше нуля');
  if (!Number.isFinite(price) || price <= 0) return alert('Нет актуальной цены — обновите данные');

  const symbol = state.currentMainSymbol;
  const currency = quote.currency || 'USD';
  const valueUsd = toUsd(shares * price, currency) ?? shares * price;
  const total = shares * price;

  if (type === 'buy') {
    if (state.portfolio.cash < valueUsd) return alert('Недостаточно средств');
    state.portfolio.cash -= valueUsd;
    const position = state.portfolio.holdings[symbol] || { shares: 0, totalCost: 0 };
    position.shares = Number(position.shares) + shares;
    position.totalCost = Number(position.totalCost) + total;
    state.portfolio.holdings[symbol] = position;
  } else {
    const position = state.portfolio.holdings[symbol];
    if (!position || Number(position.shares) < shares) return alert('Недостаточно бумаг');
    const costPerShare = Number(position.totalCost) / Number(position.shares);
    position.totalCost = Math.max(0, Number(position.totalCost) - costPerShare * shares);
    position.shares = Number(position.shares) - shares;
    state.portfolio.cash += valueUsd;
    if (position.shares <= 1e-9) delete state.portfolio.holdings[symbol];
  }

  state.portfolio.history.push({
    date: new Date().toISOString(),
    type: type.toUpperCase(),
    symbol,
    shares,
    price,
    total,
    currency,
  });

  closeModal('tradeModal');
  await fetchPortfolioQuotes();
  updatePortfolioUI();
  await syncPortfolio();
}

async function syncPortfolio() {
  if (!state.user) return null;
  try {
    const response = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: state.portfolio, returnPercent: calcReturnPercent() }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  }
}

/* --------------------------------------------------------------------- CSV */

function downloadCsv(filename, rows) {
  const escapeCell = (value) => {
    const text = String(value ?? '');
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => row.map(escapeCell).join(';')).join('\r\n');
  const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

/** Экспорт позиций: раньше кнопка вызывала несуществующую функцию. */
function exportCSV() {
  const valuation = portfolioValuation();
  const rows = [
    ['Тикер', 'Название', 'Количество', 'Средняя цена', 'Текущая цена', 'Стоимость', 'P&L', 'Валюта', 'Стоимость в USD'],
  ];

  if (!valuation.rows.length) rows.push(['—', 'Портфель пуст', '', '', '', '', '', '', '']);

  for (const row of valuation.rows) {
    rows.push([
      displaySymbol(row.symbol),
      (state.markets[findMarketForSymbol(row.symbol)] || []).find((item) => item.symbol === row.symbol)?.name || '',
      row.position.shares,
      row.position.shares ? (row.cost / row.position.shares).toFixed(4) : '',
      Number.isFinite(row.price) ? row.price.toFixed(4) : '',
      row.value.toFixed(2),
      row.pnl.toFixed(2),
      row.currency,
      Number.isFinite(row.valueUsd) ? row.valueUsd.toFixed(2) : '',
    ]);
  }

  rows.push([]);
  rows.push(['Кэш (USD)', state.portfolio.cash.toFixed(2)]);
  rows.push(['Стоимость активов (USD)', valuation.stockUsd.toFixed(2)]);
  rows.push(['Итого (USD)', valuation.total.toFixed(2)]);
  rows.push(['Доходность (%)', calcReturnPercent().toFixed(2)]);
  if (valuation.partial) rows.push(['Примечание', 'Часть позиций без курса валют — итог неполный']);

  downloadCsv(`starstocks_portfolio_${todayStamp()}.csv`, rows);
}

function exportTradesCSV() {
  const history = Array.isArray(state.portfolio.history) ? state.portfolio.history : [];
  const rows = [['Дата', 'Тип', 'Тикер', 'Количество', 'Цена', 'Сумма', 'Валюта']];

  if (!history.length) rows.push(['—', 'Сделок пока нет', '', '', '', '', '']);

  for (const trade of history) {
    rows.push([
      new Date(trade.date).toISOString(),
      trade.type,
      displaySymbol(trade.symbol),
      trade.shares,
      Number(trade.price).toFixed(4),
      Number(trade.total).toFixed(2),
      trade.currency || '',
    ]);
  }

  downloadCsv(`starstocks_trades_${todayStamp()}.csv`, rows);
}

/* ----------------------------------------------------------------- лимитки */

function openLimitModal() {
  if (!state.user) {
    openModal('authModal');
    return;
  }
  $('limitModal').style.display = 'block';
  $('limitSymbol').textContent = displaySymbol(state.currentMainSymbol);
  const quote = state.quotes[state.currentMainSymbol];
  $('limitTargetPrice').value = quote ? quote.price.toFixed(2) : '';
  $('limitShares').value = '';
}

async function submitLimitOrder() {
  if (!state.user) return alert('Войдите в аккаунт');
  const type = $('limitType').value;
  const target = Number.parseFloat($('limitTargetPrice').value);
  const shares = Number.parseInt($('limitShares').value, 10);

  if (!Number.isFinite(target) || target <= 0) return alert('Укажите цену больше нуля');
  if (!Number.isInteger(shares) || shares <= 0) return alert('Количество должно быть целым числом больше нуля');

  try {
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: state.currentMainSymbol,
        market: state.currentMainMarket,
        type,
        target_price: target,
        shares,
      }),
    });
    const data = await response.json();
    if (!response.ok) return alert(data.error || 'Не удалось создать заявку');

    closeModal('limitModal');
    alert('Заявка создана');
  } catch (_) {
    alert('Сеть недоступна, попробуйте ещё раз');
  }
}

async function loadOrders() {
  if (!state.user) return;
  const tbody = document.querySelector('#ordersTable tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;">Загрузка…</td></tr>';

  try {
    const response = await fetch('/api/orders');
    if (!response.ok) throw new Error('fail');
    const orders = await response.json();

    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;">Нет заявок</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map((order) => {
      const statusText = order.status === 'PENDING' ? 'Ожидает' : order.status === 'FILLED' ? 'Исполнена' : 'Отменена';
      const statusColor = order.status === 'PENDING' ? 'var(--warn)' : order.status === 'FILLED' ? 'var(--up)' : 'var(--down)';
      const cancelBtn = order.status === 'PENDING'
        ? `<button class="btn-small btn-sell" data-cancel="${esc(order.id)}">Отменить</button>`
        : '—';

      return `<tr>
        <td>${new Date(order.created_at).toLocaleString('ru-RU')}</td>
        <td><b>${esc(displaySymbol(order.symbol))}</b></td>
        <td>${order.type === 'buy' ? 'Покупка' : 'Продажа'}</td>
        <td>${order.shares}</td>
        <td>${fmtPrice(order.target_price)}</td>
        <td style="color:${statusColor};">${statusText}</td>
        <td>${cancelBtn}</td>
      </tr>`;
    }).join('');
  } catch (_) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="down" style="text-align:center;">Не удалось загрузить заявки</td></tr>';
  }
}

async function cancelOrder(id) {
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      alert(data.error || 'Не удалось отменить');
    }
  } catch (_) {
    alert('Сеть недоступна');
  }
  loadOrders();
}

/* ================================================================== авторизация */

async function processAuth(user) {
  state.user = user;
  state.portfolio = user.portfolio || { cash: 10000, holdings: {}, history: [] };
  closeModal('authModal');
  checkAuth();
  await loadFxRates();
  await fetchPortfolioQuotes();
  updatePortfolioUI();
  await syncPortfolio();
}

async function login() {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value.trim();
  if (!email || !password) return alert('Введите email и пароль');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) return alert(data.error || 'Не удалось войти');
    await processAuth(data.user);
  } catch (_) {
    alert('Сеть недоступна');
  }
}

async function register() {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value.trim();
  const username = $('authUsername').value.trim();
  if (!email || !password || !username) return alert('Заполните все поля');

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username }),
    });
    const data = await response.json();
    if (!response.ok) return alert(data.error || 'Не удалось зарегистрироваться');
    await processAuth(data.user);
  } catch (_) {
    alert('Сеть недоступна');
  }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  state.user = null;
  state.portfolio = { cash: 10000, holdings: {}, history: [] };
  localStorage.removeItem('currentUser');
  localStorage.removeItem('portfolio');
  updatePortfolioUI();
  checkAuth();
}

function checkAuth() {
  const loginBtn = $('loginBtn');
  const userInfo = $('userInfo');
  if (state.user) {
    loginBtn.style.display = 'none';
    userInfo.style.display = 'block';
    $('displayUsername').textContent = state.user.username;
  } else {
    loginBtn.style.display = 'block';
    userInfo.style.display = 'none';
  }
}

async function loadLeaderboard() {
  const tbody = document.querySelector('#leaderboardTable tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;">Загрузка…</td></tr>';

  try {
    const response = await fetch('/api/leaderboard');
    const users = await response.json();
    if (!Array.isArray(users) || !users.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;">Пока пусто</td></tr>';
      return;
    }

    tbody.innerHTML = users.map((user, index) => {
      const isMe = state.user && user.id === state.user.id;
      const percent = Number(user.return_percent) || 0;
      return `<tr style="${isMe ? 'background: rgba(88, 166, 255, 0.1);' : ''}">
        <td>#${index + 1}</td>
        <td>${esc(user.username)} ${isMe ? '(вы)' : ''}</td>
        <td class="${percent >= 0 ? 'up' : 'down'}">${fmtPercent(percent)}</td>
        <td>${(user.badges || []).map(esc).join(' ') || '—'}</td>
      </tr>`;
    }).join('');
  } catch (_) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="down" style="text-align:center;">Не удалось загрузить</td></tr>';
  }
}

/* ================================================== новости, избранное, профиль */

async function loadNews() {
  const container = $('newsList');
  if (!container) return;
  container.innerHTML = '<div class="skeleton-item"><div class="skeleton-img"></div><div class="skeleton-text"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>';

  try {
    const response = await fetch('/api/news');
    const news = await response.json();
    if (!Array.isArray(news) || !news.length) {
      container.innerHTML = '<p class="muted">Нет новостей</p>';
      return;
    }

    container.innerHTML = news.map((item) => `
      <div class="news-item">
        ${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : ''}
        <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a>
      </div>
    `).join('');
  } catch (_) {
    container.innerHTML = '<p class="muted">Нет новостей</p>';
  }
}

function toggleFavorite(symbol) {
  state.favorites = state.favorites.includes(symbol)
    ? state.favorites.filter((item) => item !== symbol)
    : [...state.favorites, symbol];

  localStorage.setItem('favorites', JSON.stringify(state.favorites));
  const starBtn = $('mainStarBtn');
  if (starBtn) starBtn.classList.toggle('active', state.favorites.includes(symbol));
  renderFavorites();
}

function renderFavorites() {
  const container = $('favoritesContainer');
  if (!container) return;

  if (!state.favorites.length) {
    container.innerHTML = '<p class="muted" style="margin:0;">Пусто — нажмите ★ на карточке инструмента</p>';
    return;
  }

  container.innerHTML = state.favorites.map((symbol) => {
    const market = findMarketForSymbol(symbol);
    const name = market
      ? (state.markets[market] || []).find((item) => item.symbol === symbol)?.name || displaySymbol(symbol)
      : displaySymbol(symbol);
    const quote = state.quotes[symbol];
    const percent = quote && Number.isFinite(quote.percent) ? quote.percent : null;

    return `<div class="fav-row" data-favorite="${esc(symbol)}">
      <div>
        <div class="fav-symbol">${esc(displaySymbol(symbol))}</div>
        <div class="fav-name">${esc(name)}</div>
      </div>
      <div class="fav-price">
        <div>${quote ? fmtPrice(quote.price) : '—'}</div>
        <div class="${percent === null ? 'muted' : percent >= 0 ? 'up' : 'down'}">${percent === null ? '' : fmtPercent(percent)}</div>
      </div>
    </div>`;
  }).join('');
}

function openProfile() {
  if (!state.user) return;
  $('profUsername').textContent = state.user.username;
  $('profEmail').textContent = state.user.email;
  $('profReturn').textContent = $('portfolioPnL').textContent;
  $('profReturn').className = $('portfolioPnL').className;
  $('profCash').textContent = $('cashBalance').textContent;
  openModal('profileModal');
}

/* ============================================================== поиск/модалки */

function setupSearch() {
  const input = $('symbolInput');
  const list = $('autocompleteList');
  if (!input || !list) return;

  input.addEventListener('input', () => {
    const query = input.value.trim().toUpperCase();
    list.innerHTML = '';
    if (!query) {
      list.style.display = 'none';
      return;
    }

    const matches = [];
    for (const [market, items] of Object.entries(state.markets)) {
      for (const item of items) {
        if (displaySymbol(item.symbol).includes(query) || String(item.name).toUpperCase().includes(query)) {
          matches.push({ ...item, market });
        }
      }
    }

    matches.slice(0, 8).forEach((match) => {
      const row = document.createElement('div');
      row.innerHTML = `<b>${esc(displaySymbol(match.symbol))}</b> — ${esc(match.name)} <span class="tag">${match.market}</span>`;
      row.onclick = () => {
        input.value = displaySymbol(match.symbol);
        list.style.display = 'none';
        loadMainStock(match.symbol, match.name, match.market);
      };
      list.appendChild(row);
    });

    list.style.display = matches.length ? 'block' : 'none';
  });

  document.addEventListener('click', (event) => {
    if (event.target !== input) list.style.display = 'none';
  });
}

function closeModal(id) { $(id).style.display = 'none'; }
function openModal(id) { $(id).style.display = 'block'; }

/* ================================================================= init */

async function refreshSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) return null;
    const data = await response.json();
    state.user = data.user;
    state.portfolio = data.user.portfolio || { cash: 10000, holdings: {}, history: [] };
    return data.user;
  } catch (_) {
    return null;
  }
}

async function refreshVisibleQuotes() {
  if (state.fetchingQuotes) return;
  const symbols = new Set([state.currentMainSymbol]);
  for (const stock of (state.markets[state.currentMarket] || []).slice(0, 12)) symbols.add(stock.symbol);
  for (const symbol of Object.keys(state.portfolio.holdings)) symbols.add(symbol);

  state.fetchingQuotes = true;
  try {
    await Promise.all([...symbols].map(async (symbol) => {
      const market = findMarketForSymbol(symbol) || state.currentMarket;
      try {
        const response = await fetch(`/api/quote/${market}/${encodeURIComponent(symbol)}`);
        if (response.ok) state.quotes[symbol] = await response.json();
      } catch (_) { /* ignore */ }
    }));
  } finally {
    state.fetchingQuotes = false;
  }

  updatePortfolioUI();
  renderWatchlistPrices();
}

function renderWatchlistPrices() {
  const stocks = (state.markets[state.currentMarket] || []).slice(0, 12);
  for (const stock of stocks) {
    const quote = state.quotes[stock.symbol];
    if (!quote) continue;
    const priceEl = $(`wl-price-${stock.symbol}`);
    const changeEl = $(`wl-change-${stock.symbol}`);
    if (priceEl) priceEl.textContent = fmtPrice(quote.price);
    if (changeEl && Number.isFinite(quote.percent)) {
      changeEl.textContent = fmtPercent(quote.percent);
      changeEl.className = `wl-change ${quote.percent >= 0 ? 'up' : 'down'}`;
    }
  }
}

/* =============================================================== тепловая карта */

async function loadHeatmap(market) {
  const container = $('heatmapContainer');
  const title = $('heatmapMarketName');
  const names = { US: 'США', EU: 'Европа', RU: 'Россия', CRYPTO: 'Крипта', FOREX: 'Валюты' };
  if (title) title.textContent = `(${names[market] || market})`;
  if (!container) return;

  container.innerHTML = '<div class="muted" style="width:100%; text-align:center; padding:20px;">Загрузка…</div>';

  try {
    const response = await fetch(`/api/heatmap/${market}`);
    if (!response.ok) throw new Error('fail');
    const data = await response.json();

    if (!data.length) {
      container.innerHTML = '<div class="muted" style="width:100%; text-align:center; padding:20px;">Нет данных</div>';
      return;
    }

    container.innerHTML = data.map((tile) => {
      const intensity = Math.min(Math.abs(tile.percent) / 3, 1);
      const rgb = tile.percent >= 0 ? '35, 134, 54' : '218, 54, 51';
      const symbol = currencySymbol(tile.currency);

      return `
        <div class="heat-tile" style="background: rgba(${rgb}, ${0.3 + intensity * 0.7});" data-symbol="${esc(tile.symbol)}">
          <div class="heat-symbol">${esc(displaySymbol(tile.symbol))}</div>
          <div>${fmtPercent(tile.percent)}</div>
          <div class="heat-price">${symbol}${fmtPrice(tile.price)}</div>
          <div class="tooltip-text">${esc(displaySymbol(tile.symbol))} · ${fmtPercent(tile.percent)}<br>${symbol}${fmtPrice(tile.price)}${tile.delayed ? '<br>задержка' : ''}</div>
        </div>`;
    }).join('');

    container.querySelectorAll('.heat-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        const symbol = tile.dataset.symbol;
        loadMainStock(symbol, displaySymbol(symbol), market);
        switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn'));
        window.scrollTo(0, 0);
      });
    });
  } catch (_) {
    container.innerHTML = '<div class="down" style="width:100%; text-align:center; padding:20px;">Ошибка загрузки</div>';
  }
}

/* ================================================================ делегирование */

document.addEventListener('click', (event) => {
  const favoriteRow = event.target.closest('[data-favorite]');
  if (favoriteRow) {
    const symbol = favoriteRow.dataset.favorite;
    const market = findMarketForSymbol(symbol) || 'US';
    loadMainStock(symbol, displaySymbol(symbol), market);
    switchTab('dashboard', document.querySelector('.nav-tabs .tab-btn'));
    return;
  }

  const sellButton = event.target.closest('[data-sell]');
  if (sellButton) {
    event.stopPropagation();
    sellFromPortfolio(sellButton.dataset.sell);
    return;
  }
  const cancelButton = event.target.closest('[data-cancel]');
  if (cancelButton) {
    event.stopPropagation();
    cancelOrder(cancelButton.dataset.cancel);
  }
});

/* ================================================================== запуск */

async function init() {
  connectWs();
  setupSearch();
  updatePortfolioUI();

  await refreshSession();
  checkAuth();
  if (state.user) await loadFxRates();

  state.markets = await fetch('/api/watchlist').then((r) => r.json());
  loadNews();
  await loadMainStock('AAPL', 'Apple Inc.', 'US');
  await fetchPortfolioQuotes();
  updatePortfolioUI();
  renderFavorites();

  switchMarket('US', document.querySelector('.market-btn'));
  setInterval(refreshVisibleQuotes, 30_000);
}

window.addEventListener('load', () => {
  init().catch((error) => console.error('Ошибка инициализации', error));
});
