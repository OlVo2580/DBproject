const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dbapi', {
  listDbs: () => ipcRenderer.invoke('list-dbs'),
  createDb: (name) => ipcRenderer.invoke('create-db', name),
  getDb: (name) => ipcRenderer.invoke('get-db', name),
  createTable: (dbName, tableName, columns) => ipcRenderer.invoke('create-table', dbName, tableName, columns),
  insertRow: (dbName, tableName, row) => ipcRenderer.invoke('insert-row', dbName, tableName, row),
  queryRows: (dbName, tableName) => ipcRenderer.invoke('query-rows', dbName, tableName),
  deleteTable: (dbName, tableName) => ipcRenderer.invoke('delete-table', dbName, tableName),
  deleteDb: (dbName) => ipcRenderer.invoke('delete-db', dbName),
  updateRow: (dbName, tableName, rowIndex, newRow) => ipcRenderer.invoke('update-row', dbName, tableName, rowIndex, newRow),
  deleteRow: (dbName, tableName, rowIndex) => ipcRenderer.invoke('delete-row', dbName, tableName, rowIndex),
  addColumn: (dbName, tableName, column) => ipcRenderer.invoke('add-column', dbName, tableName, column),
  removeColumn: (dbName, tableName, columnName) => ipcRenderer.invoke('remove-column', dbName, tableName, columnName),
  exportDb: (dbName) => ipcRenderer.invoke('export-db', dbName),
  importDb: () => ipcRenderer.invoke('import-db'),
   importDbFromJson: (fileName, fileContent) => ipcRenderer.invoke('import-db-from-json', fileName, fileContent),
  computeLayout: (dbName) => ipcRenderer.invoke('compute-layout', dbName),
  savePositions: (dbName, positions) => ipcRenderer.invoke('save-positions', dbName, positions),
  updateColumn: (dbName, tableName, columnName, newMeta) => ipcRenderer.invoke('update-column', dbName, tableName, columnName, newMeta),
  renameColumn: (dbName, tableName, oldName, newName) => ipcRenderer.invoke('rename-column', dbName, tableName, oldName, newName),
});
