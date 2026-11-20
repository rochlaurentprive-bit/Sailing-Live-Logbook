'use strict';
/* Miroir InfluxDB 2.x du carnet : notes, journal, trajets, réglages… écrits dans un bucket DÉDIÉ (« carnet »),
   jamais dans celui de Signal K. Les fichiers du Pi restent le cache local ; InfluxDB sert de copie durable
   et permet de reconstruire le carnet sur un Pi neuf. Une écriture qui échoue est remise en file d'attente. */
const http = require('http'), https = require('https');
const MAX_DOC = 900 * 1024;

function req(method, urlStr, headers, body) {
  return new Promise((ok, ko) => {
    const u = new URL(urlStr), mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(u, { method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 30000 }, res => {
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); res.statusCode >= 200 && res.statusCode < 300 ? ok(t) : ko(new Error('InfluxDB ' + res.statusCode + ' : ' + t.slice(0, 160))); });
    });
    r.on('timeout', () => r.destroy(new Error('InfluxDB : délai dépassé'))); r.on('error', ko);
    if (body) r.write(body); r.end();
  });
}
const tagEsc = s => String(s).replace(/[,= \\]/g, c => '\\' + c).replace(/\n/g, '_');
const strEsc = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function csv(text) {                      // CSV RFC 4180 (guillemets, virgules et retours à la ligne dans les valeurs)
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

class Mirror {
  constructor(cfg, log, now) {
    this.c = cfg || {}; this.log = log || (() => {}); this.now = now || Date.now;
    this.q = new Map(); this.timer = null; this.err = null; this.sent = 0;
  }
  get enabled() { return !!(this.c.enabled && this.c.mirror !== false && String(this.c.version) === '2' && this.c.url && this.c.org); }
  get bucket() { return this.c.carnetBucket || 'carnet'; }
  get token() { return this.c.carnetToken || this.c.token || ''; }
  base() { return this.c.url.replace(/\/$/, ''); }
  line(kind, id, json, t) { return 'carnet_doc,kind=' + tagEsc(kind) + ',id=' + tagEsc(id) + ' json=' + strEsc(json) + ' ' + t; }
  put(kind, id, obj) {
    if (!this.enabled) return;
    let json = JSON.stringify(obj);
    if (json.length > MAX_DOC && obj && Array.isArray(obj.points)) json = JSON.stringify({ ...obj, points: [], pointsDropped: obj.points.length });
    this.enqueue(kind, id, json);
  }
  del(kind, id) { if (this.enabled) this.enqueue(kind, id, '{"_del":1}'); }
  enqueue(kind, id, json) {
    this.q.set(kind + '\u0000' + id, this.line(kind, id, json, this.now()));   // dernière version seulement
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500); this.timer.unref && this.timer.unref(); }
  }
  async flush() {
    if (!this.q.size) return;
    const batch = [...this.q.entries()]; this.q.clear();
    try {
      await req('POST', `${this.base()}/api/v2/write?org=${encodeURIComponent(this.c.org)}&bucket=${encodeURIComponent(this.bucket)}&precision=ms`,
        { Authorization: 'Token ' + this.token, 'Content-Type': 'text/plain; charset=utf-8' }, batch.map(b => b[1]).join('\n'));
      this.sent += batch.length; this.err = null;
    } catch (e) {
      this.err = e.message; this.log('miroir InfluxDB : ' + e.message);
      for (const [k, v] of batch) if (!this.q.has(k)) this.q.set(k, v);
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 30000); this.timer.unref && this.timer.unref(); }   // nouvel essai dans 30 s
    }
  }
  status() { return { enabled: this.enabled, bucket: this.bucket, pending: this.q.size, sent: this.sent, error: this.err }; }
  /* dernière version de chaque document, tombstones écartés : [{kind,id,doc}] */
  async restore() {
    if (!this.enabled) return [];
    const flux = `from(bucket: "${this.bucket.replace(/"/g, '')}") |> range(start: -20y) |> filter(fn: (r) => r._measurement == "carnet_doc" and r._field == "json") |> group(columns: ["kind","id"]) |> last()`;
    const text = await req('POST', `${this.base()}/api/v2/query?org=${encodeURIComponent(this.c.org)}`,
      { Authorization: 'Token ' + this.token, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' }, flux);
    const out = []; let head = null;
    for (const r of csv(text)) {
      if (!r.length || (r.length === 1 && !r[0]) || (r[0] || '').startsWith('#')) continue;
      if (r.includes('_value')) { head = r; continue; }
      if (!head) continue;
      const o = Object.fromEntries(head.map((h, i) => [h, r[i]]));
      try { const doc = JSON.parse(o._value); if (o.kind && o.id != null && !doc._del) out.push({ kind: o.kind, id: o.id, doc }); } catch (e) {}
    }
    return out;
  }
}
module.exports = { Mirror, csv };
