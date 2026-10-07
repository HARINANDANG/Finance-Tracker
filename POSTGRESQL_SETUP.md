# PostgreSQL setup

This app now stores data in PostgreSQL instead of `data/db.json`.

## Default local setup

Running the app starts a project-local PostgreSQL server on port `55432`:

```powershell
npm start
```

The local database files live in `.postgres-data`. On first startup, the app creates the database, tables, and imports the existing `data/db.json` data.

Use this to stop the project-local PostgreSQL server:

```powershell
npm run db:stop
```

## Use another PostgreSQL server

Set either a full connection string:

```powershell
$env:DATABASE_URL="postgres://postgres:your_password@localhost:5432/student_finance_tracker"
npm start
```

Or individual PostgreSQL variables:

```powershell
$env:PGHOST="localhost"
$env:PGPORT="5432"
$env:PGDATABASE="student_finance_tracker"
$env:PGUSER="postgres"
$env:PGPASSWORD="your_password"
npm start
```

The database named by `PGDATABASE` or `DATABASE_URL` must already exist when using an external PostgreSQL server. On startup, the app creates its own tables and imports the existing `data/db.json` data if the PostgreSQL categories table is empty.
