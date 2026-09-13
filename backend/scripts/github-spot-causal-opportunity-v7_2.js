'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const V70_PATH = path.join(__dirname, 'github-spot-adaptive-mixture-trainer-v7_0.js');
const REGIMES = ['TREND_UP', 'RANGE', 'VOLATILE', 'RISK_OFF'];
const INTERVAL = '5m';
const STEP = 300000;
const DAY = 86400000;
const WARM = 288;
const FWD = 288;
const PURGE = 6 * 3600000;
const COOLDOWN = 6 * 3600000;
const COST = 0.004;
const DAYS = Math.max(7, Math.min(30, Number(process.env.TRAIN_LOOKBACK_DAYS || 30)));
const POOL_SIZE = Math.max(30, Math.min(90, Number(process.env.HIST_POOL_SIZE || 60)));
const MIN_QV = Math.max(100000, Number(process.env.MIN_HIST_QUOTE_VOL_24H || 200000));
const MIN_TEST_TRADES = 10;
const FIXED_SIZE = 0.05;
const ARCHIVE = 'https://data.binance.vision/data';
const S3_INDEX = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';

const BASE_EXIT = {
  id: 'v7_0_fixed',
  hardStop: 0.05,
  beTrigger: 0.05,
  beLock: 0.002,
  trailTrigger: 0.08,
  trailGap: 0.03,
  staleBars: 216,
};

const EXIT_GRID = {
  TREND_UP: [
    { id: 'trend_balanced', hardStop: .050, beTrigger: .060, beLock: .002, trailTrigger: .100, trailGap: .035, staleBars: 240 },
    { id: 'trend_runner', hardStop: .055, beTrigger: .070, beLock: .002, trailTrigger: .120, trailGap: .045, staleBars: 264 },
    { id: 'trend_wide', hardStop: .060, beTrigger: .080, beLock: .001, trailTrigger: .140, trailGap: .050, staleBars: 276 },
  ],
  RANGE: [
    { id: 'range_fast', hardStop: .035, beTrigger: .030, beLock: .003, trailTrigger: .050, trailGap: .018, staleBars: 120 },
    { id: 'range_balanced', hardStop: .040, beTrigger: .035, beLock: .003, trailTrigger: .055, trailGap: .020, staleBars: 144 },
    { id: 'range_loose', hardStop: .045, beTrigger: .040, beLock: .002, trailTrigger: .065, trailGap: .025, staleBars: 168 },
  ],
  VOLATILE: [
    { id: 'volatile_defensive', hardStop: .045, beTrigger: .050, beLock: .002, trailTrigger: .085, trailGap: .035, staleBars: 168 },
    { id: 'volatile_balanced', hardStop: .050, beTrigger: .060, beLock: .002, trailTrigger: .100, trailGap: .040, staleBars: 192 },
    { id: 'volatile_room', hardStop: .060, beTrigger: .070, beLock: .001, trailTrigger: .120, trailGap: .050, staleBars: 216 },
  ],
  RISK_OFF: [
    { id: 'risk_fast', hardStop: .030, beTrigger: .025, beLock: .003, trailTrigger: .045, trailGap: .015, staleBars: 72 },
    { id: 'risk_balanced', hardStop: .035, beTrigger: .030, beLock: .003, trailTrigger: .050, trailGap: .018, staleBars: 96 },
    { id: 'risk_room', hardStop: .040, beTrigger: .035, beLock: .002, trailTrigger: .060, trailGap: .022, staleBars: 120 },
  ],
};

const STABLE_OR_FIAT = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USDS', 'USD1', 'RLUSD', 'BFUSD',
  'AEUR', 'EURI', 'EUR', 'GBP', 'AUD', 'BRL', 'TRY', 'UAH', 'BIDR', 'IDRT', 'NGN', 'RUB',
  'ZAR', 'PLN', 'ARS', 'MXN', 'JPY',
]);

const SPECIALIST_EVAL_CFG = {
  maxOpen: 5,
  maxExposure: 0.35,
  dailyRiskBudget: 0.02,
  ddBrake: 0.12,
  ddScale: 0.5,
  oppFloor: 0,
};
const META_FALLBACK = {
  maxOpen: 5,
  maxExposure: 0.35,
  dailyRiskBudget: 0.02,
  ddBrake: 0.12,
  ddScale: 0.5,
  oppFloor: 0.25,
};

const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = a => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, Number(x) || 0));
const pct = (a, p) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y), i = Math.floor((b.length - 1) * p);
  return b[Math.max(0, Math.min(b.length - 1, i))];
};
const isoDay = t => new Date(t).toISOString().slice(0, 10);

function loadV70() {
  let src = fs.readFileSync(V70_PATH, 'utf8').replace(/main\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__v70={agents,feat,btcMap,state,microCal,microScore,regimeWeights,opportunityScore};';
  const c = vm.createContext({ require, console, process, fetch, URLSearchParams, AbortController, setTimeout, clearTimeout });
  vm.runInContext(src, c, { filename: V70_PATH });
  return c.__v70;
}
const v = loadV70();

function normalizeTs(x) {
  x = Number(x);
  return x > 1e14 ? Math.floor(x / 1000) : x;
}

async function fetchRaw(url, { optional = false, retries = 2 } = {}) {
  let last;
  for (let n = 0; n <= retries; n++) {
    try {
      const c = new AbortController();
      const to = setTimeout(() => c.abort(), 30000);
      const r = await fetch(url, { signal: c.signal, headers: { 'user-agent': 'proypers25-v7.2-causal-research' } });
      clearTimeout(to);
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      if (n < retries) await new Promise(r => setTimeout(r, 350 * (n + 1)));
    }
  }
  if (optional) return null;
  throw last;
}

async function fetchText(url, opt = {}) {
  const b = await fetchRaw(url, opt);
  return b ? b.toString('utf8') : null;
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

async function archiveSymbols() {
  let token = null, out = [];
  for (let page = 0; page < 10; page++) {
    const u = new URL(S3_INDEX);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('delimiter', '/');
    u.searchParams.set('prefix', 'data/spot/monthly/klines/');
    if (token) u.searchParams.set('continuation-token', token);
    const xml = await fetchText(u.toString());
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)) {
      const p = decodeXml(m[1]), parts = p.split('/').filter(Boolean), sym = parts.at(-1);
      if (sym) out.push(sym);
    }
    const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const mt = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!trunc) break;
    if (!mt) throw new Error('S3 index truncated without continuation token');
    token = decodeXml(mt[1]);
  }
  return [...new Set(out)];
}

function targetSymbol(symbol) {
  if (!symbol.endsWith('USDT')) return { ok: false, why: 'quote' };
  const base = symbol.slice(0, -4);
  if (!/^[A-Z0-9]+$/.test(base)) return { ok: false, why: 'invalid' };
  if (STABLE_OR_FIAT.has(base) || base === 'USDT') return { ok: false, why: 'stableFiat' };
  if (/(UP|DOWN|BULL|BEAR)$/.test(base)) return { ok: false, why: 'leveraged' };
  return { ok: true, base };
}

function unzipSingle(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('ZIP EOCD not found');
  const cd = buf.readUInt32LE(e + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('ZIP central directory missing');
  const method = buf.readUInt16LE(cd + 10), cs = buf.readUInt32LE(cd + 20), lo = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP local header missing');
  const nl = buf.readUInt16LE(lo + 26), el = buf.readUInt16LE(lo + 28), start = lo + 30 + nl + el;
  const data = buf.subarray(start, start + cs);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression ${method}`);
}

function parseKlines(csv) {
  const out = [];
  for (const line of csv.trim().split(/\r?\n/)) {
    const x = line.split(',');
    if (x.length < 9 || !/^\d+$/.test(x[0])) continue;
    const t = normalizeTs(x[0]), o = +x[1], h = +x[2], l = +x[3], c = +x[4], q = +x[7], n = +x[8];
    if (Number.isFinite(t + o + h + l + c + q + n) && o > 0) out.push({ t, o, h, l, c, q, n });
  }
  return out;
}

async function archiveCsv(url) {
  const b = await fetchRaw(url, { optional: true, retries: 1 });
  if (!b) return null;
  try { return unzipSingle(b).toString('utf8'); }
  catch (e) { throw new Error(`archive parse ${url}: ${e.message}`); }
}

function prevCompleteMonth(start) {
  const d = new Date(start);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}
function monthParts(d) {
  return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` };
}
async function priorMonthLiquidity(symbol, month) {
  const { key } = monthParts(month);
  const csv = await archiveCsv(`${ARCHIVE}/spot/monthly/klines/${symbol}/1d/${symbol}-1d-${key}.zip`);
  if (!csv) return null;
  const rows = parseKlines(csv);
  if (rows.length < 10) return null;
  return { symbol, days: rows.length, avgDailyQuoteVolume: avg(rows.map(r => r.q)), lastTs: rows.at(-1).t };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    for (;;) {
      const j = i++;
      if (j >= items.length) return;
      try { out[j] = await fn(items[j], j); }
      catch (e) { out[j] = { __error: e.message, item: items[j] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function monthStart(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function addMonth(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

async function loadMonthOrDays(symbol, ms, rangeStart, rangeEnd, endUtc) {
  const d = new Date(ms), key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const next = addMonth(ms), currentMonth = monthStart(endUtc - 1);
  let rows = [];
  if (ms < currentMonth) {
    const csv = await archiveCsv(`${ARCHIVE}/spot/monthly/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${key}.zip`);
    if (csv) rows = parseKlines(csv);
    else {
      for (let t = Math.max(ms, rangeStart); t < Math.min(next, rangeEnd); t += DAY) {
        const ds = isoDay(t), c = await archiveCsv(`${ARCHIVE}/spot/daily/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${ds}.zip`);
        if (c) rows.push(...parseKlines(c));
      }
    }
  } else {
    for (let t = Math.max(ms, rangeStart); t < Math.min(next, rangeEnd); t += DAY) {
      const ds = isoDay(t), c = await archiveCsv(`${ARCHIVE}/spot/daily/klines/${symbol}/${INTERVAL}/${symbol}-${INTERVAL}-${ds}.zip`);
      if (c) rows.push(...parseKlines(c));
    }
  }
  return rows.filter(r => r.t >= rangeStart && r.t < rangeEnd);
}

async function loadKlines(symbol, rangeStart, rangeEnd, endUtc) {
  let rows = [];
  for (let m = monthStart(rangeStart); m < rangeEnd; m = addMonth(m)) {
    rows.push(...await loadMonthOrDays(symbol, m, rangeStart, rangeEnd, endUtc));
  }
  rows.sort((a, b) => a.t - b.t);
  const seen = new Set();
  return rows.filter(r => !seen.has(r.t) && seen.add(r.t));
}

function contiguous(r, i, back = WARM, fwd = FWD) {
  return i >= back && i + fwd < r.length &&
    r[i].t - r[i - back].t <= back * STEP + 2 * STEP &&
    r[i + fwd].t - r[i].t <= fwd * STEP + 2 * STEP;
}

function opportunity24h(s) {
  const r = s.series, e = s.index + 1, entry = r[e]?.o;
  if (!(entry > 0)) return null;
  let high = entry, low = entry, hit10 = null, ambiguous = false, stopBefore10 = false;
  for (let k = e; k < r.length && k <= s.index + FWD; k++) {
    const b = r[k], hitHigh = b.h / entry - 1 >= .10, hitRisk = b.l / entry - 1 <= -.04;
    if (hit10 === null && hitHigh) {
      if (hitRisk) ambiguous = true;
      else hit10 = (k - e) * 5;
    }
    if (hit10 === null && hitRisk) stopBefore10 = true;
    high = Math.max(high, b.h); low = Math.min(low, b.l);
  }
  const mfe = high / entry - 1, mae = low / entry - 1, pathRatio = mfe / Math.max(.005, Math.abs(mae));
  const clean = !ambiguous && hit10 !== null && hit10 <= 720 && !stopBefore10 && mae >= -.04 && pathRatio >= 2;
  return { mfeFixed24h: mfe, maeFixed24h: mae, hit10, stopBefore10, ambiguous, clean, pathRatio };
}

function simulateExit(s, p) {
  const r = s.series, e = s.index + 1, entry = r[e]?.o;
  if (!(entry > 0)) return null;
  let high = entry, low = entry, stop = entry * (1 - p.hardStop), exit = entry, exitI = e;
  let reason = 'END_OF_HORIZON', hit10 = null, stopBefore10 = false;
  for (let k = e; k < r.length && k <= s.index + FWD; k++) {
    const b = r[k];
    if (b.l <= stop) {
      low = Math.min(low, stop);
      if (hit10 === null) stopBefore10 = true;
      exit = stop; exitI = k;
      reason = stop <= entry * (1 - p.hardStop) + 1e-12 ? 'HARD_STOP' :
        stop <= entry * (1 + p.beLock) + 1e-12 ? 'BREAK_EVEN' : 'TRAILING';
      break;
    }
    high = Math.max(high, b.h); low = Math.min(low, b.l);
    if (hit10 === null && b.h / entry - 1 >= .10) hit10 = (k - e) * 5;
    const hg = high / entry - 1;
    let newStop = stop, newReason = null;
    if (hg >= p.trailTrigger) { newStop = Math.max(stop, high * (1 - p.trailGap)); newReason = 'TRAILING'; }
    else if (hg >= p.beTrigger) { newStop = Math.max(stop, entry * (1 + p.beLock)); newReason = 'BREAK_EVEN'; }
    if (newStop > stop && b.l <= newStop) {
      stop = newStop;
      if (hit10 === null) stopBefore10 = true;
      exit = stop; exitI = k; reason = newReason;
      break;
    }
    stop = newStop;
    if (k - e >= p.staleBars && hg <= .005) {
      exit = b.c; exitI = k; reason = 'STALE_TIMEOUT';
      break;
    }
    exit = b.c; exitI = k;
  }
  const gross = exit / entry - 1, net = gross - COST, mfeDuring = high / entry - 1, opp = s.opp24;
  const c24 = opp && opp.mfeFixed24h > 0 ? clamp(Math.max(0, net) / opp.mfeFixed24h, 0, 1) : 0;
  const cd = mfeDuring > 0 ? clamp(Math.max(0, net) / mfeDuring, 0, 1) : 0;
  const loss = opp ? Math.max(0, opp.mfeFixed24h - Math.max(0, net)) : 0;
  return {
    net, gross, mfeDuringTrade: mfeDuring, mfeFixed24h: opp?.mfeFixed24h || 0,
    captureRatioDuringTrade: cd, captureRatioFixed24h: c24, captureLoss24h: loss,
    holdingMin: (exitI - e) * 5, exitReason: reason, stopBefore10, hit10,
  };
}

function onsetFor(s, bm) {
  const r = s.series, i = s.index, from = Math.max(WARM, i - 72);
  let lastOnset = null, prev = [false, false, false];
  for (let k = from; k <= i; k++) {
    let cond = false;
    try {
      const f = v.feat(r, k, bm);
      cond = f.r15 >= .004 && f.vol15 >= 1.15 && (f.breakout60 >= -.002 || f.rs60 > 0);
    } catch {}
    if (cond && !prev.some(Boolean)) lastOnset = r[k].t;
    prev = [prev[1], prev[2], cond];
  }
  return lastOnset === null ? null : Math.max(0, (s.t - lastOnset) / 60000);
}

function thresholds(samples, q) {
  const out = {};
  for (const [n, fn] of Object.entries(v.agents)) out[n] = pct(samples.map(s => fn(s.f)), q);
  return out;
}
function specialistConfigs() {
  const out = [];
  for (const q of [.80, .86, .92]) for (const consensus of [2, 3, 4])
    for (const microWeight of [.25, .5]) for (const minQuality of [.30, .45])
      out.push({ q, consensus, microWeight, minQuality });
  return out;
}
function entryQuality(s, p, cal) {
  const st = v.state(s, p.th);
  if (st.passed < p.cfg.consensus) return null;
  const ms = v.microScore(s.f, cal);
  const bq = clamp((st.passed - p.cfg.consensus + 1) / Math.max(1, 6 - p.cfg.consensus));
  const mq = clamp((st.margin + .15) / .75);
  const quality = clamp((1 - p.cfg.microWeight) * (.65 * bq + .35 * mq) + p.cfg.microWeight * ms);
  if (quality < p.cfg.minQuality) return null;
  return { quality, agreement: st.passed / 5, margin: st.margin };
}

function dedupeEntries(rows) {
  const out = [], until = new Map();
  for (const s of [...rows].sort((a, b) => a.t - b.t)) {
    if (s.t < (until.get(s.symbol) || 0)) continue;
    out.push(s); until.set(s.symbol, s.t + COOLDOWN);
  }
  return out;
}

function summarizeTrades(trades, base = {}) {
  const outs = trades.map(x => x.out);
  const clean = trades.filter(x => x.s.opp24?.clean);
  const cleanIds = new Set(clean.map(x => `${x.s.symbol}:${Math.floor(x.s.t / COOLDOWN)}`));
  const delays = trades.map(x => x.s.detectionDelayMinutes).filter(Number.isFinite);
  const ext = trades.map(x => x.s.f.r24 * 100);
  return {
    ...base,
    tradeCount: trades.length,
    wins: outs.filter(o => o.net > 0).length,
    losses: outs.filter(o => o.net <= 0).length,
    winRate: trades.length ? outs.filter(o => o.net > 0).length / trades.length : 0,
    avgNetRet: avg(outs.map(o => o.net)),
    medianNetRet: median(outs.map(o => o.net)),
    avgCaptureRatioDuringTrade: avg(outs.map(o => o.captureRatioDuringTrade)),
    medianCaptureRatioDuringTrade: median(outs.map(o => o.captureRatioDuringTrade)),
    avgCaptureRatioFixed24h: avg(outs.map(o => o.captureRatioFixed24h)),
    medianCaptureRatioFixed24h: median(outs.map(o => o.captureRatioFixed24h)),
    avgMFEFixed24h: avg(outs.map(o => o.mfeFixed24h)),
    medianMFEFixed24h: median(outs.map(o => o.mfeFixed24h)),
    avgCaptureLoss24h: avg(outs.map(o => o.captureLoss24h)),
    medianCaptureLoss24h: median(outs.map(o => o.captureLoss24h)),
    avgHoldingMinutes: avg(outs.map(o => o.holdingMin)),
    stopBefore10Rate: trades.length ? outs.filter(o => o.stopBefore10).length / trades.length : 0,
    avgSize: avg(trades.map(x => x.size)),
    avgQuality: avg(trades.map(x => x.s.quality)),
    avgOpportunity: avg(trades.map(x => x.s.opportunity)),
    precision: trades.length ? clean.length / trades.length : 0,
    detectedCleanIds: cleanIds.size,
    avgDetectionDelayMinutes: avg(delays),
    medianDetectionDelayMinutes: median(delays),
    timingSampleCount: delays.length,
    timingCoverage: trades.length ? delays.length / trades.length : 0,
    entryExtension24hPct: avg(ext),
  };
}
function withRecall(m, trades, all) {
  const allClean = new Set(all.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
  const det = new Set(trades.filter(x => x.s.opp24?.clean).map(x => `${x.s.symbol}:${Math.floor(x.s.t / COOLDOWN)}`));
  m.recall = allClean.size ? det.size / allClean.size : 0;
  delete m.detectedCleanIds;
  return m;
}
function stripMetrics(m) {
  if (!m) return null;
  const c = { ...m };
  delete c._trades; delete c.detectedCleanIds;
  return c;
}

function simpleTradeMetrics(rows, outcomeFn, sizeFn = () => FIXED_SIZE) {
  let eq = 1, peak = 1, dd = 0;
  const trades = [];
  for (const s of rows) {
    const out = outcomeFn(s);
    if (!out) continue;
    const size = sizeFn(s);
    eq *= 1 + size * out.net;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    trades.push({ s, out, size });
  }
  const m = summarizeTrades(trades, { netGrowth: eq - 1, maxDrawdown: dd });
  m._trades = trades;
  return m;
}

function portfolio(cands, all, cfg, outcomeFn, sizeFn, riskFn = () => BASE_EXIT.hardStop) {
  let eq = 1, peak = 1, dd = 0, open = [];
  let skippedByConcurrency = 0, skippedByExposure = 0, skippedByRisk = 0;
  const dayRisk = new Map(), trades = [];
  const close = t => {
    const keep = [];
    for (const p of open) {
      if (p.exitT <= t) {
        eq *= 1 + p.size * p.out.net; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
      } else keep.push(p);
    }
    open = keep;
  };
  for (const s of cands) {
    close(s.t);
    if (open.length >= cfg.maxOpen) { skippedByConcurrency++; continue; }
    const out = outcomeFn(s); if (!out) continue;
    let size = sizeFn(s);
    if (dd <= -cfg.ddBrake) size *= cfg.ddScale;
    const exposure = open.reduce((a, p) => a + p.size, 0);
    if (exposure + size > cfg.maxExposure) size = Math.max(0, cfg.maxExposure - exposure);
    if (size < .008) { skippedByExposure++; continue; }
    const day = isoDay(s.t), risk = size * riskFn(s), used = dayRisk.get(day) || 0;
    if (used + risk > cfg.dailyRiskBudget) { skippedByRisk++; continue; }
    dayRisk.set(day, used + risk);
    trades.push({ s, out, size });
    open.push({ s, out, size, exitT: s.t + out.holdingMin * 60000 });
  }
  close(Infinity);
  const summary = summarizeTrades(trades, { netGrowth: eq - 1, maxDrawdown: dd });
  summary.skippedByConcurrency = skippedByConcurrency;
  summary.skippedByExposure = skippedByExposure;
  summary.skippedByRisk = skippedByRisk;
  summary._trades = trades;
  return summary;
}

function specialistRows(samples, policy, cal) {
  const rows = [];
  for (const s of samples) {
    const e = entryQuality(s, policy, cal);
    if (!e) continue;
    rows.push({
      ...s,
      quality: e.quality,
      agreement: e.agreement,
      regimeConfidence: Math.max(...Object.values(s.regimeWeights)),
      activationWeight: s.regimeWeights[s.primaryRegime] || 0,
    });
  }
  return dedupeEntries(rows);
}

function continuousActivation(m) {
  if (!m || m.tradeCount < 5) return 0;
  const d = Math.abs(m.maxDrawdown);
  const ddFactor = d <= .06 ? 1 : d >= .24 ? .15 : 1 - .85 * ((d - .06) / .18);
  const retFactor = m.avgNetRet >= 0 ? .75 + .25 * clamp(m.avgNetRet / .02) :
    m.avgNetRet <= -.015 ? 0 : .75 * clamp(1 + m.avgNetRet / .015);
  const growthFactor = m.netGrowth >= 0 ? 1 : clamp(1 + m.netGrowth / .25);
  const evidenceFactor = clamp(m.tradeCount / 25, .35, 1);
  const raw = ddFactor * retFactor * growthFactor * evidenceFactor;
  if (m.avgNetRet <= -.015 || (m.netGrowth <= -.25 && m.avgNetRet < -.005)) return 0;
  return clamp(raw, .03, 1);
}

function choosePolicies(train, val, cal) {
  const out = {};
  for (const rg of REGIMES) {
    const tr = train.filter(s => s.primaryRegime === rg), va = val.filter(s => s.primaryRegime === rg);
    let best = null;
    if (tr.length >= 80 && va.length >= 20) {
      for (const cfg of specialistConfigs()) {
        const th = thresholds(tr, cfg.q), policy = { cfg, th };
        const rows = specialistRows(va, policy, cal);
        const m = portfolio(rows, va, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
        withRecall(m, m._trades || [], va);
        const part = rows.length ? m.tradeCount / rows.length : 0;
        const score = m.tradeCount < 5 ? -1e9 :
          m.netGrowth * 6 + m.avgNetRet * 20 + m.winRate * .5 + m.precision * .5 + m.recall * .5
          - Math.max(0, Math.abs(m.maxDrawdown) - .12) * 20 - Math.max(0, .35 - part);
        if (!best || score > best.score) best = {
          cfg, th, validation: stripMetrics(m), score,
          audit: { rawValidationSamples: va.length, dedupedCandidates: rows.length, admittedTrades: m.tradeCount, participationRate: part },
        };
      }
    }
    if (!best || best.score <= -1e8) {
      out[rg] = { activation: 0, cfg: null, th: null, validation: null, score: -1e9, selectedByEvidence: false, audit: { rawValidationSamples: va.length, dedupedCandidates: 0, admittedTrades: 0, participationRate: 0 } };
      continue;
    }
    out[rg] = { ...best, activation: continuousActivation(best.validation), selectedByEvidence: true };
  }
  return out;
}

function evaluateEntry(s, policies, cal, oppFloor = 0, useActivation = true) {
  let qsumw = 0, asum = 0, wz = 0, passedAny = false, qualityAny = false;
  for (const rg of REGIMES) {
    const p = policies[rg];
    if (!p?.th) continue;
    const rw = s.regimeWeights[rg] || 0;
    if (rw < .10) continue;
    const st = v.state(s, p.th);
    if (st.passed < p.cfg.consensus) continue;
    passedAny = true;
    const e = entryQuality(s, p, cal);
    if (!e) continue;
    qualityAny = true;
    const activation = useActivation ? p.activation : 1;
    const w = rw * Math.max(0, activation);
    if (w <= 0) continue;
    qsumw += w * e.quality; asum += w * e.agreement; wz += w;
  }
  if (!passedAny || !qualityAny) return { reason: 'QUALITY' };
  if (wz <= 0) return { reason: 'REGIME_ACTIVATION' };
  if (s.opportunity < oppFloor) return { reason: 'QUALITY' };
  const rawQuality = qsumw / wz;
  const activationConfidence = useActivation ? clamp(wz / .25, .10, 1) : 1;
  const quality = clamp(rawQuality * (.80 + .20 * Math.sqrt(activationConfidence)));
  return {
    candidate: {
      ...s,
      quality,
      rawQuality,
      agreement: asum / wz,
      regimeConfidence: Math.max(...Object.values(s.regimeWeights)),
      activationWeight: wz,
      activationConfidence,
    },
  };
}

function buildCandidates(samples, policies, cal, oppFloor, useActivation = true) {
  const rows = [], stats = { skippedByQuality: 0, skippedByRegimeActivation: 0 };
  for (const s of samples) {
    const e = evaluateEntry(s, policies, cal, oppFloor, useActivation);
    if (e.candidate) rows.push(e.candidate);
    else if (e.reason === 'REGIME_ACTIVATION') stats.skippedByRegimeActivation++;
    else stats.skippedByQuality++;
  }
  return { rows: dedupeEntries(rows), stats };
}

function blendExit(s, selected) {
  const keys = ['hardStop', 'beTrigger', 'beLock', 'trailTrigger', 'trailGap', 'staleBars'];
  const o = Object.fromEntries(keys.map(k => [k, 0]));
  let z = 0;
  for (const rg of REGIMES) {
    const p = selected[rg] || BASE_EXIT, w = Math.max(0, s.regimeWeights[rg] || 0);
    z += w; for (const k of keys) o[k] += w * p[k];
  }
  if (!z) return { ...BASE_EXIT };
  for (const k of keys) o[k] /= z;
  o.staleBars = Math.max(60, Math.min(FWD - 6, Math.round(o.staleBars)));
  o.id = 'blended';
  return o;
}

function exitScore(m) {
  if (m.tradeCount < 5) return -1e9;
  return m.netGrowth * 6 + m.avgNetRet * 24 + m.avgCaptureRatioFixed24h * 1.4
    - m.avgCaptureLoss24h * 2 + m.winRate * .4 - Math.max(0, Math.abs(m.maxDrawdown) - .12) * 20;
}

function chooseExits(trainC, valC) {
  const selected = {}, evidence = {};
  let evidenceRegimes = 0;
  for (const rg of REGIMES) {
    const a = trainC.filter(s => s.primaryRegime === rg), b = valC.filter(s => s.primaryRegime === rg);
    let best = null; const trials = [];
    for (const p of EXIT_GRID[rg]) {
      const tm = simpleTradeMetrics(a, s => simulateExit(s, p)), vm = simpleTradeMetrics(b, s => simulateExit(s, p));
      const score = tm.tradeCount < 5 || vm.tradeCount < 5 ? -1e9 : .35 * exitScore(tm) + .65 * exitScore(vm);
      const row = { profile: p, train: stripMetrics(tm), validation: stripMetrics(vm), score };
      trials.push(row); if (!best || score > best.score) best = row;
    }
    if (!best || best.score <= -1e8) {
      selected[rg] = { ...BASE_EXIT, id: `${rg.toLowerCase()}_fallback_baseline` };
      evidence[rg] = { fallback: true, selectedByEvidence: false, trainTrades: a.length, validationTrades: b.length, trials };
    } else {
      selected[rg] = best.profile; evidenceRegimes++;
      evidence[rg] = { fallback: false, selectedByEvidence: true, trainTrades: a.length, validationTrades: b.length, selected: best, trials };
    }
  }
  return { selected, evidence, evidenceRegimes, selectedByEvidence: evidenceRegimes > 0 };
}

function sizingGrid() {
  const ws = [
    { quality: .45, opportunity: .20, regime: .20, agreement: .15 },
    { quality: .35, opportunity: .30, regime: .20, agreement: .15 },
    { quality: .40, opportunity: .20, regime: .15, agreement: .25 },
  ], out = [];
  for (const minSize of [.008, .012]) for (const maxSize of [.08, .10, .12])
    for (const gamma of [1.10, 1.35]) for (const weights of ws) out.push({ minSize, maxSize, gamma, weights });
  return out;
}
function asymSize(s, c) {
  if (!c) return FIXED_SIZE;
  const r = s.regimeWeights;
  const fav = clamp(.55 + .55 * (r.TREND_UP || 0) + .10 * (r.VOLATILE || 0) - .45 * (r.RISK_OFF || 0), .15, 1);
  const reg = clamp(s.regimeConfidence * fav);
  const q = clamp(c.weights.quality * s.quality + c.weights.opportunity * s.opportunity + c.weights.regime * reg + c.weights.agreement * s.agreement);
  return c.minSize + (c.maxSize - c.minSize) * Math.pow(q, c.gamma);
}
function chooseSizing(valC, selected) {
  for (const s of valC) { s.adaptiveExit = blendExit(s, selected); s.adaptiveOutcome = simulateExit(s, s.adaptiveExit); }
  let best = null;
  for (const cfg of sizingGrid()) {
    const m = simpleTradeMetrics(valC, s => s.adaptiveOutcome, s => asymSize(s, cfg));
    const score = m.tradeCount < 10 ? -1e9 : m.netGrowth * 8 + m.avgNetRet * 18 + m.avgCaptureRatioFixed24h * .8
      - Math.max(0, Math.abs(m.maxDrawdown) - .12) * 20;
    if (score > -1e8 && (!best || score > best.score)) best = { cfg, validation: stripMetrics(m), score };
  }
  if (!best) return { cfg: null, validation: null, score: -1e9, selectedByEvidence: false };
  return { ...best, selectedByEvidence: true };
}

function metaGrid() {
  const out = [];
  for (const maxOpen of [5, 8]) for (const maxExposure of [.35, .55])
    for (const dailyRiskBudget of [.02, .03]) for (const ddBrake of [.08, .12])
      for (const oppFloor of [.25, .35]) out.push({ maxOpen, maxExposure, dailyRiskBudget, ddBrake, ddScale: .5, oppFloor });
  return out;
}
function chooseMeta(val, policies, cal) {
  let best = null;
  for (const cfg of metaGrid()) {
    const b = buildCandidates(val, policies, cal, cfg.oppFloor, true);
    const m = portfolio(b.rows, val, cfg, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], val);
    const part = b.rows.length ? m.tradeCount / b.rows.length : 0;
    const score = m.tradeCount < 10 ? -1e9 : m.netGrowth * 7 + m.avgNetRet * 18 + m.winRate * .5 + m.recall * .4
      - Math.max(0, Math.abs(m.maxDrawdown) - .12) * 20 - Math.max(0, .5 - part);
    if (score > -1e8 && (!best || score > best.score)) best = { cfg, validation: stripMetrics(m), entryStats: b.stats, score };
  }
  if (!best) {
    const b = buildCandidates(val, policies, cal, META_FALLBACK.oppFloor, true);
    const m = portfolio(b.rows, val, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], val);
    return { cfg: META_FALLBACK, validation: stripMetrics(m), entryStats: b.stats, score: -1e9, selectedByEvidence: false };
  }
  return { ...best, selectedByEvidence: true };
}

function regimeAttribution(trades, all) {
  const out = {};
  for (const rg of REGIMES) {
    const ts = trades.filter(x => x.s.primaryRegime === rg), as = all.filter(s => s.primaryRegime === rg);
    const m = withRecall(summarizeTrades(ts, { netGrowthContribution: ts.reduce((z, x) => z + x.size * x.out.net, 0) }), ts, as);
    const reasons = {}; for (const x of ts) reasons[x.out.exitReason] = (reasons[x.out.exitReason] || 0) + 1;
    out[rg] = { ...stripMetrics(m), candidateOpportunities: as.filter(s => s.opp24?.clean).length, entryQuality: avg(ts.map(x => x.s.quality)), opportunityBreadth: avg(ts.map(x => x.s.opportunity)), exitReasons: reasons };
  }
  return out;
}
function exitReasonAttribution(trades) {
  const out = {};
  for (const reason of ['HARD_STOP', 'BREAK_EVEN', 'TRAILING', 'STALE_TIMEOUT', 'END_OF_HORIZON']) {
    const ts = trades.filter(x => x.out.exitReason === reason), m = summarizeTrades(ts);
    out[reason] = { count: ts.length, avgNetRet: m.avgNetRet, avgMFEFixed24h: m.avgMFEFixed24h, avgCaptureRatioFixed24h: m.avgCaptureRatioFixed24h, avgCaptureLoss24h: m.avgCaptureLoss24h, avgHoldingMinutes: m.avgHoldingMinutes };
  }
  return out;
}
function pairedDelta(a, b) {
  return {
    netGrowth: b.netGrowth - a.netGrowth,
    avgNetRet: b.avgNetRet - a.avgNetRet,
    maxDrawdown: b.maxDrawdown - a.maxDrawdown,
    avgCaptureRatioFixed24h: b.avgCaptureRatioFixed24h - a.avgCaptureRatioFixed24h,
    avgCaptureLoss24h: b.avgCaptureLoss24h - a.avgCaptureLoss24h,
    avgHoldingMinutes: b.avgHoldingMinutes - a.avgHoldingMinutes,
    winRate: b.winRate - a.winRate,
    tradeCount: b.tradeCount - a.tradeCount,
  };
}
function validationStability(valC, selected, sizeCfg) {
  const chunks = [];
  if (!valC.length) return chunks;
  const t0 = valC[0].t, t1 = valC.at(-1).t, span = Math.max(1, t1 - t0);
  for (let k = 0; k < 3; k++) {
    const a = t0 + span * k / 3, b = t0 + span * (k + 1) / 3;
    const rows = valC.filter(s => s.t >= a && (k === 2 ? s.t <= b : s.t < b));
    const m = simpleTradeMetrics(rows, s => simulateExit(s, blendExit(s, selected)), s => asymSize(s, sizeCfg));
    chunks.push({ fold: k + 1, trades: m.tradeCount, netGrowth: m.netGrowth, avgNetRet: m.avgNetRet, maxDrawdown: m.maxDrawdown, avgCaptureRatioFixed24h: m.avgCaptureRatioFixed24h });
  }
  return chunks;
}

function decide(test) {
  const { baseline, full, pairedExit, participation, selectionEvidence } = test;
  if (full.tradeCount < MIN_TEST_TRADES || baseline.tradeCount < MIN_TEST_TRADES) {
    return { ready: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'Untouched TEST has too few comparable admitted trades.' };
  }
  if (!selectionEvidence.meta || !selectionEvidence.exit || !selectionEvidence.sizing) {
    return { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'TEST is measurable, but one or more META/EXIT/SIZING components lacked TRAIN/VALIDATION evidence and used a fallback.' };
  }
  const activeRegimes = REGIMES.filter(r => test.regimeAttribution[r]?.tradeCount >= 3).length;
  const positive = full.netGrowth > 0;
  const econ = full.netGrowth > baseline.netGrowth && full.avgNetRet > baseline.avgNetRet;
  const cap = full.avgCaptureRatioFixed24h > baseline.avgCaptureRatioFixed24h && full.avgCaptureLoss24h < baseline.avgCaptureLoss24h;
  const dd = full.maxDrawdown >= -.12;
  const timing = full.timingCoverage >= .5 && baseline.timingCoverage >= .5 && full.avgDetectionDelayMinutes <= baseline.avgDetectionDelayMinutes + 30;
  const part = full.tradeCount >= baseline.tradeCount * .65 && participation.participationRate >= .45;
  const exitPure = pairedExit.delta.netGrowth > 0 && pairedExit.delta.avgNetRet > 0 && pairedExit.delta.avgCaptureRatioFixed24h > 0;
  const coverage = activeRegimes >= 2;
  const notSizingOnly = test.causalAttribution.exitEffect.netGrowth > 0 && test.causalAttribution.selectionEffect.selectedNetGrowth !== null;
  const ready = positive && econ && cap && dd && timing && part && exitPure && coverage && notSizingOnly;
  if (ready) return { ready: true, label: 'READY_FOR_SHADOW_VALIDATION', reason: 'Untouched TEST shows positive pure-exit edge, improved fixed-24h capture, safe drawdown/timing/participation, multi-regime coverage, and gains are not sizing-only.' };
  if (!part) return { ready: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'Economic evidence is not accepted because participation collapses.' };
  if (!exitPure && pairedExit.delta.avgCaptureRatioFixed24h <= 0) return { ready: false, label: 'REQUIRES_REDESIGN', reason: 'Pure EXIT attribution does not improve economics/capture on paired untouched TEST entries.' };
  return { ready: false, label: 'REQUIRES_IMPROVEMENT', reason: 'V7.2 is measurable but does not satisfy every causal economic, capture, risk, timing, participation and regime-coverage gate.' };
}

function writeReport(r) {
  const d = path.join('backend', 'training-output');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'spot-causal-opportunity-v7_2-report.json'), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
}

async function main() {
  const now = new Date();
  const END = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const START = END - DAYS * DAY, LOAD_START = START - DAY, LOAD_END = END, preMonth = prevCompleteMonth(START);
  console.log(`V7.2 causal research ${DAYS}d ${isoDay(START)}..${isoDay(END - 1)} pool=${POOL_SIZE}`);

  const allSymbols = await archiveSymbols();
  const audit = {
    archiveSymbols: allSymbols.length,
    excludedStableFiat: 0, excludedLeveraged: 0, excludedInvalid: 0, excludedOtherQuote: 0,
    priorMonthAvailable: 0, selectedPool: 0,
    prefilterMonth: monthParts(preMonth).key,
    selectionCutoff: new Date(START).toISOString(),
    selectionUsesCurrentTicker: false,
    selectionUsesFutureVolume: false,
    survivorshipControl: 'No current ticker or current exchangeInfo is used. Candidate symbols come from Binance Vision historical archive prefixes; symbols are eligible only if their own pre-window archive history exists.',
    minimumHistoryPolicy: 'Target must have >=10 daily rows in the last complete calendar month strictly before the research window; ranking uses only that pre-window quote volume. Point-in-time 24h rolling quote volume is rechecked at every signal timestamp.',
  };
  const targets = [];
  for (const s of allSymbols) {
    const t = targetSymbol(s);
    if (t.ok) targets.push(s);
    else if (t.why === 'stableFiat') audit.excludedStableFiat++;
    else if (t.why === 'leveraged') audit.excludedLeveraged++;
    else if (t.why === 'invalid') audit.excludedInvalid++;
    else audit.excludedOtherQuote++;
  }

  const liq = await mapLimit(targets, 20, s => priorMonthLiquidity(s, preMonth));
  const ranked = liq.filter(x => x && !x.__error && x.avgDailyQuoteVolume >= MIN_QV)
    .sort((a, b) => b.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  audit.priorMonthAvailable = ranked.length;
  const pool = ranked.slice(0, POOL_SIZE).map(x => x.symbol);
  audit.selectedPool = pool.length;
  if (!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');
  if (pool.length < 20) return writeReport({ version: 'V7.2', researchOnly: true, lookbackDays: DAYS, universeAudit: audit, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Historical archive universe produced too few causal pre-window symbols.' } });

  const data = new Map();
  const loaded = await mapLimit(pool, 8, async s => ({ symbol: s, rows: await loadKlines(s, LOAD_START, LOAD_END, END) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  audit.loadedSymbols = data.size;
  const btc = data.get('BTCUSDT');
  if (!btc?.length) throw new Error('BTCUSDT historical archive unavailable');

  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();
  for (const [symbol, r] of data) {
    if (symbol === 'BTCUSDT' || r.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < r.length - FWD; i++) {
      const t = r[i].t;
      if (t < START || t >= END - FWD * STEP || !contiguous(r, i)) continue;
      let f; try { f = v.feat(r, i, bm); } catch { continue; }
      if (f.qv < MIN_QV) continue;
      const b = breadth.get(t) || { n: 0, up15: 0, up60: 0, breakout: 0, ignite: 0, sum60: 0 };
      b.n++; if (f.r15 > 0) b.up15++; if (f.r60 > 0) b.up60++; if (f.breakout60 > 0) b.breakout++;
      if (f.vol15 > 1.2) b.ignite++; b.sum60 += f.r60; breadth.set(t, b);
      featureRows.push({ symbol, t, f, series: r, index: i });
    }
  }

  const raw = [];
  for (const s of featureRows) {
    if (s.f.r24 < .001 || s.f.r24 >= .18 || s.f.r60 >= .10 || s.f.r15 >= .06) continue;
    const b = breadth.get(s.t);
    const bd = b && b.n ? { up15: b.up15 / b.n, up60: b.up60 / b.n, breakout: b.breakout / b.n, ignite: b.ignite / b.n, mean60: b.sum60 / b.n }
      : { up15: .5, up60: .5, breakout: .5, ignite: .5, mean60: 0 };
    s.breadth = bd; s.regimeWeights = v.regimeWeights(s.f, bd);
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, b) => b[1] - a[1])[0][0];
    s.opportunity = v.opportunityScore(bd); s.opp24 = opportunity24h(s); s.o = { clean: Boolean(s.opp24?.clean) };
    s.detectionDelayMinutes = onsetFor(s, bm); raw.push(s);
  }
  raw.sort((a, b) => a.t - b.t);
  if (raw.length < 600) return writeReport({ version: 'V7.2', researchOnly: true, lookbackDays: DAYS, universeAudit: audit, samples: { all: raw.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Too few causal eligible samples after point-in-time universe filtering.' } });

  const t0 = raw[0].t, t1 = raw.at(-1).t, span = t1 - t0, c1 = t0 + span * .45, c2 = t0 + span * .80, horizon = FWD * STEP;
  const train = raw.filter(x => x.t < c1 - horizon);
  const val = raw.filter(x => x.t > c1 + PURGE && x.t < c2 - horizon);
  const test = raw.filter(x => x.t > c2 + PURGE);
  if (train.length < 200 || val.length < 80 || test.length < 80) return writeReport({ version: 'V7.2', researchOnly: true, lookbackDays: DAYS, universeAudit: audit, samples: { all: raw.length, train: train.length, validation: val.length, test: test.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Embargoed chronological split is too small.' } });

  const cal = v.microCal(train);
  const policies = choosePolicies(train, val, cal);
  const meta = chooseMeta(val, policies, cal);
  const trB = buildCandidates(train, policies, cal, meta.cfg.oppFloor, true);
  const vaB = buildCandidates(val, policies, cal, meta.cfg.oppFloor, true);
  const teB = buildCandidates(test, policies, cal, meta.cfg.oppFloor, true);
  const teQualityOnly = buildCandidates(test, policies, cal, meta.cfg.oppFloor, false);
  const exitSel = chooseExits(trB.rows, vaB.rows);
  const sizing = chooseSizing(vaB.rows, exitSel.selected);

  for (const s of teB.rows) {
    s.adaptiveExit = blendExit(s, exitSel.selected);
    s.baseOutcome = simulateExit(s, BASE_EXIT);
    s.adaptiveOutcome = simulateExit(s, s.adaptiveExit);
  }
  for (const s of teQualityOnly.rows) s.baseOutcome = simulateExit(s, BASE_EXIT);

  const pairBaseRaw = simpleTradeMetrics(teB.rows, s => s.baseOutcome);
  const pairAdaptRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome);
  const sizeFixedRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome);
  const sizeAsymRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome, s => asymSize(s, sizing.cfg));
  const selectionQualityOnlyRaw = simpleTradeMetrics(teQualityOnly.rows, s => s.baseOutcome);
  const selectionSelectedRaw = simpleTradeMetrics(teB.rows, s => s.baseOutcome);
  for (const m of [pairBaseRaw, pairAdaptRaw, sizeFixedRaw, sizeAsymRaw, selectionQualityOnlyRaw, selectionSelectedRaw]) withRecall(m, m._trades || [], test);

  const fullBase = portfolio(teB.rows, test, meta.cfg, s => s.baseOutcome, () => FIXED_SIZE, () => BASE_EXIT.hardStop);
  const full = portfolio(teB.rows, test, meta.cfg, s => s.adaptiveOutcome, s => asymSize(s, sizing.cfg), s => s.adaptiveExit.hardStop);
  withRecall(fullBase, fullBase._trades, test); withRecall(full, full._trades, test);

  const reg = regimeAttribution(full._trades, test), reasons = exitReasonAttribution(full._trades);
  const participation = {
    candidateSignals: teB.rows.length,
    admittedTrades: full.tradeCount,
    participationRate: teB.rows.length ? full.tradeCount / teB.rows.length : 0,
    qualityOnlyCandidateSignals: teQualityOnly.rows.length,
    baselineTrades: fullBase.tradeCount,
    adaptiveTrades: full.tradeCount,
    skippedByRisk: full.skippedByRisk,
    skippedByExposure: full.skippedByExposure,
    skippedByRegimeActivation: teB.stats.skippedByRegimeActivation,
    skippedByQuality: teB.stats.skippedByQuality,
    skippedByConcurrency: full.skippedByConcurrency,
  };

  const pairedExit = { baselineExitFixedSize: stripMetrics(pairBaseRaw), adaptiveExitFixedSize: stripMetrics(pairAdaptRaw), delta: pairedDelta(pairBaseRaw, pairAdaptRaw) };
  const sizingAttribution = { adaptiveExitFixedSize: stripMetrics(sizeFixedRaw), adaptiveExitAsymmetricSize: stripMetrics(sizeAsymRaw), delta: pairedDelta(sizeFixedRaw, sizeAsymRaw) };
  const entrySelectionAttribution = {
    qualityOnlyEntrySet: stripMetrics(selectionQualityOnlyRaw),
    activatedEntrySet: stripMetrics(selectionSelectedRaw),
    delta: pairedDelta(selectionQualityOnlyRaw, selectionSelectedRaw),
    interpretation: 'Same baseline exit and fixed size; delta isolates the economic effect of regime activation/entry selection on the signal set before EXIT and SIZING changes.',
  };
  const causalAttribution = {
    selectionEffect: {
      qualityOnlyNetGrowth: selectionQualityOnlyRaw.netGrowth,
      selectedNetGrowth: selectionSelectedRaw.netGrowth,
      netGrowth: selectionSelectedRaw.netGrowth - selectionQualityOnlyRaw.netGrowth,
      tradeCountDelta: selectionSelectedRaw.tradeCount - selectionQualityOnlyRaw.tradeCount,
    },
    exitEffect: pairedExit.delta,
    sizingEffect: sizingAttribution.delta,
  };

  const activeRegimes = REGIMES.filter(r => reg[r].tradeCount >= 3).length;
  const selectionEvidence = { meta: meta.selectedByEvidence, exit: exitSel.selectedByEvidence, sizing: sizing.selectedByEvidence };
  const decision = decide({ baseline: fullBase, full, pairedExit, regimeAttribution: reg, participation, selectionEvidence, causalAttribution });

  const report = {
    generatedAt: new Date().toISOString(), version: 'V7.2', experiment: 'Causal Opportunity Capture & Regime Attribution',
    researchOnly: true, publicDataOnly: true, privateBinanceUsed: false, firestoreUsed: false,
    productionTradingTouched: false, automaticPromotion: false, interval: INTERVAL, lookbackDays: DAYS,
    methodology: {
      objective: 'Separate entry selection, exit, sizing and portfolio-control effects using causal historical eligibility and paired TEST comparisons.',
      costFraction: COST, fixedSizingForPureExit: FIXED_SIZE,
      specialistActivation: 'Specialist risk/edge is estimated on cooldown-deduplicated validation candidates passed through a fixed executable portfolio control. Activation is continuous; no hidden positive-weight cutoff removes signals.',
      universe: 'Historical Binance Vision archive index; ranking uses only the last complete calendar month before window start; rolling 24h historical quote volume re-validates eligibility at every timestamp.',
      walkForward: 'Three chronological validation-stability slices with frozen TRAIN/VALIDATION-selected configuration; final TEST remains untouched.',
    },
    leakageAudit: {
      currentTickerUsedForUniverse: false, currentExchangeInfoUsedForUniverse: false, archiveIndexHistoricalSymbols: true,
      universeRankingCutoffStrictlyBeforeWindow: true, rollingLiquidityUsesOnlyPastAndCurrentBars: true,
      featuresUseFuture: false, regimesUseFuture: false, testUsedForThresholdSelection: false,
      testUsedForExitSelection: false, testUsedForSizingSelection: false, mfeFixed24hUsedForEntryDecision: false,
      mfeFixed24hUsedForTestSelection: false, testUntouchedUntilFreeze: true,
      specialistValidationUsesCooldownDeduplication: true, specialistValidationUsesExecutablePortfolioControl: true,
      zeroTradeWindowsCountAsSafe: false,
    },
    universeAudit: audit,
    intrabarPolicy: {
      resolution: 'CONSERVATIVE_5M',
      reason: '1m expansion across four windows and the causal archive pool would make the first V7.2 harness materially heavier; 5m is retained with adverse ambiguity handling.',
      stopVsHigh: 'Existing stop is evaluated before granting same-bar favorable high.',
      activationVsBreak: 'If a bar activates break-even/trailing and its low also crosses the newly activated stop, the position exits in that bar; favorable continuation is never assumed.',
      sameBarHit10VsHardStop: 'If existing stop is touched, stop wins and same-bar +10% is not credited before exit.',
    },
    captureMetrics: {
      primary: 'captureRatioFixed24h = max(0, realizedNetReturn) / MFE_fixed_24h; bounded [0,1]; loss trades are 0.',
      secondary: 'captureRatioDuringTrade = max(0, realizedNetReturn) / MFE_during_trade.',
      captureLoss24h: 'MFE_fixed_24h - max(0, realizedNetReturn).',
    },
    timingDefinition: {
      entryExtension24hPct: 'Legacy price-extension proxy, explicitly not temporal timing.',
      momentumOnset: 'Most recent onset in prior 6h after >=3 consecutive non-onset bars where causal 15m return >=0.4%, vol15 >=1.15x baseline, and breakout60 >=-0.2% or relative strength 60m >0.',
      detectionDelayMinutes: 'signalTime - momentumOnsetTime; null when no reproducible onset is found.',
    },
    split: { trainPct: .45, validationPct: .35, testPct: .20, purgeHours: PURGE / 3600000, forwardEmbargoHours: horizon / 3600000 },
    samples: { all: raw.length, train: train.length, validation: val.length, test: test.length },
    specialists: Object.fromEntries(Object.entries(policies).map(([k, p]) => [k, { activation: p.activation, cfg: p.cfg, validation: p.validation, score: p.score, selectedByEvidence: p.selectedByEvidence, audit: p.audit }])),
    metaController: { cfg: meta.cfg, validation: meta.validation, score: meta.score, selectedByEvidence: meta.selectedByEvidence },
    exitSelection: exitSel,
    asymmetricSizing: { selected: sizing.cfg, validation: sizing.validation, score: sizing.score, selectedByEvidence: sizing.selectedByEvidence },
    selectionEvidence,
    walkForwardLite: validationStability(vaB.rows, exitSel.selected, sizing.cfg),
    entrySelectionAttribution,
    pairedExitComparison: pairedExit,
    sizingAttribution,
    causalAttribution,
    fullSystem: {
      baseline: stripMetrics(fullBase), v72: stripMetrics(full),
      portfolioControlEffectVsUnconstrainedSizing: { netGrowth: full.netGrowth - sizeAsymRaw.netGrowth, tradeCount: full.tradeCount - sizeAsymRaw.tradeCount },
    },
    regimeAttribution: reg,
    exitReasonAttribution: reasons,
    timing: {
      baseline: { avgDetectionDelayMinutes: fullBase.avgDetectionDelayMinutes, medianDetectionDelayMinutes: fullBase.medianDetectionDelayMinutes, timingCoverage: fullBase.timingCoverage, entryExtension24hPct: fullBase.entryExtension24hPct },
      v72: { avgDetectionDelayMinutes: full.avgDetectionDelayMinutes, medianDetectionDelayMinutes: full.medianDetectionDelayMinutes, timingCoverage: full.timingCoverage, entryExtension24hPct: full.entryExtension24hPct },
    },
    participation,
    entryAttribution: (() => {
      const allClean = new Set(test.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
      const candidateClean = new Set(teB.rows.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
      return {
        rawEligibleSamples: test.length, candidateSignals: teB.rows.length, candidateRate: test.length ? teB.rows.length / test.length : 0,
        candidateOpportunityPrecision: teB.rows.length ? candidateClean.size / teB.rows.length : 0,
        candidateOpportunityRecall: allClean.size ? candidateClean.size / allClean.size : 0,
        avgRawMFEFixed24h: avg(test.map(s => s.opp24?.mfeFixed24h || 0)),
        avgCandidateMFEFixed24h: avg(teB.rows.map(s => s.opp24?.mfeFixed24h || 0)),
        skippedByQuality: teB.stats.skippedByQuality, skippedByRegimeActivation: teB.stats.skippedByRegimeActivation,
        avgCandidateQuality: avg(teB.rows.map(s => s.quality)), avgCandidateOpportunity: avg(teB.rows.map(s => s.opportunity)),
      };
    })(),
    baseline: stripMetrics(fullBase),
    deltas: { fullVsBaseline: pairedDelta(fullBase, full), pureExit: pairedExit.delta, pureSizing: sizingAttribution.delta, pureSelection: entrySelectionAttribution.delta },
    regimeCoverage: { activeRegimes, totalRegimes: REGIMES.length },
    decision,
    promotion: 'RESEARCH ONLY. No automatic production or shadow promotion.',
  };
  writeReport(report);
}

main().catch(e => { console.error(e); process.exit(1); });
