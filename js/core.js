/*
 * Trade-Forex — core logic (no DOM).
 * Instruments, P/L maths, statistics, insights, CSV and formatting.
 * Works in the browser (window.TFCore) and in Node (module.exports) so it can be unit-tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TFCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Instruments
   * ------------------------------------------------------------------ */

  var ASSETS = {
    forex: { key: 'forex', label: 'Forex', short: 'FX', contract: 100000, unit: 'Lot' },
    gold: { key: 'gold', label: 'ทองคำ', short: 'XAU', contract: 100, unit: 'Lot' },
    crypto: { key: 'crypto', label: 'บิตคอยน์', short: 'BTC', contract: 1, unit: 'Lot / BTC' }
  };
  var ASSET_ORDER = ['forex', 'gold', 'crypto'];

  var SYMBOLS = {
    forex: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'EURJPY', 'GBPJPY', 'EURGBP', 'AUDJPY'],
    gold: ['XAUUSD'],
    crypto: ['BTCUSD']
  };

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** Parse user input to a finite number, or null. Accepts "1,234.5". */
  function num(v) {
    if (isNum(v)) return v;
    if (v === null || v === undefined) return null;
    var s = String(v).replace(/,/g, '').replace(/−/g, '-').trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  function normSymbol(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 16);
  }

  /** Guess the asset class of a symbol; null when it can't be told. */
  function classifySymbol(sym) {
    var s = normSymbol(sym);
    if (!s) return null;
    if (/^(XAU|GOLD)/.test(s)) return 'gold';
    if (/^(BTC|XBT|ETH|SOL|XRP|BNB|DOGE|ADA|LTC)/.test(s)) return 'crypto';
    if (/^[A-Z]{6}/.test(s)) return 'forex';
    return null;
  }

  /**
   * Contract details used for P/L. `quote`/`base` are currency codes when known.
   * Forex: 1 lot = 100,000 units. Gold: 1 lot = 100 oz. Bitcoin: 1 lot = 1 coin.
   */
  function instrument(symbol, asset) {
    var s = normSymbol(symbol);
    var a = ASSETS[asset] ? asset : classifySymbol(s) || 'forex';
    var letters = s.replace(/[^A-Z]/g, '');
    if (a === 'forex') {
      var base = letters.slice(0, 3);
      var quote = letters.slice(3, 6);
      var jpy = quote === 'JPY';
      return { asset: a, contract: 100000, pip: jpy ? 0.01 : 0.0001, digits: jpy ? 3 : 5, base: base, quote: quote };
    }
    if (a === 'gold') {
      return { asset: a, contract: 100, pip: 0.1, digits: 2, base: 'XAU', quote: 'USD' };
    }
    return { asset: 'crypto', contract: 1, pip: 1, digits: 2, base: letters.slice(0, 3), quote: 'USD' };
  }

  /* ------------------------------------------------------------------ *
   * Per-trade maths
   * ------------------------------------------------------------------ */

  function dirOf(t) {
    return t.side === 'sell' ? -1 : 1;
  }

  /** Convert an amount in the quote currency to USD. Null when a rate is needed that we don't have. */
  function quoteToUsd(amount, ins, refPrice) {
    if (ins.quote === 'USD') return amount;
    if (ins.base === 'USD' && isNum(refPrice) && refPrice > 0) return amount / refPrice;
    return null;
  }

  /** Gross profit in USD from prices (before fees). Null for cross pairs or missing fields. */
  function calcGross(t) {
    if (!isNum(t.entry) || !isNum(t.exit) || !isNum(t.lots)) return null;
    var ins = instrument(t.symbol, t.asset);
    var q = (t.exit - t.entry) * dirOf(t) * t.lots * ins.contract;
    return quoteToUsd(q, ins, t.exit);
  }

  /** Net profit suggestion: gross minus fees. */
  function calcNet(t) {
    var g = calcGross(t);
    if (g === null) return null;
    return round(g - (isNum(t.fees) ? t.fees : 0), 2);
  }

  function calcPips(t) {
    if (!isNum(t.entry) || !isNum(t.exit)) return null;
    var ins = instrument(t.symbol, t.asset);
    return ((t.exit - t.entry) * dirOf(t)) / ins.pip;
  }

  /** Realised R-multiple from prices: how many times the initial risk was won or lost. */
  function calcR(t) {
    if (!isNum(t.entry) || !isNum(t.exit) || !isNum(t.sl)) return null;
    var risk = Math.abs(t.entry - t.sl);
    if (risk <= 0) return null;
    return ((t.exit - t.entry) * dirOf(t)) / risk;
  }

  /** Planned reward-to-risk from entry, SL and TP. */
  function plannedRR(t) {
    if (!isNum(t.entry) || !isNum(t.sl) || !isNum(t.tp)) return null;
    var risk = Math.abs(t.entry - t.sl);
    if (risk <= 0) return null;
    return Math.abs(t.tp - t.entry) / risk;
  }

  /** Money at risk (USD) if the stop loss is hit. */
  function riskAmount(t) {
    if (!isNum(t.entry) || !isNum(t.sl) || !isNum(t.lots)) return null;
    var ins = instrument(t.symbol, t.asset);
    var q = Math.abs(t.entry - t.sl) * t.lots * ins.contract;
    return quoteToUsd(q, ins, t.sl);
  }

  function toDate(s) {
    if (!s) return null;
    if (s instanceof Date) return isNaN(s) ? null : s;
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function holdMinutes(t) {
    var a = toDate(t.openTime), b = toDate(t.closeTime);
    if (!a || !b) return null;
    var m = (b - a) / 60000;
    return m >= 0 ? m : null;
  }

  function isClosed(t) {
    return isNum(t.pnl) && !!toDate(t.closeTime);
  }

  /** Time used to order a trade: close time, else open time. */
  function tradeTime(t) {
    return toDate(t.closeTime) || toDate(t.openTime);
  }

  function round(v, dp) {
    var f = Math.pow(10, dp);
    return Math.round((v + Number.EPSILON) * f) / f;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** Local "YYYY-MM-DDTHH:mm" (the value format of <input type="datetime-local">). */
  function toLocalInput(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function monthKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  /* ------------------------------------------------------------------ *
   * Trade records
   * ------------------------------------------------------------------ */

  var EMOTIONS = ['มั่นใจ', 'เฉยๆ', 'ลังเล', 'กลัว', 'โลภ', 'เอาคืน'];
  var NOTE_MAX = 1000;

  function newId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function cleanText(v, max) {
    return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
  }

  function cleanTime(v) {
    var d = toDate(v);
    return d ? toLocalInput(d) : '';
  }

  /** Coerce arbitrary input (form, CSV, backup file) into a trade record. */
  function normalizeTrade(raw) {
    raw = raw || {};
    var symbol = normSymbol(raw.symbol);
    var asset = ASSETS[raw.asset] ? raw.asset : classifySymbol(symbol) || 'forex';
    var side = String(raw.side || '').toLowerCase();
    side = side === 'sell' || side === 'short' ? 'sell' : 'buy';
    var plan = raw.plan;
    if (plan === 'yes' || plan === true || plan === 'true' || plan === '1') plan = 'yes';
    else if (plan === 'no' || plan === false || plan === 'false' || plan === '0') plan = 'no';
    else plan = '';
    var t = {
      id: cleanText(raw.id, 40) || newId(),
      symbol: symbol,
      asset: asset,
      side: side,
      lots: num(raw.lots),
      entry: num(raw.entry),
      exit: num(raw.exit),
      sl: num(raw.sl),
      tp: num(raw.tp),
      openTime: cleanTime(raw.openTime),
      closeTime: cleanTime(raw.closeTime),
      fees: num(raw.fees) || 0,
      pnl: num(raw.pnl),
      strategy: cleanText(raw.strategy, 60),
      emotion: cleanText(raw.emotion, 20),
      plan: plan,
      notes: cleanText(raw.notes, NOTE_MAX)
    };
    if (raw.sample) t.sample = true;
    return t;
  }

  /** Returns { field: message } for anything that stops the trade being saved. */
  function validateTrade(t) {
    var e = {};
    if (!t.symbol) e.symbol = 'ใส่ชื่อคู่เงินหรือสินทรัพย์ เช่น EURUSD, XAUUSD, BTCUSD';
    if (!isNum(t.lots) || t.lots <= 0) e.lots = 'ใส่ขนาด Lot ที่มากกว่า 0';
    if (!isNum(t.entry) || t.entry <= 0) e.entry = 'ใส่ราคาเข้า';
    if (!toDate(t.openTime)) e.openTime = 'เลือกวันและเวลาที่เปิดออเดอร์';
    if (isNum(t.exit) && t.exit <= 0) e.exit = 'ราคาออกต้องมากกว่า 0';
    if (isNum(t.sl) && t.sl <= 0) e.sl = 'SL ต้องมากกว่า 0';
    if (isNum(t.tp) && t.tp <= 0) e.tp = 'TP ต้องมากกว่า 0';
    var closing = isNum(t.exit) || !!t.closeTime || isNum(t.pnl);
    if (closing) {
      if (!toDate(t.closeTime)) e.closeTime = 'เลือกวันและเวลาที่ปิดออเดอร์';
      else if (toDate(t.openTime) && toDate(t.closeTime) < toDate(t.openTime)) e.closeTime = 'เวลาปิดต้องไม่ก่อนเวลาเปิด';
      if (!isNum(t.pnl)) e.pnl = 'ใส่กำไร/ขาดทุนสุทธิของออเดอร์นี้';
    }
    return e;
  }

  /* ------------------------------------------------------------------ *
   * Filtering
   * ------------------------------------------------------------------ */

  var RANGES = [
    { key: 'all', label: 'ทั้งหมด' },
    { key: '7d', label: '7 วัน', days: 7 },
    { key: '30d', label: '30 วัน', days: 30 },
    { key: '90d', label: '90 วัน', days: 90 },
    { key: 'ytd', label: 'ปีนี้' }
  ];

  function rangeStart(range, now) {
    now = now || new Date();
    for (var i = 0; i < RANGES.length; i++) {
      if (RANGES[i].key === range && RANGES[i].days) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        d.setDate(d.getDate() - RANGES[i].days + 1);
        return d;
      }
    }
    if (range === 'ytd') return new Date(now.getFullYear(), 0, 1);
    return null;
  }

  /** opts: { range, asset, q, now } */
  function filterTrades(trades, opts) {
    opts = opts || {};
    var start = rangeStart(opts.range, opts.now);
    var q = String(opts.q || '').trim().toLowerCase();
    return trades.filter(function (t) {
      if (opts.asset && opts.asset !== 'all' && t.asset !== opts.asset) return false;
      if (start) {
        var d = tradeTime(t);
        if (!d || d < start) return false;
      }
      if (q) {
        var hay = (t.symbol + ' ' + t.strategy + ' ' + t.notes + ' ' + t.emotion + ' ' + (t.side === 'sell' ? 'sell short' : 'buy long')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function closedSorted(trades) {
    return trades.filter(isClosed).sort(function (a, b) {
      var d = toDate(a.closeTime) - toDate(b.closeTime);
      return d !== 0 ? d : (toDate(a.openTime) || 0) - (toDate(b.openTime) || 0);
    });
  }

  /* ------------------------------------------------------------------ *
   * Statistics
   * ------------------------------------------------------------------ */

  /** Headline statistics over closed trades. `startBalance` anchors equity and drawdown %. */
  function computeStats(trades, opts) {
    opts = opts || {};
    var start = isNum(opts.startBalance) && opts.startBalance > 0 ? opts.startBalance : 0;
    var list = closedSorted(trades);
    var s = {
      n: list.length, wins: 0, losses: 0, be: 0,
      grossProfit: 0, grossLoss: 0, net: 0, fees: 0,
      winRate: null, profitFactor: null, avgWin: null, avgLoss: null, payoff: null, expectancy: null,
      avgR: null, nR: 0, best: null, worst: null,
      maxWinStreak: 0, maxLossStreak: 0, streak: { type: null, n: 0 },
      maxDD: 0, maxDDPct: null, returnPct: null, avgHoldMin: null,
      startBalance: start, equity: [], open: trades.length - list.length
    };
    var cum = 0, peak = start, rSum = 0, holdSum = 0, holdN = 0, ws = 0, ls = 0;
    list.forEach(function (t, i) {
      var p = t.pnl;
      s.net += p;
      s.fees += isNum(t.fees) ? t.fees : 0;
      if (p > 0) { s.wins++; s.grossProfit += p; ws++; ls = 0; }
      else if (p < 0) { s.losses++; s.grossLoss += -p; ls++; ws = 0; }
      else { s.be++; ws = 0; ls = 0; }
      if (ws > s.maxWinStreak) s.maxWinStreak = ws;
      if (ls > s.maxLossStreak) s.maxLossStreak = ls;
      if (!s.best || p > s.best.pnl) s.best = t;
      if (!s.worst || p < s.worst.pnl) s.worst = t;
      var r = calcR(t);
      if (r !== null) { rSum += r; s.nR++; }
      var h = holdMinutes(t);
      if (h !== null) { holdSum += h; holdN++; }
      cum += p;
      var eq = start + cum;
      if (eq > peak) peak = eq;
      var dd = eq - peak;
      if (dd < -s.maxDD) {
        s.maxDD = -dd;
        s.maxDDPct = peak > 0 ? (-dd / peak) * 100 : null;
      }
      s.equity.push({ i: i + 1, trade: t, time: toDate(t.closeTime), cum: cum, equity: eq, dd: dd });
    });
    s.streak = ws > 0 ? { type: 'win', n: ws } : ls > 0 ? { type: 'loss', n: ls } : { type: null, n: 0 };
    if (s.n > 0) {
      var decided = s.wins + s.losses;
      s.winRate = (s.wins / s.n) * 100;
      s.expectancy = s.net / s.n;
      s.avgWin = s.wins ? s.grossProfit / s.wins : null;
      s.avgLoss = s.losses ? s.grossLoss / s.losses : null;
      s.payoff = s.avgWin !== null && s.avgLoss ? s.avgWin / s.avgLoss : null;
      s.profitFactor = s.grossLoss > 0 ? s.grossProfit / s.grossLoss : (s.grossProfit > 0 ? Infinity : null);
      s.avgR = s.nR ? rSum / s.nR : null;
      s.avgHoldMin = holdN ? holdSum / holdN : null;
      s.returnPct = start > 0 ? (s.net / start) * 100 : null;
      s.decided = decided;
    }
    return s;
  }

  /**
   * Group closed trades. keyFn returns a key (or null to skip); labelFn names it.
   * Returns [{ key, label, n, wins, losses, net, grossProfit, grossLoss, winRate, avg }].
   */
  function groupStats(trades, keyFn, labelFn) {
    var map = {}, order = [];
    trades.forEach(function (t) {
      if (!isClosed(t)) return;
      var k = keyFn(t);
      if (k === null || k === undefined || k === '') return;
      var g = map[k];
      if (!g) {
        g = map[k] = { key: k, label: labelFn ? labelFn(k, t) : String(k), n: 0, wins: 0, losses: 0, net: 0, grossProfit: 0, grossLoss: 0 };
        order.push(g);
      }
      g.n++;
      g.net += t.pnl;
      if (t.pnl > 0) { g.wins++; g.grossProfit += t.pnl; }
      else if (t.pnl < 0) { g.losses++; g.grossLoss += -t.pnl; }
    });
    order.forEach(function (g) {
      g.winRate = (g.wins / g.n) * 100;
      g.avg = g.net / g.n;
    });
    return order;
  }

  function byNetDesc(a, b) {
    return b.net - a.net;
  }

  function bySymbol(trades) {
    return groupStats(trades, function (t) { return t.symbol; }).sort(byNetDesc);
  }

  function byAsset(trades) {
    var g = groupStats(trades, function (t) { return t.asset; }, function (k) { return ASSETS[k].label; });
    var idx = {};
    g.forEach(function (x) { idx[x.key] = x; });
    return ASSET_ORDER.map(function (k) {
      return idx[k] || { key: k, label: ASSETS[k].label, n: 0, wins: 0, losses: 0, net: 0, grossProfit: 0, grossLoss: 0, winRate: null, avg: null };
    });
  }

  var NO_STRATEGY = 'ไม่ระบุ';

  function byStrategy(trades) {
    return groupStats(trades, function (t) { return t.strategy || NO_STRATEGY; }).sort(byNetDesc);
  }

  function bySide(trades) {
    var g = groupStats(trades, function (t) { return t.side; }, function (k) { return k === 'sell' ? 'Sell (Short)' : 'Buy (Long)'; });
    return g.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
  }

  var WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสฯ', 'ศุกร์', 'เสาร์'];
  var WEEKDAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  /** By weekday of the entry (local time), Monday first. Days with no trades are kept so the axis is complete. */
  function byWeekday(trades) {
    var g = groupStats(trades, function (t) {
      var d = toDate(t.openTime) || toDate(t.closeTime);
      return d ? String(d.getDay()) : null;
    });
    var idx = {};
    g.forEach(function (x) { idx[x.key] = x; });
    var out = [];
    WEEK_ORDER.forEach(function (wd) {
      var x = idx[String(wd)];
      if (!x && (wd === 0 || wd === 6)) return; // weekends only when traded (crypto)
      out.push(x ? Object.assign(x, { label: WEEKDAYS_SHORT[wd], full: WEEKDAYS[wd] })
        : { key: String(wd), label: WEEKDAYS_SHORT[wd], full: WEEKDAYS[wd], n: 0, wins: 0, losses: 0, net: 0, grossProfit: 0, grossLoss: 0, winRate: null, avg: null });
    });
    return out;
  }

  /* Market sessions, defined in UTC hours. */
  var SESSIONS = [
    { key: 'asia', label: 'เอเชีย', from: 22, to: 7 },
    { key: 'london', label: 'ลอนดอน', from: 7, to: 12 },
    { key: 'overlap', label: 'ลอนดอน+นิวยอร์ก', from: 12, to: 16 },
    { key: 'ny', label: 'นิวยอร์ก', from: 16, to: 22 }
  ];

  function sessionOf(date) {
    var h = date.getUTCHours();
    if (h >= 7 && h < 12) return 'london';
    if (h >= 12 && h < 16) return 'overlap';
    if (h >= 16 && h < 22) return 'ny';
    return 'asia';
  }

  /** "14:00–19:00" in the viewer's own time zone for a session. */
  function sessionLocalRange(sess, tzOffsetMin) {
    var off = isNum(tzOffsetMin) ? tzOffsetMin : -new Date().getTimezoneOffset();
    function local(h) {
      var m = (((h * 60 + off) % 1440) + 1440) % 1440;
      return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
    }
    return local(sess.from) + '–' + local(sess.to);
  }

  function bySession(trades) {
    var g = groupStats(trades, function (t) {
      var d = toDate(t.openTime) || toDate(t.closeTime);
      return d ? sessionOf(d) : null;
    });
    var idx = {};
    g.forEach(function (x) { idx[x.key] = x; });
    return SESSIONS.map(function (s) {
      var x = idx[s.key];
      return x ? Object.assign(x, { label: s.label })
        : { key: s.key, label: s.label, n: 0, wins: 0, losses: 0, net: 0, grossProfit: 0, grossLoss: 0, winRate: null, avg: null };
    });
  }

  var HOLD_BUCKETS = [
    { key: 'h0', label: 'ไม่เกิน 30 นาที', max: 30 },
    { key: 'h1', label: '30 นาที–4 ชม.', max: 240 },
    { key: 'h2', label: '4–24 ชม.', max: 1440 },
    { key: 'h3', label: 'เกิน 1 วัน', max: Infinity }
  ];

  function byHold(trades) {
    var g = groupStats(trades, function (t) {
      var m = holdMinutes(t);
      if (m === null) return null;
      for (var i = 0; i < HOLD_BUCKETS.length; i++) if (m <= HOLD_BUCKETS[i].max) return HOLD_BUCKETS[i].key;
      return null;
    });
    var idx = {};
    g.forEach(function (x) { idx[x.key] = x; });
    return HOLD_BUCKETS.map(function (b) {
      var x = idx[b.key];
      return x ? Object.assign(x, { label: b.label })
        : { key: b.key, label: b.label, n: 0, wins: 0, losses: 0, net: 0, grossProfit: 0, grossLoss: 0, winRate: null, avg: null };
    });
  }

  var MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

  function monthLabel(key) {
    var p = key.split('-');
    return MONTHS_SHORT[Number(p[1]) - 1] + ' ' + p[0].slice(2);
  }

  /** By calendar month of the close, oldest first. */
  function byMonth(trades) {
    var g = groupStats(trades, function (t) { return monthKey(toDate(t.closeTime)); }, monthLabel);
    return g.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
  }

  /** { 'YYYY-MM-DD': { net, n } } by close date. */
  function dailyPnl(trades) {
    var out = {};
    trades.forEach(function (t) {
      if (!isClosed(t)) return;
      var k = dayKey(toDate(t.closeTime));
      var d = out[k] || (out[k] = { net: 0, n: 0 });
      d.net += t.pnl;
      d.n++;
    });
    return out;
  }

  function byEmotion(trades) {
    return groupStats(trades, function (t) { return t.emotion || null; }).sort(byNetDesc);
  }

  function byPlan(trades) {
    return groupStats(trades, function (t) { return t.plan || null; }, function (k) { return k === 'yes' ? 'ทำตามแผน' : 'ไม่ทำตามแผน'; })
      .sort(function (a, b) { return a.key === 'yes' ? -1 : 1; });
  }

  var R_BINS = [
    { label: 'ต่ำกว่า −2R', lo: -Infinity, hi: -2, sign: -1 },
    { label: '−2R ถึง −1R', lo: -2, hi: -1, sign: -1 },
    { label: '−1R ถึง 0', lo: -1, hi: 0, sign: -1 },
    { label: '0 ถึง 1R', lo: 0, hi: 1, sign: 1 },
    { label: '1R ถึง 2R', lo: 1, hi: 2, sign: 1 },
    { label: '2R ถึง 3R', lo: 2, hi: 3, sign: 1 },
    { label: '3R ขึ้นไป', lo: 3, hi: Infinity, sign: 1 }
  ];

  /** Count of trades per R-multiple bin (lo <= R < hi). Only trades with an SL have an R. */
  function rHistogram(trades) {
    var bins = R_BINS.map(function (b) { return { label: b.label, sign: b.sign, n: 0 }; });
    var total = 0;
    trades.forEach(function (t) {
      if (!isClosed(t)) return;
      var r = calcR(t);
      if (r === null) return;
      r = round(r, 2);
      for (var i = 0; i < R_BINS.length; i++) {
        if (r >= R_BINS[i].lo && r < R_BINS[i].hi) { bins[i].n++; total++; break; }
      }
    });
    return { bins: bins, total: total };
  }

  /* ------------------------------------------------------------------ *
   * Insights — plain-language observations, each backed by a minimum sample
   * ------------------------------------------------------------------ */

  var MIN_GROUP = 3;

  function insights(trades, stats) {
    var out = [];
    var s = stats || computeStats(trades);
    if (s.n === 0) return out;

    if (s.n < 20) {
      out.push({ tone: 'info', key: 'sample', title: 'ข้อมูลยังน้อย',
        text: 'ตอนนี้มี ' + s.n + ' เทรดที่ปิดแล้ว สถิติจะเริ่มน่าเชื่อถือเมื่อมีราว 30 เทรดขึ้นไป อย่าเพิ่งปรับระบบจากตัวเลขชุดนี้' });
    }

    if (s.wins > 0 && s.losses > 0) {
      var breakeven = (s.avgLoss / (s.avgWin + s.avgLoss)) * 100;
      if (s.expectancy > 0) {
        out.push({ tone: 'good', key: 'edge', title: 'ระบบมีค่าคาดหวังเป็นบวก',
          text: 'เฉลี่ยได้ ' + fmtMoney(s.expectancy, { sign: true }) + ' ต่อเทรด ด้วย Win rate ' + fmtPct(s.winRate) +
            ' (จุดคุ้มทุนอยู่ที่ ' + fmtPct(breakeven) + ' เมื่อกำไรเฉลี่ย ' + fmtMoney(s.avgWin) + ' และขาดทุนเฉลี่ย ' + fmtMoney(s.avgLoss) + ')' });
      } else {
        out.push({ tone: 'warn', key: 'edge', title: 'ค่าคาดหวังยังติดลบ',
          text: 'เฉลี่ย ' + fmtMoney(s.expectancy, { sign: true }) + ' ต่อเทรด Win rate ' + fmtPct(s.winRate) +
            ' แต่ต้องชนะอย่างน้อย ' + fmtPct(breakeven) + ' จึงจะคุ้มทุน เพราะขาดทุนเฉลี่ย ' + fmtMoney(s.avgLoss) + ' เทียบกับกำไรเฉลี่ย ' + fmtMoney(s.avgWin) });
      }
      if (s.wins >= MIN_GROUP && s.losses >= MIN_GROUP && s.payoff < 0.8) {
        out.push({ tone: 'warn', key: 'payoff', title: 'ขาดทุนต่อครั้งใหญ่กว่ากำไรต่อครั้ง',
          text: 'กำไรเฉลี่ยเป็น ' + s.payoff.toFixed(2) + ' เท่าของขาดทุนเฉลี่ย ลองดูว่าปิดกำไรเร็วไปหรือปล่อยให้ขาดทุนลากเกิน SL หรือไม่' });
      }
    }

    function pick(groups, minN) {
      return groups.filter(function (g) { return g.n >= (minN || MIN_GROUP); });
    }

    var sym = pick(bySymbol(trades));
    if (sym.length >= 2) {
      var bestS = sym[0], worstS = sym[sym.length - 1];
      if (bestS.net > 0) {
        out.push({ tone: 'good', key: 'bestSymbol', title: 'ทำได้ดีที่สุดกับ ' + bestS.label,
          text: 'กำไรรวม ' + fmtMoney(bestS.net, { sign: true }) + ' จาก ' + bestS.n + ' เทรด Win rate ' + fmtPct(bestS.winRate) });
      }
      if (worstS.net < 0) {
        out.push({ tone: 'warn', key: 'worstSymbol', title: worstS.label + ' ดึงผลรวมลง',
          text: 'ขาดทุนรวม ' + fmtMoney(worstS.net, { sign: true }) + ' จาก ' + worstS.n + ' เทรด Win rate ' + fmtPct(worstS.winRate) + ' ลองลดขนาด Lot หรือพักคู่นี้จนกว่าจะเจอ Setup ที่ชัด' });
      }
    }

    var strat = pick(byStrategy(trades)).filter(function (g) { return g.key !== NO_STRATEGY; });
    if (strat.length >= 2) {
      var worstT = strat[strat.length - 1];
      if (strat[0].net > 0) {
        out.push({ tone: 'good', key: 'bestStrategy', title: 'กลยุทธ์ที่ได้ผลที่สุด: ' + strat[0].label,
          text: 'กำไรรวม ' + fmtMoney(strat[0].net, { sign: true }) + ' จาก ' + strat[0].n + ' เทรด เฉลี่ย ' + fmtMoney(strat[0].avg, { sign: true }) + ' ต่อเทรด' });
      }
      if (worstT.net < 0) {
        out.push({ tone: 'warn', key: 'worstStrategy', title: 'กลยุทธ์ที่ยังไม่ได้ผล: ' + worstT.label,
          text: 'ขาดทุนรวม ' + fmtMoney(worstT.net, { sign: true }) + ' จาก ' + worstT.n + ' เทรด Win rate ' + fmtPct(worstT.winRate) });
      }
    }

    var sess = pick(bySession(trades));
    if (sess.length >= 2) {
      var sorted = sess.slice().sort(byNetDesc);
      var bestSe = sorted[0], worstSe = sorted[sorted.length - 1];
      if (bestSe.net > 0 && worstSe.net < 0) {
        out.push({ tone: 'info', key: 'session', title: 'ช่วงเวลามีผลกับผลลัพธ์',
          text: 'ช่วง' + bestSe.label + 'ได้ ' + fmtMoney(bestSe.net, { sign: true }) + ' (' + bestSe.n + ' เทรด) ส่วนช่วง' + worstSe.label + 'เสีย ' + fmtMoney(worstSe.net, { sign: true }) + ' (' + worstSe.n + ' เทรด)' });
      }
    }

    var wd = pick(byWeekday(trades)).sort(byNetDesc);
    if (wd.length >= 3 && wd[wd.length - 1].net < 0) {
      var w = wd[wd.length - 1];
      out.push({ tone: 'info', key: 'weekday', title: 'วัน' + w.full + 'เป็นวันที่เสียมากที่สุด',
        text: 'ขาดทุนรวม ' + fmtMoney(w.net, { sign: true }) + ' จาก ' + w.n + ' เทรด Win rate ' + fmtPct(w.winRate) });
    }

    var side = pick(bySide(trades));
    if (side.length === 2 && side[0].net * side[1].net < 0) {
      var up = side[0].net > 0 ? side[0] : side[1], down = side[0].net > 0 ? side[1] : side[0];
      out.push({ tone: 'info', key: 'side', title: 'ฝั่ง ' + up.label + ' ทำได้ดีกว่า',
        text: up.label + ' ได้ ' + fmtMoney(up.net, { sign: true }) + ' (Win rate ' + fmtPct(up.winRate) + ') ขณะที่ ' + down.label + ' เสีย ' + fmtMoney(down.net, { sign: true }) + ' (Win rate ' + fmtPct(down.winRate) + ')' });
    }

    var plan = pick(byPlan(trades));
    if (plan.length === 2) {
      var yes = plan[0].key === 'yes' ? plan[0] : plan[1], no = plan[0].key === 'yes' ? plan[1] : plan[0];
      if (yes.avg > no.avg) {
        out.push({ tone: no.net < 0 ? 'warn' : 'info', key: 'plan', title: 'ทำตามแผนให้ผลดีกว่า',
          text: 'เทรดที่ทำตามแผนเฉลี่ย ' + fmtMoney(yes.avg, { sign: true }) + ' ต่อเทรด (' + yes.n + ' เทรด) ส่วนเทรดที่หลุดแผนเฉลี่ย ' + fmtMoney(no.avg, { sign: true }) + ' (' + no.n + ' เทรด)' });
      }
    }

    var emo = pick(byEmotion(trades));
    if (emo.length >= 2 && emo[emo.length - 1].net < 0) {
      var em = emo[emo.length - 1];
      out.push({ tone: 'warn', key: 'emotion', title: 'เทรดตอนรู้สึก “' + em.label + '” มักเสีย',
        text: 'ขาดทุนรวม ' + fmtMoney(em.net, { sign: true }) + ' จาก ' + em.n + ' เทรด Win rate ' + fmtPct(em.winRate) });
    }

    if (s.maxLossStreak >= 4) {
      out.push({ tone: 'info', key: 'streak', title: 'เคยแพ้ติดกัน ' + s.maxLossStreak + ' เทรด',
        text: 'วางขนาด Lot ให้พอร์ตรับช่วงแพ้ติดกันแบบนี้ได้โดยไม่เสียเกินที่ตั้งใจ' });
    }

    if (s.maxDDPct !== null && s.maxDDPct >= 15) {
      out.push({ tone: 'warn', key: 'drawdown', title: 'Drawdown สูงสุด ' + fmtPct(s.maxDDPct),
        text: 'พอร์ตเคยลดลง ' + fmtMoney(s.maxDD) + ' จากจุดสูงสุด ลองลดความเสี่ยงต่อเทรดลงเพื่อให้ช่วงขาดทุนตื้นขึ้น' });
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Position sizing
   * ------------------------------------------------------------------ */

  /** in: { balance, riskPct, symbol, asset, entry, sl, tp } */
  function positionSize(inp) {
    var balance = num(inp.balance), riskPct = num(inp.riskPct), entry = num(inp.entry), sl = num(inp.sl), tp = num(inp.tp);
    if (!isNum(balance) || balance <= 0 || !isNum(riskPct) || riskPct <= 0 || !isNum(entry) || !isNum(sl) || entry <= 0 || sl <= 0 || entry === sl) return null;
    var ins = instrument(inp.symbol, inp.asset);
    var dist = Math.abs(entry - sl);
    var lossPerLot = quoteToUsd(dist * ins.contract, ins, sl);
    var riskAmt = balance * riskPct / 100;
    var out = { riskAmount: riskAmt, distance: dist, pips: dist / ins.pip, side: sl < entry ? 'buy' : 'sell', lossPerLot: lossPerLot, lots: null, actualRisk: null, rr: null, reward: null, needsRate: lossPerLot === null };
    if (lossPerLot !== null && lossPerLot > 0) {
      out.lots = Math.floor((riskAmt / lossPerLot) * 100 + 1e-9) / 100;
      out.actualRisk = out.lots * lossPerLot;
    }
    if (isNum(tp) && tp > 0 && tp !== entry) {
      out.rr = Math.abs(tp - entry) / dist;
      if (out.lots !== null) {
        var rw = quoteToUsd(Math.abs(tp - entry) * ins.contract * out.lots, ins, tp);
        out.reward = rw;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * CSV
   * ------------------------------------------------------------------ */

  var CSV_FIELDS = ['openTime', 'closeTime', 'symbol', 'asset', 'side', 'lots', 'entry', 'exit', 'sl', 'tp', 'fees', 'pnl', 'strategy', 'emotion', 'plan', 'notes'];

  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(trades) {
    var lines = [CSV_FIELDS.join(',')];
    trades.forEach(function (t) {
      lines.push(CSV_FIELDS.map(function (f) { return csvCell(t[f]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /** RFC-4180-style parser. Returns an array of rows (arrays of strings). */
  function parseCSV(text) {
    var rows = [], row = [], cell = '', q = false, i = 0;
    text = String(text || '').replace(/^﻿/, '');
    var delim = ',';
    var firstLine = text.split(/\r?\n/)[0] || '';
    if (firstLine.split(';').length > firstLine.split(',').length) delim = ';';
    else if (firstLine.split('\t').length > firstLine.split(',').length) delim = '\t';
    for (; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }

  /* Header aliases, so files exported from MT4/MT5-style history tables also load. */
  var CSV_ALIASES = {
    opentime: 'openTime', open: 'openTime', opendate: 'openTime', time: 'openTime', 'เวลาเปิด': 'openTime',
    closetime: 'closeTime', closedate: 'closeTime', 'เวลาปิด': 'closeTime',
    symbol: 'symbol', item: 'symbol', instrument: 'symbol', pair: 'symbol', 'คู่เงิน': 'symbol',
    asset: 'asset',
    side: 'side', type: 'side', direction: 'side', 'ฝั่ง': 'side',
    lots: 'lots', lot: 'lots', size: 'lots', volume: 'lots', qty: 'lots',
    entry: 'entry', openprice: 'entry', entryprice: 'entry', 'ราคาเข้า': 'entry',
    exit: 'exit', closeprice: 'exit', exitprice: 'exit', 'ราคาออก': 'exit',
    sl: 'sl', stoploss: 'sl', tp: 'tp', takeprofit: 'tp',
    fees: 'fees', commission: 'commission', swap: 'swap', taxes: 'taxes',
    pnl: 'pnl', profit: 'profit', netprofit: 'pnl', 'กำไร': 'pnl',
    strategy: 'strategy', setup: 'strategy', 'กลยุทธ์': 'strategy',
    emotion: 'emotion', plan: 'plan',
    notes: 'notes', note: 'notes', comment: 'notes', 'โน้ต': 'notes'
  };

  function parseLooseDate(s) {
    s = String(s || '').trim();
    if (!s) return '';
    var m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/);
    if (m) return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) + 'T' + pad2(+(m[4] || 0)) + ':' + (m[5] || '00');
    m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?/);
    if (m) return m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]) + 'T' + pad2(+(m[4] || 0)) + ':' + (m[5] || '00');
    var d = toDate(s);
    return d ? toLocalInput(d) : '';
  }

  /** Parse CSV text into trades. Returns { trades, skipped, error }. */
  function importCSV(text) {
    var rows = parseCSV(text);
    if (rows.length < 2) return { trades: [], skipped: 0, error: 'ไฟล์ไม่มีข้อมูล ต้องมีแถวหัวตารางและข้อมูลอย่างน้อย 1 แถว' };
    var seenPrice = 0;
    var cols = rows[0].map(function (h) {
      var k = String(h).toLowerCase().replace(/[\s_\/.\-]/g, '');
      if (k === 'price') { seenPrice++; return seenPrice === 1 ? 'entry' : 'exit'; }
      return CSV_ALIASES[k] || null;
    });
    if (cols.indexOf('symbol') === -1 || cols.indexOf('entry') === -1) {
      return { trades: [], skipped: 0, error: 'ไม่พบคอลัมน์ symbol และ entry ในหัวตาราง ลองส่งออก CSV จากแอพนี้เพื่อดูรูปแบบที่ใช้ได้' };
    }
    var trades = [], skipped = 0;
    for (var r = 1; r < rows.length; r++) {
      var raw = {}, extra = { commission: 0, swap: 0, taxes: 0, profit: null };
      for (var c = 0; c < cols.length; c++) {
        var f = cols[c], v = rows[r][c];
        if (!f || v === undefined) continue;
        if (f === 'commission' || f === 'swap' || f === 'taxes') extra[f] = num(v) || 0;
        else if (f === 'profit') extra.profit = num(v);
        else if (f === 'openTime' || f === 'closeTime') raw[f] = parseLooseDate(v);
        else if (f === 'side') {
          var sv = String(v).toLowerCase();
          if (!/buy|sell|long|short/.test(sv)) { raw.__skip = true; }
          raw.side = /sell|short/.test(sv) ? 'sell' : 'buy';
        } else if (typeof v === 'string' && v.charAt(0) === "'" && /^'[=+\-@]/.test(v)) raw[f] = v.slice(1);
        else raw[f] = v;
      }
      if (raw.__skip) { skipped++; continue; } // balance / deposit rows in broker statements
      if (extra.profit !== null && raw.pnl === undefined) {
        // broker statements list costs as negative numbers alongside gross profit
        var costs = extra.commission + extra.swap + extra.taxes;
        raw.pnl = round(extra.profit + costs, 2);
        raw.fees = round(-costs, 2);
      }
      raw.id = '';
      var t = normalizeTrade(raw);
      var err = validateTrade(t);
      if (Object.keys(err).length) { skipped++; continue; }
      trades.push(t);
    }
    return { trades: trades, skipped: skipped, error: trades.length ? null : 'อ่านไฟล์ได้ แต่ไม่มีแถวไหนครบพอจะบันทึกเป็นเทรด' };
  }

  /* ------------------------------------------------------------------ *
   * Formatting
   * ------------------------------------------------------------------ */

  var MINUS = '−';

  function fmtNumber(v, dp) {
    return v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }

  /** "$1,234.50", "−$320.00"; opts.sign adds "+" to gains; opts.dp overrides decimals. */
  function fmtMoney(v, opts) {
    if (!isNum(v)) return '–';
    opts = opts || {};
    var abs = Math.abs(v);
    var dp = opts.dp !== undefined ? opts.dp : abs >= 100000 ? 0 : 2;
    if (abs < 0.5 / Math.pow(10, dp)) { abs = 0; v = 0; }
    var sign = v < 0 ? MINUS : opts.sign && v > 0 ? '+' : '';
    return sign + '$' + fmtNumber(abs, dp);
  }

  /** Axis tick: full numbers below 10,000, compact (10K) on an axis that reaches it. */
  function fmtAxisMoney(v, maxAbs) {
    var abs = Math.abs(v), sign = v < 0 ? MINUS : '';
    if (maxAbs >= 1000000) return sign + '$' + trimZero(abs / 1000000, 1) + 'M';
    if (maxAbs >= 10000) return sign + '$' + trimZero(abs / 1000, 1) + 'K';
    return sign + '$' + fmtNumber(abs, abs < 10 && abs !== Math.floor(abs) ? 2 : 0);
  }

  function trimZero(v, dp) {
    return String(parseFloat(v.toFixed(dp)));
  }

  function fmtPct(v, dp) {
    if (!isNum(v)) return '–';
    return v.toFixed(dp === undefined ? (Math.abs(v) >= 100 || v === Math.round(v) ? 0 : 1) : dp) + '%';
  }

  function fmtSigned(v, dp, unit) {
    if (!isNum(v)) return '–';
    var a = Math.abs(v), s = a.toFixed(dp);
    if (Number(s) === 0) return s + (unit || '');
    return (v < 0 ? MINUS : '+') + s + (unit || '');
  }

  function fmtR(v) {
    return isNum(v) ? fmtSigned(v, 2, 'R') : '–';
  }

  function fmtPrice(v, symbol, asset) {
    if (!isNum(v)) return '–';
    var ins = instrument(symbol, asset);
    return fmtNumber(v, ins.digits);
  }

  /** Lot size with at least two decimals: 0.2 -> "0.20", 0.005 -> "0.005". */
  function fmtLots(v) {
    if (!isNum(v)) return '–';
    var n = parseFloat(v.toFixed(4));
    var dec = (String(n).split('.')[1] || '').length;
    return n.toFixed(Math.max(2, dec));
  }

  /** Signed pips: one decimal, or whole numbers with separators once they reach 1,000. */
  function fmtPips(v) {
    if (!isNum(v)) return '–';
    var a = Math.abs(v);
    if (a < 1000) return fmtSigned(v, 1);
    return (v < 0 ? MINUS : '+') + fmtNumber(a, 0);
  }

  function fmtFactor(v) {
    if (v === Infinity) return '∞';
    return isNum(v) ? v.toFixed(2) : '–';
  }

  function fmtDuration(min) {
    if (!isNum(min)) return '–';
    if (min < 1) return 'ไม่ถึง 1 นาที';
    if (min < 60) return Math.round(min) + ' นาที';
    if (min < 1440) {
      var h = Math.floor(min / 60), m = Math.round(min - h * 60);
      return h + ' ชม.' + (m ? ' ' + m + ' นาที' : '');
    }
    var d = Math.floor(min / 1440), hh = Math.round((min - d * 1440) / 60);
    return d + ' วัน' + (hh ? ' ' + hh + ' ชม.' : '');
  }

  /** "15 พ.ย." (adds the year when it isn't the current one). */
  function fmtDate(v, now) {
    var d = toDate(v);
    if (!d) return '–';
    var y = (now || new Date()).getFullYear();
    return d.getDate() + ' ' + MONTHS_SHORT[d.getMonth()] + (d.getFullYear() !== y ? ' ' + String(d.getFullYear()).slice(2) : '');
  }

  function fmtTime(v) {
    var d = toDate(v);
    return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '';
  }

  function fmtDateTime(v, now) {
    var d = toDate(v);
    return d ? fmtDate(d, now) + ' ' + fmtTime(d) : '–';
  }

  return {
    ASSETS: ASSETS, ASSET_ORDER: ASSET_ORDER, SYMBOLS: SYMBOLS, EMOTIONS: EMOTIONS, RANGES: RANGES, SESSIONS: SESSIONS,
    WEEKDAYS: WEEKDAYS, WEEKDAYS_SHORT: WEEKDAYS_SHORT, MONTHS_SHORT: MONTHS_SHORT, MONTHS_FULL: MONTHS_FULL,
    NO_STRATEGY: NO_STRATEGY, NOTE_MAX: NOTE_MAX, CSV_FIELDS: CSV_FIELDS, MINUS: MINUS,
    isNum: isNum, num: num, round: round, pad2: pad2,
    normSymbol: normSymbol, classifySymbol: classifySymbol, instrument: instrument,
    calcGross: calcGross, calcNet: calcNet, calcPips: calcPips, calcR: calcR, plannedRR: plannedRR, riskAmount: riskAmount,
    toDate: toDate, toLocalInput: toLocalInput, dayKey: dayKey, monthKey: monthKey, monthLabel: monthLabel,
    holdMinutes: holdMinutes, isClosed: isClosed, tradeTime: tradeTime,
    newId: newId, normalizeTrade: normalizeTrade, validateTrade: validateTrade,
    rangeStart: rangeStart, filterTrades: filterTrades, closedSorted: closedSorted,
    computeStats: computeStats, groupStats: groupStats,
    bySymbol: bySymbol, byAsset: byAsset, byStrategy: byStrategy, bySide: bySide, byWeekday: byWeekday,
    bySession: bySession, sessionOf: sessionOf, sessionLocalRange: sessionLocalRange, byHold: byHold,
    byMonth: byMonth, dailyPnl: dailyPnl, byEmotion: byEmotion, byPlan: byPlan, rHistogram: rHistogram,
    insights: insights, positionSize: positionSize,
    toCSV: toCSV, parseCSV: parseCSV, importCSV: importCSV,
    fmtMoney: fmtMoney, fmtAxisMoney: fmtAxisMoney, fmtPct: fmtPct, fmtSigned: fmtSigned, fmtR: fmtR,
    fmtPrice: fmtPrice, fmtLots: fmtLots, fmtPips: fmtPips, fmtFactor: fmtFactor, fmtDuration: fmtDuration,
    fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime
  };
});
