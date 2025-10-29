const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const dagre = require('dagre');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development';

function getDataDir() {
  return path.join(app.getPath('userData'), 'mini-db-data');
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function listDatabases() {
  ensureDataDir();
  return fs.readdirSync(getDataDir()).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
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

function validateRowAgainstSchema(columns, row) {
  // columns: [{name, type}, ...]
  const out = {};
  for (const col of columns) {
    const key = col.name;
    const typ = (col.type || 'string').toLowerCase();
    // allow nullable columns: if missing and nullable, set to null
    let val = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
    if ((val === undefined || val === '') && col.nullable) {
      out[key] = null;
      continue;
    }
      if (val === undefined) {
        throw new Error(`Missing column ${JSON.stringify(key)} in row`);
    }
    if (typ === 'integer') {
      if (typeof val === 'string' && val.trim() !== '') {
          if (!/^[-+]?\d+$/.test(val.trim())) throw new Error(`Column ${JSON.stringify(key)} expects integer`);
        val = parseInt(val, 10);
      }
        if (typeof val !== 'number' || !Number.isInteger(val)) throw new Error(`Column ${JSON.stringify(key)} expects integer`);
    } else if (typ === 'real') {
      if (typeof val === 'string') {
        if (val.trim() === '' || Number.isNaN(Number(val))) throw new Error(`Column '${key}' expects real number`);
          if (val.trim() === '' || Number.isNaN(Number(val))) throw new Error(`Column ${JSON.stringify(key)} expects real number`);
        val = Number(val);
      }
        if (typeof val !== 'number' || Number.isNaN(val)) throw new Error(`Column ${JSON.stringify(key)} expects real number`);
    } else if (typ === 'char') {
      // coerce to string
      val = String(val);
        if (val.length !== 1) throw new Error(`Column ${JSON.stringify(key)} expects single character`);
    } else if (typ === 'time') {
      // expect HH:MM or HH:MM:SS(.sss) 24-hour time
      if (typeof val !== 'string') val = String(val);
      const t = val.trim();
      const timeRe = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;
      if (!timeRe.test(t)) throw new Error(`Column ${JSON.stringify(key)} expects time in HH:MM[:SS] format`);
      val = t;
    } else if (typ === 'timeinvl') {
      // Accept ISO 8601 durations (e.g. 'PT1H30M') or HH:MM:SS interval strings
      if (typeof val !== 'string') val = String(val);
      const s = val.trim();
      const isoDur = /^P(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/i;
      const hhmmss = /^-?\d+:\d{2}:\d{2}(?:\.\d+)?$/;
      if (!isoDur.test(s) && !hhmmss.test(s)) throw new Error(`Column ${JSON.stringify(key)} expects interval (ISO8601 duration or HH:MM:SS)`);
      val = s;
    } else { // string
      val = String(val);
    }
    out[key] = val;
  }
  // check for unknown fields
  for (const k of Object.keys(row)) {
    if (!columns.find(c => c.name === k)) throw new Error(`Unknown column '${k}' in row`);
  }
  return out;
}

function isValidIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function validateColumnsDef(columns) {
  // columns: array of {name,type,default}
  const seen = new Set();
  const allowed = new Set(['integer', 'real', 'char', 'string', 'time', 'timeinvl']);
  let pkCount = 0;
  for (const c of columns) {
    if (!c || !isValidIdentifier(c.name)) throw new Error(`Invalid column name '${c && c.name}'`);
    if (seen.has(c.name)) throw new Error(`Duplicate column name '${c.name}'`);
    seen.add(c.name);
    const typ = (c.type || 'string').toLowerCase();
    if (!allowed.has(typ)) throw new Error(`Unsupported column type '${c.type}' for '${c.name}'`);
    // optional flags
    if (c.pk && typeof c.pk !== 'boolean') throw new Error(`Invalid pk flag for '${c.name}'`);
    if (c.nullable && typeof c.nullable !== 'boolean') throw new Error(`Invalid nullable flag for '${c.name}'`);
    if (c.pk) pkCount++;
  }
  // Enforce primary key semantics: at most one pk and if present it must be integer
  if (pkCount > 1) throw new Error('Multiple primary keys defined; only single primary key is supported');
  if (pkCount === 1) {
    const pk = columns.find(c => c.pk);
    if (!pk) throw new Error('Invalid primary key definition');
    if ((pk.type || '').toLowerCase() !== 'integer') throw new Error('Primary key must be of type integer');
  }
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (isDev) {
    win.webContents.openDevTools();
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  ipcMain.handle('list-dbs', () => {
    return listDatabases();
  });

  ipcMain.handle('create-db', (event, name) => {
    const exists = listDatabases().includes(name);
    if (exists) throw new Error('Database already exists');
    writeDatabase(name, { tables: {} });
    return true;
  });

  ipcMain.handle('get-db', (event, name) => {
    return readDatabase(name);
  });

  ipcMain.handle('create-table', (event, dbName, tableName, columns) => {
    if (!dbName) throw new Error('No database specified');
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    if (!isValidIdentifier(tableName)) throw new Error('Invalid table name');
    if (db.tables[tableName]) throw new Error('Table exists');
    // normalize columns: if string array given, convert to objects
    const cols = (columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : { name: c.name, type: (c.type||'string'), default: c.default }));
    // ensure primary key exists as first column and is integer
  const pkName = `${tableName}Id`;
    const existingPk = cols.find(c => c.pk || c.name === pkName || c.name === 'Id');
    if (!existingPk) {
      cols.unshift({ name: pkName, type: 'integer', pk: true, default: undefined, nullable: false });
    } else {
      // normalize PK column
      existingPk.type = 'integer';
      existingPk.pk = true;
      existingPk.nullable = false;
      // if its name was 'Id' rename to pkName
      if (existingPk.name === 'Id') existingPk.name = pkName;
    }
    validateColumnsDef(cols);
    db.tables[tableName] = { columns: cols, rows: [], _pk: pkName };
    writeDatabase(dbName, db);
    return true;
  });

  // helper: compute next integer Id for table (1-based)
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

  ipcMain.handle('insert-row', (event, dbName, tableName, row) => {
    const db = readDatabase(dbName);
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    // tbl.columns may be array of names or array of {name,type}
    let cols = tbl.columns;
    if (cols.length > 0 && typeof cols[0] === 'string') cols = cols.map(n => ({ name: n, type: 'string' }));
    // apply defaults for missing fields
    const prepared = {};
    for (const c of cols) {
      if (Object.prototype.hasOwnProperty.call(row, c.name) && row[c.name] !== '') prepared[c.name] = row[c.name];
      else prepared[c.name] = c.default !== undefined ? c.default : '';
    }

    // handle primary key: use per-table PK name
    const pkName = getPkName(tbl, tableName);
    const pkCol = cols.find(c => c.name === pkName || c.name === 'Id' || c.pk);
    if (pkCol) {
      const currentVal = prepared[pkCol.name];
      if (currentVal === undefined || currentVal === '' || currentVal === null) {
        prepared[pkCol.name] = getNextIdForTable(tbl, tableName);
      }
      // coerce string integers
      if (typeof prepared[pkCol.name] === 'string' && /^[-+]?\d+$/.test(prepared[pkCol.name])) prepared[pkCol.name] = parseInt(prepared[pkCol.name], 10);
      if (typeof prepared[pkCol.name] !== 'number' || !Number.isInteger(prepared[pkCol.name])) throw new Error(`${pkCol.name} must be integer`);
      // uniqueness check
      if (tbl.rows.some(r => r && Number(r[pkCol.name]) === Number(prepared[pkCol.name]))) throw new Error(`${pkCol.name} must be unique`);
    }

    const valid = validateRowAgainstSchema(cols, prepared);
    // enforce foreign key constraints: for each fk column, referenced value must exist
    for (const c of cols) {
      if (c.fk && c.fk.table && c.fk.column) {
        const refTbl = db.tables[c.fk.table];
        if (!refTbl) throw new Error(`Referenced table ${c.fk.table} not found for FK ${c.name}`);
        const refExists = (refTbl.rows || []).some(r => Number(r[c.fk.column]) === Number(valid[c.name]));
        if (!refExists) throw new Error(`Foreign key constraint failed: ${c.name} references ${c.fk.table}.${c.fk.column}`);
      }
    }
    tbl.rows.push(valid);
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('query-rows', (event, dbName, tableName) => {
    const db = readDatabase(dbName);
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    return tbl.rows;
  });

  ipcMain.handle('delete-table', (event, dbName, tableName) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    if (!db.tables[tableName]) throw new Error('Table not found');
    delete db.tables[tableName];
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('delete-db', (event, dbName) => {
    ensureDataDir();
    const file = path.join(getDataDir(), `${dbName}.json`);
    if (!fs.existsSync(file)) throw new Error('Database not found');
    fs.unlinkSync(file);
    return true;
  });

  ipcMain.handle('update-row', (event, dbName, tableName, rowIndex, newRow) => {
    const db = readDatabase(dbName);
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    if (rowIndex < 0 || rowIndex >= tbl.rows.length) throw new Error('Row index out of range');
    let cols = tbl.columns;
    if (cols.length > 0 && typeof cols[0] === 'string') cols = cols.map(n => ({ name: n, type: 'string' }));
    // primary key uniqueness enforcement
    const pkName = getPkName(tbl, tableName);
    if (Object.prototype.hasOwnProperty.call(newRow, pkName)) {
      const candidate = newRow[pkName];
      if (typeof candidate === 'string' && /^[-+]?\d+$/.test(candidate)) newRow[pkName] = parseInt(candidate, 10);
      if (typeof newRow[pkName] !== 'number' || !Number.isInteger(newRow[pkName])) throw new Error(`${pkName} must be integer`);
      for (let i = 0; i < tbl.rows.length; i++) {
        if (i === rowIndex) continue;
        const rr = tbl.rows[i];
        if (rr && Number(rr[pkName]) === Number(newRow[pkName])) throw new Error(`${pkName} must be unique`);
      }
    }
    const valid = validateRowAgainstSchema(cols, newRow);
    tbl.rows[rowIndex] = valid;
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('delete-row', (event, dbName, tableName, rowIndex) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    if (rowIndex < 0 || rowIndex >= tbl.rows.length) throw new Error('Row index out of range');
    // enforce FK on delete: check other tables for FKs referencing this table
    const pkName = tbl._pk || (tableName + 'Id');
    const targetVal = tbl.rows[rowIndex][pkName];
    for (const otherName of Object.keys(db.tables)) {
      const other = db.tables[otherName];
      const cols = (other.columns || []).map(c => (typeof c === 'string' ? { name: c } : c));
      for (const c of cols) {
        if (c.fk && c.fk.table === tableName && c.fk.column === pkName) {
          if (c.fk.onDelete === 'cascade') {
            other.rows = (other.rows || []).filter(r => Number(r[c.name]) !== Number(targetVal));
          } else {
            // restrict
            const exists = (other.rows || []).some(r => Number(r[c.name]) === Number(targetVal));
            if (exists) throw new Error(`Cannot delete row: referenced by ${otherName}.${c.name}`);
          }
        }
      }
    }
    tbl.rows.splice(rowIndex, 1);
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('add-column', (event, dbName, tableName, column) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    // ensure columns array normalized
    tbl.columns = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
  if (!isValidIdentifier(column.name)) throw new Error('Invalid column name');
  const pkName = tbl._pk || (tableName + 'Id');
  if (column.name === pkName) throw new Error(`${pkName} is reserved as primary key and cannot be added`);
    validateColumnsDef([...(tbl.columns || []), { name: column.name, type: column.type||'string', default: column.default }]);
    if (tbl.columns.find(c => c.name === column.name)) throw new Error('Column already exists');
    // support optional fk metadata
    const colObj = { name: column.name, type: (column.type||'string'), default: column.default };
    if (column.fk && column.fk.table && column.fk.column) {
      colObj.fk = { table: column.fk.table, column: column.fk.column, onDelete: column.fk.onDelete || 'restrict' };
    }
    tbl.columns.push(colObj);
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('update-column', (event, dbName, tableName, columnName, newMeta) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
    tbl.columns = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
    const idx = tbl.columns.findIndex(c => c.name === columnName);
    if (idx === -1) throw new Error('Column not found');
    const updated = { ...tbl.columns[idx], ...newMeta };
    // don't allow changing primary key name/type
  const pkName = tbl._pk || (tableName + 'Id');
    if (tbl.columns[idx].name === pkName) {
      if (updated.name && updated.name !== pkName) throw new Error('Cannot rename primary key column');
      if ((updated.type || '').toLowerCase() !== 'integer') throw new Error('Primary key column must remain integer');
      updated.pk = true; updated.nullable = false;
    }
    validateColumnsDef(tbl.columns.map((c, i) => i === idx ? updated : c));
    tbl.columns[idx] = updated;
    // if column became nullable, leave rows; if became non-nullable, ensure rows have value or default
    if (!updated.nullable) {
      for (let r of tbl.rows) {
        if (r[updated.name] === undefined || r[updated.name] === null || r[updated.name] === '') {
          r[updated.name] = updated.default !== undefined ? updated.default : '';
        }
      }
    }
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('rename-column', (event, dbName, tableName, oldName, newName) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
  if (!isValidIdentifier(newName)) throw new Error('Invalid column name');
  const pkName = (db.tables && db.tables[tableName] && db.tables[tableName]._pk) || (tableName + 'Id');
  if (oldName === pkName || newName === pkName) throw new Error('Cannot rename primary key column');
    // normalize columns
    tbl.columns = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
    if (tbl.columns.find(c => c.name === newName)) throw new Error('Column already exists with that name');
    const col = tbl.columns.find(c => c.name === oldName);
    if (!col) throw new Error('Column not found');
    col.name = newName;
    // rename keys in rows
    tbl.rows = tbl.rows.map(r => {
      const nr = { ...r };
      if (Object.prototype.hasOwnProperty.call(nr, oldName)) {
        nr[newName] = nr[oldName];
        delete nr[oldName];
      }
      return nr;
    });
    writeDatabase(dbName, db);
    return true;
  });

  // export database to chosen file path
  ipcMain.handle('export-db', async (event, dbName) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export database',
      defaultPath: `${dbName}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(db, null, 2), 'utf8');
    return true;
  });

  // import database from chosen JSON file (overwrites or creates DB)
  ipcMain.handle('import-db', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import database',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (canceled || !filePaths || filePaths.length === 0) return false;
    const file = filePaths[0];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // basic validation
    if (!data || typeof data !== 'object' || !data.tables) throw new Error('Invalid database file');
    // ask for DB name
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Import as new name', 'Cancel'],
      title: 'Import DB',
      message: 'Choose import to save under a new database name (existing names will not be overwritten).'
    });
    if (response !== 0) return false;
    // prompt for name
    // fallback: use filename without extension
    const name = path.basename(file).replace(/\.json$/, '');
    let target = name;
    // ensure unique name
    const exists = listDatabases();
    let idx = 1;
    while (exists.includes(target)) {
      target = `${name}_${idx++}`;
    }
    // validate columns in each table
    for (const t of Object.keys(data.tables)) {
      const tbl = data.tables[t];
      let cols = (tbl.columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
      // set pk name for this table
    const pkName = (t + 'Id');
    // if 'Id' exists, rename to pkName
    const idIdx = cols.findIndex(c => c.name === 'Id');
    if (idIdx !== -1) cols[idIdx].name = pkName;
    // if a pk flagged exists, ensure it's the pkName
    const pkIdx = cols.findIndex(c => c.pk);
    if (pkIdx !== -1) cols[pkIdx].name = pkName;
      validateColumnsDef(cols);
      tbl.columns = cols;
      tbl._pk = pkName;
      tbl.rows = tbl.rows || [];
    }
    writeDatabase(target, data);
    return true;
  });

  // Import DB by passing JSON content (used for drag-and-drop from renderer)
  ipcMain.handle('import-db-from-json', (event, fileName, fileContent) => {
    if (!fileContent) throw new Error('No content provided');
    let data;
    try {
      data = JSON.parse(fileContent);
    } catch (e) { throw new Error('Invalid JSON file'); }
    if (!data || typeof data !== 'object' || !data.tables) throw new Error('Invalid database file');
    // derive name from filename (without extension)
    let base = path.basename(fileName).replace(/\.json$/i, '');
    if (!isValidIdentifier(base)) {
      // sanitize: replace non-identifier chars with underscore, ensure starts with letter/underscore
      base = base.replace(/[^A-Za-z0-9_]/g, '_');
      if (!/^[A-Za-z_]/.test(base)) base = '_' + base;
    }
    let target = base;
    const exists = listDatabases();
    let idx = 1;
    while (exists.includes(target)) { target = `${base}_${idx++}`; }
    // validate columns
    for (const t of Object.keys(data.tables)) {
      const tbl = data.tables[t];
      let cols = (tbl.columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
  const pkName = (t + 'Id');
  const idIdx = cols.findIndex(c => c.name === 'Id');
  if (idIdx !== -1) cols[idIdx].name = pkName;
  const pkIdx = cols.findIndex(c => c.pk);
  if (pkIdx !== -1) cols[pkIdx].name = pkName;
      validateColumnsDef(cols);
      tbl.columns = cols;
      tbl._pk = pkName;
      tbl.rows = tbl.rows || [];
    }
    writeDatabase(target, data);
    return target;
  });

  // compute layout using dagre; expects an array of tables with width/height or will use defaults
  ipcMain.handle('compute-layout', (event, dbName) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const tables = Object.keys(db.tables || {});
    // default size
    const defaultW = 260, defaultH = 120;
    tables.forEach(t => {
      const tbl = db.tables[t];
      const cols = (tbl.columns || []).length || 1;
      const h = 28 + Math.max(1, cols) * 18 + 10;
      g.setNode(t, { width: defaultW, height: h });
    });

    // simple edges: same heuristic as renderer
    tables.forEach(tn => {
      const colsArr = (db.tables[tn].columns || []).map(c => (typeof c === 'string' ? { name: c } : c));
      colsArr.forEach(c => {
        const col = c.name.toLowerCase();
        if (!col.endsWith('id')) return;
        tables.forEach(t2 => {
          if (t2.toLowerCase() === tn.toLowerCase()) return;
          if (col === (t2 + 'Id').toLowerCase() || col === (t2.toLowerCase() + 'id') || col === (t2.toLowerCase().slice(0, -1) + 'id')) {
            g.setEdge(tn, t2);
          }
        });
      });
    });

    dagre.layout(g);

    const positions = {};
    g.nodes().forEach(n => {
      const d = g.node(n);
      positions[n] = { x: Math.round(d.x - d.width / 2), y: Math.round(d.y - d.height / 2) };
    });

    // persist positions into db
    if (!db._positions) db._positions = {};
    Object.keys(positions).forEach(t => { db._positions[t] = positions[t]; });
    writeDatabase(dbName, db);

    return positions;
  });

  ipcMain.handle('save-positions', (event, dbName, positions) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    if (!db._positions) db._positions = {};
    Object.keys(positions).forEach(t => { db._positions[t] = positions[t]; });
    writeDatabase(dbName, db);
    return true;
  });

  ipcMain.handle('remove-column', (event, dbName, tableName, columnName) => {
    const db = readDatabase(dbName);
    if (!db) throw new Error('Database not found');
    const tbl = db.tables[tableName];
    if (!tbl) throw new Error('Table not found');
  const pkName = tbl._pk || (tableName + 'Id');
    if (columnName === pkName) throw new Error('Cannot remove primary key column');
    tbl.columns = tbl.columns.filter(c => ((typeof c === 'string' ? c : c.name) !== columnName));
    // also remove field from rows
    tbl.rows = tbl.rows.map(r => {
      const nr = { ...r };
      delete nr[columnName];
      return nr;
    });
    writeDatabase(dbName, db);
    return true;
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      // create window
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
