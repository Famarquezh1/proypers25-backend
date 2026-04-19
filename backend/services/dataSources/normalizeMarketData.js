function toTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value?.toDate === 'function') {
    const millis = value.toDate().getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeRow(row = {}) {
  const timestamp = toTimestamp(row.timestamp);
  const open = toNumber(row.open);
  const high = toNumber(row.high);
  const low = toNumber(row.low);
  const close = toNumber(row.close);
  const volume = toNumber(row.volume);

  if (![timestamp, open, high, low, close].every(Number.isFinite)) {
    return null;
  }

  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0
  };
}

function normalizeBinanceMarketData(rawData) {
  if (!Array.isArray(rawData)) {
    return [];
  }

  return rawData
    .map((row) => {
      if (Array.isArray(row)) {
        return normalizeRow({
          timestamp: row[0],
          open: row[1],
          high: row[2],
          low: row[3],
          close: row[4],
          volume: row[5]
        });
      }
      return normalizeRow(row);
    })
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeYahooMarketData(rawData) {
  if (!Array.isArray(rawData)) {
    return [];
  }

  return rawData
    .map((row) =>
      normalizeRow({
        timestamp: row?.date || row?.timestamp || row?.datetime || row?.time,
        open: row?.open,
        high: row?.high,
        low: row?.low,
        close: row?.close,
        volume: row?.volume
      })
    )
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function extractAlphaValue(values, explicitKeys = [], pattern = null) {
  if (!values || typeof values !== 'object') {
    return null;
  }

  for (const key of explicitKeys) {
    if (values[key] != null) {
      return values[key];
    }
  }

  if (pattern instanceof RegExp) {
    const matchedKey = Object.keys(values).find((key) => pattern.test(key));
    if (matchedKey) {
      return values[matchedKey];
    }
  }

  return null;
}

function extractAlphaSeries(rawData) {
  if (!rawData || typeof rawData !== 'object') {
    return [];
  }

  const seriesKey = Object.keys(rawData).find(
    (key) =>
      key.startsWith('Time Series Crypto') ||
      key.startsWith('Time Series (Digital Currency')
  );
  if (!seriesKey || !rawData[seriesKey] || typeof rawData[seriesKey] !== 'object') {
    return [];
  }

  return Object.entries(rawData[seriesKey]).map(([timestamp, values]) => ({
    timestamp,
    open: extractAlphaValue(values, ['1. open'], /^1(?:[ab])?\. open(?: \(.+\))?$/),
    high: extractAlphaValue(values, ['2. high'], /^2(?:[ab])?\. high(?: \(.+\))?$/),
    low: extractAlphaValue(values, ['3. low'], /^3(?:[ab])?\. low(?: \(.+\))?$/),
    close: extractAlphaValue(values, ['4. close'], /^4(?:[ab])?\. close(?: \(.+\))?$/),
    volume: extractAlphaValue(values, ['5. volume', '6. volume'], /^[56]\. volume(?: \(.+\))?$/)
  }));
}

function normalizeAlphaMarketData(rawData) {
  const rows = Array.isArray(rawData)
    ? rawData
    : extractAlphaSeries(rawData);

  return rows
    .map((row) => normalizeRow(row))
    .filter(Boolean)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeMarketData(source, rawData) {
  switch (String(source || '').toLowerCase()) {
    case 'binance':
      return normalizeBinanceMarketData(rawData);
    case 'yahoo':
      return normalizeYahooMarketData(rawData);
    case 'alpha':
      return normalizeAlphaMarketData(rawData);
    case 'cache':
    case 'stale_cache':
    case 'emergency_cache':
      return normalizeBinanceMarketData(rawData);
    default:
      return [];
  }
}

module.exports = {
  normalizeMarketData
};
