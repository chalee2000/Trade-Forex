'use strict';
/*
 * Browser test of the artifact build against an in-memory stand-in for the Claude
 * `db`, `user`, `downloads` and `sample` capabilities. The stand-in is deliberately awkward:
 * every write is followed by a late, out-of-order echo of the state before it.
 * Needs Playwright:  npm i -D playwright  &&  node tests/browser/cloud.e2e.js
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { serve } = require('./serve');

const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-forex-'));
// the artifact host wraps the published page in this skeleton
const SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';

const MOCK = () => {
  const KEY = '__mockdb';
  let data = JSON.parse(sessionStorage.getItem(KEY) || '{}');
  const listeners = [];
  const clone = o => JSON.parse(JSON.stringify(o));
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (p, src) => ({ id: p.split('/').pop(), exists: src[p] !== undefined, data: () => (src[p] === undefined ? undefined : Object.freeze(clone(src[p]))), metadata: meta });
  const colSnap = (p, src) => {
    const n = p.split('/').length + 1;
    const docs = Object.keys(src).filter(k => k.startsWith(p + '/') && k.split('/').length === n).sort().map(k => docSnap(k, src));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta };
  };
  const fire = src => listeners.slice().forEach(l => l.next(l.type === 'doc' ? docSnap(l.path, src) : colSnap(l.path, src)));
  const M = (window.__mock = { writes: 0, inFlight: 0, maxInFlight: 0, log: [], downloads: [], failNext: 0, data: () => data });
  function write(p, body) {
    M.inFlight++; M.maxInFlight = Math.max(M.maxInFlight, M.inFlight);
    if (M.failNext > 0) { M.failNext--; return new Promise((_, rej) => setTimeout(() => { M.inFlight--; rej({ code: 'unavailable', message: 'mock outage' }); }, 20)); }
    const before = clone(data);
    M.writes++; M.log.push(p.split('/').slice(-1)[0] + (body === undefined ? ':del' : ':set'));
    if (body === undefined) delete data[p]; else data[p] = clone(body);
    sessionStorage.setItem(KEY, JSON.stringify(data));
    const after = clone(data);
    return new Promise(res => {
      setTimeout(() => fire(after), 10);
      setTimeout(() => fire(before), 22);   // a late, out-of-order echo of the state before this write
      setTimeout(() => { M.inFlight--; res(); }, 35);
    });
  }
  function doc(p) {
    if (p.split('/').length % 2) throw new TypeError('document path needs an even number of segments: ' + p);
    return {
      id: p.split('/').pop(), path: p, get: async () => docSnap(p, data), set: b => write(p, b), delete: () => write(p, undefined),
      update: b => write(p, Object.assign({}, data[p], b)),
      onSnapshot(next) { const l = { type: 'doc', path: p, next }; listeners.push(l); setTimeout(() => next(docSnap(p, data)), 15); return () => listeners.splice(listeners.indexOf(l), 1); },
      collection: sub => collection(p + '/' + sub)
    };
  }
  function collection(p) {
    if (p.split('/').length % 2 === 0) throw new TypeError('collection path needs an odd number of segments: ' + p);
    return {
      path: p, doc: id => doc(p + '/' + id), get: async () => colSnap(p, data),
      onSnapshot(next) { const l = { type: 'col', path: p, next }; listeners.push(l); setTimeout(() => next(colSnap(p, data)), 20); return () => listeners.splice(listeners.indexOf(l), 1); }
    };
  }
  // `sample`: streams a canned answer in two parts; M.sampleFail makes the next call reject with that code
  M.samples = [];
  M.sampleFail = null;
  const ANSWER = 'แนวโน้ม: ขาขึ้น ราคาทำจุดสูงสุดใหม่ต่อเนื่อง\nแนวรับสำคัญ: 1.1620\n**ข้อความอื่น** <b>ไม่ใช่ HTML</b>';
  const sample = (input, opts) => new Promise((res, rej) => {
    opts = opts || {};
    M.samples.push({ input: String(input), images: opts.images ? opts.images.length : 0, imageType: opts.images && opts.images[0] ? opts.images[0].type : null });
    if (M.sampleFail) { const code = M.sampleFail; M.sampleFail = null; return setTimeout(() => rej({ code, message: 'mock ' + code }), 20); }
    if (opts.signal) opts.signal.addEventListener('abort', () => rej({ code: 'cancelled', message: 'aborted', text: ANSWER.slice(0, 30) }));
    setTimeout(() => opts.onText && !opts.signal.aborted && opts.onText({ text: ANSWER.slice(0, 30), delta: ANSWER.slice(0, 30) }), 20);
    setTimeout(() => { if (opts.signal && opts.signal.aborted) return; if (opts.onText) opts.onText({ text: ANSWER, delta: ANSWER.slice(30) }); res({ text: ANSWER, truncated: false, modelTierApplied: 'default' }); }, M.sampleDelay || 80);
  });
  // sample.json: a structured reading of a gold chart; M.jsonAnswer can replace it per call
  M.jsonAnswer = null;
  sample.json = (input, opts) => new Promise((res, rej) => {
    opts = opts || {};
    M.samples.push({ input: String(input), images: opts.images ? opts.images.length : 0, imageType: opts.images && opts.images[0] ? opts.images[0].type : null, json: true });
    if (M.sampleFail) { const code = M.sampleFail; M.sampleFail = null; return setTimeout(() => rej({ code, message: 'mock ' + code }), 20); }
    if (opts.signal) opts.signal.addEventListener('abort', () => rej({ code: 'cancelled', message: 'aborted' }));
    const answer = M.jsonAnswer || {
      isChart: true, symbol: 'XAUUSD.iux', timeframe: 'M15', lastPrice: 3868.41, trend: 'ขาลง', summary: 'ราคาลงแรงแล้วเด้งจาก 3,828 <b>x</b>',
      supports: [3856.3, 3828.1], resistances: [3884.5, 3912.7],
      buy: { entry: 3857, sl: 3826, tp1: 3884, tp2: 3912, condition: 'รอยืนเหนือ 3,856' },
      sell: { entry: 3884, sl: 3900, tp1: 3856, tp2: 3830, condition: 'รอโดนขายที่ 3,884' },
      favored: 'sell', reason: 'โครงสร้างยังทำจุดต่ำใหม่', risks: 'ข่าวเศรษฐกิจคืนนี้', confidence: 'กลาง'
    };
    setTimeout(() => { if (opts.signal && opts.signal.aborted) return; res(JSON.parse(JSON.stringify(answer))); }, M.sampleDelay || 80);
  });
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 4, maxInputBytes: 20 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } });
  const caps = {
    sample,
    db: Object.freeze({ doc, collection }),
    user: Object.freeze({ id: async () => 'u_test-1', isOwner: async () => true }),
    downloads: Object.freeze({ save: async r => { M.downloads.push({ filename: r.filename, head: String(r.data).slice(0, 40) }); return { status: 'saved' }; } })
  };
  // how long the host takes to hand over a capability; a test can stretch it to see the loading frame
  const wait = Number(sessionStorage.getItem('__mockWait') || 30);
  window.claude = { use: name => new Promise(res => setTimeout(() => res(caps[name] || null), wait)) };
};

(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-artifact.mjs'), TMP], { stdio: 'ignore' });
  fs.renameSync(path.join(TMP, 'trade-forex.html'), path.join(TMP, 'index.html'));
  const site = await serve(TMP, (html) => SKELETON + html + '</body></html>');
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: 'Asia/Bangkok', locale: 'th-TH' });
  await ctx.addInitScript(MOCK);
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  p.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await p.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const external = [];
  p.on('request', r => { if (!r.url().startsWith(site.url) && !/fonts\.g/.test(r.url()) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  const step = n => console.log('ok  ' + n);
  const mock = () => p.evaluate(() => ({ d: window.__mock.data(), writes: window.__mock.writes, log: window.__mock.log, max: window.__mock.maxInFlight, dl: window.__mock.downloads }));
  const settle = () => p.waitForFunction(() => window.__mock.inFlight === 0 && !window.TFApp.store.saving, null, { timeout: 15000 }).then(() => p.waitForTimeout(80));
  const BASE = 'data/users/u_test-1/journal';

  // ---- market analysis inside an artifact: no network, so examples + Claude reading a chart image ----
  await p.goto(site.url);
  await p.waitForSelector('#cv-mkt-price');
  assert.equal(await p.evaluate(() => window.TFApp.state.view), 'market');
  assert.match(await p.locator('#market-body .banner').innerText(), /ข้อมูลสมมติ/);
  assert.match(await p.locator('#market-body .hero-label').innerText(), /ราคาอ้างอิง/);
  assert.equal(await p.locator('#market-body .hero-value').innerText(), '1.10230', 'example ends at the reference quote');
  assert.equal(await p.locator('#btn-mkt-refresh').isVisible(), false);
  assert.equal(await p.locator('[data-action="plan-calc"]').count(), 0);
  assert.match(await p.locator('.setup-warn').innerText(), /ไม่ใช่จุดเข้าเทรดจริง/, 'example setups are marked as not for trading');
  await p.waitForSelector('#ai-chart:not([hidden])');
  await p.waitForFunction(() => document.querySelector('#view-market').firstElementChild.id === 'ai-chart');
  assert.deepEqual(external, [], 'the artifact build must not call out to the network');
  step('market view shows labelled example candles and makes no network calls');

  // 1x1 PNG standing in for a chart screenshot
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(TMP, 'chart.png'), png);
  await p.click('#btn-ai-chart');
  await p.waitForFunction(() => /เลือกภาพกราฟก่อน/.test(document.querySelector('#toast').textContent));
  assert.equal(await p.evaluate(() => window.__mock.samples.length), 0, 'nothing is sent without an image');
  await p.setInputFiles('#ai-file', path.join(TMP, 'chart.png'));
  await p.waitForSelector('#ai-preview:not([hidden])');
  await p.fill('#ai-question', 'เน้นแผน Sell');
  await p.click('#btn-ai-chart');
  await p.waitForSelector('#ai-chart-out.has-reading');
  let sent = await p.evaluate(() => window.__mock.samples[0]);
  assert.equal(sent.json, true);
  assert.equal(sent.images, 1);
  assert.equal(sent.imageType, 'image/png');
  assert.ok(sent.input.includes('lastPrice') && sent.input.includes('เน้นแผน Sell'));
  const out = await p.locator('#ai-chart-out').innerText();
  assert.match(out, /XAUUSD\.IUX · M15 · ราคาปัจจุบันในภาพ/);
  assert.equal(await p.locator('.ai-price-value').innerText(), '3,868.41', 'the price read from the screenshot is the headline');
  assert.match(out, /ความมั่นใจกลาง/);
  assert.match(out, /แนวต้าน 3,884.50/);
  assert.match(out, /ราคาลงแรงแล้วเด้งจาก 3,828 <b>x<\/b>/, 'text from the model is shown as text, never as markup');
  assert.equal(await p.locator('#ai-chart-out .ai-plan').count(), 2);
  assert.equal(await p.locator('#ai-chart-out .ai-plan.favored h4').innerText(), 'จุดเข้าขาย (Sell) ★');
  // sell ladder, highest price first: SL 3900, entry 3884, current 3868.41, TP1 3856, TP2 3830
  const sellRows = await p.$$eval('.ai-plan.favored .lad', els => els.map(e => e.className.replace('lad ', '') + ':' + e.querySelector('.lad-price').textContent));
  assert.deepEqual(sellRows, ['sl:3,900.00', 'entry:3,884.00', 'now:3,868.41', 'tp:3,856.00', 'tp:3,830.00']);
  assert.match(await p.locator('.ai-plan.favored').innerText(), /1\.75R/);
  await p.waitForFunction(() => window.TFApp.state.ready);
  await p.click('.ai-plan.favored [data-action="ai-plan-trade"]');
  await p.waitForSelector('#dlg-trade[open]');
  assert.equal(await p.inputValue('#f-symbol'), 'XAUUSD');
  assert.ok(await p.isChecked('#f-asset-gold') && await p.isChecked('#f-side-sell'));
  assert.equal(await p.inputValue('#f-entry'), '3884');
  assert.equal(await p.inputValue('#f-sl'), '3900');
  assert.equal(await p.inputValue('#f-tp'), '3830');
  await p.click('#dlg-trade [data-action="close-dialog"]');
  step('Claude reads the screenshot: price from the image, buy and sell ladders, plan into the trade form');

  // a plan with the stop on the wrong side is not shown
  await p.evaluate(() => { window.__mock.jsonAnswer = { isChart: true, symbol: 'EURUSD', lastPrice: 1.1023, buy: { entry: 1.1, sl: 1.105, tp1: 1.11 }, sell: { entry: 1.104, sl: 1.106, tp1: 1.1, tp2: 1.098 }, favored: 'buy' }; });
  await p.click('#btn-ai-chart');
  await p.waitForFunction(() => /ไม่สมเหตุสมผล/.test(document.querySelector('#ai-chart-out').textContent));
  assert.equal(await p.locator('#ai-chart-out .ai-plan.favored').count(), 0);
  await p.evaluate(() => { window.__mock.jsonAnswer = { isChart: false }; });
  await p.click('#btn-ai-chart');
  await p.waitForFunction(() => /ไม่ใช่กราฟราคา/.test(document.querySelector('#ai-chart-out').textContent));
  await p.evaluate(() => { window.__mock.jsonAnswer = null; });
  step('nonsense plans and non-chart images are caught');

  await p.evaluate(() => { window.__mock.sampleDelay = 4000; });
  await p.click('#btn-ai-chart');
  await p.waitForSelector('#btn-ai-chart-stop:not([hidden])');
  await p.click('#btn-ai-chart-stop');
  await p.waitForFunction(() => /หยุดแล้ว/.test(document.querySelector('#ai-chart-out').textContent));
  assert.ok(await p.isEnabled('#btn-ai-chart'));
  await p.evaluate(() => { window.__mock.sampleDelay = 80; window.__mock.sampleFail = 'rate_limited'; });
  await p.click('#btn-ai-chart');
  await p.waitForFunction(() => /โควตา/.test(document.querySelector('#ai-chart-out').textContent));
  assert.ok(await p.locator('#ai-chart').isVisible());
  step('stop button and a rate-limit error leave the feature usable');

  // ---- journal in the cloud store ----
  await p.click('.tabs a[data-view="overview"]');
  await p.evaluate(() => sessionStorage.setItem('__mockWait', '600'));
  await p.reload();
  assert.match(await p.locator('#overview-body .loading-title').innerText(), /กำลังเปิดสมุดเทรด/);
  await p.evaluate(() => sessionStorage.removeItem('__mockWait'));
  await p.waitForSelector('#overview-body .summary');
  assert.equal(await p.locator('#ai-coach').isVisible(), false, 'no AI review of example trades');
  assert.equal(await p.evaluate(() => window.TFApp.store.mode), 'cloud');
  assert.equal(await p.evaluate(() => localStorage.getItem('tf.trades.v1')), null);
  step('artifact build boots in cloud mode, shows examples while the journal is empty');

  async function add(symbol, lots, entry, exit, sl) {
    await p.click('#btn-add');
    await p.fill('#f-symbol', symbol);
    await p.fill('#f-lots', String(lots));
    await p.fill('#f-entry', String(entry));
    await p.fill('#f-exit', String(exit));
    await p.fill('#f-sl', String(sl));
    await p.fill('#f-open', '2026-11-03T09:15');
    await p.fill('#f-close', '2026-11-03T11:40');
    await p.click('#btn-save-trade');
  }
  // two trades back to back: the second is saved while the first write is still in flight
  await add('XAUUSD', 0.1, 4100, 4112.5, 4090);
  await add('EURUSD', 0.5, 1.165, 1.164, 1.167);
  await settle();
  let m = await mock();
  assert.deepEqual(Object.keys(m.d), [BASE + '/chunks/c00001']);
  assert.equal(m.d[BASE + '/chunks/c00001'].trades.length, 2);
  assert.equal(m.max, 1, 'never more than one write in flight');
  assert.equal(await p.evaluate(() => window.TFApp.store.trades.length), 2);
  assert.match(await p.locator('#overview-body .hero-value').innerText(), /\+\$75\.00/);
  const stored = m.d[BASE + '/chunks/c00001'].trades[0];
  assert.ok(!('notes' in stored) && !('sample' in stored) && stored.symbol === 'XAUUSD', JSON.stringify(stored));
  step('rapid saves land in one private document; stale echoes do not drop trades');

  await p.click('.tabs a[data-view="tools"]');
  assert.match(await p.locator('#storage-note').innerText(), /บัญชี Claude/);
  await p.fill('#s-balance', '2000');
  await p.click('#form-settings button[type=submit]');
  await settle();
  m = await mock();
  assert.equal(m.d[BASE].settings.startBalance, 2000);
  step('settings saved to the journal document');

  await p.reload();
  await p.waitForFunction(() => window.TFApp.state.ready);
  assert.equal(await p.evaluate(() => window.TFApp.state.view), 'tools', 'the open tab survives a reload through the hash');
  await p.click('.tabs a[data-view="overview"]');
  await p.waitForSelector('#overview-body .summary');
  assert.equal(await p.evaluate(() => window.TFApp.store.trades.length), 2);
  assert.match(await p.locator('#overview-body .hero-meta').innerText(), /จากทุน \$2,000/);
  step('reload restores trades and settings from the store');

  // a write that fails twice is retried and lands
  await p.evaluate(() => { window.__mock.failNext = 2; });
  await add('BTCUSD', 0.05, 104000, 105000, 103000);
  await p.waitForFunction(() => /เชื่อมต่อที่เก็บข้อมูลไม่ได้ชั่วคราว/.test(document.querySelector('#toast').textContent));
  await p.waitForFunction(() => { const d = window.__mock.data()['data/users/u_test-1/journal/chunks/c00001']; return d && d.trades.length === 3; }, null, { timeout: 15000 });
  await settle();
  step('failed write is reported, retried and saved');

  // bulk import: 230 trades -> spread over chunks of 100
  const rows = ['openTime,closeTime,symbol,side,lots,entry,exit,pnl'];
  for (let i = 0; i < 230; i++) {
    const d = new Date(2026, 0, 5 + Math.floor(i / 2), 9 + (i % 2) * 5, 0);
    const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':00';
    rows.push([s, s.slice(0, 11) + String(d.getHours() + 2).padStart(2, '0') + ':00', 'GBPUSD', i % 3 ? 'buy' : 'sell', '0.10', '1.3300', '1.3310', i % 3 ? '10' : '-10'].join(','));
  }
  fs.writeFileSync(path.join(TMP, 'bulk.csv'), rows.join('\n'));
  const before = (await mock()).writes;
  await p.setInputFiles('#file-import', path.join(TMP, 'bulk.csv'));
  await p.click('#dlg-confirm-yes');
  await settle();
  m = await mock();
  const sizes = Object.keys(m.d).filter(k => k.includes('/chunks/')).sort().map(k => m.d[k].trades.length);
  assert.deepEqual(sizes, [100, 100, 33]);
  assert.equal(m.writes - before, 3, 'one write per touched chunk');
  assert.equal(await p.evaluate(() => window.TFApp.store.trades.length), 233);
  const bytes = Math.max(...Object.keys(m.d).map(k => JSON.stringify(m.d[k]).length));
  assert.ok(bytes < 100 * 1024, 'chunk size ' + bytes);
  step('bulk import of 230 trades = 3 writes, chunks of 100 (largest ' + (bytes / 1024).toFixed(1) + ' KB)');

  // AI review of real statistics (text only, no notes)
  await p.click('.tabs a[data-view="analysis"]');
  await p.waitForSelector('#ai-coach:not([hidden])');
  const before2 = await p.evaluate(() => window.__mock.samples.length);
  await p.click('#btn-ai-coach');
  await p.waitForFunction(() => /1\.1620/.test(document.querySelector('#ai-coach-out').textContent));
  sent = await p.evaluate(n => window.__mock.samples[n], before2);
  assert.equal(sent.images, 0);
  const payload = JSON.parse(sent.input.slice(sent.input.indexOf('{'), sent.input.lastIndexOf('}') + 1));
  assert.equal(payload.closedTrades, 233);
  assert.ok(payload.bySymbol.some(g => g.name === 'GBPUSD' && g.trades === 230));
  assert.ok(!/notes/.test(sent.input));
  await p.evaluate(() => { window.__mock.sampleFail = 'not_granted'; });
  await p.click('#seg-range button[data-range="ytd"]');
  await p.click('#btn-ai-coach');
  await p.waitForSelector('#ai-coach', { state: 'hidden' });
  step('AI review sends statistics only; a declined permission hides the feature');

  // edit + delete inside chunks
  await p.click('.tabs a[data-view="journal"]');
  await p.fill('#q', 'btc');
  await p.click('.journal-table tbody tr');
  await p.click('#btn-delete-trade');
  await p.click('#dlg-confirm-yes');
  await settle();
  m = await mock();
  assert.equal(m.d[BASE + '/chunks/c00001'].trades.length, 99);
  await p.fill('#q', '');
  step('delete rewrites only the chunk that held the trade');

  // export goes through the downloads capability
  await p.click('#view-journal [data-action="export-csv"]');
  await p.waitForFunction(() => window.__mock.downloads.length === 1);
  m = await mock();
  assert.match(m.dl[0].filename, /^trade-forex-.*\.csv$/);
  step('export uses the downloads capability');

  // a change made on another device shows up here
  await p.evaluate(() => {
    const k = 'data/users/u_test-1/journal/chunks/c00003';
    const d = window.__mock.data();
    const body = JSON.parse(JSON.stringify(d[k]));
    body.rev += 1000;
    body.trades.push({ id: 'remote1', symbol: 'XAUUSD', asset: 'gold', side: 'buy', lots: 0.01, entry: 4000, exit: 4010, openTime: '2026-11-10T10:00', closeTime: '2026-11-10T11:00', pnl: 10 });
    return window.claude.use('db').then(db => db.doc(k).set(body));
  });
  await p.waitForFunction(() => window.TFApp.store.trades.some(t => t.id === 'remote1'));
  step('remote change appears without a reload');

  // clear all removes every chunk document
  await p.click('.tabs a[data-view="tools"]');
  await p.click('[data-action="clear-all"]');
  await p.click('#dlg-confirm-yes');
  await settle();
  m = await mock();
  assert.deepEqual(Object.keys(m.d), [BASE]);
  assert.equal(m.d[BASE].settings.hideDemo, true);
  await p.reload();
  await p.waitForFunction(() => window.TFApp.state.ready);
  await p.click('.tabs a[data-view="overview"]');
  await p.waitForSelector('.empty');
  step('clear all deletes every chunk; empty state after reload');

  console.log('console errors:', JSON.stringify(errors));
  assert.equal(errors.length, 0);
  await browser.close();
  site.close();
  console.log('CLOUD BROWSER TEST PASSED');
})().catch(e => { console.error('CLOUD BROWSER TEST FAILED\n', e); process.exit(1); });
