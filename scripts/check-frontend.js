'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

let problems = 0;

const handlers = [...new Set([...html.matchAll(/onclick="([A-Za-z_]\w*)\(/g)].map((m) => m[1]))];
const defined = new Set([...js.matchAll(/(?:^|\n)(?:async\s+)?function\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));
for (const handler of handlers) {
  if (!defined.has(handler)) {
    console.log(`FAIL обработчик ${handler} не определён в app.js`);
    problems++;
  }
}
console.log(`Обработчиков в HTML: ${handlers.length}, отсутствующих: ${problems}`);

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = [...new Set([...js.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]))];
const missingIds = usedIds.filter((id) => !htmlIds.has(id));
console.log(`id используется в JS: ${usedIds.length}, нет в HTML: ${missingIds.length}${missingIds.length ? ` → ${missingIds.join(', ')}` : ''}`);
if (missingIds.length) problems++;

const cssVars = new Set([...css.matchAll(/--([a-z-]+)\s*:/g)].map((m) => `--${m[1]}`));
const usedVars = [...new Set([...js.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]))];
const missingVars = usedVars.filter((name) => !cssVars.has(name));
console.log(`CSS-переменные в JS: ${usedVars.length}, не объявлены: ${missingVars.length}${missingVars.length ? ` → ${missingVars.join(', ')}` : ''}`);
if (missingVars.length) problems++;

for (const id of ['exportCSV', 'exportTradesCSV', 'switchTab', 'switchMarket', 'loadMainStock', 'openTradeModal', 'executeTrade', 'loadLeaderboard', 'cancelOrder']) {
  if (!defined.has(id)) {
    console.log(`FAIL функция ${id} отсутствует`);
    problems++;
  }
}

console.log(problems ? `\nПроблем: ${problems}` : '\nСтатическая проверка фронтенда: без замечаний');
process.exit(problems ? 1 : 0);
