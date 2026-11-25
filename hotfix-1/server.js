'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const config = require('./src/config');
const log = require('./src/logger');
const { supabase, run, ping } = require('./src/db');
const { getOrLoad, stats: cacheStats } = require('./src/cache');
const auth = require('./src/auth');
const validate = require('./src/validate');
const { MARKETS, MARKET_META, companyName, marketOf, isKnown } = require('./src/markets');
const { getQuote, getCandles, getFundamentals, getFxRate, getNews, getProviderStatus } = require('./src/providers');
const { getJson } = require('./src/http');
const { computeIndicators, buildRadar } = require('./src/indicators');

const app = express();
app.disable('x-powered-by');
// Render стоит за прокси — без этого не работают secure-cookie и req.ip
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ------------------------------------------------------------------ рынок */

app.get('/api/health', asyncRoute(async (req, res) => {
  const db = await getOrLoad('health:db', 30_000, async () => {
    const result = await ping();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  res.status(db && db.ok ? 200 : 503).json({
    ok: !!(db && db.ok),
    version: config.VERSION,
    uptime: Math.round(process.uptime()),
    db: db || { ok: false },
    cache: cacheStats(),
  });
}));

/**
 * Диагностика источников: одна страница, по которой видно, что именно сломано —
 * сеть, тариф источника или конкретный символ. Без неё «нет данных» неотличимо
 * от «источник заблокирован».
 */
app.get('/api/diagnostics', asyncRoute(async (req, res) => {
  const withTimeout = (promise, ms = 15_000) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`таймаут ${ms} мс`)), ms)),
    ]);

  const checks = {
    database: async () => {
      const result = await ping();
      if (!result.ok) throw new Error(result.error || 'нет соединения');
      return { ok: true };
    },
    finnhub: async () => {
      const data = await getJson('https://finnhub.io/api/v1/quote', {
        params: { symbol: 'AAPL', token: config.FINNHUB_KEY },
      });
      if (!data || !data.c) throw new Error('пустой ответ');
      return { price: data.c };
    },
    yahoo: async () => {
      const data = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/AAPL', {
        params: { range: '5d', interval: '1d' },
      });
      const price = data && data.chart && data.chart.result && data.chart.result[0]
        && data.chart.result[0].meta && data.chart.result[0].meta.regularMarketPrice;
      if (!price) throw new Error('нет цены в ответе');
      return { price };
    },
    binance: async () => {
      const data = await getJson('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: 'BTCUSDT' } });
      if (!data || !data.lastPrice) throw new Error('пустой ответ');
      return { price: Number(data.lastPrice) };
    },
    frankfurter: async () => {
      const data = await getJson('https://api.frankfurter.app/latest', { params: { from: 'USD', to: 'EUR' } });
      const rate = data && data.rates && data.rates.EUR;
      if (!rate) throw new Error('нет курса');
      return { rate };
    },
    moex: async () => {
      const data = await getJson(
        'https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/SBER.json',
        { params: { 'iss.meta': 'off' } },
      );
      const row = data && data.marketdata && data.marketdata.data && data.marketdata.data[0];
      if (!row) throw new Error('нет строки marketdata');
      return { ok: true };
    },
  };

  const results = {};
  await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    const started = Date.now();
    try {
      const detail = await withTimeout(check());
      results[name] = { ok: true, ms: Date.now() - started, ...detail };
    } catch (err) {
      results[name] = { ok: false, ms: Date.now() - started, error: String((err && err.message) || err) };
    }
  }));

  res.json({
    node: process.version,
    version: config.VERSION,
    uptime: Math.round(process.uptime()),
    hasMoexCa: require('./src/http').hasExtraCa,
    checks: results,
    providers: getProviderStatus(),
    cache: cacheStats(),
  });
}));

app.get('/api/watchlist', (req, res) => {  const payload = {};
  for (const [market, symbols] of Object.entries(MARKETS)) {
    payload[market] = symbols.map((symbol) => ({
      symbol,
      name: companyName(symbol),
      market,
      currency: MARKET_META[market].currency,
      delayed: !!MARKET_META[market].delayed,
    }));
  }
  res.json(payload);
});

app.get('/api/quote/:market/:symbol', asyncRoute(async (req, res) => {
  const market = validate.market(req.params.market);
  const symbol = validate.symbol(req.params.symbol);
  if (!market || !symbol) return res.status(400).json({ error: 'Некорректный запрос' });
  if (!isKnown(symbol)) {
    return res.status(404).json({ error: 'Инструмент не торгуется на платформе', symbol });
  }

  const quote = await getQuote(symbol, market);
  if (!quote) {
    return res.status(404).json({ error: 'Нет данных от источника', symbol, market });
  }
  res.json({ ...quote, meta: MARKET_META[market] });
}));

app.get('/api/candles/:market/:symbol', asyncRoute(async (req, res) => {
  const market = validate.market(req.params.market);
  const symbol = validate.symbol(req.params.symbol);
  if (!market || !symbol) return res.status(400).json({ error: 'Некорректный запрос' });
  if (!isKnown(symbol)) return res.status(404).json({ error: 'Инструмент не торгуется на платформе', symbol });

  const days = Math.min(Math.max(Number(req.query.days) || 365, 5), 2500);
  const data = await getCandles(symbol, market, days);

  if (!data || !data.candles.length) {
    // 502, а не 404: символ существует, но источник не отдал данные.
    return res.status(502).json({
      error: 'Источник свечей недоступен',
      reason: (data && data.error) || 'unknown',
      provider: data && data.provider,
      symbol,
      market,
    });
  }

  res.json({
    symbol,
    market,
    currency: MARKET_META[market].currency,
    delayed: !!MARKET_META[market].delayed,
    asOf: data.fetchedAt,
    provider: data.provider,
    candles: data.candles,
    indicators: computeIndicators(data.candles),
  });
}));

app.get('/api/tech-radar/:market/:symbol', asyncRoute(async (req, res) => {
  const market = validate.market(req.params.market);
  const symbol = validate.symbol(req.params.symbol);
  if (!market || !symbol) return res.status(400).json({ error: 'Некорректный запрос' });

  const data = await getCandles(symbol, market, 365);
  if (!data || !data.candles.length) {
    return res.json({
      score: 0,
      verdict: 'Нет данных',
      buy: 0,
      sell: 0,
      neutral: 0,
      groups: {},
      values: {},
      reason: (data && data.error) || 'источник не вернул свечи',
      provider: data && data.provider,
    });
  }

  const indicators = computeIndicators(data.candles);
  res.json({ ...buildRadar(indicators), asOf: data.fetchedAt, provider: data.provider });
}));

app.get('/api/fundamentals/:market/:symbol', asyncRoute(async (req, res) => {
  const market = validate.market(req.params.market);
  const symbol = validate.symbol(req.params.symbol);
  if (!market || !symbol) return res.status(400).json({ error: 'Некорректный запрос' });
  res.json(await getFundamentals(symbol, market));
}));

app.get('/api/fx', asyncRoute(async (req, res) => {
  const rate = await getFxRate(req.query.from, req.query.to);
  if (!rate) return res.status(404).json({ error: 'Курс недоступен' });
  res.json({ from: String(req.query.from).toUpperCase(), to: String(req.query.to).toUpperCase(), ...rate });
}));

app.get('/api/news', asyncRoute(async (req, res) => {
  res.json((await getNews()) || []);
}));

app.get('/api/heatmap/:market', asyncRoute(async (req, res) => {
  const market = validate.market(req.params.market);
  if (!market) return res.status(400).json({ error: 'Некорректный рынок' });

  const symbols = MARKETS[market].slice(0, 20);
  const results = await Promise.all(symbols.map((symbol) => getQuote(symbol, market)));

  res.json(
    results
      .filter((q) => q && Number.isFinite(q.percent))
      .map((q) => ({
        symbol: q.symbol,
        price: q.price,
        percent: q.percent,
        change: q.change,
        currency: q.currency,
        delayed: q.delayed,
        asOf: q.asOf,
      })),
  );
}));

/* -------------------------------------------------------------------- auth */

const loginLimiter = auth.rateLimit('login', 10, 15 * 60 * 1000);
const registerLimiter = auth.rateLimit('register', 5, 60 * 60 * 1000);

app.post('/api/auth/register', registerLimiter, asyncRoute(async (req, res) => {
  const result = await auth.registerUser(req.body || {});
  if (result.error) return res.status(result.status || 400).json({ error: result.error });

  auth.setSessionCookie(req, res, result.token);
  res.status(201).json({ user: auth.publicUser(result.user) });
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const result = await auth.loginUser(req.body || {});
  if (result.error) return res.status(result.status || 401).json({ error: result.error });

  auth.setSessionCookie(req, res, result.token);
  res.json({ user: auth.publicUser(result.user) });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', asyncRoute(async (req, res) => {
  const user = await auth.authenticate(req);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  res.json({ user: auth.publicUser(user) });
}));

/* -------------------------------------------------------------- портфель */

app.post(['/api/portfolio', '/api/update-portfolio'], auth.requireAuth, asyncRoute(async (req, res) => {
  const portfolio = validate.portfolio(req.body && req.body.portfolio);
  if (!portfolio) return res.status(400).json({ error: 'Некорректная структура портфеля' });

  const rawPercent = Number(req.body.returnPercent);
  const returnPercent = Number.isFinite(rawPercent) ? Math.max(-100, Math.min(10_000, rawPercent)) : 0;

  const badges = new Set(Array.isArray(req.user.badges) ? req.user.badges : []);
  if (returnPercent > 50) badges.add('🐺 Волк с Уолл-Стрит');
  if (returnPercent > 10) badges.add('📈 Первая прибыль');

  const { error } = await run(
    supabase
      .from('users')
      .update({ portfolio, return_percent: returnPercent, badges: [...badges] })
      .eq('id', req.user.id),
    'portfolio:save',
  );

  if (error) return res.status(500).json({ error: 'Не удалось сохранить портфель' });
  auth.invalidateUser(req.user.id);
  res.json({ ok: true, returnPercent });
}));

app.get('/api/leaderboard', asyncRoute(async (req, res) => {
  // Никакого select('*'): пароль и email не должны покидать сервер.
  const { data } = await run(
    supabase
      .from('users')
      .select('id,username,return_percent,badges')
      .order('return_percent', { ascending: false })
      .limit(50),
    'leaderboard',
  );

  res.json(data || []);
}));

/* -------------------------------------------------------------------- ордера */

app.get('/api/orders', auth.requireAuth, asyncRoute(async (req, res) => {
  const { data } = await run(
    supabase
      .from('orders')
      .select('*')
      .eq('email', req.user.email)
      .order('created_at', { ascending: false })
      .limit(200),
    'orders:list',
  );
  res.json(data || []);
}));

app.post('/api/orders', auth.requireAuth, asyncRoute(async (req, res) => {
  const symbol = validate.symbol(req.body && req.body.symbol);
  const market = validate.market(req.body && req.body.market) || (symbol ? marketOf(symbol) : null);
  const type = req.body && req.body.type === 'sell' ? 'sell' : 'buy';
  // Колонка orders.shares объявлена integer — дробные объёмы пока не поддержаны схемой.
  const shares = validate.positiveInteger(req.body && req.body.shares, 1e9);
  const targetPrice = validate.positiveNumber(req.body && req.body.target_price, 1e9);

  if (!symbol || !isKnown(symbol)) return res.status(400).json({ error: 'Неизвестный инструмент' });
  if (!market) return res.status(400).json({ error: 'Не указан рынок' });
  if (!shares) {
    return res.status(400).json({ error: 'Количество должно быть целым числом больше нуля' });
  }
  if (!targetPrice) return res.status(400).json({ error: 'Цена должна быть больше нуля' });

  const { data, error } = await run(
    supabase
      .from('orders')
      .insert([{
        email: req.user.email,
        symbol,
        market,
        type,
        shares,
        target_price: targetPrice,
        status: 'PENDING',
      }])
      .select()
      .single(),
    'orders:create',
  );

  if (error) return res.status(500).json({ error: 'Не удалось создать заявку' });
  res.status(201).json(data);
}));

app.delete('/api/orders/:id', auth.requireAuth, asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  const { data: order } = await run(
    supabase.from('orders').select('id,email,status').eq('id', id).maybeSingle(),
    'orders:find',
  );

  if (!order) return res.status(404).json({ error: 'Заявка не найдена' });
  if (order.email !== req.user.email) return res.status(403).json({ error: 'Это чужая заявка' });
  if (order.status !== 'PENDING') return res.status(409).json({ error: 'Заявка уже исполнена' });

  await run(
    supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', id),
    'orders:cancel',
  );
  res.json({ ok: true });
}));

/* ------------------------------------------------------- исполнение лимиток */

function normalizePortfolio(raw) {
  if (!raw || typeof raw !== 'object') return { cash: 10000, holdings: {}, history: [] };
  return {
    cash: Number.isFinite(Number(raw.cash)) ? Number(raw.cash) : 10000,
    holdings: raw.holdings && typeof raw.holdings === 'object' ? { ...raw.holdings } : {},
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

async function executeOrder(order) {
  const shares = Number(order.shares);
  const target = Number(order.target_price);

  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(target) || target <= 0) {
    await run(supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id), 'orders:cancel:invalid');
    log.warn('orders', 'заявка отменена: некорректные параметры', { id: order.id });
    return;
  }

  const quote = await getQuote(order.symbol, order.market);
  if (!quote) return;

  const shouldExecute = order.type === 'buy' ? quote.price <= target : quote.price >= target;
  if (!shouldExecute) return;

  const { data: user } = await run(
    supabase.from('users').select('*').eq('email', order.email).maybeSingle(),
    'orders:user',
  );
  if (!user) {
    await run(supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id), 'orders:cancel:nouser');
    return;
  }

  const portfolio = normalizePortfolio(user.portfolio);
  const cost = shares * quote.price;

  if (order.type === 'buy') {
    if (portfolio.cash < cost) {
      await run(supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id), 'orders:cancel:cash');
      return;
    }
    portfolio.cash -= cost;
    const position = portfolio.holdings[order.symbol] || { shares: 0, totalCost: 0 };
    position.shares = Number(position.shares) + shares;
    position.totalCost = Number(position.totalCost) + cost;
    portfolio.holdings[order.symbol] = position;
  } else {
    const position = portfolio.holdings[order.symbol];
    const held = position ? Number(position.shares) : 0;
    if (!position || held < shares) {
      await run(supabase.from('orders').update({ status: 'CANCELLED' }).eq('id', order.id), 'orders:cancel:shares');
      return;
    }
    // Раньше totalCost не уменьшался и средняя цена после частичной продажи врала.
    const costPerShare = held > 0 ? Number(position.totalCost) / held : 0;
    position.totalCost = Math.max(0, Number(position.totalCost) - costPerShare * shares);
    position.shares = held - shares;
    portfolio.cash += cost;
    if (position.shares <= 1e-9) delete portfolio.holdings[order.symbol];
  }

  portfolio.history.push({
    date: new Date().toISOString(),
    type: order.type.toUpperCase(),
    symbol: order.symbol,
    shares,
    price: quote.price,
    total: cost,
    currency: quote.currency,
    orderId: order.id,
  });
  if (portfolio.history.length > 2000) portfolio.history = portfolio.history.slice(-2000);

  const { error: saveError } = await run(
    supabase.from('users').update({ portfolio }).eq('id', user.id),
    'orders:savePortfolio',
  );
  if (saveError) return;

  await run(supabase.from('orders').update({ status: 'FILLED' }).eq('id', order.id), 'orders:fill');
  auth.invalidateUser(user.id);
  log.info('orders', 'заявка исполнена', { id: order.id, symbol: order.symbol, type: order.type });
}

async function processPendingOrders() {
  const { data: orders } = await run(
    supabase.from('orders').select('*').eq('status', 'PENDING').limit(200),
    'orders:pending',
  );
  if (!Array.isArray(orders) || !orders.length) return;

  for (const order of orders) {
    try {
      await executeOrder(order);
    } catch (err) {
      // Одна битая заявка больше не останавливает обработку остальных.
      log.error('orders', `ошибка исполнения ${order && order.id}`, String(err && err.message));
    }
  }
}

/* --------------------------------------------------------------- WebSocket */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clients = new Set();
const lastBroadcast = new Map();

wss.on('connection', (socket) => {
  socket.isAlive = true;
  clients.add(socket);
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', (err) => {
    log.warn('ws', 'ошибка клиента', String(err && err.message));
    clients.delete(socket);
  });
});

setInterval(() => {
  for (const socket of clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      clients.delete(socket);
      continue;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch (_) { /* ignore */ }
  }
}, 30_000).unref();

function broadcast(payload, minimumGapMs = 200) {
  const now = Date.now();
  const last = lastBroadcast.get(payload.symbol) || 0;
  if (now - last < minimumGapMs) return;
  lastBroadcast.set(payload.symbol, now);

  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

let finnhubSocket = null;
let reconnectDelay = 3000;
let shuttingDown = false;

function connectFinnhub() {
  if (shuttingDown || !config.FINNHUB_KEY || process.env.ENABLE_FINNHUB_WS === 'false') return;

  const symbols = MARKETS.US.slice(0, 25);
  const socket = new WebSocket(`wss://ws.finnhub.io?token=${config.FINNHUB_KEY}`);
  finnhubSocket = socket;

  socket.on('open', () => {
    reconnectDelay = 3000;
    log.info('finnhub-ws', 'подключено', { symbols: symbols.length });
    symbols.forEach((symbol, index) => {
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'subscribe', symbol }));
        }
      }, index * 300);
    });
  });

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw);
      if (message.type === 'trade' && Array.isArray(message.data)) {
        for (const trade of message.data) broadcast({ symbol: trade.s, price: trade.p, t: trade.t });
      }
    } catch (err) {
      log.warn('finnhub-ws', 'битое сообщение', String(err && err.message));
    }
  });

  // Без этого обработчика ошибка сокета убивала весь процесс (падение на 429).
  socket.on('error', (err) => {
    log.warn('finnhub-ws', 'ошибка соединения', String(err && err.message));
  });

  socket.on('close', () => {
    if (shuttingDown) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 5 * 60 * 1000);
    setTimeout(connectFinnhub, delay).unref();
  });
}

/* ------------------------------------------------------------ обработчики */

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

app.use((err, req, res, next) => {
  log.error('http', `${req.method} ${req.path}`, String((err && err.stack) || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

process.on('unhandledRejection', (reason) => {
  log.error('process', 'unhandledRejection', String((reason && reason.stack) || reason));
});
process.on('uncaughtException', (err) => {
  log.error('process', 'uncaughtException', String((err && err.stack) || err));
});

/* ---------------------------------------------------------------- запуск */

async function start() {
  const db = await ping();
  if (!db.ok) {
    log.error('startup', 'База данных недоступна — проверьте SUPABASE_URL и SUPABASE_KEY', db.error);
  } else {
    log.info('startup', 'База данных доступна');
  }
  if (config.AUTH_SECRET_IS_DERIVED) {
    log.warn('startup', 'AUTH_SECRET не задан — используется производный ключ. Задайте AUTH_SECRET в переменных окружения.');
  }
  if (!require('./src/http').hasExtraCa) {
    log.warn('startup', 'CA-бандл для MOEX не загружен — российский рынок будет недоступен');
  }

  server.listen(config.PORT, config.HOST, () => {
    log.info('startup', `StarStocks слушает ${config.PORT}`);
    connectFinnhub();
    processPendingOrders().catch(() => {});
    setInterval(() => processPendingOrders().catch(() => {}), 60_000).unref();
  });
}

function shutdown(signal) {
  shuttingDown = true;
  log.info('shutdown', `получен ${signal}`);
  if (finnhubSocket) {
    try { finnhubSocket.terminate(); } catch (_) { /* ignore */ }
  }
  for (const client of clients) {
    try { client.close(); } catch (_) { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

module.exports = { app, server };
