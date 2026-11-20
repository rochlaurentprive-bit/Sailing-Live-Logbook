'use strict';
/* Lecture SEULE d'InfluxDB (1.x en InfluxQL, 2.x en Flux) et reconstruction de trajets à partir de l'historique
   écrit par Signal K. Rien n'est jamais écrit ni supprimé dans InfluxDB. */
const { Collector } = require('./collector');
const http = require('http'), https = require('https');
const DAY = 86400000;

function request(method, urlStr, headers, body) {
  return new Promise((ok, ko) => {
    const u = new URL(urlStr), mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 30000 }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); res.statusCode >= 200 && res.statusCode < 300 ? ok(t) : ko(new Error('InfluxDB ' + res.statusCode + ' : ' + t.slice(0, 200))); });
    });
    req.on('timeout', () => req.destroy(new Error('InfluxDB : délai dépassé'))); req.on('error', ko);
    if (body) req.write(body); req.end();
  });
}
const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

class Influx {
  constructor(cfg) { this.c = cfg || {}; }
  get enabled() { return !!(this.c && this.c.enabled && this.c.url); }
  get v2() { return String(this.c.version) === '2'; }
  /* lignes {t (ms), v} ; plusieurs séries (sources) sont moyennées par instant */
  async series(measurement, field, from, to, stepS) {
    let rows = [];
    if (!this.v2) {
      const ql = `SELECT mean(${q(field)}) FROM ${q(measurement)} WHERE time >= ${from}ms AND time < ${to}ms GROUP BY time(${stepS}s) fill(none)`;
      const url = `${this.c.url.replace(/\/$/, '')}/query?db=${encodeURIComponent(this.c.database || '')}&epoch=ms&q=${encodeURIComponent(ql)}`;
      const h = this.c.username ? { Authorization: 'Basic ' + Buffer.from(this.c.username + ':' + (this.c.password || '')).toString('base64') } : {};
      const j = JSON.parse(await request('GET', url, h));
      const err = j.error || (j.results && j.results[0] && j.results[0].error); if (err) throw new Error('InfluxDB : ' + err);
      for (const r of (j.results || [])) for (const s of (r.series || [])) for (const [t, v] of (s.values || [])) if (v != null) rows.push({ t, v });
    } else {
      const flux = `from(bucket: ${q(this.c.bucket)}) |> range(start: ${new Date(from).toISOString()}, stop: ${new Date(to).toISOString()}) |> filter(fn: (r) => r._measurement == ${q(measurement)} and r._field == ${q(field)}) |> aggregateWindow(every: ${stepS}s, fn: mean, createEmpty: false)`;
      const csv = await request('POST', `${this.c.url.replace(/\/$/, '')}/api/v2/query?org=${encodeURIComponent(this.c.org || '')}`, { Authorization: 'Token ' + (this.c.token || ''), 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' }, flux);
      rows = parseCsv(csv);
    }
    const m = new Map();
    for (const r of rows) { const a = m.get(r.t) || { s: 0, n: 0 }; a.s += r.v; a.n++; m.set(r.t, a); }
    return [...m.entries()].map(([t, a]) => ({ t, v: a.s / a.n })).sort((a, b) => a.t - b.t);
  }
  async measurements() {
    if (!this.v2) {
      const url = `${this.c.url.replace(/\/$/, '')}/query?db=${encodeURIComponent(this.c.database || '')}&q=${encodeURIComponent('SHOW MEASUREMENTS')}`;
      const h = this.c.username ? { Authorization: 'Basic ' + Buffer.from(this.c.username + ':' + (this.c.password || '')).toString('base64') } : {};
      const j = JSON.parse(await request('GET', url, h)), out = [];
      for (const r of (j.results || [])) for (const s of (r.series || [])) for (const v of (s.values || [])) out.push(v[0]);
      return out;
    }
    const flux = `import "influxdata/influxdb/schema"\nschema.measurements(bucket: ${q(this.c.bucket)})`;
    const csv = await request('POST', `${this.c.url.replace(/\/$/, '')}/api/v2/query?org=${encodeURIComponent(this.c.org || '')}`, { Authorization: 'Token ' + (this.c.token || ''), 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' }, flux);
    return parseCsvCol(csv, '_value');
  }
}
function csvRows(csv) {
  const out = []; let head = null;
  for (const line of csv.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split(',');
    if (c.includes('_time') || c.includes('_value')) { head = c; continue; }
    if (head) out.push(Object.fromEntries(head.map((h, i) => [h, c[i]])));
  }
  return out;
}
function parseCsv(csv) { return csvRows(csv).map(r => ({ t: Date.parse(r._time), v: parseFloat(r._value) })).filter(r => !isNaN(r.t) && !isNaN(r.v)); }
function parseCsvCol(csv, col) { return csvRows(csv).map(r => r[col]).filter(Boolean); }

/* Séries utilisées : clé interne → chemin Signal K (champ « value » ; la position a deux champs ou deux mesures) */
const FIXED = { sog: 'navigation.speedOverGround', cog: 'navigation.courseOverGroundTrue', stw: 'navigation.speedThroughWater', hdg: 'navigation.headingTrue',
  aws: 'environment.wind.speedApparent', awa: 'environment.wind.angleApparent', tws: 'environment.wind.speedTrue', twa: 'environment.wind.angleTrueWater',
  depth: 'environment.depth.belowTransducer' };
const PATTERN = { rpm: /^propulsion\.[^.]+\.revolutions$/, engT: /^propulsion\.[^.]+\.(temperature|coolantTemperature)$/, bat: /^electrical\.batteries\.[^.]+\.voltage$/ };
const DEFAULT_OPTS = { startKn: 1.5, startSec: 30, stopKn: 0.5, stopMin: 5, logMin: 15, step: 10, lang: 'fr-FR', maxGapMin: 5 };

async function loadWindow(inf, names, from, to, step) {
  const have = new Set(names), S = {};
  const get = async (key, meas, field) => { if (!have.has(meas)) return; try { S[key] = await inf.series(meas, field, from, to, step); } catch (e) { S[key + '_err'] = e.message; } };
  for (const [k, m] of Object.entries(FIXED)) await get(k, m, 'value');
  for (const [k, re] of Object.entries(PATTERN)) { const m = names.find(n => re.test(n)); if (m) await get(k, m, 'value'); }
  // position : deux champs d'une mesure, ou deux mesures séparées
  if (have.has('navigation.position')) {
    try { S.lat = await inf.series('navigation.position', inf.c.latField || 'lat', from, to, step); S.lon = await inf.series('navigation.position', inf.c.lonField || 'lon', from, to, step); } catch (e) { S.pos_err = e.message; }
    if (!S.lat || !S.lat.length) { try { S.lat = await inf.series('navigation.position', 'latitude', from, to, step); S.lon = await inf.series('navigation.position', 'longitude', from, to, step); } catch (e) {} }
  }
  if ((!S.lat || !S.lat.length) && have.has('navigation.position.latitude')) { S.lat = await inf.series('navigation.position.latitude', 'value', from, to, step); S.lon = await inf.series('navigation.position.longitude', 'value', from, to, step); }
  return S;
}
/* fusionne les séries sur une grille de pas fixe */
function grid(S, from, to, stepMs) {
  const maps = {}; for (const [k, rows] of Object.entries(S)) if (Array.isArray(rows)) { const m = new Map(); for (const r of rows) m.set(Math.round(r.t / stepMs) * stepMs, r.v); maps[k] = m; }
  const ts = new Set(); for (const m of Object.values(maps)) for (const t of m.keys()) ts.add(t);
  return [...ts].sort((a, b) => a - b).map(t => { const o = { t }; for (const k in maps) if (maps[k].has(t)) o[k] = maps[k].get(t); return o; });
}

/* Reconstruit les trajets : mêmes règles que l'enregistreur (départ, arrêt, entrées automatiques). */
function buildTrips(samples, opts) {
  const o = { ...DEFAULT_OPTS, ...opts }, KN = 1.9438444924, trips = []; let clock = 0;
  const col = new Collector(() => clock);
  let cur = null, mv = 0, idle = 0, lastT = 0, lastLog = 0, pending = [];
  const feed = s => {
    clock = s.t;
    if (s.lat != null && s.lon != null) col.ingest('navigation.position', { latitude: s.lat, longitude: s.lon });
    const m = { sog: 'navigation.speedOverGround', cog: 'navigation.courseOverGroundTrue', stw: 'navigation.speedThroughWater', hdg: 'navigation.headingTrue', aws: 'environment.wind.speedApparent', awa: 'environment.wind.angleApparent', tws: 'environment.wind.speedTrue', twa: 'environment.wind.angleTrueWater', depth: 'environment.depth.belowTransducer', rpm: 'propulsion.main.revolutions', engT: 'propulsion.main.temperature', bat: 'electrical.batteries.house.voltage' };
    for (const k in m) if (s[k] != null) col.ingest(m[k], s[k]);
  };
  const mkEntry = (t, kind) => { const d = col.fullData(), e = { id: 'i' + t.toString(36) + kind[0], t, kind, note: '', d, edited: false }; e.orig = JSON.parse(JSON.stringify({ t, note: '', d })); return e; };
  const close = (t, why) => {
    if (!cur) return; cur.log.push(mkEntry(t, 'end')); cur.open = false; cur.end = t;
    if (cur.points.length >= 2) trips.push(cur); cur = null; mv = 0; idle = 0;
  };
  for (const s of samples) {
    if (cur && lastT && s.t - lastT > o.maxGapMin * 60000) close(lastT, 'trou');
    feed(s); lastT = s.t;
    const hasPos = s.lat != null && s.lon != null, sog = s.sog != null ? s.sog * KN : 0;
    if (!hasPos) continue;
    if (!cur) {
      if (sog >= o.startKn) { mv += o.step; if (mv >= o.startSec) {
        cur = { id: 'inf' + s.t.toString(36), name: 'Navigation du ' + new Date(s.t).toLocaleDateString(o.lang) + ' (historique)', auto: true, open: true, start: s.t, end: null, crew: '', points: [], log: [], demo: false, imported: 'influx' };
        cur.log.push(mkEntry(s.t, 'start')); lastLog = s.t; idle = 0; } } else mv = 0;
    }
    if (cur) {
      cur.points.push(col.snapshot());
      if (s.t - lastLog >= o.logMin * 60000) { cur.log.push(mkEntry(s.t, 'auto')); lastLog = s.t; }
      if (sog < o.stopKn) { idle += o.step; if (idle >= o.stopMin * 60) close(s.t, 'arrêt'); } else idle = 0;
    }
  }
  if (cur) close(lastT, 'fin des données');
  return trips;
}
const NM = (a, b) => { const R = 3440.065, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lon - a.lon) * r, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
function dist(t) { let d = 0; for (let i = 1; i < t.points.length; i++) d += NM(t.points[i - 1], t.points[i]); return d; }

async function importTrips(inf, store, from, to, opts) {
  if (!inf.enabled) throw new Error('InfluxDB non configuré dans le plugin');
  if (!(to > from)) throw new Error('période invalide');
  if (to - from > 62 * DAY) throw new Error('période trop longue : 62 jours au maximum par import');
  const o = { ...DEFAULT_OPTS, ...opts }, names = await inf.measurements();
  let samples = [], errors = [];
  for (let t = from; t < to; t += DAY) {
    const S = await loadWindow(inf, names, t, Math.min(to, t + DAY), o.step);
    for (const k of Object.keys(S)) if (k.endsWith('_err')) errors.push(S[k]);
    samples = samples.concat(grid(S, t, Math.min(to, t + DAY), o.step * 1000));
  }
  if (!samples.some(s => s.lat != null)) return { created: [], skipped: [], samples: samples.length, errors, note: 'aucune position trouvée dans InfluxDB sur cette période' };
  const trips = buildTrips(samples, o), existing = store.all('trips'), created = [], skipped = [];
  for (const t of trips) {
    const clash = existing.find(e => e.start <= t.end && (e.end || Date.now()) >= t.start);
    const info = { id: t.id, name: t.name, start: t.start, end: t.end, points: t.points.length, nm: Math.round(dist(t) * 10) / 10 };
    if (clash) { skipped.push({ ...info, why: 'un trajet existe déjà sur cette période' }); continue; }
    store.put('trips', t); created.push(info);
  }
  return { created, skipped, samples: samples.length, errors };
}
module.exports = { Influx, importTrips, buildTrips, grid, parseCsv, DEFAULT_OPTS };
