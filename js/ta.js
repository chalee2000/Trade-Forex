/*
 * Trade-Forex — technical analysis (no DOM).
 * Indicators over OHLC candles, support/resistance from swing points, and a
 * rule-based reading of them. Works in the browser (window.TFTA) and in Node.
 *
 * A candle is { t: epoch ms, o, h, l, c, v }. Series are oldest first. Indicator
 * arrays are the same length as their input, with null where there is not yet
 * enough history.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.TFTA = factory(root.TFCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clip(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function nulls(n) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = null; return a; }
  function lastOf(a) { return a.length ? a[a.length - 1] : null; }

  /* ------------------------------------------------------------------ *
   * Indicators
   * ------------------------------------------------------------------ */

  function sma(values, n) {
    var out = nulls(values.length), sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /** Exponential moving average, seeded with the simple average of the first n values. */
  function ema(values, n) {
    var out = nulls(values.length);
    if (values.length < n) return out;
    var k = 2 / (n + 1), sum = 0, i;
    for (i = 0; i < n; i++) sum += values[i];
    var prev = sum / n;
    out[n - 1] = prev;
    for (i = n; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** Relative Strength Index with Wilder's smoothing. */
  function rsi(closes, n) {
    n = n || 14;
    var out = nulls(closes.length);
    if (closes.length <= n) return out;
    var gain = 0, loss = 0, i, d;
    for (i = 1; i <= n; i++) {
      d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    out[n] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    for (i = n + 1; i < closes.length; i++) {
      d = closes[i] - closes[i - 1];
      gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
      loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  /** MACD line, signal line and histogram. */
  function macd(closes, fast, slow, sig) {
    fast = fast || 12; slow = slow || 26; sig = sig || 9;
    var len = closes.length, ef = ema(closes, fast), es = ema(closes, slow);
    var line = nulls(len), signal = nulls(len), hist = nulls(len), i;
    var start = slow - 1, vals = [];
    for (i = start; i < len; i++) { line[i] = ef[i] - es[i]; vals.push(line[i]); }
    var s = ema(vals, sig);
    for (i = 0; i < s.length; i++) {
      if (s[i] !== null) { signal[start + i] = s[i]; hist[start + i] = vals[i] - s[i]; }
    }
    return { macd: line, signal: signal, hist: hist };
  }

  function trueRanges(candles) {
    var tr = new Array(candles.length);
    for (var i = 0; i < candles.length; i++) {
      var k = candles[i];
      if (i === 0) { tr[i] = k.h - k.l; continue; }
      var pc = candles[i - 1].c;
      tr[i] = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    }
    return tr;
  }

  /** Average True Range with Wilder's smoothing. */
  function atr(candles, n) {
    n = n || 14;
    var out = nulls(candles.length);
    if (candles.length <= n) return out;
    var tr = trueRanges(candles), sum = 0, i;
    for (i = 1; i <= n; i++) sum += tr[i];
    var prev = sum / n;
    out[n] = prev;
    for (i = n + 1; i < candles.length; i++) {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
    return out;
  }

  /** Bollinger bands: simple mean ± k population standard deviations. */
  function bollinger(closes, n, k) {
    n = n || 20; k = k || 2;
    var len = closes.length, mid = sma(closes, n), upper = nulls(len), lower = nulls(len);
    for (var i = n - 1; i < len; i++) {
      var s = 0;
      for (var j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) * (closes[j] - mid[i]);
      var sd = Math.sqrt(s / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  /** Average Directional Index (trend strength), with +DI and −DI. */
  function adx(candles, n) {
    n = n || 14;
    var len = candles.length, out = nulls(len), plus = nulls(len), minus = nulls(len);
    if (len < 2 * n) return { adx: out, plusDI: plus, minusDI: minus };
    var tr = trueRanges(candles), sTR = 0, sP = 0, sM = 0, dx = nulls(len), i;
    function dm(i) {
      var up = candles[i].h - candles[i - 1].h, down = candles[i - 1].l - candles[i].l;
      return { p: up > down && up > 0 ? up : 0, m: down > up && down > 0 ? down : 0 };
    }
    for (i = 1; i < len; i++) {
      var d = dm(i);
      if (i <= n) { sTR += tr[i]; sP += d.p; sM += d.m; }
      else { sTR = sTR - sTR / n + tr[i]; sP = sP - sP / n + d.p; sM = sM - sM / n + d.m; }
      if (i >= n) {
        plus[i] = sTR > 0 ? (100 * sP) / sTR : 0;
        minus[i] = sTR > 0 ? (100 * sM) / sTR : 0;
        var sum = plus[i] + minus[i];
        dx[i] = sum > 0 ? (100 * Math.abs(plus[i] - minus[i])) / sum : 0;
      }
    }
    var acc = 0;
    for (i = n; i < 2 * n; i++) acc += dx[i];
    var prev = acc / n;
    out[2 * n - 1] = prev;
    for (i = 2 * n; i < len; i++) {
      prev = (prev * (n - 1) + dx[i]) / n;
      out[i] = prev;
    }
    return { adx: out, plusDI: plus, minusDI: minus };
  }

  /* ------------------------------------------------------------------ *
   * Support and resistance
   * ------------------------------------------------------------------ */

  /** Swing highs and lows: a bar whose high (low) is the extreme of `span` bars either side. */
  function swings(candles, span) {
    span = span || 3;
    var out = [];
    for (var i = span; i < candles.length - span; i++) {
      var hi = true, lo = true;
      for (var j = i - span; j <= i + span; j++) {
        if (j === i) continue;
        // on a tie, only the first of the equal bars counts as the turning point
        if (j < i ? candles[j].h >= candles[i].h : candles[j].h > candles[i].h) hi = false;
        if (j < i ? candles[j].l <= candles[i].l : candles[j].l < candles[i].l) lo = false;
      }
      if (hi) out.push({ i: i, price: candles[i].h, type: 'high' });
      if (lo) out.push({ i: i, price: candles[i].l, type: 'low' });
    }
    return out;
  }

  /**
   * Price levels the market has turned at: swing points within `tol` of each other
   * are merged into one level. Returns [{ price, touches, lastIndex }] sorted by price.
   */
  function levels(candles, tol, span, lookback) {
    var from = Math.max(0, candles.length - (lookback || 200));
    var pts = swings(candles.slice(from), span).sort(function (a, b) { return a.price - b.price; });
    var out = [], group = null;
    pts.forEach(function (p) {
      if (group && p.price - group.max <= tol) {
        group.sum += p.price; group.n++; group.max = p.price;
        group.last = Math.max(group.last, p.i);
      } else {
        group = { sum: p.price, n: 1, max: p.price, last: p.i };
        out.push(group);
      }
    });
    return out.map(function (g) { return { price: g.sum / g.n, touches: g.n, lastIndex: g.last + from }; });
  }

  /* ------------------------------------------------------------------ *
   * Reading the indicators
   * ------------------------------------------------------------------ */

  var BIAS = [
    { key: 'strong-up', min: 50, label: 'ขาขึ้นชัด', side: 'buy' },
    { key: 'up', min: 20, label: 'เอียงขึ้น', side: 'buy' },
    { key: 'flat', min: -20, label: 'ไม่มีทิศทางชัด', side: null },
    { key: 'down', min: -50, label: 'เอียงลง', side: 'sell' },
    { key: 'strong-down', min: -Infinity, label: 'ขาลงชัด', side: 'sell' }
  ];

  function biasOf(score) {
    for (var i = 0; i < BIAS.length; i++) if (score >= BIAS[i].min) return BIAS[i];
    return BIAS[BIAS.length - 1];
  }

  var MIN_CANDLES = 60;

  /**
   * Full reading of a candle series. opts: { symbol, asset }.
   * Returns null when there are too few candles to say anything.
   */
  function analyze(candles, opts) {
    opts = opts || {};
    var n = candles.length;
    if (n < MIN_CANDLES) return null;
    var ins = C.instrument(opts.symbol || 'EURUSD', opts.asset);
    var closes = candles.map(function (k) { return k.c; });
    var i = n - 1, last = candles[i], close = last.c;

    var e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
    var r = rsi(closes, 14), m = macd(closes, 12, 26, 9), a = atr(candles, 14), b = bollinger(closes, 20, 2), dmi = adx(candles, 14);
    var A = a[i];
    if (!isNum(A) || A <= 0) return null;

    var out = {
      n: n, time: last.t, close: close, prevClose: candles[i - 1].c,
      ema20: e20[i], ema50: e50[i], ema200: e200[i],
      rsi: r[i], macd: m.macd[i], macdSignal: m.signal[i], macdHist: m.hist[i],
      atr: A, atrPct: (A / close) * 100, atrPips: A / ins.pip,
      adx: dmi.adx[i], plusDI: dmi.plusDI[i], minusDI: dmi.minusDI[i],
      bbUpper: b.upper[i], bbLower: b.lower[i], bbMid: b.mid[i],
      series: { ema20: e20, ema50: e50, ema200: e200, rsi: r, macd: m.macd, macdSignal: m.signal, macdHist: m.hist, bbUpper: b.upper, bbLower: b.lower },
      digits: ins.digits, pip: ins.pip
    };

    // change over roughly the last 24 hours (or the previous candle on daily data)
    var dayAgo = last.t - 86400000, ref = candles[i - 1];
    for (var j = i - 1; j >= 0; j--) { if (candles[j].t <= dayAgo) { ref = candles[j]; break; } ref = candles[j]; }
    out.change = { from: ref.c, abs: close - ref.c, pct: ((close - ref.c) / ref.c) * 100, hours: Math.round((last.t - ref.t) / 3600000) };

    /* --- score: each part is −1..+1, weighted; positive = bullish --- */
    var parts = [];
    function part(key, w, v) { if (isNum(v)) parts.push({ key: key, w: w, v: clip(v, -1, 1) }); }
    if (isNum(e200[i])) part('ema200', 20, (close - e200[i]) / (2 * A));
    if (isNum(e50[i])) part('emaCross', 20, (e20[i] - e50[i]) / A);
    if (isNum(e50[i - 10])) part('emaSlope', 15, (e50[i] - e50[i - 10]) / (1.5 * A));
    if (isNum(m.hist[i]) && isNum(m.hist[i - 1])) part('macd', 15, clip(m.hist[i] / (0.25 * A), -1, 1) * 0.7 + (m.hist[i] > m.hist[i - 1] ? 0.3 : -0.3));
    if (isNum(r[i])) part('rsi', 15, (r[i] - 50) / 20);
    part('ema20', 15, (close - e20[i]) / A);
    var wSum = 0, vSum = 0;
    parts.forEach(function (p) { wSum += p.w; vSum += p.w * p.v; });
    var score = wSum ? (vSum / wSum) * 100 : 0;
    var trending = isNum(out.adx) ? out.adx >= 18 : true;
    if (!trending) score *= 0.7; // without a trend, trend-following evidence counts for less
    out.score = Math.round(score);
    out.bias = biasOf(out.score);
    out.parts = parts;

    /* --- trend, momentum, volatility in words --- */
    var above50 = isNum(e50[i]) && close > e50[i], cross = isNum(e50[i]) ? e20[i] - e50[i] : 0;
    var dir = cross > 0 && above50 ? 'up' : cross < 0 && !above50 ? 'down' : 'side';
    var strength = !isNum(out.adx) ? '' : out.adx >= 25 ? 'แข็งแรง' : out.adx >= 18 ? 'ปานกลาง' : 'อ่อน';
    out.trend = {
      key: !trending ? 'side' : dir,
      label: !trending ? 'ไซด์เวย์' : dir === 'up' ? 'ขาขึ้น' : dir === 'down' ? 'ขาลง' : 'ยังไม่ชัด',
      note: isNum(out.adx) ? 'ADX ' + out.adx.toFixed(0) + (strength ? ' เทรนด์' + strength : '') : ''
    };
    var mom = isNum(out.macdHist) ? (out.macdHist > 0 ? 1 : -1) + (out.rsi > 55 ? 1 : out.rsi < 45 ? -1 : 0) : 0;
    out.momentum = {
      key: mom > 0 ? 'up' : mom < 0 ? 'down' : 'flat',
      label: mom >= 2 ? 'แรงซื้อนำ' : mom === 1 ? 'เอียงทางซื้อ' : mom === 0 ? 'สมดุล' : mom === -1 ? 'เอียงทางขาย' : 'แรงขายนำ',
      note: 'RSI ' + (isNum(out.rsi) ? out.rsi.toFixed(0) : '–')
    };
    var atrs = a.slice(Math.max(0, i - 99), i + 1).filter(isNum).slice().sort(function (x, y) { return x - y; });
    var rank = atrs.length ? atrs.filter(function (x) { return x <= A; }).length / atrs.length : 0.5;
    out.volatility = {
      key: rank >= 0.8 ? 'high' : rank <= 0.2 ? 'low' : 'normal',
      label: rank >= 0.8 ? 'สูงกว่าปกติ' : rank <= 0.2 ? 'ต่ำกว่าปกติ' : 'ปกติ',
      note: 'ATR ' + C.fmtPips(out.atrPips).replace('+', '') + ' pips'
    };

    /* --- levels --- */
    var lv = levels(candles, 0.35 * A, n > 300 ? 4 : 3, 220);
    function decorate(l) {
      var dist = Math.abs(l.price - close);
      return { price: l.price, touches: l.touches, dist: dist, pips: dist / ins.pip, atrs: dist / A };
    }
    out.supports = lv.filter(function (l) { return l.price < close - 0.1 * A; }).sort(function (x, y) { return y.price - x.price; }).slice(0, 3).map(decorate);
    out.resistances = lv.filter(function (l) { return l.price > close + 0.1 * A; }).sort(function (x, y) { return x.price - y.price; }).slice(0, 3).map(decorate);

    /* --- signals, in the order a reader would weigh them --- */
    var sig = [];
    function px(v) { return C.fmtPrice(v, opts.symbol, ins.asset); }
    function add(tone, title, text) { sig.push({ tone: tone, title: title, text: text }); }

    if (isNum(e200[i])) {
      if (close > e200[i]) add('bull', 'ราคาอยู่เหนือ EMA200', 'ภาพใหญ่เป็นฝั่งขาขึ้น เส้น EMA200 อยู่ที่ ' + px(e200[i]));
      else add('bear', 'ราคาอยู่ใต้ EMA200', 'ภาพใหญ่เป็นฝั่งขาลง เส้น EMA200 อยู่ที่ ' + px(e200[i]));
    }
    if (isNum(e50[i])) {
      var crossed = null;
      for (var k = i; k > i - 5 && k > 0; k--) {
        if (!isNum(e50[k - 1])) break;
        var now = e20[k] - e50[k], was = e20[k - 1] - e50[k - 1];
        if (now > 0 && was <= 0) { crossed = 'up'; break; }
        if (now < 0 && was >= 0) { crossed = 'down'; break; }
      }
      if (crossed === 'up') add('bull', 'EMA20 เพิ่งตัดขึ้นเหนือ EMA50', 'สัญญาณเปลี่ยนเป็นขาขึ้นระยะสั้น เกิดภายใน 5 แท่งล่าสุด');
      else if (crossed === 'down') add('bear', 'EMA20 เพิ่งตัดลงใต้ EMA50', 'สัญญาณเปลี่ยนเป็นขาลงระยะสั้น เกิดภายใน 5 แท่งล่าสุด');
      else if (cross > 0) add('bull', 'EMA20 อยู่เหนือ EMA50', 'แนวโน้มระยะสั้นยังเป็นขาขึ้น');
      else add('bear', 'EMA20 อยู่ใต้ EMA50', 'แนวโน้มระยะสั้นยังเป็นขาลง');
    }
    if (isNum(out.macdHist) && isNum(m.hist[i - 1])) {
      var rising = out.macdHist > m.hist[i - 1];
      if (out.macdHist > 0 && m.hist[i - 1] <= 0) add('bull', 'MACD เพิ่งตัดขึ้นเหนือเส้น Signal', 'โมเมนตัมเปลี่ยนเป็นบวกในแท่งล่าสุด');
      else if (out.macdHist < 0 && m.hist[i - 1] >= 0) add('bear', 'MACD เพิ่งตัดลงใต้เส้น Signal', 'โมเมนตัมเปลี่ยนเป็นลบในแท่งล่าสุด');
      else if (out.macdHist > 0) add(rising ? 'bull' : 'neutral', rising ? 'MACD เป็นบวกและกำลังเพิ่ม' : 'MACD เป็นบวกแต่เริ่มแผ่ว', rising ? 'แรงซื้อยังเพิ่มขึ้น' : 'แรงซื้อยังมี แต่เริ่มอ่อนลงจากแท่งก่อน');
      else add(!rising ? 'bear' : 'neutral', !rising ? 'MACD เป็นลบและกำลังลดลง' : 'MACD เป็นลบแต่เริ่มฟื้น', !rising ? 'แรงขายยังเพิ่มขึ้น' : 'แรงขายยังมี แต่เริ่มอ่อนลงจากแท่งก่อน');
    }
    if (isNum(out.rsi)) {
      if (out.rsi >= 70) add('neutral', 'RSI ' + out.rsi.toFixed(0) + ' อยู่ในเขตซื้อมากเกิน', 'ราคาขึ้นมาเร็ว มีโอกาสพักตัว ไม่ควรไล่ซื้อโดยไม่มีจุด SL ชัด');
      else if (out.rsi <= 30) add('neutral', 'RSI ' + out.rsi.toFixed(0) + ' อยู่ในเขตขายมากเกิน', 'ราคาลงมาเร็ว มีโอกาสเด้ง ไม่ควรไล่ขายโดยไม่มีจุด SL ชัด');
      else if (out.rsi >= 55) add('bull', 'RSI ' + out.rsi.toFixed(0) + ' อยู่ฝั่งแรงซื้อ', 'โมเมนตัมเป็นบวกและยังไม่ร้อนเกิน');
      else if (out.rsi <= 45) add('bear', 'RSI ' + out.rsi.toFixed(0) + ' อยู่ฝั่งแรงขาย', 'โมเมนตัมเป็นลบและยังไม่ถึงเขตขายมากเกิน');
      else add('neutral', 'RSI ' + out.rsi.toFixed(0) + ' อยู่กลางกรอบ', 'โมเมนตัมยังไม่เลือกข้าง');
    }
    if (isNum(out.adx)) {
      if (out.adx < 18) add('neutral', 'ADX ' + out.adx.toFixed(0) + ' ตลาดไม่มีเทรนด์', 'ราคาแกว่งในกรอบ สัญญาณตามเทรนด์เชื่อถือได้น้อยลง');
      else if (out.adx >= 25) add(dir === 'down' ? 'bear' : dir === 'up' ? 'bull' : 'neutral', 'ADX ' + out.adx.toFixed(0) + ' เทรนด์แข็งแรง', 'การเคลื่อนไหวมีทิศทางชัด การสวนเทรนด์มีความเสี่ยงสูง');
    }
    if (isNum(out.bbUpper)) {
      if (close > out.bbUpper) add('neutral', 'ราคาปิดเหนือกรอบบนของ Bollinger', 'ราคายืดตัวจากค่าเฉลี่ยมาก กรอบบนอยู่ที่ ' + px(out.bbUpper));
      else if (close < out.bbLower) add('neutral', 'ราคาปิดใต้กรอบล่างของ Bollinger', 'ราคายืดตัวจากค่าเฉลี่ยมาก กรอบล่างอยู่ที่ ' + px(out.bbLower));
    }
    if (out.resistances.length && out.resistances[0].atrs < 0.6) add('neutral', 'ราคาอยู่ใกล้แนวต้าน ' + px(out.resistances[0].price), 'ห่างเพียง ' + C.fmtPips(out.resistances[0].pips).replace('+', '') + ' pips รอดูว่าจะผ่านหรือโดนขายกลับ');
    if (out.supports.length && out.supports[0].atrs < 0.6) add('neutral', 'ราคาอยู่ใกล้แนวรับ ' + px(out.supports[0].price), 'ห่างเพียง ' + C.fmtPips(out.supports[0].pips).replace('+', '') + ' pips รอดูว่าจะยืนได้หรือหลุด');
    out.signals = sig;

    /* --- entry, stop and take-profit levels for both sides ---
     * A mechanical reading of ATR and the levels above; it says where a trade would make sense
     * on this chart, not whether to take one. Each side gets:
     *   entry   market (at the last close) or limit (wait for price to come back to a level)
     *   sl      just beyond the level that protects the entry, else 1.5 ATR away; 0.8–3 ATR
     *   tps     three targets, each at least 1R and 0.75R apart, placed just in front of a
     *           level when one is in reach, else at 1.5R / 2.5R / 3.5R
     */
    function rnd(v) { return C.round(v, ins.digits); }
    var allLevels = lv.map(function (l) { return l.price; });

    function setupFor(side) {
      var d = side === 'buy' ? 1 : -1;
      var trendSide = out.bias.side;
      var kind = !trendSide ? 'range' : trendSide === side ? 'trend' : 'counter';
      var guards = side === 'buy' ? out.supports : out.resistances; // levels on the stop side of price, nearest first
      var stretch = isNum(e20[i]) ? (d * (close - e20[i])) / A : 0; // how far price has run ahead of EMA20 in this direction
      var hot = isNum(out.rsi) && (side === 'buy' ? out.rsi >= 70 : out.rsi <= 30);
      var near = guards.filter(function (l) { return l.atrs >= 0.3 && l.atrs <= 3; })[0];

      var entryType, entry, anchor = null, entryBasis;
      var waitWord = side === 'buy' ? 'ย่อลงมา' : 'เด้งขึ้นไป';
      // pullback candidates, nearest to price first: a level, EMA20 (trend side), the outer Bollinger band (other sides)
      var pulls = [];
      if (near) pulls.push({ price: near.price, name: (side === 'buy' ? 'แนวรับ ' : 'แนวต้าน ') + px(near.price) });
      if (kind === 'trend' && isNum(e20[i]) && stretch > 0.3) pulls.push({ price: e20[i], name: 'EMA20 ' + px(e20[i]) });
      var band = side === 'buy' ? out.bbLower : out.bbUpper;
      if (kind !== 'trend' && isNum(band) && d * (close - band) > 0.3 * A) pulls.push({ price: band, name: 'ขอบ Bollinger ' + (side === 'buy' ? 'ล่าง ' : 'บน ') + px(band) });
      pulls.sort(function (x, y) { return Math.abs(close - x.price) - Math.abs(close - y.price); });
      if (kind === 'trend' && stretch < 1 && !hot) {
        entryType = 'market'; entry = close;
        entryBasis = 'เข้าที่ราคาปัจจุบันได้ แนวโน้มหนุนและราคายังไม่วิ่งไกลจาก EMA20';
      } else if (pulls.length) {
        var pb = pulls[0];
        entryType = 'limit'; anchor = pb.price; entry = pb.price + d * 0.15 * A;
        entryBasis = (kind === 'trend' ? 'ราคาวิ่งไกลจากค่าเฉลี่ยแล้ว ' : '') + 'รอราคา' + waitWord + 'ที่' + pb.name + ' แล้วมีแท่งเทียนปิดยืนยันก่อนเข้า';
      } else {
        entryType = 'market'; entry = close;
        entryBasis = 'ยังไม่มีจุดรอที่ชัด เข้าที่ราคาปัจจุบันเฉพาะเมื่อมีสัญญาณกลับตัวชัด';
      }

      // the level that protects the entry: the limit anchor, or the nearest level 0.2–2.5 ATR behind the entry
      var protect = anchor;
      if (protect === null) {
        var behind = allLevels.filter(function (p) { var g = d * (entry - p); return g >= 0.2 * A && g <= 2.5 * A; });
        if (behind.length) protect = side === 'buy' ? Math.max.apply(null, behind) : Math.min.apply(null, behind);
      }
      var sl = protect !== null ? protect - d * 0.4 * A : entry - d * 1.5 * A;
      var slBasis = protect !== null ? 'เลยแนว' + (side === 'buy' ? 'รับ ' : 'ต้าน ') + px(protect) + ' ไป 0.4 ATR' : '1.5 เท่าของ ATR จากจุดเข้า';
      var risk = d * (entry - sl);
      if (risk < 0.8 * A) { sl = entry - d * 0.8 * A; slBasis = '0.8 เท่าของ ATR จากจุดเข้า (ระยะขั้นต่ำ)'; }
      else if (risk > 3 * A) { sl = entry - d * 1.5 * A; slBasis = '1.5 เท่าของ ATR จากจุดเข้า'; }
      entry = rnd(entry);
      var f = Math.pow(10, ins.digits); // round the stop away from the entry so rounding never shrinks the risk
      sl = d > 0 ? Math.floor(sl * f + 1e-9) / f : Math.ceil(sl * f - 1e-9) / f;
      risk = d * (entry - sl);

      var tps = [], minNext = 1, levelNames = side === 'buy' ? 'แนวต้าน ' : 'แนวรับ ';
      allLevels.filter(function (p) { return d * (p - entry) > 0; })
        .sort(function (x, y) { return d * (x - y); })
        .forEach(function (p) {
          if (tps.length >= 3) return;
          var target = p - d * 0.1 * A, rr = (d * (target - entry)) / risk; // take profit just in front of the level
          if (rr < minNext) return;
          tps.push({ price: rnd(target), rr: rr, basis: 'ก่อนถึง' + levelNames + px(p) });
          minNext = rr + 0.75;
        });
      [1.5, 2.5, 3.5].forEach(function (m, k) {
        if (tps.length > k) return;
        var r = Math.max(m, minNext);
        tps.push({ price: rnd(entry + d * r * risk), rr: r, basis: r.toFixed(1) + ' เท่าของความเสี่ยง' });
        minNext = r + 0.75;
      });
      tps.forEach(function (t) { t.pips = Math.abs(t.price - entry) / ins.pip; t.rr = Math.abs(t.price - entry) / risk; });

      var zone = entryType === 'limit' ? [anchor, anchor + d * 0.3 * A] : [close - d * 0.2 * A, close];
      return {
        side: side, kind: kind, favored: kind === 'trend', entryType: entryType,
        entry: entry, zone: [rnd(Math.min(zone[0], zone[1])), rnd(Math.max(zone[0], zone[1]))], entryBasis: entryBasis,
        sl: sl, slBasis: slBasis, slPips: risk / ins.pip, risk: risk,
        tps: tps,
        note: kind === 'trend' ? 'เข้าตามแนวโน้มหลัก ทยอยปิดกำไรที่ TP1 แล้วเลื่อน SL มาไว้ที่จุดเข้า ให้ส่วนที่เหลือวิ่งไป TP2 และ TP3' :
          kind === 'counter' ? 'สวนแนวโน้มหลัก โอกาสสำเร็จต่ำกว่า ถ้าจะเข้าให้ลดขนาด Lot รอสัญญาณกลับตัวก่อน และปิดกำไรเร็วที่ TP1' :
            'ตลาดยังไม่เลือกทาง เล่นในกรอบ: เข้าเมื่อราคามาถึงขอบกรอบและมีแท่งยืนยัน แล้วปิดกำไรเร็วที่ TP1'
      };
    }

    out.setups = { buy: setupFor('buy'), sell: setupFor('sell') };
    out.preferred = out.bias.side;
    // the favoured side, in the shape the lot calculator and trade form take (TP2 as the main target)
    out.plan = null;
    if (out.preferred) {
      var fav = out.setups[out.preferred], main = fav.tps[1];
      out.plan = {
        side: fav.side, entry: fav.entry, sl: fav.sl, tp: main.price,
        slPips: fav.slPips, tpPips: main.pips, rr: main.rr, slBasis: fav.slBasis, tpBasis: main.basis
      };
    }

    /* --- one-paragraph summary --- */
    var bits = [];
    bits.push('คะแนนรวม ' + C.fmtSigned(out.score, 0) + ' จาก ±100 (' + out.bias.label + ')');
    bits.push('แนวโน้ม' + out.trend.label + (out.trend.note ? ' ' + out.trend.note : ''));
    bits.push('โมเมนตัม' + out.momentum.label);
    if (out.resistances.length) bits.push('แนวต้านถัดไป ' + px(out.resistances[0].price));
    if (out.supports.length) bits.push('แนวรับถัดไป ' + px(out.supports[0].price));
    out.summary = bits.join(' · ');
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Candle files
   * ------------------------------------------------------------------ */

  function parseTime(dateStr, timeStr) {
    var s = String(dateStr || '').trim();
    if (/^\d{9,10}$/.test(s)) return Number(s) * 1000;       // unix seconds
    if (/^\d{12,13}$/.test(s)) return Number(s);              // unix milliseconds
    var m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    var t = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      var hh = m[4] !== undefined ? +m[4] : t ? +t[1] : 0, mm = m[5] !== undefined ? +m[5] : t ? +t[2] : 0;
      return new Date(+m[1], +m[2] - 1, +m[3], hh, mm, 0, 0).getTime();
    }
    var d = new Date(s);
    return isNaN(d) ? null : d.getTime();
  }

  /**
   * Read OHLC candles from a text file. Understands:
   *  - MetaTrader 4 History Center:  2026.11.13,14:00,1.16500,1.16620,1.16480,1.16590,1234
   *  - MetaTrader 5 export (tab separated, <DATE> <TIME> <OPEN> ... header)
   *  - TradingView export:           time,open,high,low,close[,...]
   *  - any table with date/time/open/high/low/close headers
   * Returns { candles, error }.
   */
  function parseCandles(text) {
    var rows = C.parseCSV(text);
    if (!rows.length) return { candles: [], error: 'ไฟล์ว่างเปล่า' };
    var head = rows[0].map(function (h) { return String(h).toLowerCase().replace(/[<>\s_]/g, ''); });
    var col = { date: -1, time: -1, o: -1, h: -1, l: -1, c: -1, v: -1 };
    var hasHeader = head.some(function (h) { return /^(open|o|close|c)$/.test(h); });
    if (hasHeader) {
      head.forEach(function (h, i) {
        if (/^(date|datetime|timestamp|time)$/.test(h) && col.date === -1) col.date = i;
        else if (h === 'time' && col.time === -1) col.time = i;
        else if (/^(open|o)$/.test(h)) col.o = i;
        else if (/^(high|h)$/.test(h)) col.h = i;
        else if (/^(low|l)$/.test(h)) col.l = i;
        else if (/^(close|c)$/.test(h)) col.c = i;
        else if (/^(tickvol|volume|vol|v)$/.test(h) && col.v === -1) col.v = i;
      });
      rows = rows.slice(1);
    } else if (rows[0].length >= 6 && /^\d{1,2}:\d{2}/.test(String(rows[0][1]).trim())) {
      col = { date: 0, time: 1, o: 2, h: 3, l: 4, c: 5, v: 6 }; // MT4: date,time,o,h,l,c,vol
    } else if (rows[0].length >= 5) {
      col = { date: 0, time: -1, o: 1, h: 2, l: 3, c: 4, v: 5 };
    }
    if (col.date === -1 || col.o === -1 || col.h === -1 || col.l === -1 || col.c === -1) {
      return { candles: [], error: 'ไม่พบคอลัมน์ วันที่ open high low close ในไฟล์ ใช้ไฟล์ที่ส่งออกจาก MT4/MT5 หรือ TradingView' };
    }
    var seen = {}, out = [];
    rows.forEach(function (r) {
      var t = parseTime(r[col.date], col.time >= 0 ? r[col.time] : '');
      var o = C.num(r[col.o]), h = C.num(r[col.h]), l = C.num(r[col.l]), c = C.num(r[col.c]);
      if (t === null || o === null || h === null || l === null || c === null || h < l || o <= 0) return;
      if (seen[t]) return;
      seen[t] = true;
      out.push({ t: t, o: o, h: Math.max(h, o, c), l: Math.min(l, o, c), c: c, v: col.v >= 0 ? C.num(r[col.v]) || 0 : 0 });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    if (out.length < MIN_CANDLES) return { candles: out, error: 'อ่านได้ ' + out.length + ' แท่ง ต้องมีอย่างน้อย ' + MIN_CANDLES + ' แท่งจึงจะวิเคราะห์ได้' };
    return { candles: out, error: null };
  }

  /** Median spacing between candles, in minutes. */
  function spacingMinutes(candles) {
    if (candles.length < 3) return null;
    var gaps = [];
    for (var i = Math.max(1, candles.length - 200); i < candles.length; i++) gaps.push((candles[i].t - candles[i - 1].t) / 60000);
    gaps.sort(function (a, b) { return a - b; });
    return gaps[Math.floor(gaps.length / 2)];
  }

  function timeframeLabel(minutes) {
    if (!isNum(minutes)) return '';
    if (minutes < 60) return 'M' + Math.round(minutes);
    if (minutes < 1440) return 'H' + Math.round(minutes / 60);
    if (minutes < 10080) return 'D' + Math.round(minutes / 1440);
    return 'W' + Math.round(minutes / 10080);
  }

  /* ------------------------------------------------------------------ *
   * Reading a chart screenshot (the JSON Claude returns for an uploaded image)
   * ------------------------------------------------------------------ */

  function txt(v, max) {
    return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max || 400) : '';
  }

  function price(v) {
    var n = typeof v === 'string' ? C.num(v) : v;
    return isNum(n) && n > 0 ? n : null;
  }

  /**
   * Check and tidy the model's reading of a chart image. Nothing it says is trusted as-is:
   * prices must be positive numbers near the last price, and a plan is kept only when its
   * stop and targets sit on the right sides of its entry. Returns
   * { isChart, symbol, timeframe, lastPrice, trend, summary, supports, resistances,
   *   plans: { buy, sell } (each null when unusable), favored, reason, risks, confidence, dropped }
   */
  function normalizeChartReading(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var out = {
      isChart: raw.isChart !== false,
      symbol: txt(raw.symbol, 20).toUpperCase().replace(/[^A-Z0-9.]/g, ''),
      timeframe: txt(raw.timeframe, 8).toUpperCase().replace(/[^A-Z0-9]/g, ''),
      lastPrice: price(raw.lastPrice),
      trend: txt(raw.trend, 40), summary: txt(raw.summary, 600), reason: txt(raw.reason, 400), risks: txt(raw.risks, 400),
      confidence: /^(สูง|กลาง|ต่ำ)$/.test(txt(raw.confidence, 8)) ? txt(raw.confidence, 8) : '',
      supports: [], resistances: [], plans: { buy: null, sell: null }, favored: null, dropped: []
    };
    var ref = out.lastPrice;
    // anything more than 25% away from the last price is a misread, not a level
    function near(p) { return p !== null && (ref === null || Math.abs(p - ref) / ref <= 0.25); }
    function list(v) {
      return (Array.isArray(v) ? v : []).map(price).filter(near).filter(function (p, k, arr) { return arr.indexOf(p) === k; }).slice(0, 4);
    }
    out.supports = list(raw.supports).sort(function (a, b) { return b - a; });
    out.resistances = list(raw.resistances).sort(function (a, b) { return a - b; });
    ['buy', 'sell'].forEach(function (side) {
      var p = raw[side] && typeof raw[side] === 'object' ? raw[side] : null;
      if (!p) return;
      var d = side === 'buy' ? 1 : -1;
      var entry = price(p.entry), sl = price(p.sl), tp1 = price(p.tp1), tp2 = price(p.tp2);
      if (!near(entry) || !near(sl) || !near(tp1)) { out.dropped.push(side); return; }
      if (!(d * (entry - sl) > 0 && d * (tp1 - entry) > 0)) { out.dropped.push(side); return; }
      if (tp2 !== null && !(near(tp2) && d * (tp2 - tp1) > 0)) tp2 = null;
      var risk = d * (entry - sl);
      out.plans[side] = {
        side: side, entry: entry, sl: sl, tp1: tp1, tp2: tp2,
        rr1: (d * (tp1 - entry)) / risk, rr2: tp2 === null ? null : (d * (tp2 - entry)) / risk,
        condition: txt(p.condition, 300)
      };
    });
    var fav = txt(raw.favored, 8).toLowerCase();
    out.favored = (fav === 'buy' || fav === 'sell') && out.plans[fav] ? fav : fav === 'wait' ? 'wait' : null;
    return out;
  }

  return {
    MIN_CANDLES: MIN_CANDLES, BIAS: BIAS,
    sma: sma, ema: ema, rsi: rsi, macd: macd, atr: atr, bollinger: bollinger, adx: adx,
    swings: swings, levels: levels, biasOf: biasOf, analyze: analyze,
    parseCandles: parseCandles, normalizeChartReading: normalizeChartReading, spacingMinutes: spacingMinutes, timeframeLabel: timeframeLabel, lastOf: lastOf
  };
});
