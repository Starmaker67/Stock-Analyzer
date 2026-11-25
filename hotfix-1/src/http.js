'use strict';
const fs = require('fs');
const tls = require('tls');
const axios = require('axios');
const https = require('https');
const { CA_BUNDLE_PATH } = require('./config');
const log = require('./logger');

/**
 * iss.moex.com (и часть гос-сайтов РФ) отдают цепочку от «Russian Trusted Sub CA»,
 * которого нет в стандартном хранилище Node. Без этого RU-рынок падал
 * на self-signed certificate in certificate chain.
 *
 * Важно: опция `ca` ЗАМЕНЯЕТ стандартные корни, поэтому склеиваем их с нашим бандлом.
 */
const extraCa = loadExtraCa();
const hasExtraCa = extraCa.length > 0;

const ruAgent = new https.Agent({ keepAlive: true, ca: [...tls.rootCertificates, ...extraCa] });
const defaultAgent = new https.Agent({ keepAlive: true });

function loadExtraCa() {
  try {
    const pem = fs.readFileSync(CA_BUNDLE_PATH, 'utf8');
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    return certs;
  } catch (err) {
    log.warn('http', 'не найден CA-бандл для российских источников', CA_BUNDLE_PATH);
    return [];
  }
}

const RU_HOSTS = new Set(['iss.moex.com', 'www.cbr.ru', 'cbr.ru']);

function agentFor(url) {
  try {
    const host = new URL(url).hostname;
    if (RU_HOSTS.has(host) && hasExtraCa) return ruAgent;
  } catch (_) {
    /* ignore */
  }
  return defaultAgent;
}

const USER_AGENT = 'StarStocks/1.0 (+https://stock-analyzer.onrender.com)';
// Yahoo отдаёт 429/пустоту не-браузерным клиентам с дата-центровых IP,
// поэтому для него представляемся обычным браузером.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_HOSTS = /(^|\.)finance\.yahoo\.com$|(^|\.)yahoo\.com$/i;

function userAgentFor(url) {
  try {
    return BROWSER_HOSTS.test(new URL(url).hostname) ? BROWSER_UA : USER_AGENT;
  } catch (_) {
    return USER_AGENT;
  }
}

async function getJson(url, options = {}) {
  const response = await axios.get(url, {
    timeout: options.timeout ?? 12_000,
    httpsAgent: agentFor(url),
    headers: {
      'User-Agent': userAgentFor(url),
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    },
    // не даём axios бросать на 4xx — решение принимает провайдер
    validateStatus: (status) => status >= 200 && status < 400,
    params: options.params,
  });
  return response.data;
}

async function getText(url, options = {}) {
  const response = await axios.get(url, {
    timeout: options.timeout ?? 12_000,
    httpsAgent: agentFor(url),
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    validateStatus: (status) => status >= 200 && status < 400,
    responseType: 'text',
  });
  return response.data;
}

module.exports = { getJson, getText, hasExtraCa, RU_HOSTS };
