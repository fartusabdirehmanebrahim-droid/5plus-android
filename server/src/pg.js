// A small PostgreSQL client using only Node's built-in modules (net, tls, crypto), so the app still needs no
// npm packages. It supports what Supabase needs: TLS, SCRAM-SHA-256 login, parameterised queries and a
// connection pool. Values come back as JavaScript numbers, strings, booleans or Buffers (bytea).
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");

class PgError extends Error {
  constructor(fields) { super(fields.M || "Database error"); this.code = fields.C; this.detail = fields.D; this.pg = fields; }
}

// Type OIDs we convert from text.
const NUMBER = new Set([20, 21, 23, 26, 700, 701, 1700]);
function parseValue(oid, text) {
  if (text === null) return null;
  if (NUMBER.has(oid)) return Number(text);
  if (oid === 16) return text === "t";
  if (oid === 17) return Buffer.from(text.slice(2), "hex"); // bytea, hex format: \x…
  return text;
}
function encodeParam(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from("\\x" + Buffer.from(v).toString("hex"));
  if (typeof v === "boolean") return Buffer.from(v ? "1" : "0");
  return Buffer.from(String(v));
}

function parseUrl(url) {
  const u = new URL(url);
  const q = u.searchParams;
  return {
    host: u.hostname, port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    sslmode: q.get("sslmode") || (["localhost", "127.0.0.1", "::1"].includes(u.hostname) ? "prefer" : "require"),
  };
}

class Connection {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.queue = Promise.resolve(); this.dead = false; }

  /* ---------- socket and messages ---------- */
  async connect() {
    const { host, port, sslmode } = this.cfg;
    let sock = await new Promise((ok, bad) => { const s = net.connect({ host, port }, () => ok(s)); s.once("error", bad); });
    sock.setKeepAlive(true, 30000);
    if (sslmode !== "disable") {
      const ssl = Buffer.alloc(8); ssl.writeInt32BE(8, 0); ssl.writeInt32BE(80877103, 4); sock.write(ssl);
      const answer = await new Promise((ok, bad) => { sock.once("data", d => ok(String.fromCharCode(d[0]))); sock.once("error", bad); });
      if (answer === "S") {
        const opts = { socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: sslmode === "verify-full" || sslmode === "verify-ca" };
        if (process.env.DATABASE_CA_CERT) opts.ca = require("node:fs").readFileSync(process.env.DATABASE_CA_CERT);
        sock = await new Promise((ok, bad) => { const t = tls.connect(opts, () => ok(t)); t.once("error", bad); });
      } else if (sslmode === "require" || sslmode.startsWith("verify")) {
        sock.destroy(); throw new Error("The database does not accept secure (TLS) connections.");
      }
    }
    this.sock = sock;
    sock.on("data", d => this.onData(d));
    sock.on("error", e => this.fail(e));
    sock.on("close", () => this.fail(new Error("Database connection closed.")));
    await this.startup();
  }
  fail(e) {
    if (this.dead) return; this.dead = true; this.error = e;
    for (const w of this.waiters.splice(0)) w.bad(e);
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const msg = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      if (msg.type === "N" || msg.type === "S" || msg.type === "A") continue; // notices, parameter status, notifications
      const w = this.waiters[0]; if (w) w.push(msg);
    }
  }
  // Collects messages until ReadyForQuery ('Z'); fails with the first ErrorResponse.
  collect(handler) {
    return new Promise((ok, bad) => {
      if (this.dead) return bad(this.error);
      let err = null;
      const w = { bad, push: msg => {
        if (msg.type === "E") { err = new PgError(readFields(msg.body)); return; }
        if (msg.type === "Z") { this.waiters.shift(); return err ? bad(err) : ok(); }
        try { handler(msg); } catch (e) { err = e; }
      } };
      this.waiters.push(w);
    });
  }
  send(type, body) {
    const head = Buffer.alloc(type ? 5 : 4);
    if (type) { head.write(type, 0); head.writeInt32BE(body.length + 4, 1); } else head.writeInt32BE(body.length + 4, 0);
    this.sock.write(Buffer.concat([head, body]));
  }

  /* ---------- login ---------- */
  async startup() {
    const { user, database, password } = this.cfg;
    const params = Buffer.from(`user\0${user}\0database\0${database}\0application_name\0sarrif\0client_encoding\0UTF8\0\0`);
    const ver = Buffer.alloc(4); ver.writeInt32BE(196608, 0);
    let scram = null;
    const done = new Promise((ok, bad) => {
      this.waiters.push({ bad, push: msg => {
        if (msg.type === "E") { this.waiters.shift(); return bad(new PgError(readFields(msg.body))); }
        if (msg.type === "Z") { this.waiters.shift(); return ok(); }
        if (msg.type !== "R") return;
        const code = msg.body.readInt32BE(0);
        try {
          if (code === 3) this.send("p", Buffer.from(password + "\0"));
          else if (code === 5) {
            const salt = msg.body.subarray(4, 8), md5 = s => crypto.createHash("md5").update(s).digest("hex");
            this.send("p", Buffer.from("md5" + md5(Buffer.concat([Buffer.from(md5(password + user)), salt])) + "\0"));
          } else if (code === 10) {
            const mechs = msg.body.subarray(4).toString().split("\0");
            if (!mechs.includes("SCRAM-SHA-256")) throw new Error("The database asks for a login method this app doesn't support.");
            scram = { nonce: crypto.randomBytes(18).toString("base64") };
            scram.first = `n=*,r=${scram.nonce}`;
            const data = Buffer.from("n,," + scram.first), len = Buffer.alloc(4); len.writeInt32BE(data.length, 0);
            this.send("p", Buffer.concat([Buffer.from("SCRAM-SHA-256\0"), len, data]));
          } else if (code === 11) {
            const server = msg.body.subarray(4).toString(), a = Object.fromEntries(server.split(",").map(p => [p[0], p.slice(2)]));
            if (!a.r.startsWith(scram.nonce)) throw new Error("Database login failed (bad nonce).");
            const salted = crypto.pbkdf2Sync(password.normalize("NFKC"), Buffer.from(a.s, "base64"), Number(a.i), 32, "sha256");
            const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
            const clientKey = hmac(salted, "Client Key"), storedKey = crypto.createHash("sha256").update(clientKey).digest();
            const without = `c=biws,r=${a.r}`, authMsg = `${scram.first},${server},${without}`;
            const sig = hmac(storedKey, authMsg), proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
            scram.serverSig = hmac(hmac(salted, "Server Key"), authMsg).toString("base64");
            this.send("p", Buffer.from(`${without},p=${proof.toString("base64")}`));
          } else if (code === 12) {
            const v = msg.body.subarray(4).toString().match(/v=([^,]+)/);
            if (!v || v[1] !== scram.serverSig) throw new Error("Database login failed (the server could not be verified).");
          } else if (code !== 0) throw new Error("The database asks for a login method this app doesn't support.");
        } catch (e) { this.waiters.shift(); this.sock.destroy(); bad(e); }
      } });
    });
    this.send(null, Buffer.concat([ver, params]));
    await done;
  }

  /* ---------- queries ---------- */
  // One query at a time per connection.
  query(sql, params = []) {
    const run = this.queue.then(() => this._query(sql, params));
    this.queue = run.catch(() => {});
    return run;
  }
  async _query(sql, params) {
    const str = s => Buffer.from(s + "\0");
    const parse = Buffer.concat([str(""), str(sql), Buffer.from([0, 0])]);
    const parts = [str(""), str(""), Buffer.from([0, 0])];
    const n = Buffer.alloc(2); n.writeInt16BE(params.length, 0); parts.push(n);
    for (const p of params) {
      const v = encodeParam(p), len = Buffer.alloc(4);
      len.writeInt32BE(v === null ? -1 : v.length, 0); parts.push(len); if (v) parts.push(v);
    }
    parts.push(Buffer.from([0, 0]));
    const exec = Buffer.alloc(9); exec.write("P", 0); exec.writeInt32BE(0, 5); // unnamed portal, all rows
    const result = { rows: [], rowCount: 0, command: "" };
    let fields = [];
    const wait = this.collect(msg => {
      if (msg.type === "T") fields = readRowDescription(msg.body);
      else if (msg.type === "D") result.rows.push(readRow(msg.body, fields));
      else if (msg.type === "C") { const tag = msg.body.toString().replace(/\0$/, ""); result.command = tag.split(" ")[0]; result.rowCount = Number(tag.split(" ").pop()) || 0; }
    });
    this.send("P", parse);
    this.send("B", Buffer.concat(parts));
    this.send("D", Buffer.from("P\0"));
    this.send("E", Buffer.concat([Buffer.from("\0"), Buffer.alloc(4)]));
    this.send("S", Buffer.alloc(0));
    await wait;
    return result;
  }
  // Several statements at once (schema set-up). No parameters.
  simple(sql) {
    const run = this.queue.then(async () => { const w = this.collect(() => {}); this.send("Q", Buffer.from(sql + "\0")); await w; });
    this.queue = run.catch(() => {});
    return run;
  }
  close() { try { this.send("X", Buffer.alloc(0)); this.sock.end(); } catch {} this.dead = true; }
}

function readFields(body) {
  const out = {}; let i = 0;
  while (i < body.length && body[i] !== 0) { const t = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); out[t] = body.subarray(i + 1, end).toString(); i = end + 1; }
  return out;
}
function readRowDescription(body) {
  const n = body.readInt16BE(0), out = []; let i = 2;
  for (let k = 0; k < n; k++) { const end = body.indexOf(0, i); const name = body.subarray(i, end).toString(); i = end + 1; const oid = body.readInt32BE(i + 6); i += 18; out.push({ name, oid }); }
  return out;
}
function readRow(body, fields) {
  const n = body.readInt16BE(0), row = {}; let i = 2;
  for (let k = 0; k < n; k++) {
    const len = body.readInt32BE(i); i += 4;
    const text = len < 0 ? null : body.subarray(i, i + len).toString(); if (len > 0) i += len;
    row[fields[k].name] = parseValue(fields[k].oid, text);
  }
  return row;
}

// A pool of connections. `max` connections at most; each query borrows one.
class Pool {
  constructor(url, max = Number(process.env.DATABASE_POOL) || 5) { this.cfg = parseUrl(url); this.max = max; this.idle = []; this.count = 0; this.waiting = []; }
  async acquire() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.count--; }
    if (this.count < this.max) {
      this.count++;
      try { const c = new Connection(this.cfg); await c.connect(); return c; } catch (e) { this.count--; throw e; }
    }
    return new Promise(ok => this.waiting.push(ok)).then(() => this.acquire());
  }
  release(c) {
    if (c.dead) this.count--; else this.idle.push(c);
    const next = this.waiting.shift(); if (next) next();
  }
  async query(sql, params) {
    const c = await this.acquire();
    try { return await c.query(sql, params); } finally { this.release(c); }
  }
  async end() { for (const c of this.idle.splice(0)) c.close(); }
}

module.exports = { Pool, Connection, PgError, parseUrl };
