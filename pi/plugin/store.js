'use strict';
const fs = require('fs'), path = require('path');
/* Stockage fichiers : un JSON par objet (trajets, notes, audit, photos). Écriture atomique
   (fichier temporaire puis renommage) : une coupure de courant ne laisse jamais un fichier tronqué. */
const NAMES = ['trips', 'notes', 'photos', 'audit'];
const safe = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dir) {
    this.dir = dir; this.mem = {};
    fs.mkdirSync(dir, { recursive: true });
    for (const n of NAMES) { fs.mkdirSync(path.join(dir, n), { recursive: true }); this.mem[n] = new Map(); }
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'kv'), { recursive: true });
    for (const n of NAMES) {
      for (const f of fs.readdirSync(path.join(dir, n))) {
        if (!f.endsWith('.json')) continue;
        try { const o = JSON.parse(fs.readFileSync(path.join(dir, n, f), 'utf8')); if (o && o.id != null) this.mem[n].set(String(o.id), o); }
        catch (e) { /* fichier abîmé : ignoré, jamais effacé */ }
      }
    }
  }
  has(n) { return NAMES.includes(n); }
  all(n) { return [...this.mem[n].values()]; }
  get(n, id) { return this.mem[n].get(String(id)) || null; }
  put(n, o) {
    this.mem[n].set(String(o.id), o);
    writeAtomic(path.join(this.dir, n, safe(o.id) + '.json'), JSON.stringify(o));
  }
  del(n, id) {
    this.mem[n].delete(String(id));
    try { fs.unlinkSync(path.join(this.dir, n, safe(id) + '.json')); } catch (e) {}
    if (n === 'photos') { try { fs.unlinkSync(path.join(this.dir, 'blobs', safe(id) + '.bin')); } catch (e) {} }
  }
  putBlob(id, buf) { writeAtomic(path.join(this.dir, 'blobs', safe(id) + '.bin'), buf); }
  getBlob(id) { try { return fs.readFileSync(path.join(this.dir, 'blobs', safe(id) + '.bin')); } catch (e) { return null; } }
  kvAll() {
    const o = {};
    for (const f of fs.readdirSync(path.join(this.dir, 'kv'))) {
      if (!f.endsWith('.txt')) continue;
      o[decodeURIComponent(f.slice(0, -4))] = fs.readFileSync(path.join(this.dir, 'kv', f), 'utf8');
    }
    return o;
  }
  kvSet(k, v) { writeAtomic(path.join(this.dir, 'kv', encodeURIComponent(k) + '.txt'), String(v)); }
  kvDel(k) { try { fs.unlinkSync(path.join(this.dir, 'kv', encodeURIComponent(k) + '.txt')); } catch (e) {} }
}
module.exports = { Store, writeAtomic, safe };
