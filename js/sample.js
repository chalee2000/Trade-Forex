/*
 * Trade-Forex — example trades.
 * A deterministic generator used only to show what the app looks like before the
 * first real trade is logged. Every record is flagged `sample: true`, is never
 * written to storage, and disappears once a real trade exists.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TFSample = factory(root.TFCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Price levels are illustrative, not quotes. */
  var SPECS = [
    { symbol: 'XAUUSD', asset: 'gold', base: 4120, drift: 110, slMin: 7, slMax: 18, w: 30, edge: 0.07 },
    { symbol: 'EURUSD', asset: 'forex', base: 1.165, drift: 0.012, slMin: 0.0012, slMax: 0.0028, w: 22, edge: 0.02 },
    { symbol: 'BTCUSD', asset: 'crypto', base: 104500, drift: 6500, slMin: 650, slMax: 1600, w: 22, edge: -0.08 },
    { symbol: 'GBPUSD', asset: 'forex', base: 1.332, drift: 0.015, slMin: 0.0015, slMax: 0.0035, w: 13, edge: 0 },
    { symbol: 'USDJPY', asset: 'forex', base: 153.4, drift: 2.2, slMin: 0.18, slMax: 0.42, w: 13, edge: -0.02 }
  ];

  var STRATEGIES = [
    { name: 'Pullback ตามเทรนด์', w: 34, edge: 0.13 },
    { name: 'Breakout', w: 28, edge: 0.02 },
    { name: 'กลับตัวที่แนวรับ-แนวต้าน', w: 24, edge: -0.03 },
    { name: 'เทรดข่าว', w: 14, edge: -0.17 }
  ];

  /* UTC hours to open in, per session. */
  var SESSION_PICK = [
    { key: 'london', hours: [7, 8, 9, 10, 11], w: 34, edge: 0.02 },
    { key: 'overlap', hours: [12, 13, 14, 15], w: 30, edge: 0.06 },
    { key: 'ny', hours: [16, 17, 18, 19], w: 16, edge: -0.02 },
    { key: 'asia', hours: [0, 1, 2, 3, 4, 5], w: 20, edge: -0.07 }
  ];

  var NOTES_WIN = ['รอ retest แล้วค่อยเข้า ตามแผน', 'เทรนด์ H4 ชัด เข้าตาม', 'ปิดที่ TP ไม่แตะออเดอร์ระหว่างทาง', 'แบ่งปิดกำไรครึ่งหนึ่งที่ 1R'];
  var NOTES_LOSS = ['เข้าเร็วไป ไม่รอแท่งปิด', 'โดน SL พอดีแล้วราคากลับตัว', 'สวนเทรนด์ใหญ่', 'ข่าวออกแรงกว่าที่คิด'];
  var NOTES_REVENGE = ['เพิ่งเสียมา รีบเข้าเพื่อเอาคืน', 'เพิ่ม Lot เกินแผน', 'ขยับ SL หนี ผิดแผน'];

  function weighted(rnd, list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].w;
    var x = rnd() * total;
    for (i = 0; i < list.length; i++) { x -= list[i].w; if (x <= 0) return list[i]; }
    return list[list.length - 1];
  }

  function between(rnd, a, b) {
    return a + rnd() * (b - a);
  }

  var SEED = 158;

  /** Build ~70 example trades over the 12 weeks before `now`. */
  function sampleTrades(now, seed) {
    now = now || new Date();
    var rnd = mulberry32(seed || SEED);
    var N = 72, SPAN = 84;
    var today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    var out = [], lastLoss = false;

    for (var i = 0; i < N; i++) {
      var spec = weighted(rnd, SPECS);
      var strat = weighted(rnd, STRATEGIES);
      var sess = weighted(rnd, SESSION_PICK);
      var ins = C.instrument(spec.symbol, spec.asset);

      var dayOffset = Math.round(SPAN - (i + rnd()) * (SPAN - 1) / N);
      var open = new Date(today - dayOffset * 86400000);
      var dow = open.getUTCDay();
      if (spec.asset !== 'crypto' && (dow === 0 || dow === 6)) open = new Date(open.getTime() - (dow === 0 ? 2 : 1) * 86400000);
      open.setUTCHours(sess.hours[Math.floor(rnd() * sess.hours.length)], Math.floor(rnd() * 12) * 5, 0, 0);

      var revenge = lastLoss && rnd() < 0.17;
      var emotion, plan;
      if (revenge) { emotion = 'เอาคืน'; plan = 'no'; }
      else {
        var e = rnd();
        emotion = e < 0.46 ? 'มั่นใจ' : e < 0.74 ? 'เฉยๆ' : e < 0.88 ? 'ลังเล' : e < 0.95 ? 'กลัว' : 'โลภ';
        plan = rnd() < (emotion === 'โลภ' || emotion === 'ลังเล' ? 0.55 : 0.9) ? 'yes' : 'no';
      }

      var side = rnd() < 0.56 ? 'buy' : 'sell';
      var dir = side === 'buy' ? 1 : -1;
      var entry = spec.base + (rnd() - 0.5) * 2 * spec.drift + (i / N - 0.5) * spec.drift * 0.6;
      var slDist = between(rnd, spec.slMin, spec.slMax);
      var tpR = between(rnd, 1.5, 2.5);

      var p = 0.5 + spec.edge + strat.edge + sess.edge + (side === 'sell' ? -0.03 : 0.02) +
        (revenge ? -0.24 : emotion === 'มั่นใจ' ? 0.04 : emotion === 'ลังเล' ? -0.06 : 0) + (plan === 'no' && !revenge ? -0.08 : 0);
      var win = rnd() < p;
      var r;
      if (win) r = rnd() < 0.68 ? tpR : between(rnd, 0.4, 1.2);
      else {
        var l = rnd();
        r = l < 0.72 ? -1 : l < 0.88 ? -between(rnd, 0.3, 0.8) : -between(rnd, 1.05, 1.35);
        if (plan === 'no' && rnd() < 0.35) r = -between(rnd, 1.1, 1.5);
      }

      var riskUsd = between(rnd, 35, 65) * (revenge ? 1.6 : 1);
      var lossPerLot = ins.quote === 'USD' ? slDist * ins.contract : (slDist * ins.contract) / entry;
      var lots = Math.max(0.01, Math.round((riskUsd / lossPerLot) * 100) / 100);

      var holdMin = rnd() < 0.14 ? between(rnd, 1500, 3000) : rnd() < 0.3 ? between(rnd, 8, 30) : between(rnd, 35, 520);
      var close = new Date(open.getTime() + Math.round(holdMin) * 60000);
      if (close.getTime() > now.getTime()) close = new Date(now.getTime() - 3600000);
      if (close.getTime() < open.getTime()) open = new Date(close.getTime() - 45 * 60000);

      var t = {
        id: 'demo-' + (i + 1),
        symbol: spec.symbol, asset: spec.asset, side: side, lots: lots,
        entry: C.round(entry, ins.digits),
        sl: C.round(entry - dir * slDist, ins.digits),
        tp: C.round(entry + dir * slDist * tpR, ins.digits),
        openTime: C.toLocalInput(open), closeTime: C.toLocalInput(close),
        strategy: strat.name, emotion: emotion, plan: plan, notes: '', sample: true
      };
      t.exit = C.round(entry + dir * slDist * r, ins.digits);
      t.fees = spec.asset === 'crypto' ? C.round(lots * entry * 0.0004, 2) : C.round(lots * 7, 2);
      t.pnl = C.calcNet(t);
      if (rnd() < 0.42) {
        var pool = revenge ? NOTES_REVENGE : t.pnl >= 0 ? NOTES_WIN : NOTES_LOSS;
        t.notes = pool[Math.floor(rnd() * pool.length)];
      }
      lastLoss = t.pnl < 0;
      out.push(C.normalizeTrade(t));
    }
    return out;
  }

  /* Illustrative price levels and typical daily move (%), per symbol. */
  var PRICE_SPECS = {
    EURUSD: { base: 1.165, vol: 0.5 }, GBPUSD: { base: 1.332, vol: 0.55 }, USDJPY: { base: 153.4, vol: 0.6 },
    AUDUSD: { base: 0.655, vol: 0.6 }, USDCHF: { base: 0.802, vol: 0.5 }, USDCAD: { base: 1.392, vol: 0.4 },
    NZDUSD: { base: 0.592, vol: 0.6 }, XAUUSD: { base: 4120, vol: 1.1 }, BTCUSD: { base: 104500, vol: 2.4 }
  };

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /**
   * Made-up candles for showing the market view when no real prices are available.
   * A random walk whose drift changes every few dozen bars, so it has trends and
   * ranges like a real chart. Deterministic per symbol and timeframe. NOT market data.
   */
  function sampleCandles(symbol, tfMinutes, count, now) {
    var spec = PRICE_SPECS[symbol] || PRICE_SPECS.EURUSD;
    var ins = C.instrument(symbol);
    var rnd = mulberry32(hash(symbol + ':' + tfMinutes));
    function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) * 1.22; }
    var step = (spec.vol / 100) * Math.sqrt(tfMinutes / 1440);
    var tf = tfMinutes * 60000;
    var end = Math.floor((now || new Date()).getTime() / tf) * tf;
    var price = spec.base * (1 + (rnd() - 0.5) * 0.02), drift = 0, out = [];
    for (var i = 0; i < count; i++) {
      if (i % 45 === 0) drift = [0.16, -0.14, 0, 0.1, -0.08, 0.2][Math.floor(rnd() * 6)] * step;
      var o = price;
      var c = o * (1 + drift + step * gauss());
      var h = Math.max(o, c) * (1 + Math.abs(gauss()) * step * 0.45);
      var l = Math.min(o, c) * (1 - Math.abs(gauss()) * step * 0.45);
      out.push({ t: end - (count - 1 - i) * tf, o: o, h: h, l: l, c: c, v: Math.round(500 + rnd() * 1500) });
      price = c;
    }
    // slide the whole walk so it finishes near the symbol's illustrative level
    var k = spec.base / price;
    out.forEach(function (x) {
      x.o = C.round(x.o * k, ins.digits); x.c = C.round(x.c * k, ins.digits);
      x.h = Math.max(C.round(x.h * k, ins.digits), x.o, x.c); x.l = Math.min(C.round(x.l * k, ins.digits), x.o, x.c);
    });
    return out;
  }

  return { sampleTrades: sampleTrades, sampleCandles: sampleCandles, START_BALANCE: 5000 };
});
