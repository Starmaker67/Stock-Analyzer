'use strict';
const { RSI, MACD, SMA } = require('technicalindicators');

function lastValue(list) {
  return Array.isArray(list) && list.length ? list[list.length - 1] : null;
}

function average(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const sum = list.reduce((acc, v) => acc + v, 0);
  return sum / list.length;
}

/** Индикаторы считаются один раз на сервере — клиент только отображает. */
function computeIndicators(candles) {
  const closes = candles.map((c) => c.c).filter((v) => Number.isFinite(v));
  if (closes.length < 2) return null;

  const volumes = candles.map((c) => (Number.isFinite(c.v) ? c.v : 0));

  const rsiSeries = RSI.calculate({ values: closes, period: 14 });
  const macdSeries = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const sma50Series = SMA.calculate({ values: closes, period: 50 });
  const sma200Series = SMA.calculate({ values: closes, period: 200 });

  const macdLast = lastValue(macdSeries);
  const volumes20 = volumes.slice(-20);

  return {
    rsi: lastValue(rsiSeries),
    macd: macdLast ? macdLast.MACD ?? null : null,
    macdSignal: macdLast ? macdLast.signal ?? null : null,
    macdHistogram: macdLast ? macdLast.histogram ?? null : null,
    sma50: lastValue(sma50Series),
    sma200: lastValue(sma200Series),
    currentPrice: closes[closes.length - 1],
    volume: volumes.length ? volumes[volumes.length - 1] : null,
    avgVolume20: average(volumes20),
    candles: candles.length,
  };
}

/**
 * Сводка в духе TradingView: считаем голоса, а не выдуманные баллы.
 * Ключевое отличие от прежней версии — отсутствующий индикатор больше НЕ
 * трактуется как «продавать»: он просто не голосует.
 */
function buildRadar(indicators) {
  if (!indicators) {
    return {
      score: 0,
      verdict: 'Нет данных',
      buy: 0,
      sell: 0,
      neutral: 0,
      groups: { oscillators: { buy: 0, sell: 0, neutral: 0 }, movingAverages: { buy: 0, sell: 0, neutral: 0 } },
      values: {},
    };
  }

  const oscillators = [];
  const movingAverages = [];
  const { rsi, macd, macdSignal, macdHistogram, sma50, sma200, currentPrice } = indicators;

  if (Number.isFinite(rsi)) {
    oscillators.push(rsi < 30 ? 'buy' : rsi > 70 ? 'sell' : 'neutral');
  }
  if (Number.isFinite(macd) && Number.isFinite(macdSignal)) {
    oscillators.push(macd > macdSignal ? 'buy' : macd < macdSignal ? 'sell' : 'neutral');
  }
  if (Number.isFinite(macdHistogram)) {
    oscillators.push(macdHistogram > 0 ? 'buy' : macdHistogram < 0 ? 'sell' : 'neutral');
  }
  if (Number.isFinite(sma50) && Number.isFinite(currentPrice)) {
    movingAverages.push(currentPrice > sma50 ? 'buy' : currentPrice < sma50 ? 'sell' : 'neutral');
  }
  if (Number.isFinite(sma200) && Number.isFinite(currentPrice)) {
    movingAverages.push(currentPrice > sma200 ? 'buy' : currentPrice < sma200 ? 'sell' : 'neutral');
  }

  const all = [...oscillators, ...movingAverages];
  if (!all.length) {
    return {
      score: 0,
      verdict: 'Нет данных',
      buy: 0,
      sell: 0,
      neutral: 0,
      groups: { oscillators: { buy: 0, sell: 0, neutral: 0 }, movingAverages: { buy: 0, sell: 0, neutral: 0 } },
      values: { rsi, macd, macdSignal, sma50, sma200, currentPrice },
    };
  }

  const count = (list) => ({
    buy: list.filter((v) => v === 'buy').length,
    sell: list.filter((v) => v === 'sell').length,
    neutral: list.filter((v) => v === 'neutral').length,
  });

  const totals = count(all);
  const score = (totals.buy - totals.sell) / all.length;
  let verdict = 'Нейтрально';
  if (score >= 0.5) verdict = 'Активно покупать';
  else if (score >= 0.17) verdict = 'Покупать';
  else if (score <= -0.5) verdict = 'Активно продавать';
  else if (score <= -0.17) verdict = 'Продавать';

  return {
    score: Number(score.toFixed(3)),
    verdict,
    ...totals,
    groups: { oscillators: count(oscillators), movingAverages: count(movingAverages) },
    values: { rsi, macd, macdSignal, sma50, sma200, currentPrice },
  };
}

module.exports = { computeIndicators, buildRadar };
