/*
 * Trade-Forex — market prices.
 *
 * Loads OHLC candles from public, key-less market-data APIs, straight from the
 * visitor's browser:
 *   - Kraken   (forex pairs, bitcoin, and PAXG as a stand-in for gold)
 *   - Binance  (fallback for bitcoin and PAXG)
 *
 * Inside a Claude artifact the page has no network access, so live prices are
 * not available there; the market view then works from an imported price file
 * or shows clearly-labelled example candles.
 */
(function (root) {
  'use strict';
  var T = root.TFTA;

  var SYMBOLS = [
    { key: 'EURUSD', asset: 'forex', name: 'EUR/USD', kraken: 'EURUSD' },
    { key: 'GBPUSD', asset: 'forex', name: 'GBP/USD', kraken: 'GBPUSD' },
    { key: 'USDJPY', asset: 'forex', name: 'USD/JPY', kraken: 'USDJPY' },
    { key: 'AUDUSD', asset: 'forex', name: 'AUD/USD', kraken: 'AUDUSD' },
    { key: 'USDCHF', asset: 'forex', name: 'USD/CHF', kraken: 'USDCHF' },
    { key: 'USDCAD', asset: 'forex', name: 'USD/CAD', kraken: 'USDCAD' },
    // spot gold has no free browser feed; the PAXG token is backed 1:1 by gold and tracks it closely
    { key: 'XAUUSD', asset: 'gold', name: 'ทองคำ XAU/USD', kraken: 'PAXGUSD', binance: 'PAXGUSDT', proxy: 'PAXG' },
    { key: 'BTCUSD', asset: 'crypto', name: 'Bitcoin BTC/USD', kraken: 'XBTUSD', binance: 'BTCUSDT' }
  ];

  var TIMEFRAMES = [
    { key: '15m', label: 'M15', minutes: 15, binance: '15m' },
    { key: '1h', label: 'H1', minutes: 60, binance: '1h' },
    { key: '4h', label: 'H4', minutes: 240, binance: '4h' },
    { key: '1d', label: 'D1', minutes: 1440, binance: '1d' }
  ];

  function find(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return list[0];
  }

  /** True where the page may talk to the price APIs (i.e. not inside a Claude artifact). */
  function live() {
    return typeof root.fetch === 'function' && !(root.claude && typeof root.claude.use === 'function');
  }

  function getJson(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    return root.fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function clean(rows) {
    return rows.filter(function (k) {
      return isFinite(k.t) && isFinite(k.o) && isFinite(k.h) && isFinite(k.l) && isFinite(k.c) && k.o > 0 && k.h >= k.l;
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /* Kraken: { error: [], result: { <PAIR>: [[time_s, open, high, low, close, vwap, volume, count], ...], last } } */
  function fromKraken(sym, tf) {
    var url = 'https://api.kraken.com/0/public/OHLC?pair=' + encodeURIComponent(sym.kraken) + '&interval=' + tf.minutes;
    return getJson(url).then(function (data) {
      if (data && data.error && data.error.length) throw new Error(String(data.error[0]));
      var result = (data && data.result) || {};
      var key = Object.keys(result).filter(function (k) { return k !== 'last'; })[0];
      var rows = key ? result[key] : null;
      if (!Array.isArray(rows)) throw new Error('unexpected response');
      return {
        candles: clean(rows.map(function (r) { return { t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] }; })),
        source: { name: 'Kraken', pair: sym.kraken, proxy: sym.proxy || null }
      };
    });
  }

  /* Binance: [[openTime_ms, open, high, low, close, volume, closeTime, ...], ...] */
  function fromBinance(sym, tf) {
    var url = 'https://data-api.binance.vision/api/v3/klines?symbol=' + encodeURIComponent(sym.binance) + '&interval=' + tf.binance + '&limit=500';
    return getJson(url).then(function (rows) {
      if (!Array.isArray(rows)) throw new Error('unexpected response');
      return {
        candles: clean(rows.map(function (r) { return { t: Number(r[0]), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }; })),
        source: { name: 'Binance', pair: sym.binance, proxy: sym.proxy || null }
      };
    });
  }

  var cache = {};
  var CACHE_MS = 60000;

  /** Resolve { candles, source, at } for a symbol and timeframe, trying each provider in turn. */
  function load(symbolKey, tfKey, opts) {
    var sym = find(SYMBOLS, symbolKey), tf = find(TIMEFRAMES, tfKey);
    var id = sym.key + '|' + tf.key, hit = cache[id];
    if (hit && !(opts && opts.fresh) && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit);
    var providers = [function () { return fromKraken(sym, tf); }];
    if (sym.binance) providers.push(function () { return fromBinance(sym, tf); });
    var i = 0;
    function attempt(lastError) {
      if (i >= providers.length) return Promise.reject(lastError || new Error('no provider'));
      return providers[i++]().then(function (r) {
        if (r.candles.length < T.MIN_CANDLES) throw new Error('not enough candles');
        r.at = Date.now();
        cache[id] = r;
        return r;
      }).catch(attempt);
    }
    return attempt();
  }

  root.TFMarket = { SYMBOLS: SYMBOLS, TIMEFRAMES: TIMEFRAMES, find: find, live: live, load: load };
})(typeof self !== 'undefined' ? self : this);
