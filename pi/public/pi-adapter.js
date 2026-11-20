/* Adaptateur « Raspberry Pi » : chargé AVANT l'appli, uniquement dans la version Pi.
   Si le plugin serveur répond, l'appli range ses trajets, notes, photos et journal d'audit sur le Pi
   (partagés entre tous les appareils) et laisse le Pi enregistrer les trajets 24 h/24.
   Sinon il ne fait rien : l'appli fonctionne alors comme une appli web autonome. */
(function () {
  'use strict';
  var BASE = '/plugins/carnet-de-bord';
  var SYNC = ['wp', 'plan', 'polar', 'mob', 'chk', 'maint', 'aisFavD'];   // réglages partagés ; le reste (thème, langue, source…) reste propre à l'appareil
  var STORES = { trips: 1, notes: 1, photos: 1, audit: 1 };               // les « grib » restent sur l'appareil (cache)
  function xhr(method, url, body) {
    var r = new XMLHttpRequest(); r.open(method, url, false);
    if (body != null) r.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
    r.send(body == null ? null : body);
    if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
    return r.responseText;
  }
  var ping; try { ping = JSON.parse(xhr('GET', BASE + '/ping')); } catch (e) { return; }
  if (!ping || ping.app !== 'carnet-de-bord') return;

  /* --- réglages partagés : le Pi fait foi ; première fois, on y envoie ce que l'appareil avait --- */
  var kv = {}; try { kv = JSON.parse(xhr('GET', BASE + '/kv')); } catch (e) {}
  SYNC.forEach(function (k) {
    try {
      if (k in kv) localStorage.setItem(k, kv[k]);
      else if (localStorage.getItem(k) != null) xhr('PUT', BASE + '/kv/' + encodeURIComponent(k), localStorage.getItem(k));
    } catch (e) {}
  });
  /* --- première ouverture : source = Signal K de ce même serveur --- */
  try {
    if (!localStorage.getItem('piInit')) {
      var c = JSON.parse(localStorage.getItem('cfg') || '{}'); c.src = 'signalk'; c.host = location.host;
      localStorage.setItem('cfg', JSON.stringify(c)); localStorage.setItem('piInit', '1');
    }
  } catch (e) {}

  var queue = []; try { queue = JSON.parse(localStorage.getItem('piQueue') || '[]'); } catch (e) {}
  var saveQ = function () { try { localStorage.setItem('piQueue', JSON.stringify(queue)); } catch (e) {} };
  var seen = 0, blobs = {}, timers = {};
  function send(method, path, body, ctype) {
    return fetch(BASE + path, { method: method, body: body, headers: body != null ? { 'Content-Type': ctype || 'text/plain;charset=utf-8' } : {}, keepalive: body != null && body.length < 60000 })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; });
  }
  function flush() {
    if (!queue.length) return;
    var q = queue[0];
    send(q.m, q.p, q.b).then(function () { queue.shift(); saveQ(); flush(); }).catch(function () { setTimeout(flush, 10000); });
  }
  function enqueue(m, p, b) { queue.push({ m: m, p: p, b: b }); saveQ(); flush(); }

  /* écriture des réglages partagés (localStorage) vers le Pi */
  var _set = Storage.prototype.setItem, _rm = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) {
    _set.apply(this, arguments);
    if (this === localStorage && SYNC.indexOf(k) >= 0) { clearTimeout(timers[k]); timers[k] = setTimeout(function () { send('PUT', '/kv/' + encodeURIComponent(k), String(v)).catch(function () {}); }, 600); }
  };
  Storage.prototype.removeItem = function (k) {
    _rm.apply(this, arguments);
    if (this === localStorage && SYNC.indexOf(k) >= 0) send('DELETE', '/kv/' + encodeURIComponent(k)).catch(function () {});
  };

  function getJSON(path) { return fetch(BASE + path, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function blobKeys(o) { return Object.keys(o).filter(function (k) { return o[k] instanceof Blob; }); }

  var PIBOX = window.PIBOX = {
    base: BASE, ping: ping,
    has: function (s) { return !!STORES[s]; },
    all: function (s) {
      return getJSON('/store/' + s).then(function (list) {
        if (s === 'trips') seen = Date.now();
        if (s !== 'photos') return list;
        return Promise.all(list.map(function (p) {
          var keys = p._blobs || [];
          return Promise.all(keys.map(function (k) {
            var id = p.id + (k === 'blob' ? '' : '.' + k);
            if (blobs[id]) return blobs[id];
            return fetch(BASE + '/blob/' + encodeURIComponent(id)).then(function (r) { return r.blob(); }).then(function (b) { return (blobs[id] = b); });
          })).then(function (bs) { var o = Object.assign({}, p); delete o._blobs; keys.forEach(function (k, i) { o[k] = bs[i]; }); return o; });
        }));
      });
    },
    put: function (s, o) {
      if (s === 'photos') {
        var ks = blobKeys(o), meta = Object.assign({}, o); meta._blobs = ks;
        return Promise.all(ks.map(function (k) {
          var id = o.id + (k === 'blob' ? '' : '.' + k); blobs[id] = o[k]; delete meta[k];
          return send('PUT', '/blob/' + encodeURIComponent(id), o[k], 'application/octet-stream');
        })).then(function () { return send('PUT', '/store/photos/' + encodeURIComponent(o.id), JSON.stringify(meta)); });
      }
      var q = '';
      var body = o;
      if (s === 'trips') { q = '?seen=' + seen; if (o.open) body = Object.assign({}, o, { points: [] }); }   // la trace d'un trajet ouvert appartient au Pi
      enqueue('PUT', '/store/' + s + '/' + encodeURIComponent(o.id) + q, JSON.stringify(body));
      return Promise.resolve();
    },
    del: function (s, id) {
      if (s === 'photos') { delete blobs[id]; }
      enqueue('DELETE', '/store/' + s + '/' + encodeURIComponent(id));
      return Promise.resolve();
    },
    /* le trajet ouvert est enregistré par le Pi : on en garde une copie à jour pour l'affichage */
    pull: function () {
      if (typeof cur === 'undefined' || queue.length) return Promise.resolve();
      var tp = 0, tl = 0;
      if (cur && cur.open) { tp = cur.points.length ? cur.points[cur.points.length - 1].t : 0; tl = (cur.log || []).reduce(function (m, e) { return Math.max(m, e.t); }, 0); }
      return getJSON('/trip/open?tp=' + tp + '&tl=' + tl).then(function (s) {
        seen = Date.now();
        if (!s || !s.id) {
          if (cur && cur.open && Date.now() - cur.start > 20000) { cur = null; try { updateRecUI(); renderTrips(); } catch (e) {} }
          return;
        }
        if (!cur || String(cur.id) !== String(s.id)) {
          return getJSON('/store/trips/' + encodeURIComponent(s.id)).then(function (t) { cur = t; try { updateRecUI(); } catch (e) {} });
        }
        var ts = {}; cur.points.forEach(function (p) { ts[p.t] = 1; });
        (s.points || []).forEach(function (p) { if (!ts[p.t]) cur.points.push(p); });
        var ids = {}; (cur.log || []).forEach(function (e) { ids[e.id] = 1; });
        (s.log || []).forEach(function (e) { if (!ids[e.id]) (cur.log = cur.log || []).push(e); });
        if (s.name) cur.name = s.name;
      }).catch(function () {});
    }
  };
  PIBOX.influx = {
    probe: function () { return getJSON('/influx/probe'); },
    import: function (from, to) { return fetch(BASE + '/influx/import', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ from: from, to: to }) }).then(function (r) { return r.json(); }); }
  };
  flush();
  window.addEventListener('load', function () { setInterval(PIBOX.pull, 5000); });
})();
