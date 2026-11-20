'use strict';
const path = require('path');
const { Collector } = require('./collector');
const { Store } = require('./store');
const { Recorder, DEFAULTS } = require('./recorder');
const pkg = require('../package.json');

const MAX_BODY = 80 * 1024 * 1024;
function readBody(req) {
  return new Promise((ok, ko) => {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return ok(req.body);
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return ok(JSON.stringify(req.body));
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { ko(new Error('trop volumineux')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', ko);
  });
}

module.exports = function (app) {
  const plugin = { id: 'carnet-de-bord', name: 'Carnet de bord (enregistrement 24 h/24)' };
  let col = null, rec = null, store = null, timer = null, unsub = [];
  const dbg = m => { try { app.debug(m); } catch (e) {} };

  plugin.description = 'Enregistre les trajets et le journal de bord sur le Raspberry Pi, même sans téléphone connecté, et les partage avec tous les appareils.';
  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enregistrement automatique des trajets', default: true },
      startKn: { type: 'number', title: 'Démarrage : vitesse fond (nœuds)', default: DEFAULTS.startKn },
      startSec: { type: 'number', title: 'Démarrage : durée au-dessus du seuil (s)', default: DEFAULTS.startSec },
      stopKn: { type: 'number', title: 'Arrêt : vitesse fond sous (nœuds)', default: DEFAULTS.stopKn },
      stopMin: { type: 'number', title: 'Arrêt : durée d’immobilité (min)', default: DEFAULTS.stopMin },
      interval: { type: 'number', title: 'Point de trace toutes les (s)', default: DEFAULTS.interval },
      logMin: { type: 'number', title: 'Entrée de journal automatique toutes les (min)', default: DEFAULTS.logMin },
      lang: { type: 'string', title: 'Langue du nom des trajets (fr-FR, en-GB…)', default: DEFAULTS.lang }
    }
  };

  plugin.start = function (options) {
    options = options || {};
    const dir = app.getDataDirPath();
    store = new Store(path.join(dir, 'data'));
    col = new Collector();
    rec = new Recorder(options, col, store, path.join(dir, 'data'), Date.now, dbg);
    const cmd = { context: 'vessels.self', subscribe: [{ path: '*', policy: 'instant', minPeriod: 200 }] };
    app.subscriptionmanager.subscribe(cmd, unsub, err => app.error && app.error('abonnement : ' + err), delta => {
      if (!delta || !delta.updates) return;
      if (delta.context && delta.context !== 'vessels.self' && delta.context !== (app.selfContext || delta.context)) return;
      for (const u of delta.updates) for (const v of (u.values || [])) { try { col.ingest(v.path, v.value); } catch (e) {} }
    });
    timer = setInterval(() => {
      try {
        if (options.enabled !== false) rec.tick();
        app.setPluginStatus && app.setPluginStatus(rec.cur ? 'Trajet en cours : ' + rec.cur.points.length + ' points' : 'En veille');
      } catch (e) { app.error && app.error('tick : ' + e.message); }
    }, 1000);
  };
  plugin.stop = function () {
    clearInterval(timer); timer = null;
    unsub.forEach(f => { try { f(); } catch (e) {} }); unsub = [];
  };

  plugin.registerWithRouter = function (router) {
    const wrap = fn => async (req, res) => {
      try {
        if (!store) return res.status(503).json({ error: 'plugin arrêté' });
        res.set && res.set('Cache-Control', 'no-store');
        await fn(req, res);
      } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
    };
    const text = async req => { const b = await readBody(req); return Buffer.isBuffer(b) ? b.toString('utf8') : b; };
    const tripsAll = () => { const l = store.all('trips'); return rec.cur ? l.concat([rec.cur]) : l; };

    router.get('/ping', wrap((req, res) => res.json({ ok: true, app: 'carnet-de-bord', version: pkg.version, time: Date.now(), open: rec.summary() })));

    router.get('/kv', wrap((req, res) => res.json(store.kvAll())));
    router.put('/kv/:key', wrap(async (req, res) => { store.kvSet(req.params.key, await text(req)); res.json({ ok: true }); }));
    router.delete('/kv/:key', wrap((req, res) => { store.kvDel(req.params.key); res.json({ ok: true }); }));

    router.get('/trip/open', wrap((req, res) => res.json(rec.since(+req.query.tp || 0, +req.query.tl || 0) || { id: null })));
    router.post('/trip/start', wrap(async (req, res) => {
      let b = {}; try { b = JSON.parse(await text(req) || '{}'); } catch (e) {}
      const t = rec.startTrip(false, b.name); res.json({ ...rec.summary(), points: [], log: t.log });
    }));
    router.post('/trip/end', wrap((req, res) => { const t = rec.endTrip(); res.json({ ok: true, id: t ? t.id : null }); }));

    router.get('/store/:n', wrap((req, res) => {
      const n = req.params.n; if (!store.has(n)) return res.status(404).json({ error: 'inconnu' });
      res.json(n === 'trips' ? tripsAll() : store.all(n));
    }));
    router.get('/store/:n/:id', wrap((req, res) => {
      const n = req.params.n; if (!store.has(n)) return res.status(404).json({ error: 'inconnu' });
      const o = n === 'trips' && rec.cur && String(rec.cur.id) === req.params.id ? rec.cur : store.get(n, req.params.id);
      o ? res.json(o) : res.status(404).json({ error: 'absent' });
    }));
    router.put('/store/:n/:id', wrap(async (req, res) => {
      const n = req.params.n; if (!store.has(n)) return res.status(404).json({ error: 'inconnu' });
      const o = JSON.parse(await text(req)); o.id = o.id != null ? o.id : req.params.id;
      if (n === 'trips') {
        const seen = +req.query.seen || 0;
        if (rec.cur && String(rec.cur.id) === String(o.id)) {
          if (o.open === false) rec.closeFromClient(o, seen); else rec.mergeOpen(o, seen);
          return res.json({ ok: true, merged: true });
        }
        if (o.open) {
          if (!rec.cur) { rec.adopt(o); return res.json({ ok: true, adopted: true }); }
          o.open = false; o.end = o.end || (o.points && o.points.length ? o.points[o.points.length - 1].t : o.start);   // un autre trajet est déjà ouvert sur le Pi
        }
      }
      store.put(n, o); res.json({ ok: true });
    }));
    router.delete('/store/:n/:id', wrap((req, res) => {
      const n = req.params.n; if (!store.has(n)) return res.status(404).json({ error: 'inconnu' });
      if (n === 'trips' && rec.cur && String(rec.cur.id) === req.params.id) { rec.cur.points = []; rec.endTrip(); }
      store.del(n, req.params.id); res.json({ ok: true });
    }));
    router.put('/blob/:id', wrap(async (req, res) => { const b = await readBody(req); store.putBlob(req.params.id, Buffer.isBuffer(b) ? b : Buffer.from(b)); res.json({ ok: true }); }));
    router.get('/blob/:id', wrap((req, res) => {
      const b = store.getBlob(req.params.id); if (!b) return res.status(404).json({ error: 'absent' });
      res.set('Content-Type', 'application/octet-stream'); res.send(b);
    }));

    router.get('/status', wrap((req, res) => res.json({ open: rec.summary(), data: col.fullData(), trips: store.all('trips').length, notes: store.all('notes').length })));
    router.get('/backup', wrap((req, res) => {
      const photos = store.all('photos').map(p => ({ ...p, blob64: (store.getBlob(p.id) || Buffer.alloc(0)).toString('base64') }));
      res.set('Content-Disposition', 'attachment; filename="carnet-sauvegarde-pi.json"');
      res.json({ v: 3, from: 'pi', trips: tripsAll(), notes: store.all('notes'), photos, audit: store.all('audit'), kv: store.kvAll() });
    }));
  };
  return plugin;
};
