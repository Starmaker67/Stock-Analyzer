'use strict';
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');
const log = require('./logger');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  log.error('db', 'SUPABASE_URL/SUPABASE_KEY не заданы — сервер не сможет работать');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/**
 * Раньше все вызовы выглядели как `const { data } = await supabase...` — ошибка
 * терялась, и сломанная БД выглядела как «пустые данные». Теперь любая ошибка
 * логируется с контекстом, а вызывающий код получает явный признак сбоя.
 */
async function run(promise, context) {
  try {
    const { data, error } = await promise;
    if (error) {
      log.error('db', context, { code: error.code, message: error.message, hint: error.hint });
      return { data: null, error };
    }
    return { data, error: null };
  } catch (err) {
    log.error('db', context, String((err && err.message) || err));
    return { data: null, error: err };
  }
}

async function ping() {
  const { error } = await run(
    supabase.from('users').select('id', { count: 'exact', head: true }),
    'health:users',
  );
  return { ok: !error, error: error ? error.message : null };
}

module.exports = { supabase, run, ping };
