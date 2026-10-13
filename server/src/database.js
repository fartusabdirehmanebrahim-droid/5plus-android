// One async database interface for the app, on either:
//  - PostgreSQL (for example Supabase), when DATABASE_URL is set, or
//  - SQLite (a file in DATA_DIR), otherwise. The demo page also uses this with its in-browser engine.
//
//   await db.get(sql, ...params)  first row or undefined
//   await db.all(sql, ...params)  all rows
//   await db.run(sql, ...params)  { changes, lastInsertRowid }
//   await db.exec(sql)            several statements (schema)
//   await db.tx(async () => …)    a transaction; every query inside it (even in helper functions) joins it
//   await db.files.put/get/del    uploaded pictures and recordings (a table in Postgres, the uploads folder in SQLite)
//
// SQL is written once, with ? placeholders, and translated for Postgres.

const ID_TABLES = new Set(["users", "wallet_tx", "shops", "messages"]); // tables with an auto-numbered id

function sqliteDb({ file, uploads, fs, path }) {
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const cache = new Map();
  const stmt = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); if (cache.size > 300) cache.clear(); cache.set(sql, s); } return s; };
  let lock = Promise.resolve(), inTx = false;
  let als = null; try { const { AsyncLocalStorage } = require("node:async_hooks"); als = new AsyncLocalStorage(); } catch {}
  const db = {
    kind: "sqlite", raw,
    async get(sql, ...p) { return stmt(sql).get(...p); },
    async all(sql, ...p) { return stmt(sql).all(...p); },
    async run(sql, ...p) { const r = stmt(sql).run(...p); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    async exec(sql) { raw.exec(sql); },
    // One transaction at a time (SQLite has a single writer); others wait their turn.
    tx(fn) {
      if (als ? als.getStore() : inTx) return fn(); // already inside a transaction
      const run = lock.then(async () => {
        raw.exec("BEGIN IMMEDIATE"); inTx = true;
        try { const r = await (als ? als.run(true, fn) : fn()); raw.exec("COMMIT"); return r; }
        catch (e) { try { raw.exec("ROLLBACK"); } catch {} throw e; }
        finally { inTx = false; }
      });
      lock = run.catch(() => {});
      return run;
    },
    async columns(table) { return raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); },
    async tableSql(table) { return raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || null; },
    files: {
      async put(name, data) { fs.mkdirSync(uploads, { recursive: true }); fs.writeFileSync(path.join(uploads, name), data); },
      async get(name) { const p = path.join(uploads, name); return fs.existsSync(p) ? fs.readFileSync(p) : null; },
      async del(name) { await fs.promises.unlink(path.join(uploads, name)).catch(() => {}); },
    },
  };
  return db;
}

// "?" → "$1, $2 …" (outside quoted strings), and INSERTs into auto-numbered tables return the new id.
function toPg(sql) {
  let n = 0, out = "", q = null;
  for (const ch of sql) {
    if (q) { out += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    out += ch === "?" ? "$" + (++n) : ch;
  }
  const m = out.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
  if (m && ID_TABLES.has(m[1].toLowerCase()) && !/\bRETURNING\b/i.test(out)) out += " RETURNING id";
  return out;
}

function postgresDb(url) {
  const { Pool } = require("./pg");
  const { AsyncLocalStorage } = require("node:async_hooks");
  const pool = new Pool(url), als = new AsyncLocalStorage(), cache = new Map();
  const pg = sql => { let s = cache.get(sql); if (!s) { s = toPg(sql); cache.set(sql, s); } return s; };
  // Inside db.tx() every query uses the transaction's connection.
  const q = (sql, p) => { const c = als.getStore(); return c ? c.query(pg(sql), p) : pool.query(pg(sql), p); };
  const db = {
    kind: "postgres", pool,
    async get(sql, ...p) { return (await q(sql, p)).rows[0]; },
    async all(sql, ...p) { return (await q(sql, p)).rows; },
    async run(sql, ...p) { const r = await q(sql, p); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id ?? 0 }; },
    async exec(sql) { const c = als.getStore(); if (c) return c.simple(sql); const k = await pool.acquire(); try { await k.simple(sql); } finally { pool.release(k); } },
    async tx(fn) {
      if (als.getStore()) return fn(); // already inside one
      const c = await pool.acquire();
      try {
        await c.query("BEGIN");
        // Money changes run one at a time (like SQLite), so two payments can't both spend the same balance.
        await c.query("SELECT pg_advisory_xact_lock(7270001)");
        const r = await als.run(c, fn);
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      } finally { pool.release(c); }
    },
    async columns(table) { return (await db.all("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table)).map(r => r.name); },
    async tableSql() { return null; },
    files: {
      async put(name, data) { await db.run("INSERT INTO files (name, data, created_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET data = excluded.data", name, data, Date.now()); },
      async get(name) { const r = await db.get("SELECT data FROM files WHERE name = ?", name); return r ? r.data : null; },
      async del(name) { await db.run("DELETE FROM files WHERE name = ?", name); },
    },
  };
  return db;
}

// SQLite schema text → the same schema for Postgres.
function schemaForPg(sql) {
  return sql
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
    .replace(/\bINTEGER\b/g, "BIGINT")
    .replace(/\bREAL\b/g, "DOUBLE PRECISION");
}

module.exports = { sqliteDb, postgresDb, schemaForPg, toPg };
