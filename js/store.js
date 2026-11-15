/*
 * Trade-Forex — storage.
 *
 * Two back ends behind one interface:
 *   - "local": the browser's localStorage (the stand-alone app).
 *   - "cloud": the Claude artifact document store, under the signed-in viewer's
 *     private subtree, so the journal follows the person across devices and is
 *     not readable by anyone else who opens the page.
 *
 * Trades are kept in memory; every change updates memory first, re-renders, then
 * persists in the background.
 */
(function (root) {
  'use strict';
  var C = root.TFCore;

  var LS_TRADES = 'tf.trades.v1';
  var LS_SETTINGS = 'tf.settings.v1';
  var CHUNK_MAX = 100; // trades per cloud document (keeps each well under the 256 KiB limit)
  var SETTINGS_ID = '__settings';

  function defaults() {
    return { startBalance: 0, hideDemo: false };
  }

  function cleanSettings(s) {
    var d = defaults();
    s = s || {};
    var b = C.num(s.startBalance);
    d.startBalance = b !== null && b > 0 ? b : 0;
    d.hideDemo = !!s.hideDemo;
    return d;
  }

  /** Drop empty fields so stored records stay small. */
  function compact(t) {
    var o = {};
    Object.keys(t).forEach(function (k) {
      var v = t[k];
      if (v === null || v === undefined || v === '' || k === 'sample') return;
      if (k === 'fees' && v === 0) return;
      o[k] = v;
    });
    return o;
  }

  function createStore(hooks) {
    hooks = hooks || {};
    var store = {
      mode: 'loading', // loading | cloud | local | memory
      trades: [],
      settings: defaults(),
      saving: false
    };

    function changed() { if (hooks.onChange) hooks.onChange(); }
    function fail(msg) { if (hooks.onError) hooks.onError(msg); }
    function status(s) { if (hooks.onStatus) hooks.onStatus(s); }

    /* ---------------- local ---------------- */

    var local = {
      ok: false,
      probe: function () {
        try {
          root.localStorage.setItem('tf.probe', '1');
          root.localStorage.removeItem('tf.probe');
          local.ok = true;
        } catch (e) { local.ok = false; }
        return local.ok;
      },
      read: function (key, fallback) {
        try {
          var s = root.localStorage.getItem(key);
          return s ? JSON.parse(s) : fallback;
        } catch (e) { return fallback; }
      },
      write: function (key, val) {
        if (!local.ok) return;
        try { root.localStorage.setItem(key, JSON.stringify(val)); }
        catch (e) { fail('บันทึกลงเบราว์เซอร์ไม่สำเร็จ พื้นที่เก็บข้อมูลอาจเต็ม ลองสำรองไฟล์แล้วลบเทรดเก่าออก'); }
      },
      load: function () {
        var list = local.read(LS_TRADES, []);
        store.trades = (Array.isArray(list) ? list : []).map(C.normalizeTrade);
        store.settings = cleanSettings(local.read(LS_SETTINGS, {}));
      },
      saveTrades: function () { local.write(LS_TRADES, store.trades.map(compact)); },
      saveSettings: function () { local.write(LS_SETTINGS, store.settings); }
    };

    /* ---------------- cloud ---------------- */

    var cloud = {
      journal: null, col: null,
      chunks: {},     // chunk id -> { rev, trades }
      expected: {},   // chunk id -> rev of our newest write not yet echoed by a snapshot
      deleted: {},    // chunk id -> rev at which we deleted it
      wrote: {},      // chunk id -> time of this page's last write or delete
      settingsRev: 0,
      dirty: {}, attempts: {}, flushing: false, lastRev: 0
    };

    /** A revision stamp that only ever grows, even across devices whose clocks disagree. */
    function nextRev(atLeast) {
      cloud.lastRev = Math.max(Date.now(), cloud.lastRev + 1, (atLeast || 0) + 1);
      return cloud.lastRev;
    }

    var SETTLE_MS = 10000;

    /** True shortly after this page wrote a chunk: a snapshot that disagrees may simply predate the write. */
    function settling(id) {
      return !!cloud.wrote[id] && Date.now() - cloud.wrote[id] < SETTLE_MS;
    }

    function chunkIds() {
      return Object.keys(cloud.chunks).sort();
    }

    function rebuild() {
      var all = [];
      chunkIds().forEach(function (id) { all = all.concat(cloud.chunks[id].trades); });
      store.trades = all;
    }

    function applyChunks(snap) {
      var seen = {}, touched = false;
      snap.docs.forEach(function (doc) {
        var id = doc.id, body = doc.data() || {};
        var rev = C.isNum(body.rev) ? body.rev : 0;
        seen[id] = true;
        if (cloud.dirty[id]) return; // this page has changes for it that are not written yet
        if (cloud.deleted[id]) {
          if (rev <= cloud.deleted[id]) return; // stale echo of a document we removed
          delete cloud.deleted[id];
        }
        if (cloud.expected[id]) {
          if (rev < cloud.expected[id]) return; // older than what this page already holds
          delete cloud.expected[id];
        }
        if (cloud.chunks[id] && rev <= cloud.chunks[id].rev) return; // unchanged, or an out-of-order echo
        cloud.chunks[id] = { rev: rev, trades: (Array.isArray(body.trades) ? body.trades : []).map(C.normalizeTrade) };
        touched = true;
      });
      Object.keys(cloud.chunks).forEach(function (id) {
        // gone from the store: removed on another device, unless it is ours and not echoed yet
        if (!seen[id] && !cloud.expected[id] && !cloud.dirty[id] && !settling(id)) { delete cloud.chunks[id]; touched = true; }
      });
      Object.keys(cloud.deleted).forEach(function (id) { if (!seen[id] && !settling(id)) delete cloud.deleted[id]; });
      if (touched) rebuild();
      return touched;
    }

    function applySettings(snap) {
      if (!snap.exists || cloud.dirty[SETTINGS_ID]) return false;
      var body = snap.data() || {};
      var rev = C.isNum(body.rev) ? body.rev : 0;
      if (rev < cloud.settingsRev) return false;
      cloud.settingsRev = rev;
      var next = cleanSettings(body.settings);
      if (JSON.stringify(next) === JSON.stringify(store.settings)) return false;
      store.settings = next;
      return true;
    }

    function describe(e) {
      var code = e && e.code;
      if (code === 'quota_exceeded') return 'พื้นที่เก็บข้อมูลเต็ม ลองสำรองไฟล์แล้วลบเทรดเก่าออก';
      if (code === 'invalid_argument') return 'บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูลในหน้านี้ ขอสิทธิ์ Contributor จากเจ้าของหน้า';
      if (code === 'revoked' || code === 'not_granted') return 'สิทธิ์เข้าถึงที่เก็บข้อมูลถูกยกเลิก โหลดหน้าใหม่แล้วลองอีกครั้ง';
      return 'เชื่อมต่อที่เก็บข้อมูลไม่ได้ชั่วคราว จะลองบันทึกใหม่ให้อัตโนมัติ';
    }

    function markDirty(id) {
      cloud.dirty[id] = true;
      flush();
    }

    function flush() {
      if (cloud.flushing) return;
      cloud.flushing = true;
      store.saving = true;
      status('saving');
      (function next() {
        var ids = Object.keys(cloud.dirty);
        if (!ids.length) {
          cloud.flushing = false;
          store.saving = false;
          status('saved');
          return;
        }
        var id = ids[0], op;
        delete cloud.dirty[id];
        try {
          if (id === SETTINGS_ID) {
            cloud.settingsRev = nextRev(cloud.settingsRev);
            op = cloud.journal.set({ v: 1, rev: cloud.settingsRev, settings: store.settings });
          } else if (cloud.chunks[id] && cloud.chunks[id].trades.length) {
            var rev = nextRev(cloud.chunks[id].rev);
            cloud.chunks[id].rev = rev;
            cloud.expected[id] = rev;
            cloud.wrote[id] = Date.now();
            op = cloud.col.doc(id).set({ v: 1, rev: rev, trades: cloud.chunks[id].trades.map(compact) });
          } else {
            var gone = cloud.chunks[id] ? cloud.chunks[id].rev : 0;
            delete cloud.chunks[id];
            delete cloud.expected[id];
            cloud.deleted[id] = nextRev(gone);
            cloud.wrote[id] = Date.now();
            op = cloud.col.doc(id).delete();
          }
        } catch (e) { op = Promise.reject(e); }
        Promise.resolve(op).then(function () {
          cloud.attempts[id] = 0;
          next();
        }, function (e) {
          var n = (cloud.attempts[id] = (cloud.attempts[id] || 0) + 1);
          var retryable = !e || !e.code || e.code === 'unavailable' || e.code === 'resource_exhausted';
          delete cloud.expected[id];
          if (retryable && n <= 3) {
            cloud.dirty[id] = true;
            setTimeout(function () { cloud.flushing = false; flush(); }, 1500 * n);
            if (n === 1) fail(describe(e));
            return;
          }
          // give up for now; the change stays queued and goes out with the next save
          cloud.dirty[id] = true;
          cloud.attempts[id] = 0;
          cloud.flushing = false;
          store.saving = false;
          status('error');
          fail(describe(e));
        });
      })();
    }

    function chunkOf(tradeId) {
      var ids = chunkIds();
      for (var i = 0; i < ids.length; i++) {
        var list = cloud.chunks[ids[i]].trades;
        for (var j = 0; j < list.length; j++) if (list[j].id === tradeId) return { id: ids[i], index: j };
      }
      return null;
    }

    /** The chunk a new trade goes into: the newest one with room, else a fresh one. */
    function chunkForInsert() {
      var ids = chunkIds();
      var last = ids[ids.length - 1];
      if (last && cloud.chunks[last].trades.length < CHUNK_MAX) return last;
      var n = last ? parseInt(last.slice(1), 10) + 1 : 1;
      var id = 'c' + ('0000' + n).slice(-5);
      cloud.chunks[id] = { rev: 0, trades: [] };
      return id;
    }

    function detectCloud() {
      var cl = root.claude;
      if (!cl || typeof cl.use !== 'function') return Promise.resolve(null);
      return Promise.all([cl.use('db'), cl.use('user')]).then(function (r) {
        var db = r[0], user = r[1];
        if (!db || !user) return null;
        return Promise.resolve(user.id()).then(function (uid) {
          return uid ? { db: db, uid: uid } : null;
        });
      }).catch(function () { return null; });
    }

    function startCloud(db, uid) {
      return new Promise(function (resolve) {
        var got = { chunks: false, settings: false }, done = false, slow;
        function finish(ok) {
          if (done) return;
          done = true;
          clearTimeout(slow);
          resolve(ok);
        }
        function ready() { if (got.chunks && got.settings) finish(true); }
        function broken(e) {
          if (!done) return finish(false);
          status('error');
          fail(describe(e));
        }
        try {
          cloud.journal = db.doc('data/users/' + uid + '/journal');
          cloud.col = cloud.journal.collection('chunks');
        } catch (e) { return finish(false); }
        slow = setTimeout(function () { if (!done) status('slow'); }, 10000);
        cloud.journal.onSnapshot(function (snap) {
          var touched = applySettings(snap);
          got.settings = true;
          if (done && touched) changed();
          ready();
        }, broken);
        cloud.col.onSnapshot(function (snap) {
          var touched = applyChunks(snap);
          got.chunks = true;
          if (done && touched) changed();
          ready();
        }, broken);
      });
    }

    /* ---------------- public ---------------- */

    store.init = function () {
      return detectCloud().then(function (c) {
        if (!c) return false;
        return startCloud(c.db, c.uid);
      }).then(function (isCloud) {
        if (isCloud) {
          store.mode = 'cloud';
        } else {
          store.mode = local.probe() ? 'local' : 'memory';
          if (local.ok) local.load();
        }
        status('ready');
        changed();
        return store.mode;
      });
    };

    /** Insert or update one trade. */
    store.upsert = function (trade) {
      var t = C.normalizeTrade(trade);
      delete t.sample;
      if (store.mode === 'cloud') {
        var at = chunkOf(t.id);
        if (at) cloud.chunks[at.id].trades[at.index] = t;
        else { at = { id: chunkForInsert() }; cloud.chunks[at.id].trades.push(t); }
        rebuild();
        markDirty(at.id);
      } else {
        var i = store.trades.findIndex(function (x) { return x.id === t.id; });
        if (i >= 0) store.trades[i] = t; else store.trades.push(t);
        local.saveTrades();
      }
      changed();
      return t;
    };

    store.remove = function (id) {
      if (store.mode === 'cloud') {
        var at = chunkOf(id);
        if (!at) return;
        cloud.chunks[at.id].trades.splice(at.index, 1);
        rebuild();
        markDirty(at.id);
      } else {
        store.trades = store.trades.filter(function (x) { return x.id !== id; });
        local.saveTrades();
      }
      changed();
    };

    /** Add many trades at once (CSV import, restore). Returns how many were added. */
    store.addMany = function (list) {
      var have = {};
      store.trades.forEach(function (t) { have[t.id] = true; });
      var added = 0, touched = {};
      list.forEach(function (raw) {
        var t = C.normalizeTrade(raw);
        delete t.sample;
        if (have[t.id]) t.id = C.newId();
        have[t.id] = true;
        if (store.mode === 'cloud') {
          var id = chunkForInsert();
          cloud.chunks[id].trades.push(t);
          touched[id] = true;
        } else store.trades.push(t);
        added++;
      });
      if (store.mode === 'cloud') {
        rebuild();
        Object.keys(touched).forEach(function (id) { cloud.dirty[id] = true; });
        flush();
      } else local.saveTrades();
      changed();
      return added;
    };

    store.clear = function () {
      if (store.mode === 'cloud') {
        chunkIds().forEach(function (id) {
          cloud.chunks[id].trades = [];
          cloud.dirty[id] = true;
        });
        rebuild();
        flush();
      } else {
        store.trades = [];
        local.saveTrades();
      }
      changed();
    };

    store.setSettings = function (patch) {
      store.settings = cleanSettings(Object.assign({}, store.settings, patch));
      if (store.mode === 'cloud') markDirty(SETTINGS_ID);
      else local.saveSettings();
      changed();
    };

    store.exportAll = function () {
      return { app: 'trade-forex', version: 1, exportedAt: new Date().toISOString(), settings: store.settings, trades: store.trades.map(compact) };
    };

    return store;
  }

  root.TFStore = { createStore: createStore, CHUNK_MAX: CHUNK_MAX };
})(typeof self !== 'undefined' ? self : this);
