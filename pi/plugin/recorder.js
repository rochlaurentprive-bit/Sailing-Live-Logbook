'use strict';
const fs = require('fs'), path = require('path');
const { writeAtomic } = require('./store');
const D2R = Math.PI / 180;
/* Enregistreur de trajets 24 h/24 : même logique que la boucle tick() de l'appli
   (démarrage sur vitesse, point de trace périodique, entrée automatique, arrêt après immobilité). */
const DEFAULTS = { startKn: 1.5, startSec: 30, stopKn: 0.5, stopMin: 5, interval: 10, logMin: 15, lang: 'fr-FR' };
const uid = now => now.toString(36) + Math.random().toString(36).slice(2, 6);

class Recorder {
  constructor(opts, col, store, dir, now, log) {
    this.o = { ...DEFAULTS, ...(opts || {}) }; this.col = col; this.store = store; this.dir = dir;
    this.now = now || Date.now; this.log = log || (() => {});
    this.cur = null; this.moveCnt = 0; this.idleCnt = 0; this.lastPt = 0; this.lastLog = 0; this.lastTick = 0;
    this.curFile = path.join(dir, 'current.json'); this.ptsFile = path.join(dir, 'current-points.ndjson');
    this.recover();
  }
  /* reprise : un trajet ouvert est repris si le dernier point date de moins de 15 min, sinon clos à ce moment */
  recover() {
    let meta; try { meta = JSON.parse(fs.readFileSync(this.curFile, 'utf8')); } catch (e) { return; }
    meta.points = [];
    try {
      for (const l of fs.readFileSync(this.ptsFile, 'utf8').split('\n')) { if (!l) continue; try { meta.points.push(JSON.parse(l)); } catch (e) {} }
    } catch (e) {}
    const last = meta.points.length ? meta.points[meta.points.length - 1].t : meta.start;
    if (this.now() - last < 15 * 60000) {
      this.cur = meta; this.lastPt = last;
      this.lastLog = (meta.log || []).reduce((m, e) => Math.max(m, e.t), meta.start);
      this.log('trajet repris : ' + meta.name);
    } else { meta.open = false; meta.end = last; this.finish(meta); }
  }
  finish(t) {
    if (t.points.length < 2) this.store.del('trips', t.id); else this.store.put('trips', t);
    try { fs.unlinkSync(this.curFile); } catch (e) {} try { fs.unlinkSync(this.ptsFile); } catch (e) {}
  }
  saveMeta() { const m = { ...this.cur, points: [] }; writeAtomic(this.curFile, JSON.stringify(m)); }
  summary() {
    const c = this.cur; if (!c) return null;
    return { id: c.id, name: c.name, auto: c.auto, start: c.start, crew: c.crew || '', nPoints: c.points.length, nLog: (c.log || []).length };
  }
  startTrip(auto, name) {
    if (this.cur) return this.cur;
    const t = this.now();
    this.cur = { id: uid(t), name: name || ('Navigation du ' + new Date(t).toLocaleDateString(this.o.lang)), auto: !!auto, open: true, start: t, end: null, crew: '', points: [], log: [], demo: false };
    this.lastPt = 0; this.idleCnt = 0; this.lastLog = 0;
    try { fs.unlinkSync(this.ptsFile); } catch (e) {}
    this.saveMeta(); this.addLog('start'); this.log('trajet démarré' + (auto ? ' (auto)' : ''));
    return this.cur;
  }
  endTrip() {
    if (!this.cur) return null;
    this.addLog('end');
    const t = this.cur; t.open = false; t.end = this.now(); this.cur = null;
    this.finish(t); this.log('trajet terminé : ' + t.points.length + ' points');
    return t;
  }
  addLog(kind, note) {
    if (!this.cur) return null;
    const t = this.now(), d = this.col.fullData();
    const e = { id: uid(t), t, kind, note: note || '', d, edited: false };
    e.orig = JSON.parse(JSON.stringify({ t: e.t, note: e.note, d: e.d }));
    (this.cur.log = this.cur.log || []).push(e); this.lastLog = t; this.saveMeta();
    return e;
  }
  /* appelé chaque seconde */
  tick() {
    const now = this.now(), c = this.col, o = this.o, D = c.D;
    const dt = this.lastTick ? Math.min(120, (now - this.lastTick) / 1000) : 1; this.lastTick = now;
    c.computeTrueWind();
    if (c.fresh('lat') && c.fresh('lon')) {
      const sog = c.fresh('sog') ? D.sog : 0;
      if (!this.cur) {
        if (sog >= o.startKn) { this.moveCnt += dt; if (this.moveCnt >= o.startSec) { this.startTrip(true); this.moveCnt = 0; } } else this.moveCnt = 0;
      } else {
        if (now - this.lastPt >= o.interval * 1000) {
          const p = c.snapshot(); this.cur.points.push(p); this.lastPt = now;
          try { fs.appendFileSync(this.ptsFile, JSON.stringify(p) + '\n'); } catch (e) { this.log('écriture trace : ' + e.message); }
        }
        if (sog < o.stopKn) { this.idleCnt += dt; if (this.idleCnt >= o.stopMin * 60 && this.cur.auto) this.endTrip(); } else this.idleCnt = 0;
      }
    }
    if (this.cur && now - this.lastLog >= o.logMin * 60000) this.addLog('auto');
  }
  /* fusion d'un trajet envoyé par un appareil : le serveur reste maître de la trace du trajet ouvert */
  mergeOpen(inc, seen) {
    const c = this.cur; if (!c || String(inc.id) !== String(c.id)) return false;
    const ids = new Set((inc.log || []).map(e => e.id)), keep = (c.log || []).filter(e => !ids.has(e.id) && e.t > (seen || 0));
    c.log = (inc.log || []).concat(keep).sort((a, b) => a.t - b.t);
    for (const k of ['name', 'crew']) if (inc[k] != null) c[k] = inc[k];
    this.saveMeta(); return true;
  }
  /* un appareil a démarré un trajet à la main : le Pi l'adopte et enregistre la trace à sa place */
  adopt(o) {
    if (this.cur) return false;
    this.cur = { ...o, points: [], open: true, end: null, demo: false, log: o.log || [] };
    this.lastPt = 0; this.idleCnt = 0; this.moveCnt = 0;
    this.lastLog = this.cur.log.reduce((m, e) => Math.max(m, e.t), this.cur.start);
    try { fs.unlinkSync(this.ptsFile); } catch (e) {}
    this.saveMeta(); this.log('trajet adopté : ' + this.cur.name);
    return true;
  }
  /* un appareil a terminé le trajet (il a déjà écrit son entrée « fin ») */
  closeFromClient(inc, seen) {
    if (!this.mergeOpen(inc, seen)) return false;
    const t = this.cur; t.open = false; t.end = inc.end || this.now(); this.cur = null;
    this.finish(t); this.log('trajet terminé depuis un appareil : ' + t.points.length + ' points');
    return true;
  }
  since(tp, tl) {
    const c = this.cur; if (!c) return null;
    return { ...this.summary(), points: c.points.filter(p => p.t > (tp || 0)), log: (c.log || []).filter(e => e.t > (tl || 0)) };
  }
}
module.exports = { Recorder, DEFAULTS };
