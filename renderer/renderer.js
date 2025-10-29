// If running in a browser (no Electron preload exposing window.dbapi),
// provide a lightweight web API wrapper that talks to the Express server.
if (typeof window.dbapi === 'undefined') {
  const base = (location && location.origin && location.origin !== 'null') ? location.origin : 'http://localhost:3000';
  const okOrThrow = async (resp) => {
    if (!resp.ok) {
      let body = null;
      try { body = await resp.json(); } catch(e) {}
      throw new Error((body && body.error) ? body.error : (`HTTP ${resp.status} ${resp.statusText}`));
    }
    return resp.json().catch(() => null);
  };

  window.dbapi = {
    listDbs: () => fetch(`${base}/api/dbs`).then(okOrThrow),
    createDb: (name) => fetch(`${base}/api/dbs`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) }).then(okOrThrow).then(j => j && j.ok),
    getDb: (name) => fetch(`${base}/api/dbs/${encodeURIComponent(name)}`).then(okOrThrow),
    createTable: (dbName, tableName, columns) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tableName, columns }) }).then(okOrThrow).then(j => j && j.ok),
    insertRow: (dbName, tableName, row) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/rows`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(row) }).then(okOrThrow).then(j => j && j.ok),
    queryRows: (dbName, tableName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/rows`).then(okOrThrow),
    deleteTable: (dbName, tableName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}`, { method: 'DELETE' }).then(okOrThrow).then(j => j && j.ok),
    deleteDb: (dbName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}`, { method: 'DELETE' }).then(okOrThrow).then(j => j && j.ok),
    updateRow: (dbName, tableName, rowIndex, newRow) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/rows/${encodeURIComponent(rowIndex)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(newRow) }).then(okOrThrow).then(j => j && j.ok),
    deleteRow: (dbName, tableName, rowIndex) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/rows/${encodeURIComponent(rowIndex)}`, { method: 'DELETE' }).then(okOrThrow).then(j => j && j.ok),
    addColumn: (dbName, tableName, column) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/columns`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(column) }).then(okOrThrow).then(j => j && j.ok),
    removeColumn: (dbName, tableName, columnName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/columns/${encodeURIComponent(columnName)}`, { method: 'DELETE' }).then(okOrThrow).then(j => j && j.ok),
    exportDb: (dbName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/export`).then(okOrThrow),
    importDb: () => { throw new Error('importDb via file selector is not supported in web fallback; use importDbFromJson'); },
    importDbFromJson: (fileName, fileContent) => fetch(`${base}/api/dbs/import`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fileName, fileContent }) }).then(okOrThrow).then(j => j && j.ok),
    computeLayout: (dbName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/compute-layout`, { method: 'POST' }).then(okOrThrow),
    savePositions: (dbName, positions) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/save-positions`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(positions) }).then(okOrThrow).then(j => j && j.ok),
    updateColumn: (dbName, tableName, columnName, newMeta) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/columns/${encodeURIComponent(columnName)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(newMeta) }).then(okOrThrow).then(j => j && j.ok),
    renameColumn: (dbName, tableName, oldName, newName) => fetch(`${base}/api/dbs/${encodeURIComponent(dbName)}/tables/${encodeURIComponent(tableName)}/columns/${encodeURIComponent(oldName)}/rename`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ newName }) }).then(okOrThrow).then(j => j && j.ok),
  };
}

const $ = (sel) => document.querySelector(sel);
let currentDb = null;
let dbData = null;
let diagramState = { scale: 1 };

// Cleanup routine to restore UI if an unexpected error leaves modals open or
// pointer capture/drag state active. Will be invoked from global error handlers
// so the app doesn't remain blocked after exceptions.
function cleanupAfterError() {
  try {
    // hide any visible modal backdrops; do NOT remove onclick handlers here
    // because that can leave UI controls unusable when users try again.
    document.querySelectorAll('.modal-backdrop.show').forEach(m => {
      m.classList.remove('show');
    });
  } catch (e) { console.warn('cleanupAfterError: failed to clean modals', e); }

  // reset drag state and selection visuals so pointer capture doesn't block
  try {
    dragState = null;
    selection.clear();
    updateSelectionVisuals();
  } catch (e) { console.warn('cleanupAfterError: failed to reset drag state', e); }
}

async function refreshDbs() {
  const list = await window.dbapi.listDbs();
  const container = $('#db-list');
  container.innerHTML = '';
  for (const name of list) {
    const el = document.createElement('div');
    el.className = 'db-item';
    const title = document.createElement('div');
    title.textContent = name;
    title.style.fontWeight = 'bold';
    title.onclick = () => selectDb(name);
    el.appendChild(title);
    // render tables under this DB
    const dbObj = await window.dbapi.getDb(name);
    const tablesWrap = document.createElement('div');
    tablesWrap.style.marginLeft = '8px';
    for (const tn of Object.keys(dbObj.tables || {})) {
      const tdiv = document.createElement('div');
      tdiv.className = 'table-item';
      tdiv.textContent = tn;
      tdiv.onclick = (e) => { e.stopPropagation(); openTableSettings(name, tn); };
      // show small list of columns under table name
      const cols = (dbObj.tables[tn].columns || []).map(c => (typeof c === 'string' ? c : `${c.name}:${c.type}`));
      const colsDiv = document.createElement('div');
      colsDiv.style.fontSize = '12px';
      colsDiv.style.opacity = '0.8';
      colsDiv.textContent = cols.join(', ');
      tdiv.appendChild(colsDiv);
      tablesWrap.appendChild(tdiv);
    }
    el.appendChild(tablesWrap);
    container.appendChild(el);
  }
  // also redraw diagram if current DB is selected
  if (currentDb) renderDiagram();
}

async function selectDb(name) {
  currentDb = name;
  $('#db-title').textContent = `DB: ${name}`;
  // add delete DB button
  let delBtn = document.getElementById('delete-db-btn');
  if (!delBtn) {
    delBtn = document.createElement('button');
    delBtn.id = 'delete-db-btn';
    delBtn.textContent = 'Delete DB';
    delBtn.style.marginLeft = '12px';
    document.getElementById('db-title').appendChild(delBtn);
  }
  delBtn.onclick = async () => {
    const ok = await showConfirm(`Delete database "${name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await window.dbapi.deleteDb(name);
      currentDb = null;
      dbData = null;
      $('#db-title').textContent = 'No database selected';
      $('#tables-section').style.display = 'none';
      await refreshDbs();
  } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error', 'error', 4000); } catch(err){} }
  };
  $('#tables-section').style.display = 'block';
  dbData = await window.dbapi.getDb(name);
  renderTables();
  renderDiagram();
}

// showConfirm: display modal confirm and return Promise<boolean>
function showConfirm(message, title = 'Confirm') {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    showModal(modal);
    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    const cleanup = () => {
      yes.onclick = null; no.onclick = null; hideModal(modal);
    };
    yes.onclick = () => { cleanup(); resolve(true); };
    no.onclick = () => { cleanup(); resolve(false); };
  });
}

function showModal(el) {
  if (typeof el === 'string') el = document.getElementById(el);
  el.classList.add('show');
}
function hideModal(el) {
  if (typeof el === 'string') el = document.getElementById(el);
  el.classList.remove('show');
}

// Toast helper (non-blocking)
function showToast(message, type = 'info', ms = 3000) {
  try {
    const container = document.getElementById('toast-container');
    if (!container) { console.warn('Toast container missing, fallback to console:' , message); return; }
    const t = document.createElement('div');
    t.className = `toast ${type} show`;
    t.textContent = message;
    container.appendChild(t);
    setTimeout(() => { t.classList.remove('show'); }, ms - 300);
    setTimeout(() => { try { container.removeChild(t); } catch(e){} }, ms);
  } catch (e) { console.warn('showToast failed, message:', message, e); }
}

// Global safety nets: when an unexpected error or unhandled rejection happens,
// remove modals/backdrops and reset drag state so the UI doesn't stay blocked.
window.addEventListener('error', (ev) => {
  console.error('Global error', ev.error || ev.message, ev);
  cleanupAfterError();
  try { showToast('Unexpected error: ' + (ev.error && ev.error.message ? ev.error.message : ev.message), 'error', 5000); } catch(e){}
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled rejection', ev.reason);
  cleanupAfterError();
  try { showToast('Unexpected error: ' + (ev.reason && ev.reason.message ? ev.reason.message : JSON.stringify(ev.reason)), 'error', 5000); } catch(e){}
  // prevent default logging in console twice
  try { ev.preventDefault && ev.preventDefault(); } catch(e){}
});

// Modal for editing column: supports renaming + metadata update
function openEditColumnModal(dbName, tableName, column) {
  // determine table primary key name
  const pkName = (dbData && dbData.tables && dbData.tables[tableName] && dbData.tables[tableName]._pk) || (tableName + 'Id');
  // set name (only editable when not primary key)
  document.getElementById('edit-col-name').value = column.name;
  if (column.name === pkName) {
    document.getElementById('edit-col-name').setAttribute('readonly', 'true');
  } else {
    document.getElementById('edit-col-name').removeAttribute('readonly');
  }
  document.getElementById('edit-col-type').value = column.type || 'string';
  document.getElementById('edit-col-default').value = column.default ?? '';
  document.getElementById('edit-col-pk').checked = !!column.pk;
  document.getElementById('edit-col-nullable').checked = !!column.nullable;
  showModal('edit-column-modal');

  const onSave = async () => {
    const newName = document.getElementById('edit-col-name').value.trim();
    const newMeta = {
      type: document.getElementById('edit-col-type').value,
      default: document.getElementById('edit-col-default').value,
      pk: document.getElementById('edit-col-pk').checked,
      nullable: document.getElementById('edit-col-nullable').checked,
    };
    try {
      // if name changed and it's not the primary key, perform rename first
      if (column.name !== pkName && newName !== column.name) {
        await window.dbapi.renameColumn(dbName, tableName, column.name, newName);
      }
      // then update metadata (uses current name if renamed)
      await window.dbapi.updateColumn(dbName, tableName, newName, newMeta);
      hideModal('edit-column-modal');
      document.getElementById('edit-col-save').onclick = null;
      document.getElementById('edit-col-cancel').onclick = null;
      await refreshAllViews(dbName, tableName);
    } catch (e) { 
      // make sure modal/backdrop are not left visible and restore UI
      cleanupAfterError();
      try { 
        showToast(e.message || 'Error updating column', 'error', 4000);
        const editName = document.getElementById('edit-col-name'); if (editName) { editName.disabled = false; editName.readOnly = false; editName.focus(); editName.select(); }
      } catch(err){}
    }
  };

  const onCancel = () => {
    hideModal('edit-column-modal');
    document.getElementById('edit-col-save').onclick = null;
    document.getElementById('edit-col-cancel').onclick = null;
  };

  document.getElementById('edit-col-save').onclick = onSave;
  document.getElementById('edit-col-cancel').onclick = onCancel;
}

// Function to refresh all views after data changes
async function refreshAllViews(dbName, tableName) {
  dbData = await window.dbapi.getDb(dbName);
  await refreshDbs();
  renderTables();
  renderDiagram();
  if (tableName) {
    showTableDetail(tableName);
  }
}

function renderTables() {
  const list = $('#table-list');
  list.innerHTML = '';
  Object.keys(dbData.tables || {}).forEach(tn => {
    const el = document.createElement('div');
    el.className = 'table-item';
    el.textContent = tn;
    el.onclick = () => showTableDetail(tn);
    list.appendChild(el);
  });
}

// Diagram rendering helpers
function clearDiagram() {
  const svg = document.getElementById('diagram');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function drawTableBox(tn, colsArr, x, y, width) {
  const g = createSvgElement('g', { 
    class: 'table-group', 
    transform: `translate(${x},${y})`,
    style: 'cursor:grab'
  });
  
  // Table header with title area
  const headerHeight = 30;
  const header = createSvgElement('rect', {
    x: 0, y: 0,
    width: width,
    height: headerHeight,
    fill: '#e8e8e8',
    stroke: '#666',
    'stroke-width': 1.5,
    rx: 4
  });
  g.appendChild(header);
  
  // Title text
  const title = createSvgElement('text', {
    x: width/2,
    y: 20,
    'text-anchor': 'middle',
    'font-weight': 'bold',
    'font-size': 14
  });
  title.textContent = tn;
  g.appendChild(title);
  
  // Column section
  const rowHeight = 24;
  const bodyHeight = colsArr.length * rowHeight;
  const body = createSvgElement('rect', {
    x: 0,
    y: headerHeight,
    width: width,
    height: bodyHeight,
    fill: 'white',
    stroke: '#666',
    'stroke-width': 1,
    rx: 4
  });
  g.appendChild(body);
  
  return {g, headerHeight, rowHeight, totalHeight: headerHeight + bodyHeight};
}

// Add style block for diagram elements
const style = document.createElement('style');
style.textContent = `
  .table-group:hover rect { stroke: #337ab7; }
  .pk-badge { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.2)); }
  .fk-badge { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1)); }
  .relationship-line { transition: stroke-width 0.2s; }
  .relationship-line:hover { stroke-width: 2.5; }
  .cardinality-marker { fill: #666; font-family: sans-serif; }
  .arrow-head { transition: fill 0.2s; }
  .relationship-line:hover + .arrow-head { fill: #1a5; }
`;
document.head.appendChild(style);

function createSvgElement(tag, attrs = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(ns, tag);
  Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
  return el;
}

function renderDiagram() {
  const svg = document.getElementById('diagram');
  if (!svg) return;
  clearDiagram();
  if (!dbData || !dbData.tables) return;
  const tables = Object.keys(dbData.tables);
  // default sizes
  const cellW = 260;
  const rowH = 18;

  // positions: prefer persisted positions in dbData._positions
  const persisted = dbData._positions || {};
  const positions = {};
  tables.forEach((tn, i) => {
    if (persisted[tn]) positions[tn] = { x: persisted[tn].x, y: persisted[tn].y };
    else positions[tn] = null; // will compute later
  });

  // fallback grid layout for tables without persisted pos
  const autoPlace = tables.filter(t => !positions[t]);
  const cols = Math.max(1, Math.ceil(Math.sqrt(autoPlace.length || tables.length)));
  const margin = 24;
  autoPlace.forEach((tn, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    positions[tn] = { x: margin + c * (cellW + margin), y: margin + r * (120 + margin) };
  });

  // infer fk columns by name
  const fkCols = {};
  Object.keys(dbData.tables).forEach(tn => { fkCols[tn] = new Set(); });
  Object.keys(dbData.tables).forEach(tn => {
    const colsArr = (dbData.tables[tn].columns || []).map(c => (typeof c === 'string' ? { name: c } : c));
    colsArr.forEach(c => {
      const col = c.name.toLowerCase();
      if (!col.endsWith('id')) return;
      Object.keys(dbData.tables).forEach(t2 => {
        if (t2.toLowerCase() === tn.toLowerCase()) return;
        if (col === (t2 + 'Id').toLowerCase() || col === (t2.toLowerCase() + 'id') || col === (t2.toLowerCase().slice(0, -1) + 'id')) {
          fkCols[tn].add(c.name);
        }
      });
    });
  });

  // draw table boxes
  Object.keys(dbData.tables).forEach(tn => {
    const pos = positions[tn];
    const boxW = cellW;
    const colsArr = (dbData.tables[tn].columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
    // ensure pk column renders first
    const pkName = (dbData.tables[tn] && dbData.tables[tn]._pk) || (tn + 'Id');
    colsArr.sort((a,b) => { if (a.name === pkName) return -1; if (b.name === pkName) return 1; return 0; });
    
    const box = drawTableBox(tn, colsArr, pos.x, pos.y, boxW);
    const group = box.g;

    // columns with markers
    colsArr.forEach((c, idx) => {
      const y = box.headerHeight + idx * box.rowHeight + 16;
      // marker badges
      const markerX = boxW - 22;
      const marker = createSvgElement('rect', { x: markerX, y: y - 12, width: 14, height: 14, rx:3 });
      let color = '#fff';
      let title = '';
      if (c.name === pkName) { 
        color = '#ffd700'; 
        title = 'PK'; 
        marker.classList.add('pk-badge');
      }
      else if (c.fk) { 
        color = '#a6e4a6'; 
        title = `FK → ${c.fk.table}.${c.fk.column}`;
        marker.classList.add('fk-badge');
      }
      else if (fkCols[tn] && fkCols[tn].has(c.name)) { 
        color = '#a6e4a6'; 
        title = 'FK (inferred)';
        marker.classList.add('fk-badge');
      }
      else if (c.nullable) { 
        color = '#d0f0ff'; 
        title = 'Nullable'; 
      }
      if (title) marker.setAttribute('title', title);
      marker.setAttribute('fill', color);
      marker.setAttribute('stroke', '#666');
      group.appendChild(marker);

      const colText = createSvgElement('text', { x: 8, y: y, 'font-size': 12 });
      // Format column display
      const typeDisplay = c.type === 'string' ? 'text' : c.type;
      colText.innerHTML = `${c.name} <tspan fill="#666">: ${typeDisplay}</tspan>`;
      group.appendChild(colText);

      // tooltips
      if (c.name === pkName || c.fk || (fkCols[tn] && fkCols[tn].has(c.name)) || c.nullable) {
        const ttag = createSvgElement('title');
        ttag.textContent = `${c.name} — ${c.type}` + 
          (c.name === pkName ? ' — PK' : '') +
          (c.nullable ? ' — Nullable' : '') +
          (c.fk ? ` — FK → ${c.fk.table}.${c.fk.column}` : '') +
          (fkCols[tn] && fkCols[tn].has(c.name) ? ' — FK (inferred)' : '');
        colText.appendChild(ttag);
      }
    });

    // attach data-name for interactions
    group.setAttribute('data-table', tn);
    svg.appendChild(group);
    makeGroupDraggable(group, tn);
  });

  // Reset connections array
  connections.length = 0;
  // Build explicit foreign-key connections (from column metadata)
  try {
    const seen = new Set();
    Object.keys(dbData.tables).forEach(tn => {
      const colsArr = (dbData.tables[tn].columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
      colsArr.forEach(c => {
        if (c && c.fk && c.fk.table) {
          const key = `${tn}->${c.fk.table}`;
          if (!seen.has(key)) {
            connections.push({ from: tn, to: c.fk.table });
            seen.add(key);
          }
        }
      });
    });
  } catch(e) { /* non-fatal */ }
  
  // simple FK inference: if a column ends with 'id' and equals another table name + 'id' or 'Id'
  Object.keys(dbData.tables).forEach(tn => {
    const colsArr = (dbData.tables[tn].columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
  const pkName = (dbData.tables[tn] && dbData.tables[tn]._pk) || (tn + 'Id');
      colsArr.sort((a,b) => { if (a.name === pkName) return -1; if (b.name === pkName) return 1; return 0; });
    colsArr.forEach(c => {
      const col = c.name.toLowerCase();
      if (!col.endsWith('id')) return;
      // try to match other table by name prefix
      Object.keys(dbData.tables).forEach(t2 => {
        if (t2.toLowerCase() === tn.toLowerCase()) return;
        // match patterns: userId -> users, lessonid -> lessons
        if (col === (t2 + 'Id').toLowerCase() || col === (t2.toLowerCase() + 'id') || col === (t2.toLowerCase().slice(0, -1) + 'id')) {
          connections.push({ from: tn, to: t2 });
        }
      });
    });
  });

  // Render all relationships
  drawRelationships(connections, positions, cellW);

  // markers
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', { id: 'arrow', markerWidth: 10, markerHeight: 10, refX: 6, refY: 3, orient: 'auto' });
  const arrowPath = createSvgElement('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#2b7' });
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.insertBefore(defs, svg.firstChild);
}

// Helper function to draw all relationship lines
function drawRelationships(connections, positions, cellWidth = DEFAULT_CELL_WIDTH) {
  // Remove existing relationships first
  const svg = document.getElementById('diagram');
  const existingPaths = svg.querySelectorAll('.relationship-line, .cardinality-marker');
  existingPaths.forEach(el => el.remove());

  // Draw new connections
  connections.forEach(conn => {
    const a = positions[conn.from];
    const b = positions[conn.to];
    if (!a || !b) return;

    // Get actual positions from current transforms if elements exist
    const fromEl = document.querySelector(`g.table-group[data-table="${conn.from}"]`);
    const toEl = document.querySelector(`g.table-group[data-table="${conn.to}"]`);
    
    let startX = a.x + cellWidth;
    let startY = a.y + 24;
    let endX = b.x;
    let endY = b.y + 24;
    
    // Update positions from current transforms if elements exist
    if (fromEl) {
      const transform = fromEl.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
      if (transform) {
        startX = parseFloat(transform[1]) + cellWidth;
        startY = parseFloat(transform[2]) + 24;
      }
    }
    if (toEl) {
      const transform = toEl.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
      if (transform) {
        endX = parseFloat(transform[1]);
        endY = parseFloat(transform[2]) + 24;
      }
    }

    // Calculate midpoint for elbow
    const midX = startX + (endX - startX) / 2;
    
    const path = createSvgElement('path', { 
      d: `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`,
      stroke: '#2b7',
      fill: 'none',
      'stroke-width': 1.5,
      'marker-end': 'url(#arrow)',
      class: 'relationship-line'
    });
    
    // Add cardinality markers
    const startMarker = createSvgElement('text', {
      x: startX + 10,
      y: startY - 5,
      'font-size': 12,
      class: 'cardinality-marker'
    });
    startMarker.textContent = '1';
    
    const endMarker = createSvgElement('text', {
      x: endX - 15,
      y: endY - 5,
      'font-size': 12,
      class: 'cardinality-marker'
    });
    endMarker.textContent = 'n';
    
    svg.appendChild(path);
    svg.appendChild(startMarker);
    svg.appendChild(endMarker);
  });

  // markers
  const defs = createSvgElement('defs');
  const marker = createSvgElement('marker', { id: 'arrow', markerWidth: 10, markerHeight: 10, refX: 6, refY: 3, orient: 'auto' });
  const arrowPath = createSvgElement('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#2b7' });
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.insertBefore(defs, svg.firstChild);

  // apply scale
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `scale(${diagramState.scale})`;
}

// Top-level: Drag & drop import support for JSON DB files on the left sidebar
(function setupDragDropImportTopLevel() {
  // Prevent default drag behaviors on window to avoid navigation
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', (e) => { e.preventDefault(); });

  const sidebar = document.getElementById('sidebar') || document.body;
  sidebar.addEventListener('dragover', (e) => { e.preventDefault(); sidebar.classList.add('drag-over'); });
  sidebar.addEventListener('dragleave', (e) => { sidebar.classList.remove('drag-over'); });
  sidebar.addEventListener('drop', async (e) => {
    e.preventDefault(); sidebar.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;
    // support multiple files but import first valid JSON
    let imported = 0;
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files[i];
      if (!file.name.toLowerCase().endsWith('.json')) continue;
      try {
        const text = await file.text();
        const newName = await window.dbapi.importDbFromJson(file.name, text);
        showToast(`Imported DB as ${newName}`, 'success');
        imported++;
      } catch (err) {
        console.error('Import failed', err);
        showToast(`Import failed (${file.name}): ${err.message || err}`, 'error');
      }
    }
    if (imported > 0) await refreshDbs();
  });
})();

// dragging support
let dragState = null;
let selection = new Set();
const GRID = 16;
const DEFAULT_CELL_WIDTH = 260;
let connections = []; // Store relationships globally

function makeGroupDraggable(group, tableName) {
  group.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const svg = document.getElementById('diagram');
    const transform = group.getAttribute('transform') || 'translate(0,0)';
    const m = transform.match(/translate\(([^,]+),([^\)]+)\)/);
    const startX = m ? parseFloat(m[1]) : 0;
    const startY = m ? parseFloat(m[2]) : 0;
    // multi-select handling: ctrl/cmd to toggle selection
    const isToggle = ev.ctrlKey || ev.metaKey;
    if (isToggle) {
      if (selection.has(tableName)) selection.delete(tableName); else selection.add(tableName);
      // visual cue
      updateSelectionVisuals();
    } else {
      if (!selection.has(tableName)) {
        selection.clear();
        selection.add(tableName);
      }
    }

    // Drag & drop import support for JSON DB files on the left sidebar
    // (drag/drop import was previously accidentally nested here; moved to top-level setup)

    dragState = { tableName, startX, startY, sx: ev.clientX, sy: ev.clientY, selected: Array.from(selection) };
    group.setPointerCapture(ev.pointerId);
    group.style.cursor = 'grabbing';
  });
  group.addEventListener('pointermove', (ev) => {
    if (!dragState || dragState.tableName !== tableName) return;
    ev.preventDefault();
    const dx = (ev.clientX - dragState.sx) / diagramState.scale;
    const dy = (ev.clientY - dragState.sy) / diagramState.scale;
    const nx = dragState.startX + dx;
    const ny = dragState.startY + dy;
    
    // Update positions object for relationship drawing
    const currentPositions = {...dbData._positions} || {};
    
    // if multiple selected, move all
    if (dragState.selected && dragState.selected.length > 1) {
      dragState.selected.forEach(tn => {
        const g = document.querySelector(`g.table-group[data-table="${tn}"]`);
        const orig = g.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
        const ox = orig ? parseFloat(orig[1]) : 0;
        const oy = orig ? parseFloat(orig[2]) : 0;
        g.setAttribute('transform', `translate(${ox + dx},${oy + dy})`);
        // Update position for relationships
        currentPositions[tn] = { x: ox + dx, y: oy + dy };
      });
    } else {
      group.setAttribute('transform', `translate(${nx},${ny})`);
      // Update position for relationships
      currentPositions[tableName] = { x: nx, y: ny };
    }
    
    // Redraw all relationships with updated positions
    drawRelationships(connections, currentPositions, DEFAULT_CELL_WIDTH);
  });
  group.addEventListener('pointerup', async (ev) => {
    if (!dragState || dragState.tableName !== tableName) return;
    
    // Update positions in dbData
    if (!dbData._positions) dbData._positions = {};
    if (dragState.selected && dragState.selected.length > 1) {
      dragState.selected.forEach(tn => {
        const g = document.querySelector(`g.table-group[data-table="${tn}"]`);
        const transform = g.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
        if (transform) {
          dbData._positions[tn] = { 
            x: parseFloat(transform[1]), 
            y: parseFloat(transform[2])
          };
        }
      });
    } else {
      const transform = group.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
      if (transform) {
        dbData._positions[tableName] = { 
          x: parseFloat(transform[1]), 
          y: parseFloat(transform[2])
        };
      }
    }
    ev.preventDefault();
    try { group.releasePointerCapture(ev.pointerId); } catch (e) {}
    group.style.cursor = 'grab';
    // persist position
    const svg = document.getElementById('diagram');
    const positions = {};
    svg.querySelectorAll('g.table-group').forEach(g => {
      const tn = g.getAttribute('data-table');
      const t = g.getAttribute('transform').match(/translate\(([^,]+),([^\)]+)\)/);
      let x = Math.round(parseFloat(t[1]));
      let y = Math.round(parseFloat(t[2]));
      // snap to grid
      x = Math.round(x / GRID) * GRID;
      y = Math.round(y / GRID) * GRID;
      g.setAttribute('transform', `translate(${x},${y})`);
      positions[tn] = { x, y };
    });
    try {
      await window.dbapi.savePositions(currentDb, positions);
    } catch (e) { console.warn('Failed to save positions', e); }
    dragState = null;
  });
}

function updateSelectionVisuals() {
  document.querySelectorAll('g.table-group').forEach(g => {
    const tn = g.getAttribute('data-table');
    if (selection.has(tn)) g.querySelector('rect').setAttribute('stroke', '#337ab7'); else g.querySelector('rect').setAttribute('stroke', '#888');
  });
}

// zoom controls
document.addEventListener('DOMContentLoaded', () => {
  const zin = document.getElementById('zoom-in');
  const zout = document.getElementById('zoom-out');
  const fit = document.getElementById('fit-diagram');
  if (zin) zin.onclick = () => { diagramState.scale = Math.min(2, diagramState.scale + 0.1); renderDiagram(); };
  if (zout) zout.onclick = () => { diagramState.scale = Math.max(0.4, diagramState.scale - 0.1); renderDiagram(); };
  if (fit) fit.onclick = () => { diagramState.scale = 1; renderDiagram(); };
  const autoBtn = document.getElementById('auto-layout');
  if (autoBtn) autoBtn.onclick = async () => {
  if (!currentDb) { showToast('Select a database first', 'error', 2500); return; }
    try {
      await window.dbapi.computeLayout(currentDb);
      dbData = await window.dbapi.getDb(currentDb);
      renderDiagram();
  } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error creating DB', 'error', 4000); } catch(err){} }
  };
});

async function showTableDetail(tableName) {
  const detail = $('#table-detail');
  const tbl = dbData.tables[tableName];
    const mainCols = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
    let tableRows = await window.dbapi.queryRows(currentDb, tableName);
    let currentSortColumn = null;
    let sortDirection = 'asc';
  
    detail.innerHTML = '';
  
    // Add table header
    const header = document.createElement('h4');
    header.textContent = tableName;
    detail.appendChild(header);
  
    // Add sort controls
    const sortControls = document.createElement('div');
    sortControls.style.marginBottom = '10px';
  
    const sortSelect = document.createElement('select');
    sortSelect.style.marginRight = '10px';
  
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '-- Select column to sort --';
    sortSelect.appendChild(defaultOption);
  
    // Add column options
    mainCols.forEach(c => {
      const option = document.createElement('option');
      option.value = c.name;
      option.textContent = `${c.name} (${c.type})`;
      sortSelect.appendChild(option);
    });
  
    const sortButton = document.createElement('button');
    sortButton.textContent = '↑ Sort Ascending';
  
    sortControls.appendChild(sortSelect);
    sortControls.appendChild(sortButton);
    detail.appendChild(sortControls);
  
    // Add columns info
    const columnsInfo = document.createElement('div');
    columnsInfo.textContent = `Columns: ${mainCols.map(c => `${c.name}:${c.type}`).join(', ')}`;
    detail.appendChild(columnsInfo);
  
    // Add insert section
    const insertHeader = document.createElement('h5');
    insertHeader.textContent = 'Insert Row';
    detail.appendChild(insertHeader);
  
    const insertFormContainer = document.createElement('div');
    insertFormContainer.id = 'insert-form';
    detail.appendChild(insertFormContainer);
  
    const insertButton = document.createElement('button');
    insertButton.id = 'insert-row-btn';
    insertButton.textContent = 'Insert';
    detail.appendChild(insertButton);
  
    // Add rows section
    const rowsHeader = document.createElement('h5');
    rowsHeader.textContent = 'Rows';
    detail.appendChild(rowsHeader);
  
    const rowsListContainer = document.createElement('div');
    rowsListContainer.id = 'rows-list';
    detail.appendChild(rowsListContainer);
  
    // Add delete table button
    const deleteContainer = document.createElement('div');
    deleteContainer.style.marginTop = '8px';
    const deleteButton = document.createElement('button');
    deleteButton.id = 'delete-table-btn';
    deleteButton.style.color = '#900';
    deleteButton.textContent = 'Delete Table';
    deleteContainer.appendChild(deleteButton);
    detail.appendChild(deleteContainer);
  
    // Add sort functionality
    sortButton.onclick = () => {
      const selectedColumn = sortSelect.value;
      if (!selectedColumn) {
        showToast('Please select a column to sort by', 'error', 2000);
        return;
      }
    
      if (currentSortColumn === selectedColumn) {
        // Toggle direction if same column
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        // New column, start with ascending
        currentSortColumn = selectedColumn;
        sortDirection = 'asc';
      }
    
      // Sort the rows array
        tableRows.sort((a, b) => {
        const aVal = a[selectedColumn];
        const bVal = b[selectedColumn];
      
        if (aVal === null || aVal === undefined) return 1;
        if (bVal === null || bVal === undefined) return -1;
      
        let comparison;
        const colType = mainCols.find(c => c.name === selectedColumn)?.type || 'string';
      
        if (colType === 'integer' || colType === 'real') {
          comparison = Number(aVal) - Number(bVal);
        } else if (colType === 'time') {
          comparison = new Date(aVal) - new Date(bVal);
        } else {
          comparison = String(aVal).localeCompare(String(bVal));
        }
      
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    
      // Update button text
      sortButton.textContent = sortDirection === 'asc' ? '↑ Sort Ascending' : '↓ Sort Descending';
    
      // Re-render rows
      renderRowsList();
    };

      // Function to render the rows list
      function renderRowsList() {
        const rowsList = $('#rows-list');
        rowsList.innerHTML = '';
        tableRows.forEach((r, idx) => {
          const rowWrap = document.createElement('div');
          rowWrap.style.borderTop = '1px solid #eee';
          rowWrap.style.padding = '6px 0';
          const view = document.createElement('div');
          view.innerHTML = `<pre>${JSON.stringify(r, null, 2)}</pre>`;
          rowWrap.appendChild(view);
          rowsList.appendChild(rowWrap);

          // Add edit and delete buttons
          const actions = document.createElement('div');
          const editBtn = document.createElement('button');
          editBtn.textContent = 'Edit';
          editBtn.style.marginRight = '8px';
          actions.appendChild(editBtn);

          const delRowBtn = document.createElement('button');
          delRowBtn.textContent = 'Delete';
          delRowBtn.style.marginLeft = '8px';
          actions.appendChild(delRowBtn);

          rowWrap.appendChild(actions);
        });
      }

      // Initial render of rows
      renderRowsList();

  // build insert form based on columns
  const insertForm = $('#insert-form');
  insertForm.innerHTML = '';
  const cols = tbl.columns.map(c => (typeof c === 'string' ? { name: c, type: 'string' } : c));
  const pkName = (dbData.tables[tableName] && dbData.tables[tableName]._pk) || (tableName + 'Id');
  cols.sort((a,b)=>{ if (a.name===pkName) return -1; if (b.name===pkName) return 1; return 0; });
  cols.forEach(c => {
    const row = document.createElement('div');
    row.style.marginBottom = '6px';
    
    // Create label
    const label = document.createElement('label');
    label.style.width = '120px';
    label.style.display = 'inline-block';
    label.textContent = `${c.name} (${c.type})`;
    row.appendChild(label);

    // Create input based on type
    let input;
    if (c.name === pkName) {
      input = document.createElement('input');
      input.disabled = true;
      input.setAttribute('data-col', c.name);
    } else {
      switch (c.type) {
        case 'time':
          input = createTimeInput();
          input.setAttribute('data-col', c.name);
          break;
        case 'timeInvl':
          input = createTimeIntervalInput();
          input.setAttribute('data-col', c.name);
          break;
        case 'integer':
          input = document.createElement('input');
          input.type = 'number';
          input.step = '1';
          input.setAttribute('data-col', c.name);
          break;
        case 'real':
          input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.setAttribute('data-col', c.name);
          break;
        case 'char':
          input = document.createElement('input');
          input.type = 'text';
          input.maxLength = 1;
          input.setAttribute('data-col', c.name);
          break;
        default:
          input = document.createElement('input');
          input.type = 'text';
          input.setAttribute('data-col', c.name);
      }
    }
    row.appendChild(input);
    insertForm.appendChild(row);
  });

  $('#insert-row-btn').onclick = async () => {
    try {
      const obj = {};
      // Збираємо всі інпути, включаючи спеціалізовані
      insertForm.querySelectorAll('[data-col]').forEach(inp => {
        const colName = inp.getAttribute('data-col');
        // Якщо це наш спеціалізований інпут з методом getValue
        if (inp.getValue) {
          obj[colName] = inp.getValue();
        } else {
          obj[colName] = inp.value;
        }
      });
      await window.dbapi.insertRow(currentDb, tableName, obj);
      dbData = await window.dbapi.getDb(currentDb);
      showTableDetail(tableName);
      renderDiagram();
  } catch (e) { cleanupAfterError(); try { showToast('Invalid data or error: ' + e.message, 'error', 4000); } catch(err){} }
  };

  $('#delete-table-btn').onclick = async () => {
    const ok = await showConfirm(`Delete table "${tableName}"? This will remove all rows.`);
    if (!ok) return;
    try {
      await window.dbapi.deleteTable(currentDb, tableName);
      // refresh both sidebar and current DB view
      await refreshDbs();
      dbData = await window.dbapi.getDb(currentDb);
      renderTables();
      // Ensure any open modals or editors related to this table are closed
      try {
        // hide specific edit-column modal if open
        const editModal = document.getElementById('edit-column-modal');
        if (editModal && editModal.classList.contains('show')) hideModal('edit-column-modal');
        // hide any generic modal backdrops that are still visible
        document.querySelectorAll('.modal-backdrop.show').forEach(m => m.classList.remove('show'));
      } catch(e) { /* non-fatal */ }
      // clear the table detail pane
      $('#table-detail').innerHTML = '';
      // if table settings panel was open for this table, hide it
      try {
        const ts = document.getElementById('table-settings');
        const titleEl = document.getElementById('table-settings-title');
        if (ts && ts.style.display === 'block' && titleEl && titleEl.textContent && titleEl.textContent.startsWith(tableName)) {
          ts.style.display = 'none';
        }
      } catch(e) {}
      renderDiagram();
  } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error', 'error', 4000); } catch(err){} }
  };

  const rows = await window.dbapi.queryRows(currentDb, tableName);
  const rowsList = $('#rows-list');
  rowsList.innerHTML = '';
  rows.forEach((r, idx) => {
    const rowWrap = document.createElement('div');
    rowWrap.style.borderTop = '1px solid #eee';
    rowWrap.style.padding = '6px 0';
    const view = document.createElement('div');
    view.innerHTML = `<pre>${JSON.stringify(r, null, 2)}</pre>`;
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.marginRight = '8px';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.display = 'none';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.display = 'none';

    rowWrap.appendChild(view);

    const editArea = document.createElement('div');
    editArea.style.display = 'none';
    const pkNameRow = (dbData.tables && dbData.tables[tableName] && dbData.tables[tableName]._pk) || (tableName + 'Id');
    cols.forEach(c => {
      const rdiv = document.createElement('div');
      rdiv.style.marginBottom = '4px';
      
      // Create label
      const label = document.createElement('label');
      label.style.width = '120px';
      label.style.display = 'inline-block';
      label.textContent = `${c.name} (${c.type})`;
      rdiv.appendChild(label);

      // Create input based on type
      let input;
      if (c.name === pkNameRow) {
        input = document.createElement('input');
        input.disabled = true;
        input.setAttribute('data-col', c.name);
        input.value = r[c.name] ?? '';
      } else {
        switch (c.type) {
          case 'time':
            input = createTimeInput();
            input.setAttribute('data-col', c.name);
            input.setValue(r[c.name] ?? '');
            break;
          case 'timeInvl':
            input = createTimeIntervalInput();
            input.setAttribute('data-col', c.name);
            input.setValue(r[c.name] ?? '');
            break;
          case 'integer':
            input = document.createElement('input');
            input.type = 'number';
            input.step = '1';
            input.setAttribute('data-col', c.name);
            input.value = r[c.name] ?? '';
            break;
          case 'real':
            input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.setAttribute('data-col', c.name);
            input.value = r[c.name] ?? '';
            break;
          case 'char':
            input = document.createElement('input');
            input.type = 'text';
            input.maxLength = 1;
            input.setAttribute('data-col', c.name);
            input.value = r[c.name] ?? '';
            break;
          default:
            input = document.createElement('input');
            input.type = 'text';
            input.setAttribute('data-col', c.name);
            input.value = r[c.name] ?? '';
        }
      }
      rdiv.appendChild(input);
      editArea.appendChild(rdiv);
    });

    const actions = document.createElement('div');
    actions.appendChild(editBtn);
    const delRowBtn = document.createElement('button');
    delRowBtn.textContent = 'Delete';
    delRowBtn.style.marginLeft = '8px';
    delRowBtn.onclick = async () => {
      const ok = await showConfirm(`Delete this row? This cannot be undone.`);
      if (!ok) return;
      try {
        await window.dbapi.deleteRow(currentDb, tableName, idx);
        dbData = await window.dbapi.getDb(currentDb);
        // refresh table detail and sidebar
        showTableDetail(tableName);
        await refreshDbs();
        renderDiagram();
      } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error deleting row', 'error', 4000); } catch(err){} }
    };
    actions.appendChild(delRowBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    rowWrap.appendChild(actions);
    rowWrap.appendChild(editArea);

    editBtn.onclick = () => {
      view.style.display = 'none';
      editArea.style.display = 'block';
      editBtn.style.display = 'none';
      saveBtn.style.display = 'inline-block';
      cancelBtn.style.display = 'inline-block';
    };
    cancelBtn.onclick = () => {
      view.style.display = 'block';
      editArea.style.display = 'none';
      editBtn.style.display = 'inline-block';
      saveBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
    };
    saveBtn.onclick = async () => {
      try {
        const obj = {};
        // Збираємо всі інпути, включаючи спеціалізовані
        editArea.querySelectorAll('[data-col]').forEach(inp => {
          const colName = inp.getAttribute('data-col');
          // Якщо це наш спеціалізований інпут з методом getValue
          if (inp.getValue) {
            obj[colName] = inp.getValue();
          } else {
            obj[colName] = inp.value;
          }
        });
        await window.dbapi.updateRow(currentDb, tableName, idx, obj);
        dbData = await window.dbapi.getDb(currentDb);
        showTableDetail(tableName);
        renderDiagram();
  } catch (e) { cleanupAfterError(); try { showToast('Invalid data or error: ' + e.message, 'error', 4000); } catch(err){} }
    };

    rowsList.appendChild(rowWrap);
  });
}

// Utility functions for creating specialized inputs
function createTimeInput() {
  const container = document.createElement('div');
  container.style.display = 'inline-block';
  container.style.position = 'relative';
  
  // Create time input
  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.step = '1'; // Allow seconds
  timeInput.style.padding = '4px';
  timeInput.style.width = '140px';
  
  // Create a wrapper for the clock icon button
  const clockWrapper = document.createElement('div');
  clockWrapper.style.display = 'inline-block';
  clockWrapper.style.marginLeft = '4px';
  clockWrapper.style.verticalAlign = 'middle';
  clockWrapper.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" style="cursor:pointer">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M12 6v6l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
  
  // Create the time picker popup
  const popup = document.createElement('div');
  popup.style.display = 'none';
  popup.style.position = 'absolute';
  popup.style.top = '100%';
  popup.style.left = '0';
  popup.style.backgroundColor = 'white';
  popup.style.border = '1px solid #ccc';
  popup.style.borderRadius = '4px';
  popup.style.padding = '8px';
  popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
  popup.style.zIndex = '1000';
  popup.style.width = '250px';
  
  // Add time picker content
  const timePickerContent = document.createElement('div');
  timePickerContent.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:8px">
      <div>
        <label>Hours</label>
        <select class="hours" style="width:60px">
          ${Array.from({length: 24}, (_, i) => 
            `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
          ).join('')}
        </select>
      </div>
      <div>
        <label>Minutes</label>
        <select class="minutes" style="width:60px">
          ${Array.from({length: 60}, (_, i) => 
            `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
          ).join('')}
        </select>
      </div>
      <div>
        <label>Seconds</label>
        <select class="seconds" style="width:60px">
          ${Array.from({length: 60}, (_, i) => 
            `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
          ).join('')}
        </select>
      </div>
    </div>
    <div style="text-align:center">
      <button class="apply-time">Apply</button>
      <button class="cancel-time">Cancel</button>
    </div>
  `;
  popup.appendChild(timePickerContent);
  
  // Add event listeners
  clockWrapper.onclick = () => {
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
    if (popup.style.display === 'block') {
      const currentValue = timeInput.value;
      if (currentValue) {
        const [hours, minutes, seconds] = currentValue.split(':');
        popup.querySelector('.hours').value = hours;
        popup.querySelector('.minutes').value = minutes;
        if (seconds) popup.querySelector('.seconds').value = seconds;
      }
    }
  };
  
  popup.querySelector('.apply-time').onclick = () => {
    const hours = popup.querySelector('.hours').value;
    const minutes = popup.querySelector('.minutes').value;
    const seconds = popup.querySelector('.seconds').value;
    timeInput.value = `${hours}:${minutes}:${seconds}`;
    popup.style.display = 'none';
  };
  
  popup.querySelector('.cancel-time').onclick = () => {
    popup.style.display = 'none';
  };
  
  // Close popup when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      popup.style.display = 'none';
    }
  });
  
  container.appendChild(timeInput);
  container.appendChild(clockWrapper);
  container.appendChild(popup);
  
  // Helper to get/set value
  container.getValue = () => timeInput.value;
  container.setValue = (val) => { timeInput.value = val; };
  
  return container;
}

function createTimeIntervalInput() {
  const container = document.createElement('div');
  container.style.display = 'inline-block';
  container.style.position = 'relative';
  
  // Create interval input
  const timeInput = document.createElement('input');
  timeInput.type = 'text';
  timeInput.placeholder = 'HH:MM:SS';
  timeInput.style.padding = '4px';
  timeInput.style.width = '140px';
  
  // Create the interval picker popup
  const popup = document.createElement('div');
  popup.style.display = 'none';
  popup.style.position = 'absolute';
  popup.style.top = '100%';
  popup.style.left = '0';
  popup.style.backgroundColor = 'white';
  popup.style.border = '1px solid #ccc';
  popup.style.borderRadius = '4px';
  popup.style.padding = '12px';
  popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
  popup.style.zIndex = '1000';
  popup.style.width = '300px';
  
  // Add interval picker content
  const pickerContent = document.createElement('div');
  pickerContent.innerHTML = `
    <style>
      .interval-input { width: 65px; padding: 4px; border: 1px solid #ccc; border-radius: 4px; }
      .interval-slider { width: 100%; margin: 8px 0; }
      .interval-label { display: block; margin-bottom: 4px; color: #666; }
      .quick-presets { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee; }
      .preset-btn { margin: 2px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; 
                    background: #f8f8f8; cursor: pointer; font-size: 12px; }
      .preset-btn:hover { background: #eee; }
    </style>
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <label class="interval-label">Hours</label>
          <input type="number" class="hours interval-input" min="0" value="0">
          <input type="range" class="hours-slider interval-slider" min="0" max="99" value="0">
        </div>
        <div>
          <label class="interval-label">Minutes</label>
          <input type="number" class="minutes interval-input" min="0" max="59" value="0">
          <input type="range" class="minutes-slider interval-slider" min="0" max="59" value="0">
        </div>
        <div>
          <label class="interval-label">Seconds</label>
          <input type="number" class="seconds interval-input" min="0" max="59" value="0">
          <input type="range" class="seconds-slider interval-slider" min="0" max="59" value="0">
        </div>
      </div>
      <div class="quick-presets">
        <label class="interval-label">Quick Presets:</label>
        <div>
          <button class="preset-btn" data-hours="0" data-minutes="30" data-seconds="0">30 min</button>
          <button class="preset-btn" data-hours="1" data-minutes="0" data-seconds="0">1 hour</button>
          <button class="preset-btn" data-hours="2" data-minutes="0" data-seconds="0">2 hours</button>
          <button class="preset-btn" data-hours="24" data-minutes="0" data-seconds="0">24 hours</button>
          <button class="preset-btn" data-hours="168" data-minutes="0" data-seconds="0">1 week</button>
        </div>
      </div>
    </div>
    <div style="text-align:right">
      <button class="apply-time" style="margin-right:8px;padding:4px 12px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer">Apply</button>
      <button class="cancel-time" style="padding:4px 12px;background:#f8f8f8;border:1px solid #ddd;border-radius:4px;cursor:pointer">Cancel</button>
    </div>
  `;
  popup.appendChild(pickerContent);
  
  // Add icon button with hourglass icon
  const iconWrapper = document.createElement('div');
  iconWrapper.style.display = 'inline-block';
  iconWrapper.style.marginLeft = '4px';
  iconWrapper.style.verticalAlign = 'middle';
  iconWrapper.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" style="cursor:pointer">
      <path d="M12 2C8 2 4 3 4 6v2c0 2 3 4 4 4 1 0 4-2 4-4V6c0-1.5-2-2-4-2s-4 .5-4 2m8 0c0-1.5 2-2 4-2s4 .5 4 2v2c0 2-3 4-4 4-1 0-4-2-4-4V6z" 
            fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M12 22c4 0 8-1 8-4v-2c0-2-3-4-4-4-1 0-4 2-4 4v2c0 1.5 2 2 4 2s4-.5 4-2m-8 0c0 1.5-2 2-4 2s-4-.5-4-2v-2c0-2 3-4 4-4 1 0 4 2 4 4v2z"
            fill="none" stroke="currentColor" stroke-width="1.5"/>
    </svg>
  `;
  
  // Sync number inputs with sliders
  function setupSliderSync(className) {
    const input = popup.querySelector(`.${className}.interval-input`);
    const slider = popup.querySelector(`.${className}-slider`);
    
    input.addEventListener('input', () => {
      slider.value = input.value;
      updateTimeInput();
    });
    
    slider.addEventListener('input', () => {
      input.value = slider.value;
      updateTimeInput();
    });
  }
  
  function updateTimeInput() {
    const hours = popup.querySelector('.hours').value.padStart(2, '0');
    const minutes = popup.querySelector('.minutes').value.padStart(2, '0');
    const seconds = popup.querySelector('.seconds').value.padStart(2, '0');
    timeInput.value = `${hours}:${minutes}:${seconds}`;
  }
  
  setupSliderSync('hours');
  setupSliderSync('minutes');
  setupSliderSync('seconds');
  
  // Setup preset buttons
  popup.querySelectorAll('.preset-btn').forEach(btn => {
    btn.onclick = () => {
      const hours = btn.dataset.hours;
      const minutes = btn.dataset.minutes;
      const seconds = btn.dataset.seconds;
      
      popup.querySelector('.hours').value = hours;
      popup.querySelector('.minutes').value = minutes;
      popup.querySelector('.seconds').value = seconds;
      
      popup.querySelector('.hours-slider').value = hours;
      popup.querySelector('.minutes-slider').value = minutes;
      popup.querySelector('.seconds-slider').value = seconds;
      
      updateTimeInput();
    };
  });
  
  // Add event listeners
  iconWrapper.onclick = () => {
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
    if (popup.style.display === 'block') {
      const currentValue = timeInput.value;
      if (currentValue) {
        const [hours, minutes, seconds] = currentValue.split(':');
        if (hours) {
          popup.querySelector('.hours').value = parseInt(hours);
          popup.querySelector('.hours-slider').value = parseInt(hours);
        }
        if (minutes) {
          popup.querySelector('.minutes').value = parseInt(minutes);
          popup.querySelector('.minutes-slider').value = parseInt(minutes);
        }
        if (seconds) {
          popup.querySelector('.seconds').value = parseInt(seconds);
          popup.querySelector('.seconds-slider').value = parseInt(seconds);
        }
      }
    }
  };
  
  popup.querySelector('.apply-time').onclick = () => {
    updateTimeInput();
    popup.style.display = 'none';
  };
  
  popup.querySelector('.cancel-time').onclick = () => {
    popup.style.display = 'none';
  };
  
  // Close popup when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      popup.style.display = 'none';
    }
  });
  
  container.appendChild(timeInput);
  container.appendChild(iconWrapper);
  container.appendChild(popup);
  
  // Helper to get/set value
  container.getValue = () => timeInput.value;
  container.setValue = (val) => {
    timeInput.value = val;
    if (val) {
      const [hours, minutes, seconds] = val.split(':');
      if (hours) {
        popup.querySelector('.hours').value = parseInt(hours);
        popup.querySelector('.hours-slider').value = parseInt(hours);
      }
      if (minutes) {
        popup.querySelector('.minutes').value = parseInt(minutes);
        popup.querySelector('.minutes-slider').value = parseInt(minutes);
      }
      if (seconds) {
        popup.querySelector('.seconds').value = parseInt(seconds);
        popup.querySelector('.seconds-slider').value = parseInt(seconds);
      }
    }
  };
  
  return container;
}

window.addEventListener('DOMContentLoaded', () => {
  refreshDbs();
  $('#create-db').onclick = async () => {
    const inputEl = document.getElementById('new-db-name');
    const name = inputEl.value.trim();
    if (!name) {
      cleanupAfterError();
      try { inputEl.disabled = false; inputEl.readOnly = false; showToast('Enter a name', 'error', 2500); inputEl.focus(); inputEl.select(); } catch(e){}
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      cleanupAfterError();
      try { inputEl.disabled = false; inputEl.readOnly = false; showToast('Invalid database name. Use letters, digits and underscore, starting with a letter or underscore.', 'error', 3500); inputEl.focus(); inputEl.select(); } catch(e){}
      return;
    }
    try {
      await window.dbapi.createDb(name);
      $('#new-db-name').value = '';
      await refreshDbs();
  } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error', 'error', 4000); } catch(err){} }
  };

  // export/import
  const exportBtn = document.getElementById('export-db-btn');
  const importBtn = document.getElementById('import-db-btn');
  if (exportBtn) exportBtn.onclick = async () => {
    if (!currentDb) { showToast('Select a database to export', 'error', 2500); return; }
    try {
      const ok = await window.dbapi.exportDb(currentDb);
      if (ok) showToast('Exported', 'info', 2000);
  } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error exporting', 'error', 4000); } catch(err){} }
  };
  if (importBtn) importBtn.onclick = async () => {
    try {
      const ok = await window.dbapi.importDb();
      if (ok) {
        await refreshDbs();
        showToast('Imported', 'info', 2000);
      }
    } catch (e) { showToast(e.message || 'Error importing', 'error', 4000); }
  };

  // Create Table via modal
  document.getElementById('create-table-global').onclick = () => {
    if (!currentDb) { showToast('Select a database first', 'error', 2500); return; }
  showModal('create-table-modal');
    document.getElementById('modal-table-name').value = '';
  };
  document.getElementById('modal-cancel').onclick = () => { hideModal('create-table-modal'); };
  document.getElementById('modal-create-table').onclick = async () => {
    const tableName = document.getElementById('modal-table-name').value.trim();
    const modalInput = document.getElementById('modal-table-name');
    if (!tableName) {
      try { modalInput.disabled = false; modalInput.readOnly = false; showToast('Provide table name', 'error', 2500); modalInput.focus(); modalInput.select(); } catch(e){}
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      try { modalInput.disabled = false; modalInput.readOnly = false; showToast('Invalid table name. Use letters, digits and underscore, starting with a letter or underscore.', 'error', 3500); modalInput.focus(); modalInput.select(); } catch(e){}
      return;
    }
    try {
      // create table and let backend create the per-table primary key (tableName + 'id')
      await window.dbapi.createTable(currentDb, tableName, []);
      hideModal('create-table-modal');
      dbData = await window.dbapi.getDb(currentDb);
      await refreshDbs();
      renderTables();
      renderDiagram();
      // open settings immediately so user can add columns
      openTableSettings(currentDb, tableName);
    } catch (e) { 
      // ensure modal/backdrop are not left visible
      cleanupAfterError();
      try { showToast(e.message || 'Error creating table', 'error', 4000); } catch(err){}
    }
  };

  // no inline columns editor anymore; create-table uses modal + table settings
});

async function openTableSettings(dbName, tableName) {
  currentDb = dbName;
  $('#db-title').textContent = `DB: ${dbName}`;
  $('#tables-section').style.display = 'block';
  dbData = await window.dbapi.getDb(dbName);
  // set table settings area
  $('#table-settings-title').textContent = `${tableName} — columns`;
  const colsWrap = $('#table-columns-list');
  colsWrap.innerHTML = '';
  const cols = (dbData.tables[tableName].columns || []).map(c => (typeof c === 'string' ? { name: c, type: 'string', default: '' } : c));
  const pkName = (dbData.tables[tableName] && dbData.tables[tableName]._pk) || (tableName + 'Id');
  cols.forEach(c => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.marginBottom = '6px';
    row.innerHTML = `<div style="flex:1">${c.name} : ${c.type} (default: ${c.default ?? ''})</div>`;
    // badges for pk/nullable
    const badges = document.createElement('div');
    badges.style.marginRight = '8px';
    if (c.pk) {
      const b = document.createElement('span'); b.textContent = 'PK'; b.style.background = '#ffd700'; b.style.padding = '2px 6px'; b.style.marginRight='6px'; b.style.borderRadius='4px'; badges.appendChild(b);
    }
    if (c.nullable) {
      const b = document.createElement('span'); b.textContent = 'NULL'; b.style.background = '#d0f0ff'; b.style.padding = '2px 6px'; b.style.marginRight='6px'; b.style.borderRadius='4px'; badges.appendChild(b);
    }
    if (c.fk) {
      const b = document.createElement('span'); b.textContent = `FK→${c.fk.table}.${c.fk.column}`; b.style.background = '#a6e4a6'; b.style.padding = '2px 6px'; b.style.marginRight='6px'; b.style.borderRadius='4px'; badges.appendChild(b);
    }
    row.insertBefore(badges, row.firstChild);

    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    // prevent removing the primary key column
    if (c.name === pkName) {
      rm.disabled = true;
      rm.title = `${pkName} column is required`;
    } else {
      rm.onclick = async () => {
        const ok = await showConfirm(`Remove column ${c.name}?`);
        if (!ok) return;
        try {
          await window.dbapi.removeColumn(dbName, tableName, c.name);
          await refreshAllViews(dbName, tableName);
        } catch (e) { cleanupAfterError(); try { showToast(e.message || 'Error', 'error', 4000); } catch(err){} }
      };
    }
    row.appendChild(rm);
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.style.marginLeft = '6px';
    // prevent renaming the primary key column
    if (c.name === pkName) {
      editBtn.onclick = () => { showToast(`${pkName} column cannot be renamed`, 'info', 2000); };
    } else {
      editBtn.onclick = () => { openEditColumnModal(dbName, tableName, c); };
    }
    row.appendChild(editBtn);
    colsWrap.appendChild(row);
  });
  $('#table-settings').style.display = 'block';
  // set add column button
  // Function to create specialized input for time
  function createTimeInput() {
    const container = document.createElement('div');
    container.style.display = 'inline-block';
    container.style.position = 'relative';
    
    // Create time input
    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.step = '1'; // Allow seconds
    timeInput.style.padding = '4px';
    timeInput.style.width = '140px';
    
    // Create a wrapper for the clock icon button
    const clockWrapper = document.createElement('div');
    clockWrapper.style.display = 'inline-block';
    clockWrapper.style.marginLeft = '4px';
    clockWrapper.style.verticalAlign = 'middle';
    clockWrapper.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" style="cursor:pointer">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M12 6v6l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    
    // Create the time picker popup
    const popup = document.createElement('div');
    popup.style.display = 'none';
    popup.style.position = 'absolute';
    popup.style.top = '100%';
    popup.style.left = '0';
    popup.style.backgroundColor = 'white';
    popup.style.border = '1px solid #ccc';
    popup.style.borderRadius = '4px';
    popup.style.padding = '8px';
    popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
    popup.style.zIndex = '1000';
    popup.style.width = '250px';
    
    // Add time picker content
    const timePickerContent = document.createElement('div');
    timePickerContent.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <div>
          <label>Hours</label>
          <select class="hours" style="width:60px">
            ${Array.from({length: 24}, (_, i) => 
              `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label>Minutes</label>
          <select class="minutes" style="width:60px">
            ${Array.from({length: 60}, (_, i) => 
              `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
            ).join('')}
          </select>
        </div>
        <div>
          <label>Seconds</label>
          <select class="seconds" style="width:60px">
            ${Array.from({length: 60}, (_, i) => 
              `<option value="${i.toString().padStart(2, '0')}">${i.toString().padStart(2, '0')}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div style="text-align:center">
        <button class="apply-time">Apply</button>
        <button class="cancel-time">Cancel</button>
      </div>
    `;
    popup.appendChild(timePickerContent);
    
    // Add event listeners
    clockWrapper.onclick = () => {
      popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
      if (popup.style.display === 'block') {
        const currentValue = timeInput.value;
        if (currentValue) {
          const [hours, minutes, seconds] = currentValue.split(':');
          popup.querySelector('.hours').value = hours;
          popup.querySelector('.minutes').value = minutes;
          if (seconds) popup.querySelector('.seconds').value = seconds;
        }
      }
    };
    
    popup.querySelector('.apply-time').onclick = () => {
      const hours = popup.querySelector('.hours').value;
      const minutes = popup.querySelector('.minutes').value;
      const seconds = popup.querySelector('.seconds').value;
      timeInput.value = `${hours}:${minutes}:${seconds}`;
      popup.style.display = 'none';
    };
    
    popup.querySelector('.cancel-time').onclick = () => {
      popup.style.display = 'none';
    };
    
    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        popup.style.display = 'none';
      }
    });
    
    container.appendChild(timeInput);
    container.appendChild(clockWrapper);
    container.appendChild(popup);
    
    // Helper to get/set value
    container.getValue = () => timeInput.value;
    container.setValue = (val) => { timeInput.value = val; };
    
    return container;
  }

  // Function to create specialized input for time interval
  function createTimeIntervalInput() {
    const container = document.createElement('div');
    container.style.display = 'inline-block';
    
    const hours = document.createElement('input');
    hours.type = 'number';
    hours.min = '0';
    hours.style.width = '50px';
    
    const minutes = document.createElement('input');
    minutes.type = 'number';
    minutes.min = '0';
    minutes.max = '59';
    minutes.style.width = '50px';
    
    const seconds = document.createElement('input');
    seconds.type = 'number';
    seconds.min = '0';
    seconds.max = '59';
    seconds.style.width = '50px';

    container.appendChild(hours);
    container.appendChild(document.createTextNode(':'));
    container.appendChild(minutes);
    container.appendChild(document.createTextNode(':'));
    container.appendChild(seconds);

    // Helper to get/set value
    container.getValue = () => {
      if (!hours.value || !minutes.value || !seconds.value) return '';
      return `${hours.value}:${minutes.value.padStart(2, '0')}:${seconds.value.padStart(2, '0')}`;
    };
    container.setValue = (val) => {
      if (!val) return;
      const parts = val.split(':');
      if (parts.length === 3) {
        hours.value = parseInt(parts[0]);
        minutes.value = parseInt(parts[1]);
        seconds.value = parseInt(parts[2]);
      }
    };
    
    return container;
  }

  // Function to create number input with validation
  function createNumberInput(isInteger) {
    const input = document.createElement('input');
    input.type = 'number';
    if (isInteger) {
      input.step = '1';
    } else {
      input.step = 'any';
    }
    input.getValue = () => input.value;
    input.setValue = (val) => input.value = val;
    return input;
  }

  // Update default input based on type
  let specializedInput = null;
  $('#col-type').onchange = () => {
    const type = $('#col-type').value;
    const defaultContainer = $('#default-container');
    const oldInput = specializedInput || $('#col-default');
    const oldValue = specializedInput ? specializedInput.getValue() : oldInput.value;

    // Remove old specialized input if exists
    if (specializedInput) {
      defaultContainer.removeChild(specializedInput);
      specializedInput = null;
    }

    switch(type) {
      case 'integer':
        specializedInput = createNumberInput(true);
        break;
      case 'real':
        specializedInput = createNumberInput(false);
        break;
      case 'char':
        specializedInput = document.createElement('input');
        specializedInput.type = 'text';
        specializedInput.maxLength = 1;
        specializedInput.getValue = () => specializedInput.value;
        specializedInput.setValue = (val) => specializedInput.value = val;
        break;
      case 'time':
        specializedInput = createTimeInput();
        break;
      case 'timeInvl':
        specializedInput = createTimeIntervalInput();
        break;
      case 'string':
        specializedInput = document.createElement('input');
        specializedInput.type = 'text';
        specializedInput.getValue = () => specializedInput.value;
        specializedInput.setValue = (val) => specializedInput.value = val;
        break;
    }

    if (specializedInput) {
      defaultContainer.appendChild(specializedInput);
      $('#col-default').style.display = 'none';
      specializedInput.setValue(oldValue);
    } else {
      $('#col-default').style.display = 'inline';
    }
  };

  $('#add-column-btn').onclick = async () => {
    const name = $('#col-name').value.trim();
    const type = $('#col-type').value;
    const def = $('#col-default').value.trim();
    const pk = document.getElementById('col-pk').checked;
    const nullable = document.getElementById('col-nullable').checked;
    const fkTarget = document.getElementById('col-fk-target').value;
    const fkOn = document.getElementById('col-fk-ondelete').value;

    if (!name) { showToast('Provide column name', 'error', 2000); return; }
    
    // Validate default value if provided
    if (def && !nullable) {
      const defaultInput = $('#col-default');
      switch(type) {
        case 'integer':
          if (!/^-?\d+$/.test(def)) {
            showToast('Default value must be a whole number', 'error', 2500);
            return;
          }
          break;
        case 'real':
          if (!/^-?\d*\.?\d+$/.test(def)) {
            showToast('Default value must be a number', 'error', 2500);
            return;
          }
          break;
        case 'char':
          if (def.length !== 1) {
            showToast('Default value must be a single character', 'error', 2500);
            return;
          }
          break;
        case 'time':
          if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(def)) {
            showToast('Default value must be in format HH:MM or HH:MM:SS', 'error', 2500);
            return;
          }
          break;
        case 'timeInvl':
          if (!/^([0-9]+:[0-5][0-9]:[0-5][0-9])|([0-9]+:[0-5][0-9])$/.test(def)) {
            showToast('Default value must be in format HH:MM:SS', 'error', 2500);
            return;
          }
          break;
      }
    }
  const addPkName = (dbData.tables[tableName] && dbData.tables[tableName]._pk) || (tableName + 'Id');
  if (name === addPkName) { showToast(`${addPkName} column already exists and cannot be added`, 'error', 3000); return; }
    try {
  // validate duplicate FK target in this table
      if (fkTarget) {
        const parts = fkTarget.split(':');
        if (parts.length >= 2) {
          const tgtTable = parts[0];
          const tgtCol = parts[1];
          const existingFk = (dbData.tables[tableName].columns || []).some(c => {
            if (typeof c === 'string') return false;
            return c.fk && c.fk.table === tgtTable && c.fk.column === tgtCol;
          });
          if (existingFk) {
            showToast(`Foreign key to ${tgtTable}.${tgtCol} already exists in ${tableName}`, 'error', 3500);
            return;
          }
        }
      }

      const payload = { name, type, default: def, pk: pk, nullable: nullable };
      if (fkTarget) {
        // fkTarget is like "OtherTable:OtherTableId"
        const parts = fkTarget.split(':');
        payload.fk = { table: parts[0], column: parts[1], onDelete: fkOn };
      }
      await window.dbapi.addColumn(dbName, tableName, payload);
      $('#col-name').value = '';
      $('#col-default').value = '';
      dbData = await window.dbapi.getDb(dbName);
      await refreshDbs();
      renderTables();
      renderDiagram();
      openTableSettings(dbName, tableName);
  } catch (e) { showToast(e.message || 'Error', 'error', 4000); }
  };

  // populate FK target select with other tables and their PKs
  const fkSelect = document.getElementById('col-fk-target');
  if (fkSelect) {
    fkSelect.innerHTML = '<option value="">-- none --</option>';
    Object.keys(dbData.tables).forEach(tn => {
      if (tn === tableName) return;
      const pk = (dbData.tables[tn] && dbData.tables[tn]._pk) || (tn + 'Id');
      const opt = document.createElement('option');
      opt.value = `${tn}:${pk}`;
      opt.textContent = `${tn} → ${pk}`;
      fkSelect.appendChild(opt);
    });
    // when user selects an FK target, auto-fill the column name with the target PK name
    fkSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (!val) return;
      const parts = val.split(':');
      if (parts.length >= 2) {
        const suggested = parts[1];
        // Only overwrite if name is empty or user hasn't typed a custom name
        const nameInput = document.getElementById('col-name');
        if (nameInput) {
          // if input is empty or matches a previous suggestion, set it
          if (!nameInput.value || nameInput.value.trim() === '') {
            nameInput.value = suggested;
          }
        }
      }
    });
  }
}
