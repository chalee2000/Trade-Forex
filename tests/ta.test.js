'use strict';
process.env.TZ = 'Asia/Bangkok';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/ta.js');
const S = require('../js/sample.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (±${eps})`);

/** Candles from closes, each bar spanning `range` around its close. */
function bars(closes, range = 0.001, tf = 3600000) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { t: Date.UTC(2026, 0, 5) + i * tf, o, h: Math.max(o, c) + range / 2, l: Math.min(o, c) - range / 2, c, v: 100 };
  });
}

test('SMA and EMA', () => {
  assert.deepEqual(T.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(T.ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]); // seed 2, k = 0.5
  const e = T.ema([10, 10, 10, 13], 3);
  near(e[3], 11.5);
  assert.deepEqual(T.ema([1, 2], 3), [null, null]);
});

test('RSI matches the classic 14-period worked example', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
    46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
  const r = T.rsi(closes, 14);
  assert.equal(r[13], null);
  near(r[14], 70.46, 0.1);
  near(r[15], 66.25, 0.1);
  near(r[19], 57.92, 0.1);
  near(r[26], 40.0, 0.1);
  near(r[32], 37.79, 0.1);
});

test('RSI extremes', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(T.rsi(up)[29], 100);
  assert.equal(T.rsi(down)[29], 0);
  assert.equal(T.rsi(new Array(30).fill(5))[29], 50);
});

test('MACD is the gap between the fast and slow EMA', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3));
  const m = T.macd(closes);
  const f = T.ema(closes, 12), s = T.ema(closes, 26);
  assert.equal(m.macd[24], null);
  near(m.macd[25], f[25] - s[25]);
  near(m.macd[79], f[79] - s[79]);
  assert.equal(m.signal[32], null);
  assert.ok(m.signal[33] !== null); // 26 + 9 - 2
  near(m.hist[79], m.macd[79] - m.signal[79]);
  const flat = T.macd(new Array(60).fill(7));
  near(flat.macd[59], 0);
  near(flat.hist[59], 0);
});

test('ATR of constant-range bars is that range, and gaps count', () => {
  const k = bars(new Array(40).fill(1.2), 0.002);
  near(T.atr(k)[39], 0.002, 1e-12);
  assert.equal(T.atr(k)[13], null);
  // a gap up larger than the bar range is measured from the previous close
  const g = [{ t: 0, o: 10, h: 10.5, l: 9.5, c: 10 }, { t: 1, o: 12, h: 12.5, l: 11.5, c: 12 }];
  for (let i = 2; i < 20; i++) g.push({ t: i, o: 12, h: 12.5, l: 11.5, c: 12 });
  const a = T.atr(g, 14);
  near(a[14], (2.5 + 13 * 1) / 14);
});

test('Bollinger bands', () => {
  const b = T.bollinger([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5, 2);
  near(b.mid[9], 8);
  near(b.upper[9], 8 + 2 * Math.sqrt(2));
  near(b.lower[9], 8 - 2 * Math.sqrt(2));
  const flat = T.bollinger(new Array(25).fill(3));
  near(flat.upper[24], 3);
});

test('ADX is high in a steady trend and low in a range', () => {
  const up = bars(Array.from({ length: 80 }, (_, i) => 1.1 + i * 0.001));
  const a = T.adx(up);
  assert.ok(a.adx[79] > 60, `trend adx ${a.adx[79]}`);
  assert.ok(a.plusDI[79] > a.minusDI[79]);
  const down = T.adx(bars(Array.from({ length: 80 }, (_, i) => 1.2 - i * 0.001)));
  assert.ok(down.minusDI[79] > down.plusDI[79]);
  const range = T.adx(bars(Array.from({ length: 160 }, (_, i) => 1.1 + 0.0008 * Math.sin(i * 1.3) + 0.0005 * Math.sin(i * 0.37))));
  assert.ok(range.adx[159] < 25, `range adx ${range.adx[159]}`);
  assert.equal(T.adx(up.slice(0, 20)).adx[19], null);
});

test('levels merge swing points that sit close together', () => {
  // zig-zag between about 1.1000 and 1.1100, twice touching each side
  const path = [];
  const legs = [[1.105, 1.1101], [1.1101, 1.1002], [1.1002, 1.1098], [1.1098, 1.0999], [1.0999, 1.105]];
  legs.forEach(([a, b]) => { for (let i = 0; i < 12; i++) path.push(a + ((b - a) * i) / 12); });
  path.push(1.105);
  const k = bars(path, 0.0002);
  const lv = T.levels(k, 0.0008, 3, 200);
  const top = lv.find(l => Math.abs(l.price - 1.11) < 0.001);
  const bottom = lv.find(l => Math.abs(l.price - 1.1) < 0.001);
  assert.ok(top && top.touches === 2, JSON.stringify(lv));
  assert.ok(bottom && bottom.touches === 2, JSON.stringify(lv));
});

test('analyze: an uptrend reads bullish and proposes a long plan with the stop below entry', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 1.1 + i * 0.0004 + Math.sin(i / 4) * 0.0012);
  const a = T.analyze(bars(closes, 0.0012), { symbol: 'EURUSD', asset: 'forex' });
  assert.ok(a.score >= 20, `score ${a.score}`);
  assert.equal(a.bias.side, 'buy');
  assert.equal(a.trend.key, 'up');
  assert.ok(a.close > a.ema50 && a.ema20 > a.ema50 && a.ema50 > a.ema200);
  assert.ok(a.plan.sl < a.plan.entry && a.plan.entry < a.plan.tp);
  assert.ok(a.plan.rr >= 1.2, `rr ${a.plan.rr}`);
  near(a.atrPips, a.atr / 0.0001, 1e-9);
  assert.ok(a.signals.some(s => s.tone === 'bull'));
  assert.ok(a.summary.includes(a.bias.label));
});

test('analyze: a downtrend reads bearish and proposes a short plan', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 160 - i * 0.05 + Math.sin(i / 4) * 0.15);
  const a = T.analyze(bars(closes, 0.15), { symbol: 'USDJPY', asset: 'forex' });
  assert.ok(a.score <= -20, `score ${a.score}`);
  assert.equal(a.bias.side, 'sell');
  assert.ok(a.plan.sl > a.plan.entry && a.plan.entry > a.plan.tp);
  assert.equal(a.digits, 3);
});

test('analyze: a flat market has no bias and no plan', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 4100 + Math.sin(i / 2.5) * 3);
  const a = T.analyze(bars(closes, 2), { symbol: 'XAUUSD', asset: 'gold' });
  assert.ok(Math.abs(a.score) < 20, `score ${a.score}`);
  assert.equal(a.bias.side, null);
  assert.equal(a.plan, null);
  assert.equal(a.trend.key, 'side');
});

test('analyze: needs enough history', () => {
  assert.equal(T.analyze(bars(new Array(30).fill(1.1))), null);
});

test('bias bands', () => {
  assert.equal(T.biasOf(80).key, 'strong-up');
  assert.equal(T.biasOf(50).key, 'strong-up');
  assert.equal(T.biasOf(20).key, 'up');
  assert.equal(T.biasOf(0).key, 'flat');
  assert.equal(T.biasOf(-20).key, 'flat');
  assert.equal(T.biasOf(-21).key, 'down');
  assert.equal(T.biasOf(-90).key, 'strong-down');
});

function fileRows(n, fmt) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 9, 1, 0, 0);
    d.setHours(d.getHours() + i);
    const o = 1.16 + i * 0.0001, h = o + 0.0006, l = o - 0.0004, c = o + 0.0002;
    rows.push(fmt(d, o.toFixed(5), h.toFixed(5), l.toFixed(5), c.toFixed(5), 100 + i));
  }
  return rows;
}
const p2 = n => String(n).padStart(2, '0');

test('candle files: MetaTrader 4 history export (no header)', () => {
  const rows = fileRows(80, (d, o, h, l, c, v) => `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())},${p2(d.getHours())}:00,${o},${h},${l},${c},${v}`);
  const r = T.parseCandles(rows.join('\n'));
  assert.equal(r.error, null);
  assert.equal(r.candles.length, 80);
  assert.equal(r.candles[0].t, new Date(2026, 9, 1, 0, 0).getTime());
  assert.deepEqual([r.candles[0].o, r.candles[0].h, r.candles[0].l, r.candles[0].c, r.candles[0].v], [1.16, 1.1606, 1.1596, 1.1602, 100]);
  assert.equal(T.spacingMinutes(r.candles), 60);
  assert.equal(T.timeframeLabel(60), 'H1');
});

test('candle files: MetaTrader 5 export (tab separated, angle-bracket header)', () => {
  const rows = fileRows(70, (d, o, h, l, c, v) => [`${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`, `${p2(d.getHours())}:00:00`, o, h, l, c, v, 0, 12].join('\t'));
  const r = T.parseCandles(['<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>'].concat(rows).join('\r\n'));
  assert.equal(r.error, null);
  assert.equal(r.candles.length, 70);
  assert.equal(r.candles[5].t, new Date(2026, 9, 1, 5, 0).getTime());
  assert.equal(r.candles[5].v, 105);
});

test('candle files: TradingView export (unix seconds), unsorted input and duplicates', () => {
  const rows = fileRows(65, (d, o, h, l, c) => `${Math.floor(d.getTime() / 1000)},${o},${h},${l},${c},1.1,2.2`);
  const shuffled = rows.slice().reverse().concat([rows[3]]);
  const r = T.parseCandles(['time,open,high,low,close,EMA,Volume'].concat(shuffled).join('\n'));
  assert.equal(r.error, null);
  assert.equal(r.candles.length, 65);
  assert.ok(r.candles[0].t < r.candles[1].t);
});

test('candle files: explains what is wrong', () => {
  assert.ok(T.parseCandles('').error);
  assert.ok(T.parseCandles('a,b\n1,2').error);
  const few = fileRows(10, (d, o, h, l, c) => `${Math.floor(d.getTime() / 1000)},${o},${h},${l},${c}`);
  assert.match(T.parseCandles(['time,open,high,low,close'].concat(few).join('\n')).error, /10 แท่ง/);
});

test('timeframe labels', () => {
  assert.equal(T.timeframeLabel(15), 'M15');
  assert.equal(T.timeframeLabel(240), 'H4');
  assert.equal(T.timeframeLabel(1440), 'D1');
});

test('example candles are deterministic, well-formed and analysable for every symbol', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  for (const sym of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'XAUUSD', 'BTCUSD']) {
    for (const tf of [15, 60, 240, 1440]) {
      const a = S.sampleCandles(sym, tf, 300, now), b = S.sampleCandles(sym, tf, 300, now);
      assert.deepEqual(a, b);
      assert.equal(a.length, 300);
      for (let i = 0; i < a.length; i++) {
        assert.ok(a[i].h >= Math.max(a[i].o, a[i].c) && a[i].l <= Math.min(a[i].o, a[i].c) && a[i].l > 0);
        if (i) assert.equal(a[i].t - a[i - 1].t, tf * 60000);
      }
      assert.ok(a[299].t <= now.getTime());
      const r = T.analyze(a, { symbol: sym });
      assert.ok(r && Number.isFinite(r.score) && r.signals.length >= 3, `${sym} ${tf}`);
    }
  }
});

/** Every setup must be internally consistent, whatever the market looks like. */
function checkSetup(s, a) {
  const d = s.side === 'buy' ? 1 : -1;
  assert.ok(d * (s.entry - s.sl) > 0, `${s.side}: stop on the wrong side of entry (${s.entry} / ${s.sl})`);
  const risk = d * (s.entry - s.sl);
  assert.ok(risk >= 0.79 * a.atr && risk <= 3.01 * a.atr, `${s.side}: risk ${risk} outside 0.8–3 ATR (${a.atr})`);
  assert.equal(s.tps.length, 3);
  let prev = s.entry;
  for (const t of s.tps) {
    assert.ok(d * (t.price - prev) > 0, `${s.side}: targets must step away from entry`);
    prev = t.price;
  }
  assert.ok(s.tps[0].rr >= 0.99, `${s.side}: TP1 below 1R (${s.tps[0].rr})`);
  assert.ok(s.tps[1].rr - s.tps[0].rr >= 0.5 && s.tps[2].rr - s.tps[1].rr >= 0.5, `${s.side}: targets too close together`);
  assert.ok(s.zone[0] <= s.zone[1]);
  assert.ok(s.entry >= s.zone[0] - a.atr * 0.2 && s.entry <= s.zone[1] + a.atr * 0.2, `${s.side}: entry outside its zone`);
  if (s.entryType === 'market') assert.equal(s.entry, C.round(a.close, a.digits));
  assert.ok(s.entryBasis && s.slBasis && s.note && s.tps.every(t => t.basis));
}
const C = require('../js/core.js');

test('setups: both sides are consistent on every example market', () => {
  const now = new Date('2026-11-16T10:00:00Z');
  for (const sym of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'XAUUSD', 'BTCUSD']) {
    for (const tf of [15, 60, 240, 1440]) {
      const a = T.analyze(S.sampleCandles(sym, tf, 320, now), { symbol: sym });
      checkSetup(a.setups.buy, a);
      checkSetup(a.setups.sell, a);
    }
  }
});

test('setups: in an uptrend the buy side follows the trend and the plan uses it', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 1.1 + i * 0.0004 + Math.sin(i / 4) * 0.0012);
  const a = T.analyze(bars(closes, 0.0012), { symbol: 'EURUSD', asset: 'forex' });
  assert.equal(a.preferred, 'buy');
  assert.equal(a.setups.buy.kind, 'trend');
  assert.equal(a.setups.buy.favored, true);
  assert.equal(a.setups.sell.kind, 'counter');
  assert.equal(a.setups.sell.favored, false);
  assert.equal(a.plan.entry, a.setups.buy.entry);
  assert.equal(a.plan.sl, a.setups.buy.sl);
  assert.equal(a.plan.tp, a.setups.buy.tps[1].price);
});

test('setups: in a flat market both sides are range trades waiting at the edges', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 4100 + Math.sin(i / 2.5) * 3);
  const a = T.analyze(bars(closes, 2), { symbol: 'XAUUSD', asset: 'gold' });
  assert.equal(a.preferred, null);
  assert.equal(a.setups.buy.kind, 'range');
  assert.equal(a.setups.sell.kind, 'range');
  assert.equal(a.setups.buy.entryType, 'limit');
  assert.equal(a.setups.sell.entryType, 'limit');
  assert.ok(a.setups.buy.entry < a.close && a.setups.sell.entry > a.close, 'buy below price, sell above');
  checkSetup(a.setups.buy, a);
  checkSetup(a.setups.sell, a);
});

test('setups: a stretched trend waits for a pullback instead of chasing', () => {
  // steady climb, then a sharp run-up that leaves price far above EMA20
  const closes = Array.from({ length: 250 }, (_, i) => 1.1 + i * 0.0003 + Math.sin(i / 4) * 0.0008);
  for (let k = 1; k <= 12; k++) closes.push(closes[closes.length - 1] + 0.0015);
  const a = T.analyze(bars(closes, 0.001), { symbol: 'EURUSD', asset: 'forex' });
  assert.equal(a.preferred, 'buy');
  assert.equal(a.setups.buy.entryType, 'limit');
  assert.ok(a.setups.buy.entry < a.close);
  checkSetup(a.setups.buy, a);
});

test('chart reading: a sensible answer passes through with risk:reward worked out', () => {
  const r = T.normalizeChartReading({
    isChart: true, symbol: 'xauusd.iux', timeframe: 'm15', lastPrice: 3868.41, trend: 'ขาลง', summary: 'ราคาเด้งจาก 3,828',
    supports: [3856.3, 3828.1, 3828.1, 99999], resistances: [3912.7, '3,884.50'],
    buy: { entry: 3857, sl: 3826, tp1: 3884, tp2: 3912, condition: 'รอยืนเหนือ 3,856' },
    sell: { entry: 3884, sl: 3900, tp1: 3856, tp2: 3830, condition: 'รอโดนขายที่ 3,884' },
    favored: 'sell', reason: 'โครงสร้างยังลง', risks: 'ข่าว', confidence: 'กลาง'
  });
  assert.equal(r.isChart, true);
  assert.equal(r.symbol, 'XAUUSD.IUX');
  assert.equal(r.timeframe, 'M15');
  assert.equal(r.lastPrice, 3868.41);
  assert.deepEqual(r.supports, [3856.3, 3828.1], 'deduplicated, nearest first, misread dropped');
  assert.deepEqual(r.resistances, [3884.5, 3912.7]);
  near(r.plans.buy.rr1, 27 / 31);
  near(r.plans.buy.rr2, 55 / 31);
  near(r.plans.sell.rr1, 28 / 16);
  assert.equal(r.favored, 'sell');
  assert.equal(r.confidence, 'กลาง');
  assert.deepEqual(r.dropped, []);
});

test('chart reading: plans with the stop or targets on the wrong side are dropped', () => {
  const r = T.normalizeChartReading({
    lastPrice: 1.1023,
    buy: { entry: 1.1, sl: 1.105, tp1: 1.11 },          // stop above a buy entry
    sell: { entry: 1.105, sl: 1.11, tp1: 1.1, tp2: 1.12 }, // tp2 on the wrong side: kept without it
    favored: 'buy'
  });
  assert.equal(r.plans.buy, null);
  assert.deepEqual(r.dropped, ['buy']);
  assert.equal(r.plans.sell.tp2, null);
  assert.equal(r.favored, null, 'a favoured side without a usable plan is not shown as favoured');
});

test('chart reading: not a chart, junk and missing fields', () => {
  assert.equal(T.normalizeChartReading({ isChart: false }).isChart, false);
  const junk = T.normalizeChartReading('not json');
  assert.equal(junk.lastPrice, null);
  assert.deepEqual(junk.plans, { buy: null, sell: null });
  const noPrice = T.normalizeChartReading({ buy: { entry: 100, sl: 90, tp1: 120 }, confidence: 'มาก', favored: 'wait' });
  assert.equal(noPrice.plans.buy.entry, 100);
  assert.equal(noPrice.confidence, '');
  assert.equal(noPrice.favored, 'wait');
});
