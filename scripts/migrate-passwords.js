'use strict';
/**
 * Переводит пароли пользователей из открытого текста в bcrypt.
 *
 * По умолчанию НИЧЕГО НЕ МЕНЯЕТ — показывает, что будет сделано.
 * Применение:  node scripts/migrate-passwords.js --apply
 *
 * Безопасность:
 *  - перед записью делает резервную копию в backups/ (вне git);
 *  - после записи проверяет, что bcrypt.compare(старый пароль, новый хеш) === true,
 *    то есть пользователи смогут войти со своими прежними паролями;
 *  - пароли не печатаются в консоль.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const { supabase, run } = require('../src/db');
const { BCRYPT_ROUNDS } = require('../src/config');

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/;
const APPLY = process.argv.includes('--apply');

async function main() {
  const { data: users, error } = await run(
    supabase.from('users').select('id,email,password'),
    'migrate:list',
  );

  if (error) {
    console.error('Не удалось прочитать пользователей:', error.message);
    process.exit(1);
  }

  console.log(`Всего пользователей: ${users.length}`);

  const legacy = users.filter((user) => !BCRYPT_RE.test(String(user.password || '')));
  const already = users.length - legacy.length;
  console.log(`Уже в bcrypt: ${already}`);
  console.log(`Открытым текстом: ${legacy.length}`);

  if (!legacy.length) {
    console.log('Миграция не требуется.');
    return;
  }

  if (!APPLY) {
    console.log('\nРежим проверки. Для применения: node scripts/migrate-passwords.js --apply');
    return;
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `passwords-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(legacy.map(({ id, email, password }) => ({ id, email, password })), null, 2),
    { mode: 0o600 },
  );
  console.log(`Резервная копия: ${backupPath}`);

  let migrated = 0;
  let failed = 0;

  for (const user of legacy) {
    const plain = String(user.password || '');
    if (!plain) {
      console.log(`- ${user.email}: пустой пароль, пропуск`);
      failed++;
      continue;
    }

    const hash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
    const { error: updateError } = await run(
      supabase.from('users').update({ password: hash }).eq('id', user.id),
      `migrate:update:${user.id}`,
    );

    if (updateError) {
      console.log(`- ${user.email}: ошибка записи`);
      failed++;
      continue;
    }

    // Проверяем именно то, что сохранилось в БД, а не хеш в памяти:
    // PostgREST может ответить без ошибки, даже если не обновил ни одной строки.
    const { data: stored } = await run(
      supabase.from('users').select('password').eq('id', user.id).maybeSingle(),
      `migrate:verify:${user.id}`,
    );

    const storedHash = stored && stored.password;
    if (!BCRYPT_RE.test(String(storedHash || ''))) {
      console.log(`- ${user.email}: в БД остался не bcrypt, повторите миграцию`);
      failed++;
      continue;
    }

    const verified = await bcrypt.compare(plain, storedHash);
    if (!verified) {
      console.log(`- ${user.email}: хеш не подтвердился, требуется ручная проверка`);
      failed++;
      continue;
    }

    migrated++;
    console.log(`- ${user.email}: переведён в bcrypt`);
  }

  console.log(`\nГотово: ${migrated}, ошибок: ${failed}`);
  console.log('Резервную копию удалите после проверки входа.');
}

main().catch((error) => {
  console.error('Сбой миграции:', error);
  process.exit(1);
});
