'use strict';
/*
 * Browser test of the stand-alone app (data in localStorage).
 * Needs Playwright:  npm i -D playwright  &&  node tests/browser/local.e2e.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { serve } = require('./serve');

(async () => {
  const site = await serve(path.resolve(__dirname, '../..'));
  const URL = site.url;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-forex-'));
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', locale: 'th-TH', timezoneId: 'Asia/Bangkok', acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  p.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const txt = sel => p.locator(sel).first().innerText();
  const step = (name) => console.log('ok  ' + name);

  // ---- market analysis, against a stand-in for the Kraken OHLC endpoint ----
  const asked = [];
  await p.route(/api\.kraken\.com/, route => {
    const u = new globalThis.URL(route.request().url());
    const pair = u.searchParams.get('pair'), tf = Number(u.searchParams.get('interval'));
    asked.push(pair + ':' + tf);
    if (pair === 'USDCAD') return route.abort();
    const base = { EURUSD: 1.165, PAXGUSD: 4120, XBTUSD: 104500 }[pair] || 1.3;
    // a steady climb with a ripple, so the reading is predictably bullish
    const end = Math.floor(Date.now() / (tf * 60000)) * tf * 60000;
    const rows = Array.from({ length: 400 }, (_, i) => {
      const c = base * (1 + i * 0.00025 + Math.sin(i / 4) * 0.0008), o = base * (1 + (i - 1) * 0.00025 + Math.sin((i - 1) / 4) * 0.0008);
      return [(end - (399 - i) * tf * 60000) / 1000, String(o), String(Math.max(o, c) * 1.0004), String(Math.min(o, c) * 0.9996), String(c), String(c), '12.5', 9];
    });
    route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: [], result: { ['Z' + pair]: rows, last: rows[399][0] } }) });
  });

  await p.goto(URL);
  await p.waitForSelector('#cv-mkt-price');
  assert.equal(await p.evaluate(() => window.TFApp.state.view), 'market');
  assert.match(await txt('.source-line'), /ราคาจาก Kraken \(EURUSD\)/);
  assert.match(await txt('.hero-label'), /EUR\/USD · H1/);
  assert.match(await txt('#market-body .kpis'), /ขาขึ้น/);
  assert.equal(await p.locator('#market-body .banner').count(), 0, 'live prices carry no example banner');
  assert.equal(await p.locator('#ai-chart').isVisible(), false, 'no Claude outside an artifact');
  step('market view loads live candles and reads an uptrend');

  await p.selectOption('#m-symbol', 'XAUUSD');
  await p.waitForFunction(() => /PAXG/.test((document.querySelector('.source-line') || {}).textContent || ''));
  await p.click('#seg-tf button[data-tf="4h"]');
  await p.waitForFunction(() => /H4/.test((document.querySelector('.hero-label') || {}).textContent || ''));
  assert.deepEqual(asked.slice(0, 3), ['EURUSD:60', 'PAXGUSD:60', 'PAXGUSD:240']);
  await p.click('[data-toggle-table="mkt"]');
  assert.equal(await p.locator('#market-body figure tbody tr').count(), 40);
  await p.click('[data-toggle-table="mkt"]');
  await p.waitForSelector('#cv-mkt-macd');
  step('symbol and timeframe switches, gold proxy is disclosed, table twin');

  // the formula plan feeds the lot calculator and the trade form
  const plan = await p.evaluate(() => window.TFApp.market.analysis.plan);
  assert.equal(plan.side, 'buy');
  assert.ok(plan.sl < plan.entry && plan.entry < plan.tp);
  await p.click('[data-action="plan-calc"]');
  assert.equal(await p.evaluate(() => window.TFApp.state.view), 'tools');
  assert.equal(await p.inputValue('#c-symbol'), 'XAUUSD');
  assert.equal(Number(await p.inputValue('#c-sl')), plan.sl);
  await p.fill('#c-balance', '10000');
  assert.match(await txt('.calc-lots'), /\d\.\d\d Lot/);
  await p.click('.tabs a[data-view="market"]');
  await p.waitForSelector('[data-action="plan-trade"]');
  await p.click('[data-action="plan-trade"]');
  await p.waitForSelector('#dlg-trade[open]');
  assert.equal(await p.inputValue('#f-symbol'), 'XAUUSD');
  assert.equal(Number(await p.inputValue('#f-tp')), plan.tp);
  assert.ok(await p.isChecked('#f-asset-gold') && await p.isChecked('#f-side-buy'));
  await p.click('#dlg-trade [data-action="close-dialog"]');
  step('plan prefills the lot calculator and the trade form');

  // the entry/exit ladder: buy is the trend side here, sell flips the ladder
  const ladder = () => p.$$eval('.ladder .lad', els => els.map(e => e.className.replace('lad ', '')));
  assert.match(await txt('button[data-setup-side="buy"]'), /★/);
  let order = (await ladder()).filter(r => r !== 'now');
  assert.deepEqual(order, ['tp', 'tp', 'tp', 'entry', 'sl'], 'buy: targets above the entry, stop below');
  await p.click('button[data-setup-side="sell"]');
  await p.waitForSelector('button[data-setup-side="sell"][aria-pressed="true"]');
  order = (await ladder()).filter(r => r !== 'now');
  assert.deepEqual(order, ['sl', 'entry', 'tp', 'tp', 'tp'], 'sell: stop above the entry, targets below');
  assert.match(await txt('.setup-card .kind-tag'), /สวนแนวโน้ม/);
  const sell = await p.evaluate(() => window.TFApp.market.analysis.setups.sell);
  await p.click('[data-action="plan-trade"]');
  await p.waitForSelector('#dlg-trade[open]');
  assert.ok(await p.isChecked('#f-side-sell'));
  assert.equal(Number(await p.inputValue('#f-sl')), sell.sl);
  assert.equal(Number(await p.inputValue('#f-tp')), sell.tps[1].price);
  await p.click('#dlg-trade [data-action="close-dialog"]');
  await p.click('#seg-tf button[data-tf="1h"]');
  await p.waitForSelector('button[data-setup-side="buy"][aria-pressed="true"]');
  step('entry/exit ladder switches between buy and sell and feeds the chosen side on');

  // a provider failure falls back to clearly-labelled example candles
  await p.selectOption('#m-symbol', 'USDCAD');
  await p.waitForSelector('#market-body .banner .tag');
  assert.match(await txt('#market-body .banner'), /โหลดราคาสดของ USD\/CAD ไม่ได้[\s\S]*ข้อมูลสมมติ/);
  assert.match(await txt('.hero-label'), /ราคาอ้างอิง/);
  assert.match(await txt('#market-body .hero-meta'), /ไม่ใช่ราคาสด/);
  assert.equal(await p.locator('[data-action="plan-calc"]').count(), 0, 'example prices cannot be sent on as a plan');
  step('failed price load is reported and falls back to labelled examples');

  // an MT4 history file
  const mt4 = Array.from({ length: 150 }, (_, i) => {
    const d = new Date(2026, 9, 1, i), c = 1.33 - i * 0.0003 + Math.sin(i / 3) * 0.0006, o = 1.33 - (i - 1) * 0.0003 + Math.sin((i - 1) / 3) * 0.0006;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())},${pad(d.getHours())}:00,${o.toFixed(5)},${(Math.max(o, c) + 0.0003).toFixed(5)},${(Math.min(o, c) - 0.0003).toFixed(5)},${c.toFixed(5)},100`;
  }).join('\n');
  fs.writeFileSync(path.join(TMP, 'GBPUSD60.csv'), mt4);
  await p.setInputFiles('#file-candles', path.join(TMP, 'GBPUSD60.csv'));
  await p.waitForFunction(() => /GBPUSD60\.csv/.test((document.querySelector('.source-line') || {}).textContent || ''));
  assert.equal(await p.inputValue('#m-symbol'), 'GBPUSD');
  assert.match(await txt('.source-line'), /150 แท่ง · H1/);
  assert.match(await txt('#market-body .kpis'), /ขาลง/);
  assert.ok(await p.isDisabled('#seg-tf button[data-tf="1h"]'));
  await p.click('[data-action="mkt-clear-file"]');
  await p.waitForFunction(() => /Kraken/.test((document.querySelector('.source-line') || {}).textContent || ''));
  step('price file import (MT4 format) is analysed and can be dismissed');

  // ---- journal ----
  await p.click('.tabs a[data-view="overview"]');
  await p.waitForSelector('#overview-body .summary');
  assert.ok(await p.locator('.banner .tag').first().isVisible());
  assert.match(await txt('#overview-body .hero-value'), /\+\$1,140\.16/);
  step('demo shown on first load');

  // empty submit -> validation
  await p.click('#btn-add');
  await p.waitForSelector('#dlg-trade[open]');
  await p.click('#btn-save-trade');
  assert.ok((await txt('[data-err="lots"]')).length > 0);
  assert.ok((await txt('[data-err="entry"]')).length > 0);
  assert.equal(await p.locator('#dlg-trade[open]').count(), 1);
  step('validation blocks an empty trade');

  // gold trade, P/L auto-calculated
  await p.click('label:has(#f-asset-gold)');
  assert.equal(await p.inputValue('#f-symbol'), 'XAUUSD');
  await p.fill('#f-lots', '0.1');
  await p.fill('#f-entry', '4100');
  await p.fill('#f-exit', '4112.5');
  await p.fill('#f-sl', '4090');
  await p.fill('#f-tp', '4120');
  await p.fill('#f-fees', '1');
  await p.fill('#f-open', '2026-11-03T09:15');
  await p.fill('#f-close', '2026-11-03T11:40');
  assert.equal(await p.inputValue('#f-pnl'), '124.00');
  const derived = await txt('#f-derived');
  assert.ok(/\+125\.0/.test(derived) && /\+1\.25R/.test(derived) && /1 : 2\.00/.test(derived) && /\$100\.00/.test(derived), derived);
  await p.fill('#f-strategy', 'Breakout <b>x</b>');
  await p.selectOption('#f-emotion', 'มั่นใจ');
  await p.click('label:has(#f-plan-yes)');
  await p.fill('#f-notes', 'ทดสอบ <script>alert(1)</script>');
  await p.click('#btn-save-trade');
  await p.waitForSelector('#dlg-trade:not([open])', { state: 'attached' });
  await p.waitForFunction(() => /\+\$124\.00/.test(document.querySelector('#overview-body .hero-value').textContent));
  assert.equal(await p.locator('.banner').count(), 0);
  step('first trade saved, demo gone, hero = +$124.00');

  // forex trade with manual P/L override
  await p.click('#btn-add');
  await p.fill('#f-symbol', 'eurusd');
  await p.click('label:has(#f-side-sell)');
  await p.fill('#f-lots', '0.5');
  await p.fill('#f-entry', '1.165');
  await p.fill('#f-exit', '1.166');
  await p.fill('#f-sl', '1.167');
  await p.fill('#f-open', '2026-11-05T20:30');
  await p.fill('#f-close', '2026-11-05T22:10');
  assert.equal(await p.inputValue('#f-pnl'), '-50.00');
  await p.fill('#f-pnl', '-53.5');
  assert.match(await txt('#f-pnl-hint'), /คำนวณจากราคาได้ −\$50\.00/);
  await p.click('#btn-save-trade');
  await p.waitForFunction(() => /\+\$70\.50/.test(document.querySelector('#overview-body .hero-value').textContent));
  step('second trade with broker P/L override, hero = +$70.50');

  // persistence across reload
  await p.reload();
  await p.waitForSelector('#overview-body .summary');
  assert.match(await txt('#overview-body .hero-value'), /\+\$70\.50/);
  assert.match(await txt('#overview-body .hero-meta'), /2 เทรด · ชนะ 1 · แพ้ 1/);
  step('trades persist across reload');

  // journal: escaping, search, edit
  await p.click('.tabs a[data-view="journal"]');
  await p.waitForSelector('.journal-table tbody tr');
  assert.equal(await p.locator('.journal-table tbody tr').count(), 2);
  assert.equal(await p.locator('.journal-table b, #journal-body script').count(), 0, 'user text must not become markup');
  assert.match(await txt('.journal-table tbody'), /Breakout <b>x<\/b>/);
  await p.fill('#q', 'xau');
  assert.equal(await p.locator('.journal-table tbody tr').count(), 1);
  await p.click('.journal-table tbody tr');
  await p.waitForSelector('#dlg-trade[open]');
  assert.equal(await txt('#dlg-trade-title'), 'แก้ไขเทรด');
  assert.equal(await p.inputValue('#f-entry'), '4100');
  assert.equal(await p.inputValue('#f-notes'), 'ทดสอบ <script>alert(1)</script>');
  await p.fill('#f-exit', '4120');
  assert.equal(await p.inputValue('#f-pnl'), '199.00');
  await p.click('#btn-save-trade');
  await p.waitForSelector('#dlg-trade:not([open])', { state: 'attached' });
  // the list re-renders on the next animation frame, so wait for it rather than reading at once
  await p.waitForFunction(() => /\+\$199\.00/.test(document.querySelector('.journal-table tbody').textContent));
  await p.fill('#q', '');
  step('journal search, edit and HTML escaping');

  // import MT4-style CSV
  const csv = [
    'Ticket,Open Time,Type,Size,Item,Price,S / L,T / P,Close Time,Price,Commission,Taxes,Swap,Profit',
    '1,2026.11.06 09:15:00,buy,0.05,btcusd,104000,103000,106000,2026.11.06 15:00:00,105200,-2.10,0,0,60.00',
    '2,2026.11.07 10:00:00,balance,,,,,,,,,,,500.00',
    '3,2026.11.09 14:00:00,sell,0.20,gbpusd,1.33200,1.33400,1.32800,2026.11.09 18:30:00,1.33400,-1.40,0,0,-40.00'
  ].join('\n');
  fs.writeFileSync(path.join(TMP, 'mt4.csv'), csv);
  await p.setInputFiles('#file-import', path.join(TMP, 'mt4.csv'));
  await p.waitForSelector('#dlg-confirm[open]');
  assert.match(await txt('#dlg-confirm-title'), /นำเข้า 2 เทรด/);
  await p.click('#dlg-confirm-yes');
  await p.waitForFunction(() => document.querySelectorAll('.journal-table tbody tr').length === 4);
  // importing the same file again adds nothing
  await p.setInputFiles('#file-import', path.join(TMP, 'mt4.csv'));
  await p.waitForFunction(() => /มีอยู่ในสมุดแล้ว/.test(document.querySelector('#toast').textContent));
  assert.equal(await p.locator('.journal-table tbody tr').count(), 4);
  step('CSV import (MT4-style columns), duplicates skipped');

  // export CSV
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#view-journal [data-action="export-csv"]')]);
  const file = path.join(TMP, 'export.csv');
  await dl.saveAs(file);
  const out = fs.readFileSync(file, 'utf8');
  assert.ok(out.startsWith('﻿openTime,closeTime,symbol'), out.slice(0, 60));
  assert.equal(out.trim().split('\r\n').length, 5);
  assert.match(dl.suggestedFilename(), /^trade-forex-\d{4}-\d{2}-\d{2}\.csv$/);
  step('CSV export downloads 4 trades');

  // delete one
  await p.click('.journal-table tbody tr >> nth=0');
  await p.waitForSelector('#dlg-trade[open]');
  await p.click('#btn-delete-trade');
  await p.waitForSelector('#dlg-confirm[open]');
  await p.click('#dlg-confirm-yes');
  await p.waitForFunction(() => document.querySelectorAll('.journal-table tbody tr').length === 3);
  step('delete with confirmation');

  // tools: start balance + calculator
  await p.click('.tabs a[data-view="tools"]');
  await p.fill('#s-balance', '5000');
  await p.click('#form-settings button[type=submit]');
  await p.fill('#c-balance', '5000');
  await p.fill('#c-risk', '1');
  await p.selectOption('#c-symbol', 'EURUSD');
  await p.fill('#c-entry', '1.165');
  await p.fill('#c-sl', '1.1625');
  await p.fill('#c-tp', '1.17');
  assert.match(await txt('.calc-lots'), /0\.20 Lot/);
  assert.match(await txt('#calc-result'), /1 : 2\.00/);
  step('position size calculator = 0.20 Lot');

  // overview with start balance, table twin, filters
  await p.click('.tabs a[data-view="overview"]');
  await p.waitForSelector('#cv-equity');
  assert.match(await txt('#overview-body .hero-meta'), /ผลตอบแทน .*จากทุน \$5,000/);
  await p.click('[data-toggle-table="equity"]');
  await p.waitForSelector('#overview-body figure table');
  assert.equal(await p.locator('#overview-body figure tbody tr').count(), 3);
  await p.click('[data-toggle-table="equity"]');
  await p.waitForSelector('#cv-equity');
  await p.click('#seg-asset button[data-asset="gold"]');
  assert.match(await txt('#overview-body .hero-meta'), /1 เทรด/);
  await p.click('#seg-asset button[data-asset="crypto"]');
  await p.click('#seg-range button[data-range="7d"]');
  await p.click('#seg-range button[data-range="all"]');
  await p.click('#seg-asset button[data-asset="all"]');
  step('filters and chart/table toggle');

  await p.click('.tabs a[data-view="analysis"]');
  await p.waitForSelector('.cal');
  const m0 = await txt('.cal-title');
  await p.click('[data-action="cal-prev"]');
  const m1 = await txt('.cal-title');
  assert.notEqual(m0, m1);
  await p.click('[data-action="cal-next"]');
  assert.equal(await txt('.cal-title'), m0);
  await p.waitForTimeout(400);
  step('calendar navigation');

  // clear all -> real empty state (no demo)
  await p.click('.tabs a[data-view="tools"]');
  await p.click('[data-action="clear-all"]');
  await p.click('#dlg-confirm-yes');
  await p.click('.tabs a[data-view="overview"]');
  await p.waitForSelector('.empty');
  assert.match(await txt('.empty h2'), /ยังไม่มีเทรดในสมุด/);
  await p.click('[data-action="show-demo"]');
  await p.waitForSelector('#overview-body .summary');
  step('clear all -> empty state -> demo on request');

  // hash deep link
  await p.goto(URL + '#analysis');
  await p.waitForSelector('#cv-monthly');
  step('hash deep link opens analysis');

  console.log('console errors:', JSON.stringify(errors));
  assert.equal(errors.length, 0);
  await browser.close();
  site.close();
  console.log('LOCAL BROWSER TEST PASSED');
})().catch(e => { console.error('LOCAL BROWSER TEST FAILED\n', e); process.exit(1); });
