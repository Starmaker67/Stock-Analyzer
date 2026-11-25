'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;

function sanitizeString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function email(value) {
  const v = sanitizeString(value, 254);
  if (!v || !EMAIL_RE.test(v)) return null;
  return v.toLowerCase();
}

function password(value) {
  if (typeof value !== 'string') return null;
  // bcrypt учитывает только первые 72 байта
  if (value.length < 8 || Buffer.byteLength(value, 'utf8') > 72) return null;
  return value;
}

function username(value) {
  const v = sanitizeString(value, 32);
  if (!v || !USERNAME_RE.test(v)) return null;
  return v;
}

/** Положительное конечное число (доли крипты допустимы, как и в реальном трейдинге). */
function positiveNumber(value, max = 1e12) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

/** Целое положительное число (для лимитных заявок: колонка orders.shares — integer). */
function positiveInteger(value, max = 1e9) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

function market(value) {
  const v = String(value || '').toUpperCase();
  return ['US', 'EU', 'RU', 'CRYPTO', 'FOREX'].includes(v) ? v : null;
}

function symbol(value) {
  const v = String(value || '').trim().toUpperCase();
  // тикеры и пары: AAPL, SAP.DE, BINANCE:BTCUSDT, EURUSD
  if (!v || v.length > 24 || !/^[A-Z0-9:.\-=_]+$/.test(v)) return null;
  return v;
}

/** Портфель приходит с клиента — принимаем только ожидаемую форму. */
function portfolio(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cash = Number(value.cash);
  if (!Number.isFinite(cash) || cash < 0 || cash > 1e12) return null;
  if (!value.holdings || typeof value.holdings !== 'object' || Array.isArray(value.holdings)) return null;
  if (!Array.isArray(value.history)) return null;

  const holdings = {};
  for (const [sym, pos] of Object.entries(value.holdings)) {
    const cleanSym = symbol(sym);
    if (!cleanSym) return null;
    if (!pos || typeof pos !== 'object') return null;
    const shares = Number(pos.shares);
    const totalCost = Number(pos.totalCost);
    if (!Number.isFinite(shares) || shares < 0 || shares > 1e12) return null;
    if (!Number.isFinite(totalCost) || totalCost < 0 || totalCost > 1e15) return null;
    if (shares > 0) holdings[cleanSym] = { shares, totalCost };
  }

  const history = value.history.slice(-2000).filter((h) => h && typeof h === 'object');

  return { cash, holdings, history };
}

module.exports = { email, password, username, positiveNumber, positiveInteger, market, symbol, portfolio };
