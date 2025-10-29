# Mini DB Manager

A small monolithic Electron app implementing a simple DB manager inspired by DBeaver. Databases are stored as JSON files in the Electron `userData` folder.

Quick start (Windows PowerShell):

1. Install dependencies:

   npm install

2. Run the app:

   npm start

Data location:

- Databases are saved to: `%APPDATA%\..\Local\<Your App Data>\mini-db-data` (Electron userData). Each database is a JSON file named <dbname>.json.

Notes:

- This is a minimal prototype. Next steps: add schema editing, query builder, export/import, and packaging scripts.

Data types and validation:

- Supported column types: `integer`, `real`, `char`, `string`.
- When creating a table, specify columns using `name:type` pairs separated by commas. Example: `id:integer,name:string,flag:char`.
- Insert and edit operations validate values against column types. `char` requires exactly one character; `integer` requires whole numbers; `real` accepts floating numbers.

Table creation UI:

- Use the "Add column" button to add column rows. For each column you can specify:
   - `name` — column name
   - `type` — one of integer, real, char, string
   - `default` — default value applied when inserting/editing if user leaves the field empty

Defaults: when inserting a row, any missing field will be filled with the column's default value before validation.

Create table workflow:

- Press "Create Table in selected DB". A modal will open where you enter the table name. The table is created empty.
- After creation, the app will open the table settings where you can add columns (name/type/default). Newly added columns appear under the table name in the sidebar.
