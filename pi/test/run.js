'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { Collector } = require('../plugin/collector'), { Store } = require('../plugin/store'), { Recorder } = require('../plugin/recorder');
const { start } = require('./harness');
let n = 0; const ok = m => { n++; console.log('  ✓ ' + m); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'carnet-t-'));
const KN = 1 / 1.9438444924;   // 1 nœud en m/s

(async () => {
  console.log('Collecteur');
  { let t = 1e12; const c = new Collector(() => t);
    c.ingest('navigation.position', { latitude: 47.5, longitude: -3.1 }); c.ingest('navigation.speedOverGround', 5 * KN);
    c.ingest('environment.wind.speedApparent', 10 * KN); c.ingest('environment.wind.angleApparent', Math.PI / 2);
    c.ingest('propulsion.main.revolutions', 25); c.ingest('electrical.batteries.house.voltage', 12.8);
    c.ingest('tanks.fuel.0.currentLevel', 0.4);
    assert(Math.abs(c.D.sog - 5) < 1e-6); assert.strictEqual(c.D.rpm, 1500); ok('conversions m/s → nœuds, tr/s → tr/min');
    c.computeTrueWind(); assert(Math.abs(c.D.tws - Math.hypot(5, 10)) < 1e-6); assert(Math.abs(c.D.twa - Math.atan2(10, -5) * 180 / Math.PI) < 1e-6); ok('vent vrai recalculé depuis le vent apparent');
    assert.strictEqual(c.fullData().bats[0].v, 12.8); assert.strictEqual(Math.round(c.fullData().tanks[0].lvl), 40); ok('batteries et réservoirs');
    t += 16000; assert.strictEqual(c.fullData().sog, null); ok('donnée de plus de 15 s non retenue (« périmée »)'); }

  console.log('Enregistreur');
  { const dir = tmp(); let t = Date.UTC(2026, 5, 1, 8, 0, 0); const col = new Collector(() => t), st = new Store(dir);
    const rec = new Recorder({}, col, st, dir, () => t);
    const feed = kn => { col.ingest('navigation.position', { latitude: 47.5, longitude: -3.1 }); col.ingest('navigation.speedOverGround', kn * KN); };
    const run = (s, kn) => { for (let i = 0; i < s; i++) { t += 1000; feed(kn); rec.tick(); } };
    run(20, 3); assert(!rec.cur); ok('pas de départ avant 30 s au-dessus de 1,5 nd');
    run(15, 3); assert(rec.cur && rec.cur.auto); assert.strictEqual(rec.cur.log[0].kind, 'start'); ok('départ automatique, entrée « start »');
    run(60, 3); assert(rec.cur.points.length >= 5 && rec.cur.points.length <= 8); ok('un point de trace toutes les 10 s (' + rec.cur.points.length + ' en ~75 s)');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'current-points.ndjson'), 'utf8').trim().split('\n').length, rec.cur.points.length); ok('trace écrite au fil de l’eau (journal ajouté, pas de réécriture complète)');
    run(15 * 60, 3); assert(rec.cur.log.some(e => e.kind === 'auto')); ok('entrée automatique toutes les 15 min');
    const e = rec.cur.log.find(e => e.kind === 'auto'); assert(e.orig && e.d && e.edited === false && e.d.sog > 2.9); ok('entrée identique au format de l’appli (instantané + copie d’origine)');
    // reprise après coupure
    const rec2 = new Recorder({}, new Collector(() => t), st, dir, () => t + 5 * 60000); assert(rec2.cur && rec2.cur.points.length === rec.cur.points.length); ok('reprise du trajet après un redémarrage de 5 min');
    const rec3 = new Recorder({}, new Collector(() => t), st, dir, () => t + 20 * 60000); assert(!rec3.cur && st.all('trips').length === 1); ok('au-delà de 15 min : trajet clos à son dernier point et conservé');
    st.del('trips', st.all('trips')[0].id);
    // arrêt après immobilité
    const dir2 = tmp(), st2 = new Store(dir2), col2 = new Collector(() => t), r2 = new Recorder({}, col2, st2, dir2, () => t);
    const f2 = kn => { col2.ingest('navigation.position', { latitude: 47.5, longitude: -3.1 }); col2.ingest('navigation.speedOverGround', kn * KN); };
    for (let i = 0; i < 120; i++) { t += 1000; f2(4); r2.tick(); } assert(r2.cur);
    for (let i = 0; i < 4 * 60; i++) { t += 1000; f2(0); r2.tick(); } assert(r2.cur); ok('toujours ouvert après 4 min d’arrêt');
    for (let i = 0; i < 90; i++) { t += 1000; f2(0); r2.tick(); } assert(!r2.cur && st2.all('trips').length === 1);
    const tr = st2.all('trips')[0]; assert.strictEqual(tr.log[tr.log.length - 1].kind, 'end'); assert(tr.open === false && tr.end); ok('arrêt automatique après 5 min sous 0,5 nd, entrée « end »'); }

  console.log('API (plugin complet, serveur de test)');
  { const S = await start(); const api = (m, p, b, ct) => fetch(S.url + '/plugins/carnet-de-bord' + p, { method: m, body: b == null ? undefined : (typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)), headers: b != null ? { 'Content-Type': ct || 'text/plain' } : {} }).then(async r => ({ s: r.status, j: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.arrayBuffer() }));
    let r = await api('GET', '/ping'); assert(r.j.ok && r.j.app === 'carnet-de-bord'); ok('ping');
    await api('PUT', '/kv/wp', '[{"lat":1,"lon":2}]'); r = await api('GET', '/kv'); assert.strictEqual(r.j.wp, '[{"lat":1,"lon":2}]'); ok('réglages partagés (clé/valeur)');
    const trip = { id: 'abc1', name: 'Manuel', auto: false, open: true, start: Date.now() - 5000, end: null, crew: '', points: [], log: [{ id: 'e1', t: Date.now() - 4000, kind: 'start', note: '', d: {}, edited: false }] };
    r = await api('PUT', '/store/trips/abc1?seen=0', trip); assert(r.j.adopted); r = await api('GET', '/trip/open'); assert.strictEqual(r.j.id, 'abc1'); ok('trajet démarré sur un appareil : adopté par le Pi');
    S.delta('navigation.position', { latitude: 47, longitude: -3 }); S.delta('navigation.speedOverGround', 3 * KN);
    await new Promise(r => setTimeout(r, 12500)); r = await api('GET', '/trip/open?tp=0&tl=0'); assert(r.j.points.length >= 1); ok('le Pi enregistre la trace depuis Signal K (' + r.j.points.length + ' point)');
    const seen = Date.now();
    const mob = { ...trip, log: [...trip.log, { id: 'e2', t: Date.now(), kind: 'mob', note: 'MOB', d: {}, edited: false, orig: {} }], points: [] };
    r = await api('PUT', '/store/trips/abc1?seen=' + seen, mob); assert(r.j.merged); r = await api('GET', '/store/trips/abc1'); assert(r.j.log.some(e => e.id === 'e2') && r.j.points.length >= 1); ok('entrée MOB envoyée par un appareil fusionnée, trace du Pi intacte');
    r = await api('PUT', '/store/trips/abc1?seen=' + Date.now(), { ...r.j, open: false, end: Date.now(), log: r.j.log.concat([{ id: 'e3', t: Date.now(), kind: 'end', note: '', d: {}, edited: false }]) });
    r = await api('GET', '/trip/open'); assert.strictEqual(r.j.id, null); r = await api('GET', '/store/trips'); assert(r.j.length === 1 && r.j[0].open === false && r.j[0].points.length >= 1); ok('fin de trajet depuis un appareil : clos et rangé');
    await api('PUT', '/store/notes/n1', { id: 'n1', t: 1, type: 'note', text: 'Bonjour' }); r = await api('GET', '/store/notes'); assert.strictEqual(r.j[0].text, 'Bonjour'); ok('notes');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); await api('PUT', '/blob/p1', jpg, 'application/octet-stream'); r = await api('GET', '/blob/p1'); assert.deepStrictEqual(Buffer.from(r.j), jpg); ok('photos (fichier binaire)');
    r = await api('GET', '/backup'); assert(r.j.trips.length === 1 && r.j.notes.length === 1 && r.j.kv.wp); ok('sauvegarde complète en un fichier');
    r = await api('GET', '/store/secret'); assert.strictEqual(r.s, 404); ok('collection inconnue refusée');
    r = await api('PUT', '/store/..%2Fx/id', '{}'); assert.strictEqual(r.s, 404); ok('chemin hors dossier refusé');
    S.stop(); }
  console.log('\n' + n + ' vérifications réussies');
})().catch(e => { console.error('ÉCHEC :', e); process.exit(1); });
