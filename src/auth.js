'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabase, run } = require('./db');
const { AUTH_SECRET, BCRYPT_ROUNDS, SESSION_DAYS, COOKIE_NAME, isProd } = require('./config');
const validate = require('./validate');
const log = require('./logger');

const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;

/* ------------------------------------------------------------------ токены */

function sign(value) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
}

function createToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS, v: 1 }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.uid || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/* ----------------------------------------------------------------- печеньки */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  return isProd || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/* ------------------------------------------------------------ пользователи */

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    return_percent: user.return_percent ?? 0,
    badges: Array.isArray(user.badges) ? user.badges : [],
    portfolio: user.portfolio || { cash: 10000, holdings: {}, history: [] },
  };
}

const userCache = new Map();
const USER_CACHE_TTL = 5_000;

function invalidateUser(userId) {
  if (userId !== undefined) userCache.delete(String(userId));
  else userCache.clear();
}

async function findUserById(id) {
  const key = String(id);
  const cached = userCache.get(key);
  if (cached && Date.now() - cached.t < USER_CACHE_TTL) return cached.user;

  const { data } = await run(
    supabase.from('users').select('*').eq('id', id).maybeSingle(),
    `auth:findUser:${key}`,
  );
  if (data) userCache.set(key, { user: data, t: Date.now() });
  return data || null;
}

async function findUserByEmail(email) {
  const { data } = await run(
    supabase.from('users').select('*').eq('email', email).maybeSingle(),
    'auth:findByEmail',
  );
  if (data) return data;
  // старые записи могли быть сохранены с другим регистром
  const { data: alt } = await run(
    supabase.from('users').select('*').ilike('email', email).maybeSingle(),
    'auth:findByEmail:ilike',
  );
  return alt || null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (BCRYPT_RE.test(stored)) return bcrypt.compare(plain, stored);
  // Легаси: пароль лежит открытым текстом. Сверяем и сразу перехешируем при входе.
  return safeEqual(plain, stored);
}

/* -------------------------------------------------------------- регистрация */

async function registerUser({ email, password, username }) {
  const cleanEmail = validate.email(email);
  const cleanPassword = validate.password(password);
  const cleanUsername = validate.username(username);

  if (!cleanEmail) return { error: 'Некорректный email', status: 400 };
  if (!cleanPassword) return { error: 'Пароль должен быть не короче 8 символов', status: 400 };
  if (!cleanUsername) {
    return { error: 'Ник: 3–32 символа, буквы, цифры, «_», «.», «-»', status: 400 };
  }

  const existing = await findUserByEmail(cleanEmail);
  if (existing) return { error: 'Email уже занят', status: 409 };

  const passwordHash = await hashPassword(cleanPassword);
  const { data, error } = await run(
    supabase
      .from('users')
      .insert([
        {
          email: cleanEmail,
          username: cleanUsername,
          password: passwordHash,
          portfolio: { cash: 10000, holdings: {}, history: [] },
          return_percent: 0,
          badges: [],
        },
      ])
      .select()
      .single(),
    'auth:register',
  );

  if (error || !data) return { error: 'Не удалось создать аккаунт', status: 500 };

  log.info('auth', 'новый пользователь', { id: data.id, email: cleanEmail });
  return { user: data, token: createToken(data.id) };
}

/* --------------------------------------------------------------------- вход */

async function loginUser({ email, password }) {
  const cleanEmail = validate.email(email);
  if (!cleanEmail) return { error: 'Неверный email или пароль', status: 400 };
  if (typeof password !== 'string' || !password) {
    return { error: 'Неверный email или пароль', status: 400 };
  }

  const user = await findUserByEmail(cleanEmail);
  if (!user) return { error: 'Неверный email или пароль', status: 401 };

  const ok = await verifyPassword(password, user.password);
  if (!ok) return { error: 'Неверный email или пароль', status: 401 };

  // Прозрачная миграция легаси-пароля в bcrypt — пользователь ничего не замечает.
  if (!BCRYPT_RE.test(String(user.password || ''))) {
    try {
      const hash = await hashPassword(password);
      await run(
        supabase.from('users').update({ password: hash }).eq('id', user.id),
        'auth:rehash',
      );
      log.info('auth', 'пароль перехеширован в bcrypt', { id: user.id });
      user.password = hash;
    } catch (err) {
      log.warn('auth', 'не удалось перехешировать пароль', String(err && err.message));
    }
  }

  invalidateUser(user.id);
  return { user, token: createToken(user.id) };
}

/* -------------------------------------------------------------- middleware */

const buckets = new Map();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }

    bucket.count++;
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    }
    return next();
  };
}

// Периодическая уборка ведра лимитов, чтобы Map не рос бесконечно
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.start > 60 * 60 * 1000) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

async function authenticate(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return findUserById(payload.uid);
}

async function requireAuth(req, res, next) {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: 'Требуется авторизация' });
    req.user = user;
    return next();
  } catch (err) {
    log.error('auth', 'ошибка авторизации', String(err && err.message));
    return res.status(500).json({ error: 'Внутренняя ошибка' });
  }
}

module.exports = {
  registerUser,
  loginUser,
  authenticate,
  requireAuth,
  rateLimit,
  publicUser,
  setSessionCookie,
  clearSessionCookie,
  invalidateUser,
  hashPassword,
  verifyPassword,
  clientIp,
  BCRYPT_RE,
};
