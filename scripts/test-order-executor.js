'use strict';
/**
 * Сквозная проверка исполнения лимитных заявок на временном аккаунте.
 * Создаёт пользователя, ставит заявку, ждёт исполнитель, проверяет портфель,
 * затем удаляет аккаунт вместе с заявками.
 *
 * Запуск: node scripts/test-order-executor.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4100';

const call = async (path, options = {}) => {
  const response = await fetch(BASE + path, options);
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { status: response.status, body, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const email = `zz_exec_${Date.now()}@example.com`;
  const password = 'test-password-123';

  const registered = await call('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, username: 'zz_exec' }),
  });
  if (registered.status !== 201) throw new Error(`register: ${registered.status}`);
  const cookie = registered.cookie;

  await call('/api/portfolio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ portfolio: { cash: 100000, holdings: {}, history: [] }, returnPercent: 0 }),
  });

  const quote = await call('/api/quote/US/AAPL');
  const price = quote.body.price;
  console.log(`Цена AAPL: ${price}`);

  // Цель выше рынка → должна исполниться на рынке
  const buyOrder = await call('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbol: 'AAPL', market: 'US', type: 'buy', shares: 2, target_price: Math.ceil(price * 2) }),
  });
  console.log('buy order:', buyOrder.status, buyOrder.body && buyOrder.body.id);

  console.log('ждём исполнитель (70 с)…');
  await sleep(70_000);

  const ordersAfterBuy = await call('/api/orders', { headers: { Cookie: cookie } });
  const filled = ordersAfterBuy.body.find((order) => order.type === 'buy');
  console.log('статус покупки:', filled && filled.status);

  const meAfterBuy = await call('/api/auth/me', { headers: { Cookie: cookie } });
  const portfolioAfterBuy = meAfterBuy.body.user.portfolio;
  const position = portfolioAfterBuy.holdings.AAPL;
  console.log('позиция после покупки:', JSON.stringify(position));
  console.log('кэш после покупки:', portfolioAfterBuy.cash.toFixed(2));

  const cashOk = Math.abs(portfolioAfterBuy.cash - (100000 - 2 * price)) < Math.max(1, price * 0.05);
  const positionOk = position && position.shares === 2;
  console.log(`ПРОВЕРКА покупки: кэш=${cashOk ? 'OK' : 'FAIL'}, позиция=${positionOk ? 'OK' : 'FAIL'}`);

  // Продажа по цене выше нуля → исполнится сразу
  const sellOrder = await call('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ symbol: 'AAPL', market: 'US', type: 'sell', shares: 1, target_price: 1 }),
  });
  console.log('sell order:', sellOrder.status, sellOrder.body && sellOrder.body.id);

  console.log('ждём исполнитель (70 с)…');
  await sleep(70_000);

  const meAfterSell = await call('/api/auth/me', { headers: { Cookie: cookie } });
  const portfolioAfterSell = meAfterSell.body.user.portfolio;
  const positionAfterSell = portfolioAfterSell.holdings.AAPL;
  console.log('позиция после продажи:', JSON.stringify(positionAfterSell));

  const sharesOk = positionAfterSell && positionAfterSell.shares === 1;
  const avgCost = positionAfterSell ? positionAfterSell.totalCost / positionAfterSell.shares : null;
  const avgOk = avgCost !== null && Math.abs(avgCost - price) < Math.max(1, price * 0.05);
  console.log(`ПРОВЕРКА продажи: остаток=${sharesOk ? 'OK' : 'FAIL'}, средняя цена=${avgOk ? 'OK' : 'FAIL'} (${avgCost && avgCost.toFixed(2)})`);

  // Уборка
  const { createClient } = require('@supabase/supabase-js');
  require('dotenv').config();
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const admin = createClient(url, process.env.SUPABASE_KEY);
  await admin.from('orders').delete().eq('email', email);
  await admin.from('users').delete().eq('email', email);
  console.log('временный аккаунт удалён');

  const allOk = cashOk && positionOk && sharesOk && avgOk && filled && filled.status === 'FILLED';
  process.exit(allOk ? 0 : 1);
})().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
