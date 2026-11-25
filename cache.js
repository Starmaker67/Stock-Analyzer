'use strict';
const log = require('./logger');

/**
 * Кэш в памяти с двумя важными свойствами:
 *  1) single-flight — параллельные запросы одного ключа дают ОДИН вызов источника
 *     (раньше 12 карточек и тепловая карта били внешний API одновременно → 429);
 *  2) negative caching — ошибка источника живёт 30 с, а не долбит API каждым запросом.
 *
 * Интерфейс намеренно минимальный: позже он заменяется на Redis без правок вызывающего кода.
 */
const store = new Map();
const inflight = new Map();
const stats = { hits: 0, misses: 0, errors: 0, inflightHits: 0 };

const MAX_KEYS = 5000;
const NEGATIVE_TTL = 30_000;

function prune() {
  if (store.size <= MAX_KEYS) return;
  const excess = store.size - MAX_KEYS;
  let removed = 0;
  for (const key of store.keys()) {
    store.delete(key);
    if (++removed >= excess) break;
  }
}

async function getOrLoad(key, ttlMs, loader, opts = {}) {
  const now = Date.now();
  const entry = store.get(key);

  if (entry) {
    const age = now - entry.t;
    if (entry.value !== null && age < ttlMs) {
      stats.hits++;
      return entry.value;
    }
    if (entry.value === null && age < (opts.negativeTtl ?? NEGATIVE_TTL)) {
      stats.hits++;
      return null;
    }
  }

  const pending = inflight.get(key);
  if (pending) {
    stats.inflightHits++;
    return pending;
  }

  stats.misses++;
  const task = (async () => {
    try {
      const value = await loader();
      const normalized = value === undefined ? null : value;
      store.set(key, { value: normalized, t: Date.now() });
      prune();
      return normalized;
    } catch (err) {
      stats.errors++;
      log.warn('cache', `источник не ответил: ${key}`, String((err && err.message) || err));
      store.set(key, { value: null, t: Date.now() });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

function peek(key) {
  return store.get(key) || null;
}

function statsSnapshot() {
  return { ...stats, keys: store.size, inflight: inflight.size };
}

module.exports = { getOrLoad, peek, stats: statsSnapshot };
