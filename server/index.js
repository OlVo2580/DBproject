const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dbLib = require('./lib/db');
const dagre = require('dagre');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
// Serve renderer static files so the web UI is available at the server root
app.use('/', express.static(path.join(__dirname, '..', 'renderer')));

// helper to send errors
function handleAsync(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('API error', err && err.stack ? err.stack : err);
      res.status(400).json({ error: err && err.message ? err.message : String(err) });
    }
  };
}

// List DBs
app.get('/api/dbs', handleAsync(async (req, res) => {
  const list = dbLib.listDatabases();
  res.json(list);
}));

// Create DB
app.post('/api/dbs', handleAsync(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new Error('Missing name');
  const exists = dbLib.listDatabases().includes(name);
  if (exists) throw new Error('Database already exists');
  dbLib.writeDatabase(name, { tables: {} });
  res.json({ ok: true });
}));

// Get DB
app.get('/api/dbs/:dbName', handleAsync(async (req, res) => {
  const db = dbLib.readDatabase(req.params.dbName);
  res.json(db);
}));

// Delete DB
app.delete('/api/dbs/:dbName', handleAsync(async (req, res) => {
  const name = req.params.dbName;
  const file = require('path').join(dbLib.getDataDir(), `${name}.json`);
  if (!require('fs').existsSync(file)) throw new Error('Database not found');
  require('fs').unlinkSync(file);
  res.json({ ok: true });
}));

// Create Table
app.post('/api/dbs/:dbName/tables', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const { tableName, columns } = req.body;
  if (!dbName || !tableName) throw new Error('Missing db or table');
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  if (!db.tables) db.tables = {};
  if (db.tables[tableName]) throw new Error('Table exists');
  const cols = (columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : { name: c.name, type: (c.type||'string'), default: c.default }));
  const pkName = `${tableName}Id`;
  const existingPk = cols.find(c => c.pk || c.name === pkName || c.name === 'Id');
  if (!existingPk) {
    cols.unshift({ name: pkName, type: 'integer', pk: true, default: undefined, nullable: false });
  } else {
    existingPk.type = 'integer';
    existingPk.pk = true;
    existingPk.nullable = false;
    if (existingPk.name === 'Id') existingPk.name = pkName;
  }
  dbLib.validateColumnsDef(cols);
  db.tables[tableName] = { columns: cols, rows: [], _pk: pkName };
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Query rows
app.get('/api/dbs/:dbName/tables/:tableName/rows', handleAsync(async (req, res) => {
  const db = dbLib.readDatabase(req.params.dbName);
  const tbl = db.tables[req.params.tableName];
  if (!tbl) throw new Error('Table not found');
  res.json(tbl.rows || []);
}));

// Insert row
app.post('/api/dbs/:dbName/tables/:tableName/rows', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const row = req.body;
  const db = dbLib.readDatabase(dbName);
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  let cols = tbl.columns;
  if (cols.length > 0 && typeof cols[0] === 'string') cols = cols.map(n => ({ name: n, type: 'string' }));
  const prepared = {};
  for (const c of cols) {
    if (Object.prototype.hasOwnProperty.call(row, c.name) && row[c.name] !== '') prepared[c.name] = row[c.name];
    else prepared[c.name] = c.default !== undefined ? c.default : '';
  }
  const pkName = dbLib.getPkName(tbl, tableName);
  const pkCol = cols.find(c => c.name === pkName || c.name === 'Id' || c.pk);
  if (pkCol) {
    const currentVal = prepared[pkCol.name];
    if (currentVal === undefined || currentVal === '' || currentVal === null) {
      prepared[pkCol.name] = dbLib.getNextIdForTable(tbl, tableName);
    }
    if (typeof prepared[pkCol.name] === 'string' && /^[-+]?\d+$/.test(prepared[pkCol.name])) prepared[pkCol.name] = parseInt(prepared[pkCol.name], 10);
    if (typeof prepared[pkCol.name] !== 'number' || !Number.isInteger(prepared[pkCol.name])) throw new Error(`${pkCol.name} must be integer`);
    if (tbl.rows.some(r => r && Number(r[pkCol.name]) === Number(prepared[pkCol.name]))) throw new Error(`${pkCol.name} must be unique`);
  }
  const valid = dbLib.validateRowAgainstSchema(cols, prepared);
  // FK enforcement omitted for brevity (server initial implementation)
  tbl.rows.push(valid);
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Update row
app.put('/api/dbs/:dbName/tables/:tableName/rows/:index', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const rowIndex = Number(req.params.index);
  const newRow = req.body;
  const db = dbLib.readDatabase(dbName);
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= tbl.rows.length) throw new Error('Row index out of range');
  let cols = tbl.columns;
  if (cols.length > 0 && typeof cols[0] === 'string') cols = cols.map(n => ({ name: n, type: 'string' }));
  const pkName = dbLib.getPkName(tbl, tableName);
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
  const valid = dbLib.validateRowAgainstSchema(cols, newRow);
  tbl.rows[rowIndex] = valid;
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Delete row
app.delete('/api/dbs/:dbName/tables/:tableName/rows/:index', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const rowIndex = Number(req.params.index);
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  if (isNaN(rowIndex) || rowIndex < 0 || rowIndex >= tbl.rows.length) throw new Error('Row index out of range');
  tbl.rows.splice(rowIndex, 1);
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Delete table
app.delete('/api/dbs/:dbName/tables/:tableName', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  if (!db.tables[tableName]) throw new Error('Table not found');
  delete db.tables[tableName];
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Add column
app.post('/api/dbs/:dbName/tables/:tableName/columns', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const column = req.body;
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  tbl.columns = (tbl.columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
  if (!dbLib.isValidIdentifier(column.name)) throw new Error('Invalid column name');
  const pkName = tbl._pk || (tableName + 'Id');
  if (column.name === pkName) throw new Error(`${pkName} is reserved as primary key and cannot be added`);
  dbLib.validateColumnsDef([...(tbl.columns || []), { name: column.name, type: column.type||'string', default: column.default }]);
  if (tbl.columns.find(c => c.name === column.name)) throw new Error('Column already exists');
  const colObj = { name: column.name, type: (column.type||'string'), default: column.default };
  if (column.fk && column.fk.table && column.fk.column) {
    colObj.fk = { table: column.fk.table, column: column.fk.column, onDelete: column.fk.onDelete || 'restrict' };
  }
  tbl.columns.push(colObj);
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Update column metadata
app.put('/api/dbs/:dbName/tables/:tableName/columns/:columnName', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const columnName = req.params.columnName;
  const newMeta = req.body;
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  tbl.columns = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
  const idx = tbl.columns.findIndex(c => c.name === columnName);
  if (idx === -1) throw new Error('Column not found');
  const updated = { ...tbl.columns[idx], ...newMeta };
  const pkName = tbl._pk || (tableName + 'Id');
  if (tbl.columns[idx].name === pkName) {
    if (updated.name && updated.name !== pkName) throw new Error('Cannot rename primary key column');
    if ((updated.type || '').toLowerCase() !== 'integer') throw new Error('Primary key column must remain integer');
    updated.pk = true; updated.nullable = false;
  }
  dbLib.validateColumnsDef(tbl.columns.map((c, i) => i === idx ? updated : c));
  tbl.columns[idx] = updated;
  if (!updated.nullable) {
    for (let r of tbl.rows) {
      if (r[updated.name] === undefined || r[updated.name] === null || r[updated.name] === '') {
        r[updated.name] = updated.default !== undefined ? updated.default : '';
      }
    }
  }
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Rename column
app.post('/api/dbs/:dbName/tables/:tableName/columns/:oldName/rename', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const oldName = req.params.oldName;
  const { newName } = req.body;
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  if (!dbLib.isValidIdentifier(newName)) throw new Error('Invalid column name');
  const pkName = (db.tables && db.tables[tableName] && db.tables[tableName]._pk) || (tableName + 'Id');
  if (oldName === pkName || newName === pkName) throw new Error('Cannot rename primary key column');
  tbl.columns = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
  if (tbl.columns.find(c => c.name === newName)) throw new Error('Column already exists with that name');
  const col = tbl.columns.find(c => c.name === oldName);
  if (!col) throw new Error('Column not found');
  col.name = newName;
  // rename values in rows
  for (const r of tbl.rows) {
    if (Object.prototype.hasOwnProperty.call(r, oldName)) {
      r[newName] = r[oldName];
      delete r[oldName];
    }
  }
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Remove column
app.delete('/api/dbs/:dbName/tables/:tableName/columns/:columnName', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const tableName = req.params.tableName;
  const columnName = req.params.columnName;
  const db = dbLib.readDatabase(dbName);
  if (!db) throw new Error('Database not found');
  const tbl = db.tables[tableName];
  if (!tbl) throw new Error('Table not found');
  const pkName = tbl._pk || (tableName + 'Id');
  if (columnName === pkName) throw new Error('Cannot remove primary key column');
  tbl.columns = (tbl.columns || []).filter(c => ((typeof c === 'string' ? c : c.name) !== columnName));
  tbl.rows = (tbl.rows || []).map(r => { const nr = { ...r }; delete nr[columnName]; return nr; });
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

// Export DB as JSON
app.get('/api/dbs/:dbName/export', handleAsync(async (req, res) => {
  const db = dbLib.readDatabase(req.params.dbName);
  res.json(db);
}));

// Import DB from JSON (body contains { fileName, fileContent })
app.post('/api/dbs/import', handleAsync(async (req, res) => {
  const { fileName, fileContent } = req.body;
  if (!fileName || !fileContent) throw new Error('Missing fileName or fileContent');
  // fileName may be with .json; strip
  const name = fileName.replace(/\.json$/, '');
  dbLib.writeDatabase(name, fileContent);
  res.json({ ok: true });
}));

// Compute layout (basic auto layout using dagre)
app.post('/api/dbs/:dbName/compute-layout', handleAsync(async (req, res) => {
  const db = dbLib.readDatabase(req.params.dbName);
  // Basic layout: place tables in a row; if dagre available, use it
  try {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR' });
    g.setDefaultEdgeLabel(() => ({}));
    const tables = Object.keys(db.tables || {});
    for (const t of tables) {
      const cols = (db.tables[t].columns || []).length;
      const width = 200;
      const height = 40 + cols * 20;
      g.setNode(t, { width, height });
    }
    // add no edges (we don't infer relationships here)
    dagre.layout(g);
    const nodes = g.nodes().map(n => ({ id: n, x: g.node(n).x, y: g.node(n).y }));
    res.json({ nodes });
  } catch (e) {
    res.json({ nodes: [] });
  }
}));

// Save positions
app.post('/api/dbs/:dbName/save-positions', handleAsync(async (req, res) => {
  const dbName = req.params.dbName;
  const positions = req.body;
  const db = dbLib.readDatabase(dbName);
  db.__positions = positions;
  dbLib.writeDatabase(dbName, db);
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
