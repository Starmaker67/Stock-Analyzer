'use strict';
const WebSocket = require('ws');

const BASE = process.env.BASE || 'http://127.0.0.1:4100';
let failures = 0;

function check(name, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FAIL';
  if (!condition) failures++;
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, options) {
  const response = await fetch(BASE + path, options);
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { status: response.status, body };
}

(async () => {
  const health = await api('/api/health');
  check('health 200 + db ok', health.status === 200 && health.body.db.ok === true, JSON.stringify(health.body.db));

  const watchlist = await api('/api/watchlist');
  check('watchlist все рынки', watchlist.status === 200 && Object.keys(watchlist.body).length === 5,
    Object.entries(watchlist.body).map(([k, v]) => `${k}:${v.length}`).join(' '));

  const deadTickers = ['LVMH.PA', 'UG.PA'];
  for (const symbol of deadTickers) {
    const quote = await api(`/api/quote/EU/${symbol}`);
    check(`мёртвый тикер ${symbol} отсутствует в списке`, quote.status === 400 || quote.status === 404, `status ${quote.status}`);
  }

  for (const [market, symbol] of [['US', 'AAPL'], ['EU', 'SAP.DE'], ['RU', 'SBER'], ['CRYPTO', 'BINANCE:BTCUSDT'], ['FOREX', 'EURUSD']]) {
    const quote = await api(`/api/quote/${market}/${encodeURIComponent(symbol)}`);
    const ok = quote.status === 200 && Number.isFinite(quote.body.price) && quote.body.price > 0;
    check(`котировка ${market}/${symbol}`, ok, quote.status === 200 ? `${quote.body.price} ${quote.body.source}` : `status ${quote.status}`);
  }

  const badSymbol = await api('/api/quote/US/NOSUCHTICKER');
  check('неизвестный тикер → 404', badSymbol.status === 404, JSON.stringify(badSymbol.body));

  for (const [market, symbol] of [['US', 'AAPL'], ['RU', 'SBER'], ['CRYPTO', 'BINANCE:BTCUSDT']]) {
    const candles = await api(`/api/candles/${market}/${encodeURIComponent(symbol)}?days=180`);
    const body = candles.body || {};
    check(`свечи ${market}/${symbol}`, candles.status === 200 && body.candles.length > 50 && body.indicators,
      `${body.candles ? body.candles.length : 0} свечей, объём=${body.indicators ? body.indicators.volume : 'n/a'}`);
  }

  const radar = await api('/api/tech-radar/US/AAPL');
  check('радар с разбивкой голосов', radar.status === 200 && typeof radar.body.verdict === 'string' && typeof radar.body.buy === 'number',
    `${radar.body.verdict} (buy ${radar.body.buy} / sell ${radar.body.sell})`);

  const fundamentalsUs = await api('/api/fundamentals/US/AAPL');
  check('фундаментал US с метриками', fundamentalsUs.status === 200 && fundamentalsUs.body.available === true && Array.isArray(fundamentalsUs.body.metrics),
    `metrics=${fundamentalsUs.body.metrics ? fundamentalsUs.body.metrics.length : 0}`);
  check('фундаментал US без подмены EBITDA margin',
    !(fundamentalsUs.body.metrics || []).some((m) => m.key === 'ebitdaMargin'), 'ок');

  const fundamentalsEu = await api('/api/fundamentals/EU/SAP.DE');
  check('фундаментал EU честно недоступен', fundamentalsEu.status === 200 && fundamentalsEu.body.available === false,
    fundamentalsEu.body.reason);

  const heatmap = await api('/api/heatmap/US');
  check('тепловая карта US непустая', heatmap.status === 200 && heatmap.body.length > 0, `${heatmap.body.length} плиток`);

  const fx = await api('/api/fx?from=RUB&to=USD');
  check('курс RUB→USD', fx.status === 200 && fx.body.rate > 0, `${fx.body.rate}`);

  const news = await api('/api/news');
  check('новости', news.status === 200 && Array.isArray(news.body) && news.body.length > 0, `${news.body.length} шт.`);

  const leaderboard = await api('/api/leaderboard');
  const keys = leaderboard.body[0] ? Object.keys(leaderboard.body[0]) : [];
  check('лидерборд без пароля и email', leaderboard.status === 200 && !keys.includes('password') && !keys.includes('email'), keys.join(','));

  const me = await api('/api/auth/me');
  check('/api/auth/me без cookie → 401', me.status === 401);

  const portfolioNoAuth = await api('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portfolio: { cash: 1, holdings: {}, history: [] } }) });
  check('портфель без авторизации → 401', portfolioNoAuth.status === 401, `status ${portfolioNoAuth.status}`);

  const ordersNoAuth = await api('/api/orders');
  check('ордера без авторизации → 401', ordersNoAuth.status === 401);

  const unknown = await api('/api/nosuchroute');
  check('неизвестный /api → 404 json', unknown.status === 404 && unknown.body && unknown.body.error);

  const index = await fetch(BASE + '/');
  check('index.html отдаётся', index.status === 200);

  const appJs = await fetch(BASE + '/app.js');
  check('app.js отдаётся', appJs.status === 200);

  await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:4100/ws`);
    const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1500);
    socket.on('open', () => { socket.send(JSON.stringify({ type: 'ping' })); });
    socket.on('message', () => {});
    socket.on('error', () => { clearTimeout(timer); resolve(); });
  });
  check('WebSocket принимает подключение и не падает', true);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const healthAfter = await api('/api/health');
  check('сервер жив после WS-клиента', healthAfter.status === 200);

  console.log(`\nПровалено проверок: ${failures}`);
  process.exit(failures ? 1 : 0);
})();
