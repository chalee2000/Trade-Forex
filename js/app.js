/*
 * Trade-Forex — user interface.
 * Views: overview, journal, analysis, tools. Everything on screen is derived from
 * the store's trades and the two filters (date range, asset class).
 */
(function () {
  'use strict';
  var C = window.TFCore, S = window.TFSample, Charts = window.TFCharts;

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  var VIEWS = ['overview', 'journal', 'analysis', 'tools'];
  var RANGE_TEXT = { all: 'ทุกช่วงเวลา', '7d': '7 วันล่าสุด', '30d': '30 วันล่าสุด', '90d': '90 วันล่าสุด', ytd: 'ตั้งแต่ต้นปี' };
  var R_SHORT = ['< −2R', '−2…−1R', '−1…0', '0…1R', '1…2R', '2…3R', '≥ 3R'];
  var PAGE = 100;

  var state = {
    view: 'overview', range: 'all', asset: 'all', q: '', limit: PAGE, calMonth: null,
    tables: {}, ready: false, slow: false, editing: null, pnlAuto: true, onConfirm: null, calcTouched: false
  };
  var charts = [];
  var demoCache = null;
  var renderQueued = false;

  var store = window.TFStore.createStore({
    onChange: scheduleRender,
    onError: function (msg) { toast(msg, 'error'); },
    onStatus: function (s) { if (s === 'slow' && !state.ready) { state.slow = true; scheduleRender(); } }
  });

  /* ------------------------------------------------------------------ *
   * Data in scope
   * ------------------------------------------------------------------ */

  function isDemo() { return state.ready && store.trades.length === 0 && !store.settings.hideDemo; }
  function demoTrades() { return demoCache || (demoCache = S.sampleTrades(new Date())); }
  function trades() { return isDemo() ? demoTrades() : store.trades; }
  function startBalance() { return isDemo() ? S.START_BALANCE : store.settings.startBalance; }
  function scoped() { return C.filterTrades(trades(), { range: state.range, asset: state.asset }); }
  function byTimeDesc(a, b) { return (C.tradeTime(b) || 0) - (C.tradeTime(a) || 0); }

  /* ------------------------------------------------------------------ *
   * Small HTML builders
   * ------------------------------------------------------------------ */

  function pnlHtml(v, opts) {
    if (!C.isNum(v)) return '–';
    var cls = v > 0.004 ? ' pos' : v < -0.004 ? ' neg' : '';
    return '<span class="pnl' + cls + '">' + C.fmtMoney(v, Object.assign({ sign: true }, opts || {})) + '</span>';
  }

  function assetChip(asset) {
    var a = C.ASSETS[asset] || C.ASSETS.forex;
    return '<span class="mono-chip" title="' + esc(a.label) + '">' + a.short + '</span>';
  }

  function sideHtml(side) {
    var sell = side === 'sell';
    return '<span class="side"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="' + (sell ? 'M1 2h8L5 9z' : 'M1 8h8L5 1z') + '"/></svg>' + (sell ? 'Sell' : 'Buy') + '</span>';
  }

  function tableHtml(t, cls) {
    var align = t.align || [];
    var head = t.head.map(function (h, i) { return '<th' + (align[i] ? ' class="' + align[i] + '"' : '') + ' scope="col">' + h + '</th>'; }).join('');
    var rows = t.rows.map(function (r) {
      return '<tr>' + r.map(function (c, i) { return '<td' + (align[i] ? ' class="' + align[i] + '"' : '') + '>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="table table-compact ' + (cls || '') + '"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      (t.note ? '<p class="card-foot">' + t.note + '</p>' : '');
  }

  /** A chart in a card, with a "view as table" twin so no value is hover-only. */
  function chartCard(s) {
    var asTable = !!state.tables[s.id];
    var body;
    if (s.empty) body = '<p class="empty-note">' + esc(s.empty) + '</p>';
    else if (asTable) body = tableHtml(s.table);
    else body = '<div class="chart-box" style="height:' + s.height + 'px"><canvas id="cv-' + s.id + '" role="img" aria-label="' + esc(s.aria || s.title) + '"></canvas></div>';
    return '<figure class="card' + (s.wide ? ' span-2' : '') + '">' +
      '<figcaption class="card-head"><div><h3>' + esc(s.title) + '</h3>' + (s.sub ? '<p class="sub">' + esc(s.sub) + '</p>' : '') + '</div>' +
      (s.empty ? '' : '<button type="button" class="btn-text" data-toggle-table="' + s.id + '" aria-pressed="' + asTable + '">' + (asTable ? 'ดูกราฟ' : 'ดูตาราง') + '</button>') +
      '</figcaption>' + body + '</figure>';
  }

  function mountCharts(specs) {
    specs.forEach(function (s) {
      if (s.empty || state.tables[s.id]) return;
      var cv = document.getElementById('cv-' + s.id);
      if (!cv) return;
      try {
        if (!window.Chart) throw new Error('Chart library missing');
        charts.push(s.build(cv));
      } catch (e) {
        if (window.console) console.error(e);
        cv.parentNode.outerHTML = '<p class="empty-note">แสดงกราฟนี้ไม่ได้ กด “ดูตาราง” เพื่อดูตัวเลขแทน</p>';
      }
    });
  }

  function destroyCharts() {
    charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* already gone */ } });
    charts = [];
  }

  /* ------------------------------------------------------------------ *
   * Chart specs
   * ------------------------------------------------------------------ */

  function capRows(rows, max, what) {
    if (rows.length <= max) return { rows: rows, note: '' };
    return { rows: rows.slice(rows.length - max), note: 'แสดง ' + max + ' ' + what + 'ล่าสุด จากทั้งหมด ' + rows.length };
  }

  function specEquity(st) {
    var start = st.startBalance, eq = st.equity;
    var s = {
      id: 'equity', height: 280,
      title: start > 0 ? 'เส้นเงินทุน' : 'กำไร/ขาดทุนสะสม',
      sub: start > 0 ? 'ยอดเงินในพอร์ตหลังปิดแต่ละเทรด เริ่มจากทุน ' + C.fmtMoney(start, { dp: 0 }) : 'ผลรวมสะสมหลังปิดแต่ละเทรด'
    };
    var labels = ['เริ่ม'].concat(eq.map(function (p) { return C.fmtDate(p.time); }));
    var values = [start].concat(eq.map(function (p) { return C.round(p.equity, 2); }));
    s.aria = s.title + ': จาก ' + C.fmtMoney(start) + ' เป็น ' + C.fmtMoney(values[values.length - 1]) + ' ใน ' + eq.length + ' เทรด';
    var capped = capRows(eq.map(function (p) {
      return [p.i, esc(C.fmtDateTime(p.time)), esc(p.trade.symbol), pnlHtml(p.trade.pnl), C.fmtMoney(p.equity)];
    }), 100, 'เทรด');
    s.table = { head: ['เทรดที่', 'ปิดเมื่อ', 'คู่เงิน', 'กำไร/ขาดทุน', start > 0 ? 'ยอดเงิน' : 'สะสม'], align: ['num', '', '', 'num', 'num'], rows: capped.rows, note: capped.note };
    s.build = function (cv) {
      return Charts.line(cv, {
        labels: labels, values: values, tone: 'series', fmtTick: C.fmtAxisMoney,
        ref: start > 0 ? { value: start, label: 'ทุนเริ่มต้น' } : { value: 0, label: '' },
        tip: function (i) {
          if (i === 0) return { value: C.fmtMoney(start), lines: [start > 0 ? 'ทุนเริ่มต้น' : 'เริ่มต้น'] };
          var p = eq[i - 1];
          return { value: C.fmtMoney(p.equity), lines: ['เทรดที่ ' + p.i + ' · ' + C.fmtDateTime(p.time), p.trade.symbol + ' ' + (p.trade.side === 'sell' ? 'Sell' : 'Buy') + ' ' + C.fmtMoney(p.trade.pnl, { sign: true })] };
        }
      });
    };
    return s;
  }

  function specDrawdown(st) {
    var eq = st.equity;
    var s = { id: 'drawdown', height: 240, title: 'Drawdown', sub: 'ยอดสะสมต่ำกว่าจุดสูงสุดก่อนหน้าเท่าไร หลังปิดแต่ละเทรด' };
    if (!(st.maxDD > 0)) { s.empty = 'ยังไม่เคยมีช่วงที่ยอดสะสมลดลงจากจุดสูงสุด'; return s; }
    var labels = ['เริ่ม'].concat(eq.map(function (p) { return C.fmtDate(p.time); }));
    var values = [0].concat(eq.map(function (p) { return C.round(p.dd, 2); }));
    s.aria = 'Drawdown: ลึกสุด ' + C.fmtMoney(-st.maxDD);
    var capped = capRows(eq.filter(function (p) { return p.dd < 0; }).map(function (p) {
      return [p.i, esc(C.fmtDateTime(p.time)), C.fmtMoney(p.dd)];
    }), 100, 'จุด');
    s.table = { head: ['เทรดที่', 'ปิดเมื่อ', 'ต่ำกว่าจุดสูงสุด'], align: ['num', '', 'num'], rows: capped.rows, note: capped.note };
    s.build = function (cv) {
      return Charts.line(cv, {
        labels: labels, values: values, tone: 'neg', fill: 'origin', max: 0, endDot: false, fmtTick: C.fmtAxisMoney,
        tip: function (i) {
          if (i === 0) return { value: '$0.00', lines: ['เริ่มต้น'] };
          var p = eq[i - 1];
          return { value: C.fmtMoney(p.dd), lines: ['หลังเทรดที่ ' + p.i + ' · ' + C.fmtDate(p.time), p.dd < 0 ? 'ต่ำกว่าจุดสูงสุดก่อนหน้า' : 'ทำจุดสูงสุดใหม่'] };
        }
      });
    };
    return s;
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /** Keep the busiest groups and fold the tail into "อื่นๆ". */
  function foldGroups(groups, max) {
    if (groups.length <= max) return groups;
    var byN = groups.slice().sort(function (a, b) { return b.n - a.n; });
    var keep = byN.slice(0, max - 1), rest = byN.slice(max - 1);
    var other = { key: '__other', label: 'อื่นๆ (' + rest.length + ')', n: 0, wins: 0, losses: 0, net: 0 };
    rest.forEach(function (g) { other.n += g.n; other.wins += g.wins; other.losses += g.losses; other.net += g.net; });
    other.winRate = (other.wins / other.n) * 100;
    other.avg = other.net / other.n;
    return keep.sort(function (a, b) { return b.net - a.net; }).concat([other]);
  }

  function groupSpec(id, title, sub, groups, opt) {
    opt = opt || {};
    var s = { id: id, title: title, sub: sub, height: opt.horizontal ? Math.max(110, groups.length * 34 + 34) : 240 };
    if (!groups.some(function (g) { return g.n > 0; })) { s.empty = opt.empty || 'ยังไม่มีเทรดที่ปิดแล้วสำหรับกราฟนี้'; return s; }
    s.table = {
      head: [opt.col || 'กลุ่ม', 'เทรด', 'Win rate', 'กำไร/ขาดทุน', 'เฉลี่ยต่อเทรด'], align: ['', 'num', 'num', 'num', 'num'],
      rows: groups.map(function (g) {
        return [esc(g.full || g.label), g.n, g.n ? C.fmtPct(g.winRate) : '–', g.n ? pnlHtml(g.net) : '–', g.n ? pnlHtml(g.avg) : '–'];
      })
    };
    s.build = function (cv) {
      return Charts.bars(cv, {
        labels: groups.map(function (g) { return clip(g.axis || g.label, opt.horizontal ? 22 : 16); }),
        values: groups.map(function (g) { return C.round(g.net, 2); }),
        horizontal: opt.horizontal, fmtTick: C.fmtAxisMoney,
        fmtValue: function (v, i) { return groups[i].n ? C.fmtMoney(v, { sign: true, dp: 0 }) : ''; },
        tip: function (i) {
          var g = groups[i];
          var where = (g.full || g.label) + (opt.extra ? ' · ' + opt.extra(g) : '');
          return g.n ? { value: C.fmtMoney(g.net, { sign: true }), lines: [where, g.n + ' เทรด · Win rate ' + C.fmtPct(g.winRate)] } : { value: 'ไม่มีเทรด', lines: [where] };
        }
      });
    };
    return s;
  }

  function specR(list) {
    var h = C.rHistogram(list);
    var s = { id: 'rdist', height: 240, title: 'การกระจายของ R', sub: 'แต่ละเทรดได้หรือเสียกี่เท่าของความเสี่ยงที่ตั้งไว้ (ระยะถึง SL = 1R)' };
    if (!h.total) { s.empty = 'ใส่ Stop loss ตอนบันทึกเทรด แล้วกราฟนี้จะบอกว่าแต่ละเทรดได้หรือเสียกี่ R'; return s; }
    s.table = {
      head: ['ช่วง R', 'เทรด', 'สัดส่วน'], align: ['', 'num', 'num'],
      rows: h.bins.map(function (b) { return [esc(b.label), b.n, C.fmtPct((b.n / h.total) * 100)]; })
    };
    s.build = function (cv) {
      return Charts.bars(cv, {
        labels: R_SHORT, values: h.bins.map(function (b) { return b.n; }),
        tones: h.bins.map(function (b) { return b.sign < 0 ? 'neg' : 'pos'; }), integer: true,
        fmtTick: function (v) { return String(v); },
        fmtValue: function (v) { return v ? String(v) : ''; },
        tip: function (i) { return { value: h.bins[i].n + ' เทรด', lines: [h.bins[i].label, C.fmtPct((h.bins[i].n / h.total) * 100) + ' ของเทรดที่ตั้ง SL'] }; }
      });
    };
    return s;
  }

  /* ------------------------------------------------------------------ *
   * Shared pieces
   * ------------------------------------------------------------------ */

  function emptyState(body, list, st) {
    if (store.trades.length === 0 && !isDemo()) {
      body.innerHTML = '<div class="card empty"><h2>ยังไม่มีเทรดในสมุด</h2>' +
        '<p>บันทึกเทรดแรกเพื่อเริ่มเห็นกำไร/ขาดทุนรวม เส้นเงินทุน และสถิติของคุณ หรือนำเข้าประวัติเทรดจากไฟล์ CSV</p>' +
        '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="add-trade">บันทึกเทรด</button>' +
        '<button type="button" class="btn" data-action="import">นำเข้าไฟล์</button>' +
        '<button type="button" class="btn" data-action="show-demo">ดูตัวอย่าง</button></div></div>';
      return true;
    }
    if (st && st.n === 0) {
      var open = list.length;
      body.innerHTML = '<div class="card empty"><h2>' + (open ? 'ยังไม่มีเทรดที่ปิดแล้วในช่วงนี้' : 'ไม่มีเทรดในช่วงที่เลือก') + '</h2>' +
        '<p>' + (open ? 'มี ' + open + ' ออเดอร์ที่ยังเปิดอยู่ ใส่ราคาออกและกำไร/ขาดทุนเมื่อปิดออเดอร์ แล้วสถิติจะนับให้' : 'ลองเลือกช่วงเวลาที่ยาวขึ้น หรือดูทุกสินทรัพย์') + '</p>' +
        '<div class="btn-row">' + (open ? '<a class="btn" href="#journal" data-view="journal">ไปที่บันทึกเทรด</a>' : '') +
        (state.range !== 'all' || state.asset !== 'all' ? '<button type="button" class="btn" data-action="reset-filters">ดูทั้งหมด</button>' : '') + '</div></div>';
      return true;
    }
    return false;
  }

  var ICONS = {
    good: '<path d="m3 8.5 3.2 3L13 4.5"/>',
    warn: '<path d="M8 3.5v5.5M8 12v.5"/>',
    info: '<path d="M8 7v5M8 4v.5"/>'
  };
  var TONE_LABEL = { good: 'จุดแข็ง', warn: 'ควรระวัง', info: 'ข้อสังเกต' };

  function insightItems(items) {
    return items.map(function (x) {
      return '<li class="insight ' + x.tone + '"><span class="insight-icon" role="img" aria-label="' + TONE_LABEL[x.tone] + '"><svg viewBox="0 0 16 16" aria-hidden="true">' + ICONS[x.tone] + '</svg></span>' +
        '<h4>' + esc(x.title) + '</h4><p>' + esc(x.text) + '</p></li>';
    }).join('');
  }

  /* ------------------------------------------------------------------ *
   * Overview
   * ------------------------------------------------------------------ */

  function summaryHtml(st) {
    var cls = st.net > 0.004 ? ' pos' : st.net < -0.004 ? ' neg' : '';
    var ret = st.returnPct !== null
      ? '<span>ผลตอบแทน <b>' + C.fmtSigned(st.returnPct, 1, '%') + '</b> จากทุน ' + C.fmtMoney(st.startBalance, { dp: 0 }) + '</span>'
      : '<span><a class="btn-text" href="#tools" data-view="tools">ตั้งทุนเริ่มต้น</a> เพื่อดูผลตอบแทนเป็น %</span>';
    var counts = st.n + ' เทรด · ชนะ ' + st.wins + ' · แพ้ ' + st.losses + (st.be ? ' · เสมอ ' + st.be : '');
    function kpi(label, value, note, extra) {
      return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-value">' + value + '</span>' +
        (extra || '') + (note ? '<span class="kpi-note">' + note + '</span>' : '') + '</div>';
    }
    var wr = st.winRate || 0;
    return '<section class="card summary" aria-label="สรุปผล">' +
      '<div class="hero"><span class="hero-label">กำไร/ขาดทุนสุทธิ · ' + RANGE_TEXT[state.range] + '</span>' +
      '<span class="hero-value' + cls + '">' + C.fmtMoney(st.net, { sign: true }) + '</span>' +
      '<div class="hero-meta">' + ret + '<span>' + counts + '</span></div></div>' +
      '<div class="kpis">' +
      kpi('Win rate', C.fmtPct(st.winRate), 'ชนะ ' + st.wins + ' จาก ' + st.n + ' เทรด',
        '<div class="meter" role="img" aria-label="Win rate ' + C.fmtPct(st.winRate) + '"><i style="width:' + Math.max(0, Math.min(100, wr)).toFixed(1) + '%"></i></div>') +
      kpi('Profit factor', C.fmtFactor(st.profitFactor), 'กำไรรวม ÷ ขาดทุนรวม') +
      kpi('เฉลี่ยต่อเทรด', pnlHtml(st.expectancy), 'ค่าคาดหวัง (Expectancy)') +
      kpi('Max drawdown', st.maxDD > 0 ? C.fmtMoney(-st.maxDD) : '$0.00', st.maxDDPct !== null && st.maxDD > 0 ? C.fmtPct(st.maxDDPct) + ' จากจุดสูงสุด' : 'ลดลงจากจุดสูงสุดมากที่สุด') +
      kpi('กำไรเฉลี่ย : ขาดทุนเฉลี่ย', (st.avgWin !== null ? C.fmtMoney(st.avgWin, { dp: 0 }) : '–') + ' : ' + (st.avgLoss !== null ? C.fmtMoney(st.avgLoss, { dp: 0 }) : '–'),
        st.payoff !== null ? 'กำไรต่อครั้งเป็น ' + st.payoff.toFixed(2) + ' เท่าของขาดทุน' : 'ต้องมีทั้งเทรดที่ชนะและแพ้') +
      kpi('R เฉลี่ย', C.fmtR(st.avgR), st.nR ? 'จาก ' + st.nR + ' เทรดที่ตั้ง SL' : 'ใส่ SL เพื่อคิดเป็น R') +
      '</div></section>';
  }

  function splitCard(list) {
    var byClass = state.asset === 'all';
    var groups = byClass ? C.byAsset(list) : C.bySymbol(list).slice(0, 5);
    var max = Math.max.apply(null, groups.map(function (g) { return Math.abs(g.net); }).concat([1]));
    var rows = groups.map(function (g) {
      var chip = byClass ? assetChip(g.key) : assetChip(state.asset);
      var meta = g.n ? g.n + ' เทรด · Win rate ' + C.fmtPct(g.winRate) : 'ยังไม่มีเทรดที่ปิดแล้ว';
      var bar = g.n ? '<i class="' + (g.net < 0 ? 'neg' : 'pos') + '" style="width:' + ((Math.abs(g.net) / max) * 100).toFixed(1) + '%"></i>' : '';
      return '<div class="asset-row">' + chip + '<span class="asset-name">' + esc(g.label) + '</span>' + (g.n ? pnlHtml(g.net) : '<span class="muted">–</span>') +
        '<div class="asset-bar" aria-hidden="true">' + bar + '</div><span class="asset-meta">' + meta + '</span></div>';
    }).join('');
    return '<section class="card"><div class="card-head"><div><h3>' + (byClass ? 'แยกตามสินทรัพย์' : 'แยกตามคู่เงิน') + '</h3>' +
      '<p class="sub">กำไร/ขาดทุนสุทธิของแต่ละกลุ่ม</p></div></div><div class="asset-list">' + rows + '</div></section>';
  }

  function insightCard(list, st, limit) {
    var all = C.insights(list, st);
    var items = limit ? all.slice(0, limit) : all;
    var more = limit && all.length > limit ? '<a class="btn-text" href="#analysis" data-view="analysis">ดูทั้งหมด ' + all.length + ' ข้อ</a>' : '';
    var body = items.length ? '<ul class="insights' + (limit ? '' : ' insight-grid') + '">' + insightItems(items) + '</ul>'
      : '<p class="empty-note">เมื่อมีเทรดมากขึ้น แอพจะสรุปจุดแข็งและจุดที่ควรระวังให้ที่นี่</p>';
    return '<section class="card' + (limit ? '' : ' span-2') + '"><div class="card-head"><div><h3>ข้อสังเกตจากสถิติ</h3>' +
      '<p class="sub">สรุปจากเทรดในช่วงที่เลือก แต่ละข้อใช้อย่างน้อย 3 เทรดต่อกลุ่ม</p></div>' + more + '</div>' + body + '</section>';
  }

  function recentCard(list) {
    var rows = list.slice().sort(byTimeDesc).slice(0, 6).map(function (t) {
      var closed = C.isClosed(t);
      return '<tr data-trade="' + esc(t.id) + '" tabindex="0"><td class="nowrap">' + esc(C.fmtDate(C.tradeTime(t))) + '</td>' +
        '<td><span class="sym">' + assetChip(t.asset) + esc(t.symbol) + '</span></td><td>' + sideHtml(t.side) + '</td>' +
        '<td class="num">' + (closed ? pnlHtml(t.pnl) : '<span class="pill">เปิดอยู่</span>') + '</td></tr>';
    }).join('');
    return '<section class="card"><div class="card-head"><div><h3>เทรดล่าสุด</h3></div>' +
      '<a class="btn-text" href="#journal" data-view="journal">ดูทั้งหมด</a></div>' +
      '<div class="table-wrap"><table class="table table-compact"><thead><tr><th scope="col">วันที่</th><th scope="col">คู่เงิน</th><th scope="col">ฝั่ง</th><th scope="col" class="num">กำไร/ขาดทุน</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
  }

  function renderOverview() {
    var list = scoped(), st = C.computeStats(list, { startBalance: startBalance() });
    var body = $('#overview-body');
    if (emptyState(body, list, st)) return;
    var eq = specEquity(st);
    body.innerHTML = summaryHtml(st) +
      '<div class="grid-lead">' + chartCard(eq) + splitCard(list) + '</div>' +
      '<div class="grid">' + insightCard(list, st, 3) + recentCard(list) + '</div>';
    mountCharts([eq]);
  }

  /* ------------------------------------------------------------------ *
   * Journal
   * ------------------------------------------------------------------ */

  function renderJournal() {
    var body = $('#journal-body');
    if (emptyState(body, [], null)) return;
    var list = C.filterTrades(trades(), { range: state.range, asset: state.asset, q: state.q }).sort(byTimeDesc);
    if (!list.length) {
      body.innerHTML = '<div class="card empty"><h2>ไม่พบเทรดที่ตรงกับตัวกรอง</h2><p>ลองเปลี่ยนคำค้น ช่วงเวลา หรือสินทรัพย์</p>' +
        '<div class="btn-row"><button type="button" class="btn" data-action="reset-filters">ล้างตัวกรอง</button></div></div>';
      return;
    }
    var closed = list.filter(C.isClosed);
    var net = closed.reduce(function (a, t) { return a + t.pnl; }, 0);
    var shown = list.slice(0, state.limit);
    var rows = '', cards = '';
    shown.forEach(function (t) {
      var isClosed = C.isClosed(t), pips = C.calcPips(t), r = C.calcR(t);
      var when = isClosed ? C.fmtDateTime(t.closeTime) : C.fmtDateTime(t.openTime);
      var pnl = isClosed ? pnlHtml(t.pnl) : '<span class="pill">เปิดอยู่</span>';
      rows += '<tr data-trade="' + esc(t.id) + '" tabindex="0">' +
        '<td class="nowrap">' + esc(when) + '</td>' +
        '<td><span class="sym">' + assetChip(t.asset) + esc(t.symbol) + '</span></td>' +
        '<td>' + sideHtml(t.side) + '</td>' +
        '<td class="num">' + C.fmtLots(t.lots) + '</td>' +
        '<td class="num">' + C.fmtPrice(t.entry, t.symbol, t.asset) + '</td>' +
        '<td class="num">' + C.fmtPrice(t.exit, t.symbol, t.asset) + '</td>' +
        '<td class="num">' + C.fmtPips(pips) + '</td>' +
        '<td class="num">' + C.fmtR(r) + '</td>' +
        '<td class="num">' + pnl + '</td>' +
        '<td class="strategy">' + esc(t.strategy) + '</td></tr>';
      cards += '<li class="trade-item" data-trade="' + esc(t.id) + '" tabindex="0">' +
        '<div class="line1"><span class="sym">' + assetChip(t.asset) + esc(t.symbol) + '</span>' + sideHtml(t.side) + '</div>' +
        '<div>' + pnl + '</div>' +
        '<div class="line2"><span>' + esc(when) + '</span><span>' + C.fmtLots(t.lots) + ' Lot</span>' +
        (r !== null ? '<span>' + C.fmtR(r) + '</span>' : pips !== null ? '<span>' + C.fmtPips(pips) + ' pips</span>' : '') +
        (t.strategy ? '<span>' + esc(t.strategy) + '</span>' : '') + '</div></li>';
    });
    var more = list.length > shown.length
      ? '<div class="more-row"><button type="button" class="btn" data-action="more">แสดงเพิ่มอีก ' + Math.min(PAGE, list.length - shown.length) + ' เทรด</button></div>' : '';
    body.innerHTML = '<section class="card"><div class="card-head"><p class="list-count">' + list.length + ' เทรด' +
      (closed.length ? ' · รวม ' + pnlHtml(net) : '') + (list.length - closed.length ? ' · เปิดอยู่ ' + (list.length - closed.length) : '') + '</p></div>' +
      '<div class="table-wrap journal-table"><table class="table"><thead><tr>' +
      '<th scope="col">ปิดเมื่อ</th><th scope="col">คู่เงิน</th><th scope="col">ฝั่ง</th><th scope="col" class="num">Lot</th><th scope="col" class="num">ราคาเข้า</th><th scope="col" class="num">ราคาออก</th>' +
      '<th scope="col" class="num">Pips</th><th scope="col" class="num">R</th><th scope="col" class="num">กำไร/ขาดทุน</th><th scope="col">กลยุทธ์</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<ul class="trade-list">' + cards + '</ul>' + more + '</section>';
  }

  /* ------------------------------------------------------------------ *
   * Analysis
   * ------------------------------------------------------------------ */

  function statsCard(st) {
    function row(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
    var best = st.best ? pnlHtml(st.best.pnl) + ' ' + esc(st.best.symbol) : '–';
    var worst = st.worst ? pnlHtml(st.worst.pnl) + ' ' + esc(st.worst.symbol) : '–';
    var streak = st.streak.n ? (st.streak.type === 'win' ? 'ชนะ ' : 'แพ้ ') + st.streak.n + ' ติดกัน' : '–';
    return '<section class="card span-2"><div class="card-head"><div><h3>สถิติโดยละเอียด</h3><p class="sub">เฉพาะเทรดที่ปิดแล้วในช่วงที่เลือก</p></div></div><dl class="stat-grid">' +
      row('เทรดที่ปิดแล้ว', st.n) +
      row('ชนะ / แพ้ / เสมอ', st.wins + ' / ' + st.losses + ' / ' + st.be) +
      row('Win rate', C.fmtPct(st.winRate)) +
      row('กำไรรวม', pnlHtml(st.grossProfit)) +
      row('ขาดทุนรวม', pnlHtml(-st.grossLoss)) +
      row('Profit factor', C.fmtFactor(st.profitFactor)) +
      row('กำไรเฉลี่ยเมื่อชนะ', st.avgWin !== null ? pnlHtml(st.avgWin) : '–') +
      row('ขาดทุนเฉลี่ยเมื่อแพ้', st.avgLoss !== null ? pnlHtml(-st.avgLoss) : '–') +
      row('เฉลี่ยต่อเทรด', pnlHtml(st.expectancy)) +
      row('เทรดที่ดีที่สุด', best) +
      row('เทรดที่แย่ที่สุด', worst) +
      row('R เฉลี่ย', C.fmtR(st.avgR)) +
      row('ชนะติดกันสูงสุด', st.maxWinStreak + ' เทรด') +
      row('แพ้ติดกันสูงสุด', st.maxLossStreak + ' เทรด') +
      row('ตอนนี้', streak) +
      row('Max drawdown', st.maxDD > 0 ? C.fmtMoney(-st.maxDD) + (st.maxDDPct !== null ? ' (' + C.fmtPct(st.maxDDPct) + ')' : '') : '$0.00') +
      row('เวลาถือเฉลี่ย', C.fmtDuration(st.avgHoldMin)) +
      row('ค่าคอม + สวอปรวม', C.fmtMoney(st.fees)) +
      '</dl></section>';
  }

  function behaviourCard(list) {
    function block(title, groups, none) {
      var head = '<tr><th scope="colgroup" colspan="5">' + title + '</th></tr>';
      if (!groups.length) return head + '<tr><td colspan="5" class="muted">' + none + '</td></tr>';
      return head + groups.map(function (g) {
        return '<tr><td class="nowrap">' + esc(g.label) + '</td><td class="num">' + g.n + '</td><td class="num">' + C.fmtPct(g.winRate) + '</td><td class="num">' + pnlHtml(g.net) + '</td><td class="num">' + pnlHtml(g.avg) + '</td></tr>';
      }).join('');
    }
    return '<section class="card span-2"><div class="card-head"><div><h3>พฤติกรรมการเทรด</h3><p class="sub">ผลลัพธ์เมื่อแยกตามฝั่ง การทำตามแผน และอารมณ์ตอนเข้าออเดอร์</p></div></div>' +
      '<div class="table-wrap"><table class="table table-compact"><thead><tr><th scope="col">กลุ่ม</th><th scope="col" class="num">เทรด</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">กำไร/ขาดทุน</th><th scope="col" class="num">เฉลี่ยต่อเทรด</th></tr></thead><tbody>' +
      block('ฝั่งที่เทรด', C.bySide(list), '') +
      block('ทำตามแผนหรือไม่', C.byPlan(list), 'ยังไม่ได้ระบุในเทรดช่วงนี้ เลือก “ทำตามแผน” หรือ “หลุดแผน” ตอนบันทึกเทรด') +
      block('อารมณ์ตอนเข้า', C.byEmotion(list), 'ยังไม่ได้ระบุในเทรดช่วงนี้') +
      '</tbody></table></div></section>';
  }

  function calMoney(v) {
    var a = Math.abs(v), sign = v < 0 ? C.MINUS : '+';
    if (a < 0.5) return '$0';
    return sign + '$' + (a >= 1000 ? parseFloat((a / 1000).toFixed(1)) + 'K' : Math.round(a));
  }

  function calendarCard(list) {
    var daily = C.dailyPnl(list);
    var keys = Object.keys(daily).sort();
    var month = state.calMonth || (keys.length ? keys[keys.length - 1].slice(0, 7) : C.monthKey(new Date()));
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    var lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    var days = new Date(y, m, 0).getDate();
    var max = 0, total = 0, traded = 0, d, k;
    for (d = 1; d <= days; d++) {
      k = month + '-' + C.pad2(d);
      if (daily[k]) { max = Math.max(max, Math.abs(daily[k].net)); total += daily[k].net; traded++; }
    }
    var cells = '';
    [1, 2, 3, 4, 5, 6, 0].forEach(function (wd) { cells += '<div class="cal-dow">' + C.WEEKDAYS_SHORT[wd] + '</div>'; });
    for (d = 0; d < lead; d++) cells += '<div class="cal-cell blank"></div>';
    for (d = 1; d <= days; d++) {
      k = month + '-' + C.pad2(d);
      var day = daily[k];
      if (!day) { cells += '<div class="cal-cell"><span class="cal-day">' + d + '</span></div>'; continue; }
      var lvl = max > 0 ? Math.min(4, Math.max(1, Math.ceil((Math.abs(day.net) / max) * 4))) : 1;
      var cls = Math.abs(day.net) < 0.005 ? '' : (day.net > 0 ? ' p' : ' n') + lvl;
      var label = d + ' ' + C.MONTHS_SHORT[m - 1] + ': ' + C.fmtMoney(day.net, { sign: true }) + ' จาก ' + day.n + ' เทรด';
      cells += '<div class="cal-cell has' + cls + '" title="' + esc(label) + '" aria-label="' + esc(label) + '" role="img"><span class="cal-day">' + d + '</span><span class="cal-val">' + calMoney(day.net) + '</span></div>';
    }
    return '<section class="card span-2"><div class="card-head"><div><h3>ปฏิทินกำไร/ขาดทุนรายวัน</h3>' +
      '<p class="sub">' + (traded ? 'เดือนนี้เทรด ' + traded + ' วัน รวม ' + C.fmtMoney(total, { sign: true }) : 'ไม่มีเทรดที่ปิดในเดือนนี้') + '</p></div>' +
      '<div class="cal-head"><button type="button" class="icon-btn" data-action="cal-prev" aria-label="เดือนก่อนหน้า"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button>' +
      '<span class="cal-title">' + C.MONTHS_FULL[m - 1] + ' ' + y + '</span>' +
      '<button type="button" class="icon-btn" data-action="cal-next" aria-label="เดือนถัดไป"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button></div></div>' +
      '<div class="cal" data-month="' + month + '">' + cells + '</div>' +
      '<div class="cal-legend"><span>ขาดทุนมาก</span><i class="n4"></i><i class="n2"></i><i></i><i class="p2"></i><i class="p4"></i><span>กำไรมาก</span></div></section>';
  }

  function renderAnalysis() {
    var list = scoped(), st = C.computeStats(list, { startBalance: startBalance() });
    var body = $('#analysis-body');
    if (emptyState(body, list, st)) return;
    var sessions = C.bySession(list).map(function (g) { return g.key === 'overlap' ? Object.assign({}, g, { axis: 'ลอนดอน+NY' }) : g; });
    var sessIdx = {};
    C.SESSIONS.forEach(function (s) { sessIdx[s.key] = s; });
    var specs = [
      groupSpec('monthly', 'กำไร/ขาดทุนรายเดือน', 'ผลรวมของเทรดที่ปิดในแต่ละเดือน', C.byMonth(list), { col: 'เดือน' }),
      specDrawdown(st),
      groupSpec('symbol', 'ตามคู่เงิน', 'เรียงจากกำไรมากไปขาดทุนมาก', foldGroups(C.bySymbol(list), 8), { horizontal: true, col: 'คู่เงิน' }),
      groupSpec('strategy', 'ตามกลยุทธ์', 'Setup ไหนทำเงิน Setup ไหนเสียเงิน', foldGroups(C.byStrategy(list), 8), { horizontal: true, col: 'กลยุทธ์' }),
      groupSpec('weekday', 'ตามวันในสัปดาห์', 'นับตามวันที่เปิดออเดอร์', C.byWeekday(list), { col: 'วัน' }),
      groupSpec('session', 'ตามช่วงตลาด', 'นับตามเวลาที่เปิดออเดอร์', sessions, {
        col: 'ช่วงตลาด', extra: function (g) { return C.sessionLocalRange(sessIdx[g.key]) + ' น. ตามเวลาเครื่องคุณ'; }
      }),
      specR(list),
      groupSpec('hold', 'ตามระยะเวลาถือ', 'ถือสั้นหรือถือยาว แบบไหนได้ผลกว่า', C.byHold(list), { col: 'เวลาถือ', empty: 'ใส่เวลาเปิดและปิดออเดอร์เพื่อดูกราฟนี้' })
    ];
    body.innerHTML = '<div class="grid">' + insightCard(list, st, 0) + statsCard(st) + specs.map(chartCard).join('') + behaviourCard(list) + calendarCard(list) + '</div>';
    mountCharts(specs);
  }

  /* ------------------------------------------------------------------ *
   * Tools
   * ------------------------------------------------------------------ */

  var STORAGE_NOTE = {
    cloud: 'เก็บไว้กับบัญชี Claude ของคุณ เปิดจากเครื่องไหนก็เห็นสมุดเล่มเดียวกัน คนอื่นที่เปิดหน้านี้จะไม่เห็นเทรดของคุณ',
    local: 'เก็บไว้ในเบราว์เซอร์นี้เท่านั้น ถ้าล้างข้อมูลเบราว์เซอร์หรือเปลี่ยนเครื่อง ข้อมูลจะไม่ตามไป ควรสำรองไฟล์เป็นระยะ',
    memory: 'เบราว์เซอร์นี้ไม่อนุญาตให้เก็บข้อมูล เทรดที่บันทึกจะหายเมื่อปิดหน้านี้ สำรองไฟล์ก่อนปิดทุกครั้ง',
    loading: ''
  };

  function renderCalc() {
    var f = $('#form-calc'), out = $('#calc-result');
    var sym = f.symbol.value;
    var r = C.positionSize({ balance: f.balance.value, riskPct: f.riskPct.value, symbol: sym, asset: C.classifySymbol(sym), entry: f.entry.value, sl: f.sl.value, tp: f.tp.value });
    if (!r) {
      out.innerHTML = '<p class="muted">ใส่เงินในพอร์ต เปอร์เซ็นต์ความเสี่ยง ราคาเข้า และ Stop loss แล้วขนาด Lot ที่เหมาะจะแสดงตรงนี้</p>';
      return;
    }
    function row(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
    var rows = row('ฝั่ง', r.side === 'buy' ? 'Buy (SL อยู่ใต้ราคาเข้า)' : 'Sell (SL อยู่เหนือราคาเข้า)') +
      row('ระยะถึง SL', C.fmtPips(r.pips).replace('+', '') + ' pips') +
      row('ยอมเสียได้', C.fmtMoney(r.riskAmount));
    var head;
    if (r.needsRate) {
      head = '<p class="muted">คู่ ' + esc(sym) + ' ไม่ได้อ้างอิงดอลลาร์โดยตรง จึงคิดขนาด Lot ให้อัตโนมัติไม่ได้ ใช้ค่า pip ของโบรกเกอร์คำนวณจากระยะ SL ด้านล่าง</p>';
    } else if (r.lots <= 0) {
      head = '<p class="muted">ความเสี่ยงที่ตั้งไว้น้อยกว่าที่ 0.01 Lot จะเสียเมื่อโดน SL (' + C.fmtMoney(r.lossPerLot * 0.01) + ') ลองขยับ SL ให้ใกล้ขึ้นหรือเพิ่มความเสี่ยง</p>';
    } else {
      head = '<div><span class="kpi-label">ขนาดที่ควรเปิด</span><div class="calc-lots">' + r.lots.toFixed(2) + ' Lot</div></div>';
      rows += row('เสียจริงถ้าโดน SL', C.fmtMoney(-r.actualRisk));
      if (r.rr !== null) rows += row('Reward : Risk', '1 : ' + r.rr.toFixed(2));
      if (r.reward !== null) rows += row('ได้ถ้าถึง TP', pnlHtml(r.reward));
    }
    out.innerHTML = head + '<dl>' + rows + '</dl>';
  }

  function renderTools() {
    $('#storage-note').textContent = STORAGE_NOTE[store.mode] || '';
    var sb = $('#s-balance');
    if (document.activeElement !== sb) sb.value = store.settings.startBalance || '';
    var f = $('#form-calc');
    if (!state.calcTouched) {
      var st = C.computeStats(store.trades, { startBalance: store.settings.startBalance });
      var bal = store.settings.startBalance > 0 ? C.round(store.settings.startBalance + st.net, 2) : '';
      if (document.activeElement !== f.balance) f.balance.value = bal > 0 ? bal : '';
      if (!f.riskPct.value) f.riskPct.value = 1;
    }
    renderCalc();
  }

  /* ------------------------------------------------------------------ *
   * Frame: tabs, filters, banner
   * ------------------------------------------------------------------ */

  function renderSeg() {
    var ranges = C.RANGES.map(function (r) {
      return '<button type="button" data-range="' + r.key + '" aria-pressed="' + (state.range === r.key) + '">' + r.label + '</button>';
    }).join('');
    var assets = [{ key: 'all', label: 'ทั้งหมด' }].concat(C.ASSET_ORDER.map(function (k) { return C.ASSETS[k]; })).map(function (a) {
      return '<button type="button" data-asset="' + a.key + '" aria-pressed="' + (state.asset === a.key) + '">' + a.label + '</button>';
    }).join('');
    $('#seg-range').innerHTML = ranges;
    $('#seg-asset').innerHTML = assets;
  }

  function renderBanner() {
    var html = '';
    if (isDemo()) {
      html += '<div class="banner"><span class="tag">ตัวอย่าง</span>' +
        '<p>ตัวเลขและกราฟตอนนี้มาจากเทรดสมมติ ' + demoTrades().length + ' รายการ เพื่อให้เห็นว่าแอพสรุปอะไรให้บ้าง เมื่อบันทึกเทรดแรกของคุณ ตัวอย่างจะหายไปเอง</p>' +
        '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="add-trade">บันทึกเทรดแรก</button>' +
        '<button type="button" class="btn" data-action="hide-demo">ซ่อนตัวอย่าง</button></div></div>';
    }
    if (state.ready && store.mode === 'memory') {
      html += '<div class="banner"><span class="tag">ไม่ได้บันทึกถาวร</span><p>' + STORAGE_NOTE.memory + '</p></div>';
    }
    $('#banner').innerHTML = html;
  }

  function loadingHtml() {
    return '<div class="card loading-card"><p class="loading-title">' + (state.slow ? 'ยังเชื่อมต่อที่เก็บข้อมูลไม่ได้' : 'กำลังเปิดสมุดเทรด…') + '</p>' +
      '<p class="muted">' + (state.slow ? 'กำลังรอการตอบกลับ ถ้าอินเทอร์เน็ตกลับมา สมุดเทรดจะเปิดเอง' : 'กำไร/ขาดทุนรวม เส้นเงินทุน และสถิติของคุณจะแสดงที่นี่') + '</p></div>';
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    (window.requestAnimationFrame || setTimeout)(render);
  }

  function render() {
    renderQueued = false;
    VIEWS.forEach(function (v) { $('#view-' + v).hidden = v !== state.view; });
    $$('.tabs a').forEach(function (a) {
      if (a.dataset.view === state.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#filters').hidden = state.view === 'tools';
    renderSeg();
    renderBanner();
    destroyCharts();
    if (!state.ready) {
      ['overview', 'journal', 'analysis'].forEach(function (v) { $('#' + v + '-body').innerHTML = loadingHtml(); });
      return;
    }
    if (state.view === 'overview') renderOverview();
    else if (state.view === 'journal') renderJournal();
    else if (state.view === 'analysis') renderAnalysis();
    else renderTools();
  }

  function setView(v, fromHash) {
    if (VIEWS.indexOf(v) === -1) v = 'overview';
    if (v === state.view && fromHash) return;
    state.view = v;
    if (!fromHash) { try { if (location.hash !== '#' + v) location.hash = v; } catch (e) { /* hash is optional */ } }
    render();
    window.scrollTo(0, 0);
  }

  function savePrefs() {
    try { localStorage.setItem('tf.ui.v1', JSON.stringify({ range: state.range, asset: state.asset })); } catch (e) { /* convenience only */ }
  }

  function loadPrefs() {
    try {
      var p = JSON.parse(localStorage.getItem('tf.ui.v1') || '{}');
      if (RANGE_TEXT[p.range]) state.range = p.range;
      if (p.asset === 'all' || C.ASSETS[p.asset]) state.asset = p.asset;
    } catch (e) { /* convenience only */ }
  }

  /* ------------------------------------------------------------------ *
   * Toast, dialogs, files
   * ------------------------------------------------------------------ */

  var toastTimer = null;
  function toast(msg, tone) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (tone === 'error' ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, tone === 'error' ? 6000 : 3200);
  }

  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }

  function closeDialog(dlg) {
    if (typeof dlg.close === 'function') { if (dlg.open) dlg.close(); }
    else dlg.removeAttribute('open');
  }

  function askConfirm(o, onYes) {
    $('#dlg-confirm-title').textContent = o.title;
    $('#dlg-confirm-text').textContent = o.text;
    var yes = $('#dlg-confirm-yes');
    yes.textContent = o.yes || 'ยืนยัน';
    yes.className = 'btn ' + (o.danger === false ? 'btn-primary' : 'btn-danger');
    state.onConfirm = onYes;
    openDialog($('#dlg-confirm'));
  }

  function showText(filename, text) {
    $('#dlg-text-title').textContent = filename;
    $('#dlg-text-help').textContent = 'ที่นี่ดาวน์โหลดไฟล์ให้โดยตรงไม่ได้ คัดลอกข้อความด้านล่างไปวางในไฟล์ชื่อ ' + filename + ' แทน';
    $('#dlg-text-area').value = text;
    openDialog($('#dlg-text'));
  }

  function saveFile(filename, text, mime) {
    var cl = window.claude;
    if (cl && typeof cl.use === 'function') {
      Promise.resolve(cl.use('downloads')).then(function (dl) {
        if (!dl) return showText(filename, text);
        return dl.save({ filename: filename, data: text }).then(function () {
          toast('บันทึกไฟล์ ' + filename + ' แล้ว');
        }, function (e) {
          if (e && e.code === 'declined') return;
          showText(filename, text);
        });
      }, function () { showText(filename, text); });
      return;
    }
    try {
      var url = URL.createObjectURL(new Blob([text], { type: mime }));
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('ดาวน์โหลด ' + filename + ' แล้ว');
    } catch (e) { showText(filename, text); }
  }

  function stamp() { return C.dayKey(new Date()); }

  function exportCsv() {
    if (!store.trades.length) return toast('ยังไม่มีเทรดของคุณให้ส่งออก');
    var list = store.trades.slice().sort(function (a, b) { return (C.tradeTime(a) || 0) - (C.tradeTime(b) || 0); });
    saveFile('trade-forex-' + stamp() + '.csv', '﻿' + C.toCSV(list), 'text/csv;charset=utf-8');
  }

  function backup() {
    if (!store.trades.length) return toast('ยังไม่มีเทรดของคุณให้สำรอง');
    saveFile('trade-forex-backup-' + stamp() + '.json', JSON.stringify(store.exportAll(), null, 2), 'application/json');
  }

  function signature(t) {
    return [t.symbol, t.side, t.openTime, t.closeTime, t.entry, t.lots].join('|');
  }

  function handleImport(text, name) {
    var incoming = [], skipped = 0, settings = null;
    if (/^\s*[\[{]/.test(text)) {
      var data;
      try { data = JSON.parse(text); } catch (e) { return toast('อ่านไฟล์ไม่ได้ ไฟล์สำรองต้องเป็น .json ที่ส่งออกจากแอพนี้', 'error'); }
      var arr = Array.isArray(data) ? data : data && data.trades;
      if (!Array.isArray(arr)) return toast('ไฟล์นี้ไม่มีรายการเทรด ใช้ไฟล์สำรองที่ส่งออกจากแอพนี้', 'error');
      arr.forEach(function (raw) {
        var t = C.normalizeTrade(raw);
        if (Object.keys(C.validateTrade(t)).length) skipped++; else incoming.push(t);
      });
      settings = data && data.settings;
    } else {
      var r = C.importCSV(text);
      if (r.error) return toast(r.error, 'error');
      incoming = r.trades;
      skipped = r.skipped;
    }
    var seen = {}, fresh = [], dup = 0;
    store.trades.forEach(function (t) { seen[signature(t)] = true; });
    incoming.forEach(function (t) {
      var s = signature(t);
      if (seen[s]) { dup++; return; }
      seen[s] = true;
      fresh.push(t);
    });
    if (!fresh.length) return toast(dup ? 'ทุกเทรดในไฟล์นี้มีอยู่ในสมุดแล้ว' : 'ไม่พบเทรดที่นำเข้าได้ในไฟล์นี้', dup ? '' : 'error');
    askConfirm({
      title: 'นำเข้า ' + fresh.length + ' เทรด',
      text: 'จากไฟล์ ' + name + (dup ? ' ข้าม ' + dup + ' รายการที่มีอยู่แล้ว' : '') + (skipped ? ' ข้าม ' + skipped + ' แถวที่ข้อมูลไม่ครบ' : '') + ' เทรดที่มีอยู่เดิมจะไม่ถูกแก้ไข',
      yes: 'นำเข้า', danger: false
    }, function () {
      var n = store.addMany(fresh);
      if (settings && C.num(settings.startBalance) > 0 && !store.settings.startBalance) store.setSettings({ startBalance: settings.startBalance });
      toast('นำเข้า ' + n + ' เทรดแล้ว');
    });
  }

  /* ------------------------------------------------------------------ *
   * Trade form
   * ------------------------------------------------------------------ */

  function form() { return $('#form-trade'); }

  function setRadio(name, value) {
    $$('input[name="' + name + '"]', form()).forEach(function (r) { r.checked = r.value === value; });
  }

  function getRadio(name) {
    var r = $('input[name="' + name + '"]:checked', form());
    return r ? r.value : '';
  }

  function fillLists(asset) {
    var used = {};
    store.trades.forEach(function (t) { if (t.asset === asset) used[t.symbol] = true; });
    var syms = C.SYMBOLS[asset].concat(Object.keys(used).filter(function (s) { return C.SYMBOLS[asset].indexOf(s) === -1; }));
    $('#dl-symbols').innerHTML = syms.map(function (s) { return '<option value="' + esc(s) + '"></option>'; }).join('');
    var strat = {};
    store.trades.forEach(function (t) { if (t.strategy) strat[t.strategy] = true; });
    $('#dl-strategies').innerHTML = Object.keys(strat).sort().map(function (s) { return '<option value="' + esc(s) + '"></option>'; }).join('');
  }

  function readForm() {
    var f = form();
    return C.normalizeTrade({
      id: state.editing || '',
      asset: getRadio('asset'), symbol: f.symbol.value, side: getRadio('side'),
      lots: f.lots.value, entry: f.entry.value, exit: f.exit.value, sl: f.sl.value, tp: f.tp.value,
      fees: f.fees.value, openTime: f.openTime.value, closeTime: f.closeTime.value, pnl: f.pnl.value,
      strategy: f.strategy.value, emotion: f.emotion.value, plan: getRadio('plan'), notes: f.notes.value
    });
  }

  function clearErrors() {
    $$('[data-err]', form()).forEach(function (p) { p.textContent = ''; });
    $$('[aria-invalid]', form()).forEach(function (i) { i.removeAttribute('aria-invalid'); });
  }

  /** Recompute the derived read-outs and, while the P/L field follows the prices, its value. */
  function updateDerived() {
    var f = form(), t = readForm();
    var net = C.calcNet(t);
    if (state.pnlAuto && net !== null) f.pnl.value = net.toFixed(2);
    var hint = $('#f-pnl-hint');
    var typed = C.num(f.pnl.value);
    if (!C.isNum(t.exit)) hint.textContent = 'ใส่ราคาออกเมื่อปิดออเดอร์ ตัวเลขนี้จะคำนวณให้';
    else if (net === null) hint.textContent = 'คู่นี้ไม่ได้อ้างอิงดอลลาร์โดยตรง ใส่ตัวเลขตามที่โบรกเกอร์แสดง';
    else if (state.pnlAuto) hint.textContent = 'คำนวณจากราคาและ Lot แก้ได้ถ้าโบรกเกอร์แสดงต่างจากนี้';
    else if (typed !== null && Math.abs(typed - net) > 0.005) {
      hint.innerHTML = 'คำนวณจากราคาได้ ' + C.fmtMoney(net, { sign: true }) + ' <button type="button" class="btn-text" data-action="pnl-auto">ใช้ค่านี้</button>';
    } else hint.textContent = '';

    var pips = C.calcPips(t), r = C.calcR(t), rr = C.plannedRR(t), risk = C.riskAmount(t);
    function row(k, v) { return '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }
    $('#f-derived').innerHTML =
      row('Pips', C.fmtPips(pips)) +
      row('ผลลัพธ์', C.fmtR(r)) +
      row('แผน RR', rr === null ? '–' : '1 : ' + rr.toFixed(2)) +
      row('เสี่ยง', risk === null ? '–' : C.fmtMoney(risk));
  }

  function openTrade(t) {
    var f = form();
    if (t && t.sample) return toast('นี่คือเทรดตัวอย่าง แก้ไขไม่ได้ บันทึกเทรดของคุณเองได้จากปุ่มด้านบน');
    state.editing = t ? t.id : null;
    $('#dlg-trade-title').textContent = t ? 'แก้ไขเทรด' : 'บันทึกเทรด';
    $('#btn-delete-trade').hidden = !t;
    var v = t || { asset: state.asset !== 'all' ? state.asset : 'forex', side: 'buy', openTime: C.toLocalInput(new Date()), plan: '' };
    if (!t) v.symbol = v.asset === 'forex' ? '' : C.SYMBOLS[v.asset][0];
    function val(x) { return x === null || x === undefined ? '' : x; }
    setRadio('asset', v.asset);
    setRadio('side', v.side);
    setRadio('plan', v.plan || '');
    f.symbol.value = val(v.symbol);
    f.lots.value = val(v.lots);
    f.entry.value = val(v.entry);
    f.exit.value = val(v.exit);
    f.sl.value = val(v.sl);
    f.tp.value = val(v.tp);
    f.fees.value = v.fees ? v.fees : '';
    f.openTime.value = val(v.openTime);
    f.closeTime.value = val(v.closeTime);
    f.pnl.value = val(v.pnl);
    f.strategy.value = val(v.strategy);
    f.emotion.value = val(v.emotion);
    f.notes.value = val(v.notes);
    var net = t ? C.calcNet(t) : null;
    state.pnlAuto = !t || !C.isNum(t.pnl) || (net !== null && Math.abs(net - t.pnl) < 0.005);
    fillLists(v.asset);
    clearErrors();
    updateDerived();
    openDialog($('#dlg-trade'));
    // start typing straight away on desktop; on touch screens leave the keyboard closed until a field is tapped
    if (!t && window.matchMedia && window.matchMedia('(hover: hover)').matches) (v.symbol ? f.lots : f.symbol).focus();
  }

  function findTrade(id) {
    var list = trades();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function submitTrade(e) {
    e.preventDefault();
    var t = readForm(), err = C.validateTrade(t), f = form();
    clearErrors();
    var first = null;
    Object.keys(err).forEach(function (k) {
      var p = $('[data-err="' + k + '"]', f);
      if (p) p.textContent = err[k];
      var input = f[k];
      if (input && input.setAttribute) {
        input.setAttribute('aria-invalid', 'true');
        if (!first) first = input;
      }
    });
    if (Object.keys(err).length) { if (first) first.focus(); return; }
    var wasEdit = !!state.editing;
    store.upsert(t);
    closeDialog($('#dlg-trade'));
    toast(wasEdit ? 'แก้ไขเทรดแล้ว' : 'บันทึกเทรดแล้ว');
  }

  function clearError(name) {
    var f = form(), p = $('[data-err="' + name + '"]', f);
    if (p) p.textContent = '';
    if (f[name] && f[name].removeAttribute) f[name].removeAttribute('aria-invalid');
  }

  function onFormInput(e) {
    var f = form(), name = e.target.name;
    clearError(name);
    if (name === 'asset') clearError('symbol');
    if (name === 'exit') { clearError('closeTime'); clearError('pnl'); }
    if (name === 'pnl') state.pnlAuto = f.pnl.value === '';
    if (name === 'asset') {
      var asset = getRadio('asset');
      if (C.classifySymbol(f.symbol.value) !== asset) f.symbol.value = asset === 'forex' ? '' : C.SYMBOLS[asset][0];
      fillLists(asset);
    }
    if (name === 'symbol') {
      var cls = C.classifySymbol(f.symbol.value);
      if (cls && cls !== getRadio('asset')) { setRadio('asset', cls); fillLists(cls); }
    }
    if (name === 'exit' && f.exit.value && !f.closeTime.value) f.closeTime.value = C.toLocalInput(new Date());
    updateDerived();
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function shiftMonth(delta) {
    var cal = $('.cal[data-month]');
    if (!cal) return;
    var p = cal.dataset.month.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1 + delta, 1);
    state.calMonth = C.monthKey(d);
    render();
  }

  var ACTIONS = {
    'add-trade': function () { if (state.ready) openTrade(null); },
    'close-dialog': function (el) { closeDialog(el.closest('dialog')); },
    'delete-trade': function () {
      var id = state.editing;
      if (!id) return;
      askConfirm({ title: 'ลบเทรดนี้?', text: 'เทรดจะถูกลบออกจากสมุดและสถิติทั้งหมด กู้คืนไม่ได้', yes: 'ลบเทรด' }, function () {
        store.remove(id);
        closeDialog($('#dlg-trade'));
        toast('ลบเทรดแล้ว');
      });
    },
    'confirm-yes': function () {
      var fn = state.onConfirm;
      state.onConfirm = null;
      closeDialog($('#dlg-confirm'));
      if (fn) fn();
    },
    'confirm-no': function () { state.onConfirm = null; closeDialog($('#dlg-confirm')); },
    'pnl-auto': function () { state.pnlAuto = true; updateDerived(); },
    'hide-demo': function () { store.setSettings({ hideDemo: true }); },
    'show-demo': function () { store.setSettings({ hideDemo: false }); },
    'reset-filters': function () {
      state.range = 'all'; state.asset = 'all'; state.q = ''; $('#q').value = '';
      savePrefs(); render();
    },
    more: function () { state.limit += PAGE; render(); },
    'cal-prev': function () { shiftMonth(-1); },
    'cal-next': function () { shiftMonth(1); },
    import: function () { if (state.ready) $('#file-import').click(); },
    'export-csv': exportCsv,
    backup: backup,
    'clear-all': function () {
      if (!store.trades.length) return toast('ไม่มีเทรดให้ลบ');
      askConfirm({ title: 'ลบเทรดทั้งหมด ' + store.trades.length + ' รายการ?', text: 'สมุดเทรดจะว่างเปล่าและกู้คืนไม่ได้ สำรองข้อมูลเป็นไฟล์ก่อนถ้ายังต้องการเก็บไว้', yes: 'ลบทั้งหมด' }, function () {
        store.clear();
        store.setSettings({ hideDemo: true });
        toast('ลบเทรดทั้งหมดแล้ว');
      });
    },
    'copy-text': function () {
      var ta = $('#dlg-text-area');
      function fallback() { ta.focus(); ta.select(); toast('เลือกข้อความไว้ให้แล้ว กดคัดลอกจากแป้นพิมพ์ได้เลย'); }
      try { navigator.clipboard.writeText(ta.value).then(function () { toast('คัดลอกแล้ว'); }, fallback); }
      catch (e) { fallback(); }
    }
  };

  function bind() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.closest) return;
      var act = t.closest('[data-action]');
      if (act && ACTIONS[act.dataset.action]) { ACTIONS[act.dataset.action](act, e); return; }
      var nav = t.closest('a[data-view], a.brand');
      if (nav) { e.preventDefault(); setView(nav.dataset.view || 'overview'); return; }
      var seg = t.closest('button[data-range], button[data-asset]');
      if (seg) {
        if (seg.dataset.range) state.range = seg.dataset.range; else state.asset = seg.dataset.asset;
        state.limit = PAGE; state.calMonth = null;
        savePrefs(); render();
        return;
      }
      var tg = t.closest('[data-toggle-table]');
      if (tg) { state.tables[tg.dataset.toggleTable] = !state.tables[tg.dataset.toggleTable]; render(); return; }
      var row = t.closest('[data-trade]');
      if (row) { var tr = findTrade(row.dataset.trade); if (tr) openTrade(tr); return; }
      if (t.nodeName === 'DIALOG') closeDialog(t); // click on the backdrop
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest && e.target.closest('[data-trade]');
      if (row && e.target === row) { e.preventDefault(); var tr = findTrade(row.dataset.trade); if (tr) openTrade(tr); }
    });

    window.addEventListener('hashchange', function () { setView(location.hash.replace('#', ''), true); });

    var f = form();
    f.addEventListener('submit', submitTrade);
    f.addEventListener('input', onFormInput);
    f.addEventListener('change', onFormInput);

    $('#q').addEventListener('input', function (e) { state.q = e.target.value; state.limit = PAGE; if (state.ready) renderJournal(); });

    $('#form-calc').addEventListener('input', function () { state.calcTouched = true; renderCalc(); });
    $('#form-calc').addEventListener('submit', function (e) { e.preventDefault(); });

    $('#form-settings').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = C.num($('#s-balance').value);
      store.setSettings({ startBalance: v !== null && v > 0 ? v : 0 });
      toast(v > 0 ? 'บันทึกทุนเริ่มต้น ' + C.fmtMoney(v, { dp: 0 }) + ' แล้ว' : 'ล้างทุนเริ่มต้นแล้ว');
    });

    $('#file-import').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () { handleImport(String(reader.result || ''), file.name); };
      reader.onerror = function () { toast('อ่านไฟล์ไม่ได้ ลองเลือกไฟล์อีกครั้ง', 'error'); };
      reader.readAsText(file);
    });

    // charts read their colours from CSS variables, so redraw when the theme flips
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onTheme = function () { scheduleRender(); };
      if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
    }
    if (window.MutationObserver) {
      new MutationObserver(scheduleRender).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  function initStatic() {
    document.documentElement.lang = 'th';
    $('#f-emotion').innerHTML = '<option value="">ไม่ระบุ</option>' + C.EMOTIONS.map(function (e) { return '<option>' + esc(e) + '</option>'; }).join('');
    $('#c-symbol').innerHTML = C.ASSET_ORDER.map(function (k) {
      return '<optgroup label="' + esc(C.ASSETS[k].label) + '">' + C.SYMBOLS[k].map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</optgroup>';
    }).join('');
  }

  function start() {
    initStatic();
    loadPrefs();
    var h = (location.hash || '').replace('#', '');
    if (VIEWS.indexOf(h) !== -1) state.view = h;
    bind();
    render();
    store.init().then(function () {
      state.ready = true;
      render();
    });
  }

  window.TFApp = { store: store, state: state, render: render };
  start();
})();
