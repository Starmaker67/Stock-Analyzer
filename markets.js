'use strict';

/**
 * Список инструментов. Из него убраны тикеры, которых больше нет (проверено запросами):
 *  EU: LVMH.PA (дубль MC.PA), UG.PA (Peugeot → Stellantis STLAP.PA)
 *  RU: POLY, AGRO, DZRL, VSMZ, ELTZ — не торгуются ни на одной доске MOEX
 */
const MARKETS = {
  US: [
    'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD', 'NFLX', 'DIS',
    'ADBE', 'CRM', 'ORCL', 'IBM', 'QCOM', 'TXN', 'AVGO', 'MU', 'AMAT', 'SBUX',
    'INTC', 'CSCO', 'PYPL', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'JNJ', 'UNH',
    'PFE', 'ABBV', 'MRK', 'WMT', 'KO', 'PEP', 'COST', 'MCD', 'NKE', 'PG',
    'XOM', 'CVX', 'BA', 'CAT', 'GE', 'T', 'VZ', 'UBER', 'ABNB', 'COIN',
  ],
  EU: [
    'SAP.DE', 'ASML.AS', 'SHEL.L', 'NESN.SW', 'MC.PA', 'OR.PA', 'DTE.DE', 'BMW.DE', 'AIR.PA', 'SIE.DE',
    'ALV.DE', 'SAN.MC', 'ENEL.MI', 'TTE.PA', 'SU.PA', 'AI.PA', 'BNP.PA', 'CS.PA', 'DG.PA', 'EL.PA',
    'RI.PA', 'KER.PA', 'VIE.PA', 'ENGI.PA', 'BAS.DE', 'BAYN.DE', 'CON.DE', 'DBK.DE', 'FRE.DE', 'IFX.DE',
    'LIN.DE', 'MRK.DE', 'RWE.DE', 'VOW3.DE', 'ADS.DE', 'HEN3.DE', 'FME.DE', 'SY1.DE', 'ABI.BR', 'KBC.BR',
    'UCB.BR', 'INGA.AS', 'HEIA.AS', 'PHIA.AS', 'AD.AS', 'RAND.AS', 'WKL.AS', 'DSFIR.AS',
  ],
  RU: [
    'SBER', 'GAZP', 'LKOH', 'YDEX', 'TATN', 'GMKN', 'ROSN', 'NVTK', 'PLZL', 'VTBR',
    'SNGS', 'MOEX', 'ALRS', 'CHMF', 'MAGN', 'MTLR', 'NLMK', 'RUAL', 'AFLT', 'FESH',
    'FLOT', 'FEES', 'HYDR', 'IRAO', 'AFKS', 'RTKM', 'MGTS', 'MTSS', 'BSPB', 'CBOM',
    'SFIN', 'SMLT', 'LSRG', 'PIKK', 'ZAYM', 'LENT', 'RAGR', 'KZOS', 'PHOR', 'AKRN',
    'UNAC', 'NMTP', 'SGZH', 'KMAZ', 'APTK',
  ],
  CRYPTO: [
    'BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT', 'BINANCE:BNBUSDT', 'BINANCE:XRPUSDT',
    'BINANCE:ADAUSDT', 'BINANCE:DOGEUSDT', 'BINANCE:AVAXUSDT', 'BINANCE:DOTUSDT', 'BINANCE:LINKUSDT',
  ],
  FOREX: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY'],
};

const MARKET_META = {
  US: { title: 'США', currency: 'USD', source: 'Finnhub' },
  EU: { title: 'Европа', currency: 'EUR', source: 'Yahoo Finance' },
  RU: { title: 'Россия', currency: 'RUB', source: 'MOEX ISS', delayed: true },
  CRYPTO: { title: 'Крипта', currency: 'USD', source: 'Binance' },
  FOREX: { title: 'Валюты', currency: 'USD', source: 'ECB / MOEX' },
};

const COMPANY_NAMES = {
  AAPL: 'Apple Inc.', MSFT: 'Microsoft', NVDA: 'NVIDIA', TSLA: 'Tesla', AMZN: 'Amazon',
  GOOGL: 'Alphabet', META: 'Meta', AMD: 'AMD', NFLX: 'Netflix', DIS: 'Disney',
  ADBE: 'Adobe', CRM: 'Salesforce', ORCL: 'Oracle', IBM: 'IBM', QCOM: 'Qualcomm',
  TXN: 'Texas Instruments', AVGO: 'Broadcom', MU: 'Micron', AMAT: 'Applied Materials', SBUX: 'Starbucks',
  INTC: 'Intel', CSCO: 'Cisco', PYPL: 'PayPal', JPM: 'JPMorgan', V: 'Visa',
  MA: 'Mastercard', BAC: 'Bank of America', WFC: 'Wells Fargo', JNJ: 'Johnson & Johnson', UNH: 'UnitedHealth',
  PFE: 'Pfizer', ABBV: 'AbbVie', MRK: 'Merck & Co.', WMT: 'Walmart', KO: 'Coca-Cola',
  PEP: 'PepsiCo', COST: 'Costco', MCD: "McDonald's", NKE: 'Nike', PG: 'Procter & Gamble',
  XOM: 'Exxon Mobil', CVX: 'Chevron', BA: 'Boeing', CAT: 'Caterpillar', GE: 'GE Aerospace',
  T: 'AT&T', VZ: 'Verizon', UBER: 'Uber', ABNB: 'Airbnb', COIN: 'Coinbase',

  'SAP.DE': 'SAP SE', 'ASML.AS': 'ASML', 'SHEL.L': 'Shell', 'NESN.SW': 'Nestlé', 'MC.PA': 'LVMH',
  'OR.PA': "L'Oréal", 'DTE.DE': 'Deutsche Telekom', 'BMW.DE': 'BMW', 'AIR.PA': 'Airbus', 'SIE.DE': 'Siemens',
  'ALV.DE': 'Allianz', 'SAN.MC': 'Santander', 'ENEL.MI': 'Enel', 'TTE.PA': 'TotalEnergies', 'SU.PA': 'Schneider Electric',
  'AI.PA': 'Air Liquide', 'BNP.PA': 'BNP Paribas', 'CS.PA': 'AXA', 'DG.PA': 'Vinci', 'EL.PA': 'EssilorLuxottica',
  'RI.PA': 'Pernod Ricard', 'KER.PA': 'Kering', 'VIE.PA': 'Veolia', 'ENGI.PA': 'Engie', 'BAS.DE': 'BASF',
  'BAYN.DE': 'Bayer', 'CON.DE': 'Continental', 'DBK.DE': 'Deutsche Bank', 'FRE.DE': 'Fresenius', 'IFX.DE': 'Infineon',
  'LIN.DE': 'Linde', 'MRK.DE': 'Merck KGaA', 'RWE.DE': 'RWE', 'VOW3.DE': 'Volkswagen', 'ADS.DE': 'Adidas',
  'HEN3.DE': 'Henkel', 'FME.DE': 'Fresenius Medical Care', 'SY1.DE': 'Symrise', 'ABI.BR': 'AB InBev', 'KBC.BR': 'KBC Group',
  'UCB.BR': 'UCB', 'INGA.AS': 'ING Groep', 'HEIA.AS': 'Heineken', 'PHIA.AS': 'Philips', 'AD.AS': 'Ahold Delhaize',
  'RAND.AS': 'Randstad', 'WKL.AS': 'Wolters Kluwer', 'DSFIR.AS': 'DSM-Firmenich',

  SBER: 'Сбербанк', GAZP: 'Газпром', LKOH: 'Лукойл', YDEX: 'Яндекс', TATN: 'Татнефть',
  GMKN: 'Норникель', ROSN: 'Роснефть', NVTK: 'Новатэк', PLZL: 'Полюс', VTBR: 'ВТБ',
  SNGS: 'Сургутнефтегаз', MOEX: 'Московская биржа', ALRS: 'Алроса', CHMF: 'Северсталь', MAGN: 'ММК',
  MTLR: 'Мечел', NLMK: 'НЛМК', RUAL: 'Русал', AFLT: 'Аэрофлот', FESH: 'ДВМП (FESCO)',
  FLOT: 'Совкомфлот', FEES: 'Россети', HYDR: 'РусГидро', IRAO: 'Интер РАО', AFKS: 'АФК Система',
  RTKM: 'Ростелеком', MGTS: 'МГТС', MTSS: 'МТС', BSPB: 'Банк Санкт-Петербург', CBOM: 'МКБ',
  SFIN: 'ЭсЭфАй', SMLT: 'Самолёт', LSRG: 'ЛСР', PIKK: 'ПИК', ZAYM: 'Займер',
  LENT: 'Лента', RAGR: 'РусАгро', KZOS: 'Казаньоргсинтез', PHOR: 'ФосАгро', AKRN: 'Акрон',
  UNAC: 'ОАК', NMTP: 'НМТП', SGZH: 'Сегежа', KMAZ: 'КАМАЗ', APTK: 'Аптечная сеть 36,6',

  'BINANCE:BTCUSDT': 'Bitcoin', 'BINANCE:ETHUSDT': 'Ethereum', 'BINANCE:SOLUSDT': 'Solana',
  'BINANCE:BNBUSDT': 'BNB', 'BINANCE:XRPUSDT': 'XRP', 'BINANCE:ADAUSDT': 'Cardano',
  'BINANCE:DOGEUSDT': 'Dogecoin', 'BINANCE:AVAXUSDT': 'Avalanche', 'BINANCE:DOTUSDT': 'Polkadot',
  'BINANCE:LINKUSDT': 'Chainlink',

  EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', USDJPY: 'USD/JPY', AUDUSD: 'AUD/USD', USDCAD: 'USD/CAD',
  USDCHF: 'USD/CHF', NZDUSD: 'NZD/USD', EURGBP: 'EUR/GBP', EURJPY: 'EUR/JPY', GBPJPY: 'GBP/JPY',
};

const SYMBOL_TO_MARKET = new Map();
for (const [market, list] of Object.entries(MARKETS)) {
  for (const symbol of list) SYMBOL_TO_MARKET.set(symbol, market);
}

function displaySymbol(symbol) {
  return String(symbol).replace(/^BINANCE:/, '').replace(/USDT$/, '');
}

function companyName(symbol) {
  return COMPANY_NAMES[symbol] || displaySymbol(symbol);
}

function marketOf(symbol) {
  return SYMBOL_TO_MARKET.get(symbol) || null;
}

function isKnown(symbol) {
  return SYMBOL_TO_MARKET.has(symbol);
}

module.exports = {
  MARKETS,
  MARKET_META,
  COMPANY_NAMES,
  displaySymbol,
  companyName,
  marketOf,
  isKnown,
};
