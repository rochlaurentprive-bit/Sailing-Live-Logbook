'use strict';
const path = require('path');
const { Collector } = require('./collector');
const { Store } = require('./store');
const { Recorder, DEFAULTS } = require('./recorder');
const { Influx, importTrips } = require('./influx');
const { Mirror } = require('./mirror');
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
  const plugin = { id: 'carnet-de-bord', name: 'Carnet de bord' };
  let col = null, rec = null, store = null, mirror = null, timer = null, unsub = [], opts = {};
  const dbg = m => { try { app.debug(m); } catch (e) {} };

  plugin.description = 'Journal de bord partagé entre tous les appareils : live lu sur Signal K, historique lu dans InfluxDB, notes et journal copiés dans un bucket InfluxDB dédié.';
  plugin.schema = {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enregistrement automatique des trajets par le Pi (inutile si Signal K écrit déjà dans InfluxDB)', default: false },
      startKn: { type: 'number', title: 'Démarrage : vitesse fond (nœuds)', default: DEFAULTS.startKn },
      startSec: { type: 'number', title: 'Démarrage : durée au-dessus du seuil (s)', default: DEFAULTS.startSec },
      stopKn: { type: 'number', title: 'Arrêt : vitesse fond sous (nœuds)', default: DEFAULTS.stopKn },
      stopMin: { type: 'number', title: 'Arrêt : durée d’immobilité (min)', default: DEFAULTS.stopMin },
      interval: { type: 'number', title: 'Point de trace toutes les (s)', default: DEFAULTS.interval },
      logMin: { type: 'number', title: 'Entrée de journal automatique toutes les (min)', default: DEFAULTS.logMin },
      lang: { type: 'string', title: 'Langue du nom des trajets (fr-FR, en-GB…)', default: DEFAULTS.lang },
      influx: {
        type: 'object', title: 'InfluxDB (historique en lecture seule ; notes et journal dans un bucket dédié)',
        properties: {
          enabled: { type: 'boolean', title: 'Activer la lecture de l’historique', default: false },
          version: { type: 'string', title: 'Version d’InfluxDB', enum: ['1', '2'], default: '1' },
          url: { type: 'string', title: 'Adresse (ex. http://localhost:8086)', default: 'http://localhost:8086' },
          database: { type: 'string', title: 'Base (InfluxDB 1.x)' },
          username: { type: 'string', title: 'Utilisateur (1.x, facultatif)' },
          password: { type: 'string', title: 'Mot de passe (1.x, facultatif)' },
          org: { type: 'string', title: 'Organisation (InfluxDB 2.x)' },
          bucket: { type: 'string', title: 'Bucket (InfluxDB 2.x)' },
          token: { type: 'string', title: 'Jeton en lecture (InfluxDB 2.x)' },
          mirror: { type: 'boolean', title: 'Copier notes, journal et réglages dans InfluxDB 2.x (bucket dédié)', default: true },
          carnetBucket: { type: 'string', title: 'Bucket du carnet (distinct de celui de Signal K)', default: 'carnet' },
          carnetToken: { type: 'string', title: 'Jeton avec droit d’écriture sur ce bucket seulement' },
          latField: { type: 'string', title: 'Champ latitude de navigation.position', default: 'lat' },
          lonField: { type: 'string', title: 'Champ longitude de navigation.position', default: 'lon' }
        }
      }
    }
  };

  plugin.start = function (options) {
    options = options || {}; opts = options;
    const dir = app.getDataDirPath();
    store = new Store(path.join(dir, 'data'));
    mirror = new Mirror(options.influx, dbg);
    const empty = !['trips', 'notes', 'photos', 'audit'].some(n => store.all(n).length) && !Object.keys(store.kvAll()).length;
    const sp = store.put.bind(store), sd = store.del.bind(store), ks = store.kvSet.bind(store), kd = store.kvDel.bind(store);
    store.put = (n, o) => { sp(n, o); mirror.put(n, o.id, o); };
    store.del = (n, id) => { sd(n, id); mirror.del(n, id); };
    store.kvSet = (k, v) => { ks(k, v); mirror.put('kv', k, { v: String(v) }); };
    store.kvDel = k => { kd(k); mirror.del('kv', k); };
    if (empty && mirror.enabled) mirror.restore().then(docs => {   // Pi neuf : le carnet est reconstruit depuis InfluxDB
      for (const d of docs) { if (d.kind === 'kv') ks(d.id, d.doc.v); else if (store.has(d.kind)) sp(d.kind, d.doc); }
      if (docs.length) dbg('carnet restauré depuis InfluxDB : ' + docs.length + ' éléments');
    }).catch(e => dbg('restauration InfluxDB : ' + e.message));
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
        if (options.enabled === true) rec.tick();
        app.setPluginStatus && app.setPluginStatus(rec.cur ? 'Trajet en cours : ' + rec.cur.points.length + ' points' : 'En veille');
      } catch (e) { app.error && app.error('tick : ' + e.message); }
    }, 1000);
  };
  plugin.stop = function () {
    clearInterval(timer); timer = null; if (mirror) mirror.flush();
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

    const influx = () => new Influx(opts.influx);
    router.get('/influx/status', wrap((req, res) => res.json({ enabled: influx().enabled, version: (opts.influx || {}).version || '1' })));
    router.get('/influx/probe', wrap(async (req, res) => {
      const i = influx(); if (!i.enabled) return res.json({ enabled: false });
      try { const m = await i.measurements(); res.json({ enabled: true, ok: true, measurements: m.length, navigation: m.filter(x => /^navigation\./.test(x)).slice(0, 40), sample: m.slice(0, 15) }); }
      catch (e) { res.json({ enabled: true, ok: false, error: e.message }); }
    }));
    router.get('/influx/mirror', wrap((req, res) => res.json(mirror.status())));
    router.post('/influx/import', wrap(async (req, res) => {
      let b = {}; try { b = JSON.parse(await text(req) || '{}'); } catch (e) {}
      try { res.json({ ok: true, ...(await importTrips(influx(), store, +b.from, +b.to, { ...DEFAULTS, ...opts })) }); }
      catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
