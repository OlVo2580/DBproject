const fs = require('fs');
const path = require('path');

function getDataDir() {
  return path.join(__dirname, '..', 'data');
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listDatabases() {
  ensureDataDir();
  return fs.readdirSync(getDataDir())
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

function readDatabase(name) {
  ensureDataDir();
  const file = path.join(getDataDir(), `${name}.json`);
  if (!fs.existsSync(file)) return { tables: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeDatabase(name, data) {
  ensureDataDir();
  const file = path.join(getDataDir(), `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function isValidIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function validateColumnsDef(columns) {
  const seen = new Set();
  const allowed = new Set(['integer', 'real', 'char', 'string', 'time', 'timeinvl', 'timeinvl']);
  let pkCount = 0;
  for (const c of columns) {
    if (!c || !isValidIdentifier(c.name)) throw new Error(`Invalid column name '${c && c.name}'`);
    if (seen.has(c.name)) throw new Error(`Duplicate column name '${c.name}'`);
    seen.add(c.name);
    const typ = (c.type || 'string').toLowerCase();
    if (!allowed.has(typ)) throw new Error(`Unsupported column type '${c.type}' for '${c.name}'`);
    if (c.pk && typeof c.pk !== 'boolean') throw new Error(`Invalid pk flag for '${c.name}'`);
    if (c.nullable && typeof c.nullable !== 'boolean') throw new Error(`Invalid nullable flag for '${c.name}'`);
    if (c.pk) pkCount++;
  }
  if (pkCount > 1) throw new Error('Multiple primary keys defined; only single primary key is supported');
  if (pkCount === 1) {
    const pk = columns.find(c => c.pk);
    if (!pk) throw new Error('Invalid primary key definition');
    if ((pk.type || '').toLowerCase() !== 'integer') throw new Error('Primary key must be of type integer');
  }
}

function validateRowAgainstSchema(columns, row) {
  const out = {};
  for (const col of columns) {
    const key = col.name;
    const typ = (col.type || 'string').toLowerCase();
    let val = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
    if ((val === undefined || val === '') && col.nullable) {
      out[key] = null;
      continue;
    }
    if (val === undefined) throw new Error(`Missing column ${JSON.stringify(key)} in row`);
    if (typ === 'integer') {
      if (typeof val === 'string' && val.trim() !== '') {
        if (!/^[-+]?\d+$/.test(val.trim())) throw new Error(`Column ${JSON.stringify(key)} expects integer`);
        val = parseInt(val, 10);
      }
      if (typeof val !== 'number' || !Number.isInteger(val)) throw new Error(`Column ${JSON.stringify(key)} expects integer`);
    } else if (typ === 'real') {
      if (typeof val === 'string') {
        if (val.trim() === '' || Number.isNaN(Number(val))) throw new Error(`Column ${JSON.stringify(key)} expects real number`);
        val = Number(val);
      }
      if (typeof val !== 'number' || Number.isNaN(val)) throw new Error(`Column ${JSON.stringify(key)} expects real number`);
    } else if (typ === 'char') {
      val = String(val);
      if (val.length !== 1) throw new Error(`Column ${JSON.stringify(key)} expects single character`);
    } else if (typ === 'time') {
      if (typeof val !== 'string') val = String(val);
      const t = val.trim();
      const timeRe = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;
      if (!timeRe.test(t)) throw new Error(`Column ${JSON.stringify(key)} expects time in HH:MM[:SS] format`);
      val = t;
    } else if (typ === 'timeinvl' || typ === 'timeinvl') {
      if (typeof val !== 'string') val = String(val);
      const s = val.trim();
      const isoDur = /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/i;
      const hhmmss = /^-?\d+:\d{2}:\d{2}(?:\.\d+)?$/;
      if (!isoDur.test(s) && !hhmmss.test(s)) throw new Error(`Column ${JSON.stringify(key)} expects interval (ISO8601 duration or HH:MM:SS)`);
      val = s;
    } else {
      val = String(val);
    }
    out[key] = val;
  }
  for (const k of Object.keys(row)) {
    if (!columns.find(c => c.name === k)) throw new Error(`Unknown column '${k}' in row`);
  }
  return out;
}

function getPkName(tbl, tableName) {
  if (tbl && tbl._pk) return tbl._pk;
  if (tbl && tbl.columns) {
    const colObj = tbl.columns.find(c => (typeof c === 'object' && c.pk));
    if (colObj) return colObj.name;
    const hasId = tbl.columns.find(c => (typeof c === 'string' ? c : c.name) === 'Id');
    if (hasId) return 'Id';
    const candidate = (tableName || '') + 'Id';
    const hasCandidate = tbl.columns.find(c => (typeof c === 'string' ? c : c.name) === candidate);
    if (hasCandidate) return candidate;
  }
  return (tableName || '') + 'Id';
}

function getNextIdForTable(tbl, tableName) {
  if (!tbl || !tbl.rows) return 1;
  const pk = getPkName(tbl, tableName);
  let max = 0;
  for (const r of tbl.rows) {
    if (!r) continue;
    if (!Object.prototype.hasOwnProperty.call(r, pk)) continue;
    const v = r[pk];
    if (typeof v === 'number' && Number.isInteger(v)) {
      if (v > max) max = v;
    } else if (typeof v === 'string' && /^[-+]?\d+$/.test(v)) {
      const n = parseInt(v, 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

module.exports = {
  getDataDir,
  ensureDataDir,
  listDatabases,
  readDatabase,
  writeDatabase,
  validateColumnsDef,
  validateRowAgainstSchema,
  getPkName,
  getNextIdForTable,
  isValidIdentifier
};
