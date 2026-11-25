'use strict';
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');

/**
 * Supabase-URL часто копируют вместе с путём /rest/v1/ — тогда supabase-js
 * строит невалидный путь и ВСЕ запросы к БД падают. Нормализуем на входе.
 */
function normalizeSupabaseUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const SUPABASE_KEY = String(process.env.SUPABASE_KEY || '').trim();
const FINNHUB_KEY = String(process.env.FINNHUB_KEY || '').trim();
const EULERPOOL_KEY = String(process.env.EULERPOOL_KEY || '').trim();

const isProd = process.env.NODE_ENV === 'production';

// Секрет для подписи сессий. На проде обязан быть задан явно.
const AUTH_SECRET = String(process.env.AUTH_SECRET || '').trim();
const derivedSecret = crypto
  .createHash('sha256')
  .update(`starstocks:${SUPABASE_KEY}`)
  .digest('hex');

module.exports = {
  SUPABASE_URL,
  SUPABASE_KEY,
  FINNHUB_KEY,
  EULERPOOL_KEY,
  AUTH_SECRET: AUTH_SECRET || derivedSecret,
  AUTH_SECRET_IS_DERIVED: !AUTH_SECRET,
  BCRYPT_ROUNDS: Number(process.env.BCRYPT_ROUNDS || 11),
  SESSION_DAYS: Number(process.env.SESSION_DAYS || 30),
  PORT: Number(process.env.PORT || 4000),
  isProd,
  HOST: '0.0.0.0',
  CA_BUNDLE_PATH: path.join(__dirname, '..', 'certs', 'russian-trusted-ca-bundle.pem'),
  COOKIE_NAME: 'ss_session',
  VERSION: require('../package.json').version,
};
