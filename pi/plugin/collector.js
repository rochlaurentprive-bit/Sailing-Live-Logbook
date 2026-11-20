'use strict';
/* Collecteur : reprend, côté serveur, le même traitement des données Signal K que l'appli
   (conversions SI → unités marines, fraîcheur 15 s, vent vrai recalculé), pour que les entrées
   de journal écrites par le Pi soient identiques à celles écrites par l'appli. */
const R2D = 180 / Math.PI, D2R = Math.PI / 180, MS2KN = 1.9438444924;
const FRESH_MS = 15000;

class Collector {
  constructor(now) {
    this.now = now || Date.now;
    this.D = { bats: {}, tanks: {} };
    this.T = {};
  }
  fresh(k) { return this.T[k] && this.now() - this.T[k] < FRESH_MS; }
  set(k, v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return;
    this.D[k] = v; this.T[k] = this.now(); if (k === 'tws' || k === 'twa') this.calc = false;
  }
  ingest(path, v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return;
    const set = this.set.bind(this), D = this.D;
    const cdeg = x => ((x * R2D) % 360 + 360) % 360;
    const sdeg = x => { let d = x * R2D; if (d > 180) d -= 360; return d; };
    switch (path) {
      case 'navigation.position':
        if (v && typeof v === 'object') { set('lat', v.latitude); set('lon', v.longitude); }
        return;
      case 'navigation.speedOverGround': return set('sog', v * MS2KN);
      case 'navigation.speedThroughWater': return set('stw', v * MS2KN);
      case 'navigation.courseOverGroundTrue': return set('cog', cdeg(v));
      case 'navigation.headingTrue': case 'navigation.headingMagnetic': return set('hdg', cdeg(v));
      case 'environment.wind.speedApparent': return set('aws', v * MS2KN);
      case 'environment.wind.angleApparent': return set('awa', sdeg(v));
      case 'environment.wind.speedTrue': return set('tws', v * MS2KN);
      case 'environment.wind.angleTrueWater': case 'environment.wind.angleTrueGround': return set('twa', sdeg(v));
      case 'environment.depth.belowTransducer': case 'environment.depth.belowKeel': case 'environment.depth.belowSurface': return set('depth', v);
      case 'environment.water.temperature': return set('wTemp', v - 273.15);
      case 'environment.outside.temperature': return set('airT', v - 273.15);
      case 'environment.outside.pressure': return set('baro', v / 100);
      case 'navigation.attitude':
        set('roll', sdeg(v.roll || 0)); set('pitch', sdeg(v.pitch || 0)); return;
      case 'steering.rudderAngle': return set('rudder', sdeg(v));
    }
    let m;
    if ((m = path.match(/^propulsion\.([^.]+)\.revolutions$/))) set('rpm', v * 60);
    else if ((m = path.match(/^propulsion\.([^.]+)\.(temperature|coolantTemperature)$/))) set('engT', v - 273.15);
    else if ((m = path.match(/^propulsion\.([^.]+)\.oilPressure$/))) set('oilP', v / 100000);
    else if ((m = path.match(/^propulsion\.([^.]+)\.runTime$/))) set('engHours', v / 3600);
    else if ((m = path.match(/^propulsion\.([^.]+)\.fuel\.rate$/))) set('fuelRate', v * 3.6e6);
    else if ((m = path.match(/^tanks\.([^.]+)\.([^.]+)\.currentLevel$/))) D.tanks[m[1] + '.' + m[2]] = { type: m[1], lvl: v * 100, t: this.now() };
    else if ((m = path.match(/^electrical\.batteries\.([^.]+)\.voltage$/))) { (D.bats[m[1]] = D.bats[m[1]] || {}).v = v; D.bats[m[1]].t = this.now(); }
    else if ((m = path.match(/^electrical\.batteries\.([^.]+)\.capacity\.stateOfCharge$/))) { (D.bats[m[1]] = D.bats[m[1]] || {}).soc = v * 100; D.bats[m[1]].t = this.now(); }
  }
  computeTrueWind() {
    const D = this.D, f = k => this.fresh(k);
    if (f('tws') && f('twa') && !this.calc) return;
    if (!f('aws') || !f('awa')) return;
    const v = f('stw') ? D.stw : (f('sog') ? D.sog : 0);
    const ax = D.aws * Math.cos(D.awa * D2R), ay = D.aws * Math.sin(D.awa * D2R);
    const tx = ax - v, ty = ay;
    D.tws = Math.hypot(tx, ty); D.twa = Math.atan2(ty, tx) * R2D; this.T.tws = this.T.twa = this.now(); this.calc = true;
  }
  snapshot() {
    const D = this.D, f = k => this.fresh(k) ? D[k] : null, b0 = Object.values(D.bats)[0];
    return { t: this.now(), lat: D.lat, lon: D.lon, sog: D.sog, cog: D.cog, tws: f('tws'), twa: f('twa'),
      aws: f('aws'), awa: f('awa'), depth: f('depth'), rpm: f('rpm'), engT: f('engT'),
      bat: b0 && b0.v != null ? b0.v : null, stw: f('stw'), roll: f('roll') };
  }
  fullData() {
    const D = this.D, f = k => this.fresh(k) ? D[k] : null, now = this.now();
    return { lat: f('lat'), lon: f('lon'), cog: f('cog'), hdg: f('hdg'), sog: f('sog'), stw: f('stw'), tws: f('tws'), twa: f('twa'),
      aws: f('aws'), awa: f('awa'), depth: f('depth'), wTemp: f('wTemp'), airT: f('airT'), baro: f('baro'), roll: f('roll'),
      pitch: f('pitch'), rpm: f('rpm'), engT: f('engT'), oilP: f('oilP'), fuelRate: f('fuelRate'), engHours: f('engHours'), rudder: f('rudder'),
      bats: Object.entries(D.bats).filter(([, b]) => now - b.t < 15000).map(([n, b]) => ({ n, v: b.v ?? null, soc: b.soc ?? null })),
      tanks: Object.values(D.tanks).filter(k => now - k.t < 60000).map(k => ({ type: k.type, lvl: k.lvl })) };
  }
}
module.exports = { Collector };
