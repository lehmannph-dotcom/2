'use strict';

/**
 * Minimaler JSON-Datenspeicher (eine Datei, atomar geschrieben).
 * Für den Produktivbetrieb durch PostgreSQL/PostGIS ersetzen – die Zugriffe
 * sind bewusst auf dieses Modul beschränkt.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ users: {}, sessions: {}, trips: {}, rides: {}, ledger: [], guestbook: [] });

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = dir ? path.join(dir, 'db.json') : null;
    this.data = EMPTY();
    this.timer = null;
    if (this.file && fs.existsSync(this.file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
  }

  id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Schlüssel zur Verschlüsselung sensibler Felder (z. B. MFA-Secrets).
   * APP_SECRET aus der Umgebung, sonst ein zufälliger Schlüssel in data/secret.key.
   */
  secretKey() {
    if (this._key) return this._key;
    if (process.env.APP_SECRET) {
      this._key = crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
    } else if (this.dir) {
      const file = path.join(this.dir, 'secret.key');
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
      this._key = fs.readFileSync(file);
    } else {
      this._key = crypto.randomBytes(32);
    }
    return this._key;
  }

  removeUpload(name) {
    if (!name) return;
    try {
      fs.unlinkSync(this.uploadPath(path.basename(name)));
    } catch {}
  }

  uploadPath(name) {
    const dir = path.join(this.dir || path.join(__dirname, '..', 'data'), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }
}

module.exports = { Store };
