'use strict';
process.env.TZ = 'Asia/Bangkok';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const S = require('../js/sample.js');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

function trade(over) {
  return C.normalizeTrade(Object.assign({
    symbol: 'EURUSD', side: 'buy', lots: 1, entry: 1.1, exit: 1.101, sl: 1.099, tp: 1.103,
    openTime: '2026-11-02T14:00', closeTime: '2026-11-02T16:00', pnl: 100
  }, over));
}

test('classifies symbols into the three asset classes', () => {
  assert.equal(C.classifySymbol('eurusd'), 'forex');
  assert.equal(C.classifySymbol('XAUUSD.r'), 'gold');
  assert.equal(C.classifySymbol('BTCUSDT'), 'crypto');
  assert.equal(C.classifySymbol('US30'), null);
});

test('gross P/L: USD-quoted forex pair', () => {
  // 10 pips on 1 lot of EURUSD = $100
  near(C.calcGross(trade({ entry: 1.1, exit: 1.101 })), 100);
  near(C.calcGross(trade({ side: 'sell', entry: 1.1, exit: 1.101 })), -100);
  near(C.calcGross(trade({ lots: 0.1, entry: 1.1, exit: 1.0985 })), -15);
});

test('gross P/L: USD-base pair converts through the exit price', () => {
  // USDJPY 150.00 -> 150.50, 1 lot: 50,000 JPY / 150.50
  near(C.calcGross(trade({ symbol: 'USDJPY', entry: 150, exit: 150.5 })), 50000 / 150.5);
});

test('gross P/L: cross pairs need a rate, so no automatic figure', () => {
  assert.equal(C.calcGross(trade({ symbol: 'EURJPY', entry: 170, exit: 171 })), null);
});

test('gross P/L: gold is 100 oz per lot, bitcoin is 1 coin per lot', () => {
  near(C.calcGross(trade({ symbol: 'XAUUSD', lots: 0.1, entry: 4100, exit: 4112.5 })), 125);
  near(C.calcGross(trade({ symbol: 'BTCUSD', side: 'sell', lots: 0.05, entry: 105000, exit: 103000 })), 100);
});

test('net suggestion subtracts fees', () => {
  near(C.calcNet(trade({ entry: 1.1, exit: 1.101, fees: 7 })), 93);
});

test('pips, R-multiple and planned reward:risk', () => {
  const t = trade({ entry: 1.1, exit: 1.102, sl: 1.099, tp: 1.103 });
  near(C.calcPips(t), 20);
  near(C.calcR(t), 2);
  near(C.plannedRR(t), 3);
  near(C.calcPips(trade({ symbol: 'USDJPY', side: 'sell', entry: 150.5, exit: 150.2 })), 30);
  near(C.calcPips(trade({ symbol: 'XAUUSD', entry: 4100, exit: 4105 })), 50);
  near(C.calcR(trade({ side: 'sell', entry: 1.1, exit: 1.101, sl: 1.102 })), -0.5);
  assert.equal(C.calcR(trade({ sl: '' })), null);
});

test('risk amount if the stop is hit', () => {
  near(C.riskAmount(trade({ lots: 0.5, entry: 1.1, sl: 1.098 })), 100);
  near(C.riskAmount(trade({ symbol: 'XAUUSD', lots: 0.02, entry: 4100, sl: 4090 })), 20);
});

test('normalizeTrade coerces input and validateTrade reports what is missing', () => {
  const t = C.normalizeTrade({ symbol: ' xauusd ', side: 'SHORT', lots: '0.10', entry: '4,100.5', openTime: '2026-11-02T09:30' });
  assert.equal(t.symbol, 'XAUUSD');
  assert.equal(t.asset, 'gold');
  assert.equal(t.side, 'sell');
  assert.equal(t.lots, 0.1);
  assert.equal(t.entry, 4100.5);
  assert.deepEqual(C.validateTrade(t), {}); // an open trade is valid
  assert.equal(C.isClosed(t), false);

  const bad = C.normalizeTrade({ symbol: '', lots: 0, entry: '', exit: 1.2 });
  const e = C.validateTrade(bad);
  assert.ok(e.symbol && e.lots && e.entry && e.openTime && e.closeTime && e.pnl);

  const backwards = trade({ openTime: '2026-11-02T14:00', closeTime: '2026-11-02T13:00' });
  assert.ok(C.validateTrade(backwards).closeTime);
});

test('computeStats: totals, rates and streaks', () => {
  const pnls = [100, -50, -50, 200, 0, -100, -25, -25, 300];
  const trades = pnls.map((p, i) => trade({ pnl: p, openTime: `2026-11-${String(i + 1).padStart(2, '0')}T10:00`, closeTime: `2026-11-${String(i + 1).padStart(2, '0')}T12:00` }));
  const s = C.computeStats(trades, { startBalance: 1000 });
  assert.equal(s.n, 9);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 5);
  assert.equal(s.be, 1);
  near(s.net, 350);
  near(s.grossProfit, 600);
  near(s.grossLoss, 250);
  near(s.profitFactor, 2.4);
  near(s.winRate, (3 / 9) * 100);
  near(s.avgWin, 200);
  near(s.avgLoss, 50);
  near(s.payoff, 4);
  near(s.expectancy, 350 / 9);
  assert.equal(s.maxWinStreak, 1);
  assert.equal(s.maxLossStreak, 3);
  assert.deepEqual(s.streak, { type: 'win', n: 1 });
  near(s.returnPct, 35);
  assert.equal(s.best.pnl, 300);
  assert.equal(s.worst.pnl, -100);
  near(s.avgHoldMin, 120);
});

test('computeStats: drawdown is measured from the running equity peak', () => {
  // equity: 1000 -> 1100 -> 1050 -> 1000 -> 1200 -> 1200 -> 1100 -> 1075 -> 1050 -> 1350
  const pnls = [100, -50, -50, 200, 0, -100, -25, -25, 300];
  const trades = pnls.map((p, i) => trade({ pnl: p, openTime: `2026-11-${String(i + 1).padStart(2, '0')}T10:00`, closeTime: `2026-11-${String(i + 1).padStart(2, '0')}T12:00` }));
  const s = C.computeStats(trades, { startBalance: 1000 });
  near(s.maxDD, 150);
  near(s.maxDDPct, (150 / 1200) * 100);
  assert.equal(s.equity.length, 9);
  near(s.equity[8].equity, 1350);
  near(s.equity[7].dd, -150);
  near(s.equity[8].dd, 0);
});

test('computeStats: orders by close time and ignores open trades', () => {
  const a = trade({ pnl: -100, closeTime: '2026-11-05T12:00', openTime: '2026-11-05T10:00' });
  const b = trade({ pnl: 300, closeTime: '2026-11-03T12:00', openTime: '2026-11-03T10:00' });
  const open = C.normalizeTrade({ symbol: 'BTCUSD', lots: 0.01, entry: 100000, openTime: '2026-11-06T10:00' });
  const s = C.computeStats([a, open, b]);
  assert.equal(s.n, 2);
  assert.equal(s.open, 1);
  assert.equal(s.equity[0].trade, b);
  near(s.maxDD, 100);
  assert.equal(s.maxDDPct, (100 / 300) * 100);
  assert.equal(s.returnPct, null); // no starting balance given
});

test('computeStats: empty and all-winning journals do not divide by zero', () => {
  const empty = C.computeStats([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.winRate, null);
  assert.equal(empty.profitFactor, null);
  const allWin = C.computeStats([trade({ pnl: 10 }), trade({ pnl: 20 })]);
  assert.equal(allWin.profitFactor, Infinity);
  assert.equal(allWin.avgLoss, null);
  assert.equal(C.fmtFactor(allWin.profitFactor), '∞');
});

test('groupings: symbol, asset, side, weekday, session, month, hold time', () => {
  const trades = [
    trade({ symbol: 'EURUSD', pnl: 100, openTime: '2026-11-02T14:30', closeTime: '2026-11-02T15:00' }), // Mon 07:30 UTC london
    trade({ symbol: 'XAUUSD', side: 'sell', pnl: -40, openTime: '2026-11-03T20:00', closeTime: '2026-11-04T01:00' }), // Tue 13:00 UTC overlap
    trade({ symbol: 'XAUUSD', pnl: 90, openTime: '2026-11-03T09:00', closeTime: '2026-11-03T09:20' }), // Tue 02:00 UTC asia
    trade({ symbol: 'BTCUSD', pnl: -60, openTime: '2026-10-31T23:30', closeTime: '2026-11-02T08:00' }) // Sat 16:30 UTC ny
  ];
  const sym = C.bySymbol(trades);
  assert.deepEqual(sym.map(g => g.key), ['EURUSD', 'XAUUSD', 'BTCUSD']);
  near(sym[1].net, 50);
  assert.equal(sym[1].n, 2);

  const asset = C.byAsset(trades);
  assert.deepEqual(asset.map(g => g.key), ['forex', 'gold', 'crypto']);
  near(asset[2].net, -60);

  const side = C.bySide(trades);
  assert.deepEqual(side.map(g => [g.key, g.n]), [['buy', 3], ['sell', 1]]);

  const wd = C.byWeekday(trades);
  assert.deepEqual(wd.map(g => g.label), ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']); // Saturday appears because it was traded
  near(wd[1].net, 50);
  assert.equal(wd[2].n, 0);

  const sess = C.bySession(trades);
  assert.deepEqual(sess.map(g => [g.key, g.n]), [['asia', 1], ['london', 1], ['overlap', 1], ['ny', 1]]);

  const month = C.byMonth(trades);
  assert.deepEqual(month.map(g => g.key), ['2026-11']);
  assert.equal(month[0].label, 'พ.ย. 26');

  const hold = C.byHold(trades);
  assert.deepEqual(hold.map(g => g.n), [2, 0, 1, 1]);

  const daily = C.dailyPnl(trades);
  near(daily['2026-11-02'].net, 40);
  assert.equal(daily['2026-11-02'].n, 2);
});

test('session ranges are shown in the viewer time zone', () => {
  assert.equal(C.sessionLocalRange(C.SESSIONS[1], 420), '14:00–19:00'); // London in Bangkok
  assert.equal(C.sessionLocalRange(C.SESSIONS[0], 420), '05:00–14:00');
  assert.equal(C.sessionLocalRange(C.SESSIONS[3], 0), '16:00–22:00');
});

test('R histogram bins lo <= R < hi and skips trades without a stop', () => {
  const mk = (exit) => trade({ entry: 1.1, sl: 1.099, exit, pnl: (exit - 1.1) * 100000 });
  const h = C.rHistogram([mk(1.099), mk(1.0975), mk(1.1005), mk(1.101), mk(1.1031), trade({ sl: '' })]);
  assert.equal(h.total, 5);
  assert.deepEqual(h.bins.map(b => b.n), [1, 0, 1, 1, 1, 0, 1]);
});

test('filterTrades by range, asset and search text', () => {
  const now = new Date('2026-11-15T12:00');
  const trades = [
    trade({ symbol: 'EURUSD', closeTime: '2026-11-14T10:00', openTime: '2026-11-14T09:00', strategy: 'Breakout' }),
    trade({ symbol: 'XAUUSD', closeTime: '2026-11-09T10:00', openTime: '2026-11-09T09:00', notes: 'รอ retest' }),
    trade({ symbol: 'BTCUSD', closeTime: '2026-08-01T10:00', openTime: '2026-08-01T09:00' }),
    trade({ symbol: 'GBPUSD', closeTime: '2025-12-30T10:00', openTime: '2025-12-30T09:00' })
  ];
  assert.equal(C.filterTrades(trades, { range: 'all', now }).length, 4);
  assert.deepEqual(C.filterTrades(trades, { range: '7d', now }).map(t => t.symbol), ['EURUSD', 'XAUUSD']);
  assert.deepEqual(C.filterTrades(trades, { range: '30d', now }).map(t => t.symbol), ['EURUSD', 'XAUUSD']);
  assert.equal(C.filterTrades(trades, { range: 'ytd', now }).length, 3);
  assert.deepEqual(C.filterTrades(trades, { asset: 'gold', now }).map(t => t.symbol), ['XAUUSD']);
  assert.deepEqual(C.filterTrades(trades, { q: 'retest', now }).map(t => t.symbol), ['XAUUSD']);
  assert.deepEqual(C.filterTrades(trades, { q: 'break', now }).map(t => t.symbol), ['EURUSD']);
});

test('position size from account risk and stop distance', () => {
  // $5,000 at 1% = $50; EURUSD 25-pip stop = $250 per lot -> 0.20 lots
  const p = C.positionSize({ balance: 5000, riskPct: 1, symbol: 'EURUSD', asset: 'forex', entry: 1.165, sl: 1.1625, tp: 1.17 });
  near(p.riskAmount, 50);
  near(p.pips, 25);
  assert.equal(p.lots, 0.2);
  near(p.actualRisk, 50);
  near(p.rr, 2);
  near(p.reward, 100);
  assert.equal(p.side, 'buy');

  // gold: $12 stop = $1,200 per lot; $100 risk -> 0.08 lots (rounded down)
  const g = C.positionSize({ balance: 10000, riskPct: 1, symbol: 'XAUUSD', asset: 'gold', entry: 4100, sl: 4112 });
  assert.equal(g.lots, 0.08);
  assert.equal(g.side, 'sell');
  near(g.actualRisk, 96);

  const cross = C.positionSize({ balance: 5000, riskPct: 1, symbol: 'EURJPY', asset: 'forex', entry: 170, sl: 169.5 });
  assert.equal(cross.lots, null);
  assert.equal(cross.needsRate, true);

  assert.equal(C.positionSize({ balance: 5000, riskPct: 1, symbol: 'EURUSD', entry: 1.1, sl: 1.1 }), null);
});

test('CSV round-trips, including commas, quotes, newlines and formula-looking text', () => {
  const trades = [
    trade({ strategy: 'Break, "retest"', notes: 'บรรทัดแรก\nบรรทัดสอง', emotion: 'มั่นใจ', plan: 'yes', fees: 7, pnl: 93 }),
    trade({ symbol: 'BTCUSD', side: 'sell', lots: 0.05, entry: 105000, exit: 103000, sl: 106000, tp: '', pnl: -12.5, notes: '=SUM(A1)' })
  ];
  const csv = C.toCSV(trades);
  assert.ok(csv.includes("'=SUM(A1)"), 'formula text is neutralised for spreadsheets');
  assert.ok(csv.includes(',-12.5,'), 'negative numbers stay numbers');
  const back = C.importCSV(csv);
  assert.equal(back.error, null);
  assert.equal(back.trades.length, 2);
  for (let i = 0; i < 2; i++) {
    for (const f of C.CSV_FIELDS) assert.deepEqual(back.trades[i][f], trades[i][f], `${f} of row ${i}`);
  }
});

test('CSV import accepts MT4-style history columns and skips balance rows', () => {
  const csv = [
    'Ticket,Open Time,Type,Size,Item,Price,S / L,T / P,Close Time,Price,Commission,Taxes,Swap,Profit',
    '1001,2026.11.03 09:15:00,buy,0.10,xauusd,4100.00,4090.00,4120.00,2026.11.03 11:40:00,4112.50,-0.70,0.00,-0.30,125.00',
    '1002,2026.11.04 15:00:00,balance,,,,,,,,,,,500.00',
    '1003,2026.11.05 20:30:00,sell,0.50,eurusd,1.16500,1.16700,1.16100,2026.11.05 22:10:00,1.16600,-3.50,0.00,0.00,-50.00'
  ].join('\n');
  const r = C.importCSV(csv);
  assert.equal(r.trades.length, 2);
  assert.equal(r.skipped, 1);
  const g = r.trades[0];
  assert.equal(g.symbol, 'XAUUSD');
  assert.equal(g.asset, 'gold');
  assert.equal(g.openTime, '2026-11-03T09:15');
  assert.equal(g.closeTime, '2026-11-03T11:40');
  assert.equal(g.entry, 4100);
  assert.equal(g.exit, 4112.5);
  near(g.pnl, 124);
  near(g.fees, 1);
  assert.equal(r.trades[1].side, 'sell');
  near(r.trades[1].pnl, -53.5);
});

test('CSV import explains unusable files', () => {
  assert.ok(C.importCSV('').error);
  assert.ok(C.importCSV('a,b\n1,2').error);
});

test('formatting', () => {
  assert.equal(C.fmtMoney(1234.5), '$1,234.50');
  assert.equal(C.fmtMoney(-320, { sign: true }), '−$320.00');
  assert.equal(C.fmtMoney(45.678, { sign: true }), '+$45.68');
  assert.equal(C.fmtMoney(-0.001, { sign: true }), '$0.00');
  assert.equal(C.fmtMoney(null), '–');
  assert.equal(C.fmtAxisMoney(500, 2000), '$500');
  assert.equal(C.fmtAxisMoney(-1500, 2000), '−$1,500');
  assert.equal(C.fmtAxisMoney(12500, 20000), '$12.5K');
  assert.equal(C.fmtPct(54.166), '54.2%');
  assert.equal(C.fmtPct(50), '50%');
  assert.equal(C.fmtR(1.5), '+1.50R');
  assert.equal(C.fmtR(-1), '−1.00R');
  assert.equal(C.fmtPrice(1.1, 'EURUSD', 'forex'), '1.10000');
  assert.equal(C.fmtPrice(153.4, 'USDJPY', 'forex'), '153.400');
  assert.equal(C.fmtPrice(4100.5, 'XAUUSD', 'gold'), '4,100.50');
  assert.equal(C.fmtLots(0.2), '0.20');
  assert.equal(C.fmtLots(1), '1.00');
  assert.equal(C.fmtLots(0.005), '0.005');
  assert.equal(C.fmtPips(32.54), '+32.5');
  assert.equal(C.fmtPips(-1625.5), '−1,626');
  assert.equal(C.fmtPips(null), '–');
  assert.equal(C.fmtDuration(45), '45 นาที');
  assert.equal(C.fmtDuration(135), '2 ชม. 15 นาที');
  assert.equal(C.fmtDuration(1500), '1 วัน 1 ชม.');
  const now = new Date('2026-11-15T12:00');
  assert.equal(C.fmtDate('2026-11-03T09:15', now), '3 พ.ย.');
  assert.equal(C.fmtDate('2025-12-30T09:15', now), '30 ธ.ค. 25');
  assert.equal(C.fmtDateTime('2026-11-03T09:05', now), '3 พ.ย. 09:05');
});

test('insights: flags a negative expectancy with the break-even win rate', () => {
  const trades = [];
  for (let i = 0; i < 6; i++) trades.push(trade({ pnl: 50, closeTime: `2026-11-0${i + 1}T12:00`, openTime: `2026-11-0${i + 1}T10:00` }));
  for (let i = 0; i < 4; i++) trades.push(trade({ pnl: -120, closeTime: `2026-11-1${i}T12:00`, openTime: `2026-11-1${i}T10:00` }));
  const ins = C.insights(trades);
  const edge = ins.find(x => x.key === 'edge');
  assert.equal(edge.tone, 'warn');
  assert.ok(edge.text.includes('70.6%'), edge.text); // 120 / (50 + 120)
  assert.ok(ins.find(x => x.key === 'payoff'));
  assert.ok(ins.find(x => x.key === 'sample'));
  assert.deepEqual(C.insights([]), []);
});

test('sample data: deterministic, valid and realistic enough to demo every chart', () => {
  const now = new Date('2026-11-15T12:00');
  const a = S.sampleTrades(now), b = S.sampleTrades(now);
  assert.deepEqual(a, b);
  assert.equal(a.length, 72);
  for (const t of a) {
    assert.deepEqual(C.validateTrade(t), {}, JSON.stringify(t));
    assert.ok(t.sample);
    assert.ok(C.isClosed(t));
    assert.ok(C.toDate(t.closeTime) <= now);
    near(t.pnl, C.calcNet(t), 0.011);
  }
  const s = C.computeStats(a, { startBalance: S.START_BALANCE });
  assert.ok(s.winRate > 35 && s.winRate < 65, `win rate ${s.winRate}`);
  assert.ok(s.net > 0, `net ${s.net}`);
  assert.ok(s.maxDDPct > 2 && s.maxDDPct < 25, `dd ${s.maxDDPct}`);
  assert.deepEqual(C.byAsset(a).map(g => g.n > 5), [true, true, true]);
  assert.ok(C.insights(a, s).length >= 4);
});
