// Sarrif server. Uses only built-in Node.js modules (Node 22.5 or newer), so there is nothing to install.
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");

/* ---------- .env ---------- */
(function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const { init, nextShopNo, newRefCode, PROOF_WALLETS, ARTS, db, DATA_DIR, WALLETS, CURS, getSettings, saveSettings, seedAdmin, cleanPhone, cleanNum } = require("./db");
const { hashSecret, checkSecret, signToken, verifyToken, parseCookies, cookieHeader } = require("./security");

const SECRET = process.env.JWT_SECRET || "";
if (SECRET.length < 32 || SECRET.startsWith("change-me")) {
  console.error("Set JWT_SECRET in .env to a long random value (at least 32 characters).");
  process.exit(1);
}
const COOKIE = "sarrif_session";
const SESSION_SECONDS = 12 * 3600;
const SECURE = process.env.COOKIE_SECURE === "true";
const MAX_FAILS = 5, LOCK_MINUTES = 15;
const PUBLIC_DIR = path.join(__dirname, "..", "public");


/* ---------- small helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (msg, status = 400) => { throw new HttpError(status, msg); };
const isPin = p => /^\d{4}$/.test(String(p || ""));
const weakPin = () => false; // any 4-digit PIN is allowed (the owner chose this; 5 wrong tries still lock the account for 15 minutes)
const now = () => Date.now();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) fail("That upload is too large.", 413); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function readJson(req, limit = 100 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString("utf8")); return v && typeof v === "object" ? v : {}; } catch { fail("Invalid request."); }
}

/* ---------- rate limiting (per IP, for login endpoints) ---------- */
const hits = new Map();
function rateLimit(req, limit = 30, windowMs = 15 * 60 * 1000, bucket = "auth") {
  const key = bucket + ":" + ((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress);
  const e = hits.get(key);
  if (!e || e.reset < now()) { hits.set(key, { n: 1, reset: now() + windowMs }); return; }
  if (++e.n > limit) fail(bucket === "auth" ? "Too many attempts. Wait 15 minutes and try again." : "You're going too fast. Wait a minute and try again.", 429);
}
setInterval(() => { for (const [k, v] of hits) if (v.reset < now()) hits.delete(k); }, 60000).unref();

/* ---------- sessions ---------- */
function startSession(res, u) {
  res.setHeader("Set-Cookie", cookieHeader(COOKIE, signToken({ uid: u.id, tv: u.token_version }, SECRET, SESSION_SECONDS), { maxAge: SESSION_SECONDS, secure: SECURE }));
}
function endSession(res) { res.setHeader("Set-Cookie", cookieHeader(COOKIE, "", { maxAge: 0, secure: SECURE })); }
async function loadUser(req) {
  const p = verifyToken(parseCookies(req.headers.cookie)[COOKIE], SECRET);
  if (!p || p.stage) return null;
  const u = await db.get("SELECT * FROM users WHERE id = ?", p.uid);
  if (!u || u.suspended || u.token_version !== p.tv) return null;
  return u;
}
async function needRole(req, ...roles) {
  const u = await loadUser(req);
  if (!u) fail("Please log in again.", 401);
  if (roles.length && !roles.includes(u.role)) fail("You don't have access to this.", 403);
  return u;
}
// Who may do what. The super admin can do everything; service admins and agents only act inside their own service.
const isSuper = u => u.role === "super";
async function needIbedelStaff(req) {
  const u = await needRole(req, "agent", "admin", "super");
  if (!isSuper(u) && u.service !== "ibedel") fail("You don't have access to this.", 403);
  return u;
}
async function needIbedelAdmin(req) {
  const u = await needRole(req, "admin", "super");
  if (!isSuper(u) && u.service !== "ibedel") fail("You don't have access to this.", 403);
  return u;
}
function canManage(actor, target) {
  if (!target || target.role === "super" || target.id === actor.id) return false;
  if (isSuper(actor)) return true;
  if (actor.role !== "admin") return false;
  if (target.role === "customer") return actor.service === "ibedel";
  if (target.role === "agent") return target.service === actor.service;
  return false;
}
const isLocked = u => u.locked_until && u.locked_until > now();
async function recordFail(u) {
  const failed = u.failed + 1, lock = failed >= MAX_FAILS ? now() + LOCK_MINUTES * 60000 : 0;
  await db.run("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?", lock ? 0 : failed, lock, u.id);
  return lock;
}
const clearFails = async u => await db.run("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?", u.id);
const tooMany = `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.`;

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, service: u.service || null, ref_code: u.ref_code || null, account_type: u.account_type || "customer", wallets: JSON.parse(u.wallets || "{}"), suspended: !!u.suspended, pause: u.pause || "", created_at: u.created_at };
}
function publicSettings(s) {
  // Customers never receive agent numbers or USSD templates; the server builds each USSD code.
  return { services: s.services.filter(x => x.visible).map(x => ({ id: x.id, name: x.name, sub: x.sub, art: x.art, ready: x.ready, photo: x.photo ? "/media/" + x.photo : null, videos: serviceVideos(x), whatsapp: x.whatsapp || "", phone: x.phone || "", tiktok: x.tiktok || "", gallery: galleryOut(x) })),
    premierPayTo: s.agentNums.premier || "", minUsd: MIN_USD_RECEIVE,
    safePay: { merchant: !!s.safePay.merchant, number: !!s.safePay.number }, earnFeePct: s.earnFeePct,
    priceWords: s.priceWords, tiers: s.tiers, show: s.show, support: s.support, voice: { script: s.voice.script, lang: s.voice.lang, hasAudio: !!s.voice.audio, audioVer: s.voice.audio?.ver || null } };
}

/* ---------- live updates (Server-Sent Events) ---------- */
const clients = new Set();
function broadcast(event, data, filter) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!filter || filter(c.user)) c.res.write(line);
}
const isStaff = u => u.role === "super" || ((u.role === "agent" || u.role === "admin") && u.service === "ibedel");
const REQ_SELECT = `SELECT r.*, u.name AS customer_name, u.phone AS customer_phone FROM requests r JOIN users u ON u.id = r.customer_id`;
function rowToRequest(r, staff) {
  const o = { id: r.id, ref: r.ref, cur: r.cur, from: r.from_wallet, to: r.to_wallet, amount: r.amount, fee: r.fee, receive: r.receive,
    status: r.status, acked: !!r.acked, created_at: r.created_at, sent_at: r.sent_at, ussd: r.ussd, hasProof: !!r.proof,
    to_name: r.to_name || "", ...(r.to_name ? { to_num: r.to_num } : {}) };
  if (staff) Object.assign(o, { customer_name: r.customer_name, customer_phone: r.customer_phone, from_num: r.from_num, to_num: r.to_num });
  return o;
}
async function pushRequest(id) {
  const r = await db.get(`${REQ_SELECT} WHERE r.id = ?`, id);
  if (!r) return;
  broadcast("request", rowToRequest(r, true), isStaff);
  broadcast("request", rowToRequest(r, false), u => u.id === r.customer_id);
}

/* ---------- money rules ---------- */
// USD transfers: the receiver gets at least this much. The customer sends it plus the charge.
const MIN_USD_RECEIVE = 100;
function minUsdAmount(tiers) {
  let a = MIN_USD_RECEIVE;
  for (let i = 0; i < 6; i++) a = Math.round((MIN_USD_RECEIVE + tierFee(tiers, a)) * 100) / 100; // the charge depends on the amount
  return a;
}
function tierFee(tiers, amt) {
  for (const r of tiers) if (r.upTo == null || amt <= Number(r.upTo)) return Number(r.fee) || 0;
  return tiers.length ? Number(tiers[tiers.length - 1].fee) || 0 : 0;
}
function buildUssd(s, wallet, cur, amount) {
  const agent = cleanNum(s.agentNums[wallet]);
  let pre = String(s.ussd[wallet]?.[cur] || "").trim();
  if (!agent || !pre) return null;
  if (!pre.startsWith("*")) pre = "*" + pre;
  if (!pre.endsWith("*")) pre += "*";
  const amt = cur === "SLSH" ? String(Math.round(amount)) : String(Math.round(amount * 100) / 100);
  return `${pre}${agent}*${amt}#`;
}

/* ---------- routes ---------- */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:\w+/g, "([^/]+)") + "$"), handler });

route("POST", "/api/auth/signup", async (req, res) => {
  rateLimit(req);
  const b = await readJson(req);
  const name = String(b.name || "").trim().slice(0, 80), phone = cleanPhone(b.phone), pin = String(b.pin || "");
  const wallets = {};
  for (const w of WALLETS) { const n = cleanNum(b.wallets?.[w]); if (n) wallets[w] = n; }
  if (name.length < 2) fail("Enter your full name.");
  if (phone.length < 7 || phone.length > 12) fail("Enter a valid phone number.");
  if (Object.keys(wallets).length < 2) fail("Add at least two wallet numbers so you can send between them.");
  if (Object.values(wallets).some(n => n.length < 7 || n.length > 12)) fail("Check your wallet numbers.");
  if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
  if (await db.get("SELECT 1 FROM users WHERE phone = ?", phone)) fail("This number already has an account. Log in instead.");
  const info = await db.run("INSERT INTO users (name, phone, role, pin_hash, wallets, created_at, ref_code) VALUES (?, ?, 'customer', ?, ?, ?, ?)", name, phone, hashSecret(pin), JSON.stringify(wallets), now(), await newRefCode());
  const u = await db.get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid);
  startSession(res, u);
  send(res, 200, { user: publicUser(u) });
});

route("POST", "/api/auth/login", async (req, res) => {
  rateLimit(req);
  const b = await readJson(req);
  const u = await db.get("SELECT * FROM users WHERE phone = ?", cleanPhone(b.phone));
  if (!u) fail("Wrong phone number or PIN.", 401);
  if (isLocked(u)) fail(tooMany, 429);
  if (!checkSecret(String(b.pin || ""), u.pin_hash)) fail(await recordFail(u) ? tooMany : "Wrong phone number or PIN.", 401);
  if (u.suspended) fail("This account is suspended. Contact support.", 403);
  if (u.role === "admin" || u.role === "super") return send(res, 200, { needPassword: true, ticket: signToken({ uid: u.id, tv: u.token_version, stage: "admin-pw" }, SECRET, 300) });
  await clearFails(u); startSession(res, u);
  send(res, 200, { user: publicUser(u) });
});

route("POST", "/api/auth/admin-password", async (req, res) => {
  rateLimit(req);
  const b = await readJson(req);
  const t = verifyToken(String(b.ticket || ""), SECRET);
  if (!t || t.stage !== "admin-pw") fail("Your login timed out. Start again.", 401);
  const u = await db.get("SELECT * FROM users WHERE id = ? AND role IN ('admin','super')", t.uid);
  if (!u || u.suspended || u.token_version !== t.tv) fail("Start the login again.", 401);
  if (isLocked(u)) fail(tooMany, 429);
  if (!checkSecret(String(b.password || ""), u.pw_hash)) fail(await recordFail(u) ? tooMany : "That password is wrong.", 401);
  await clearFails(u); startSession(res, u);
  send(res, 200, { user: publicUser(u) });
});

// Re-checks the PIN before a transfer without changing the session.
route("POST", "/api/auth/check-pin", async (req, res) => {
  const u = await needRole(req, "customer"); rateLimit(req, 60);
  const b = await readJson(req);
  if (isLocked(u)) fail(tooMany, 429);
  if (!checkSecret(String(b.pin || ""), u.pin_hash)) fail(await recordFail(u) ? tooMany : "Wrong PIN. Try again.", 401);
  await clearFails(u); send(res, 200, { ok: true });
});

route("POST", "/api/auth/logout", async (req, res) => { endSession(res); send(res, 200, { ok: true }); });
route("GET", "/api/me", async (req, res) => {
  const u = await loadUser(req);
  const staff = u && u.role !== "customer";
  send(res, 200, { user: u ? publicUser(u) : null, services: staff ? (await getSettings()).services.map(({ id, name, art, ready, visible, photo }) => ({ id, name, art, ready, visible, photo: photo ? "/media/" + photo : null })) : undefined });
});

route("POST", "/api/me/wallets", async (req, res) => {
  const u = await needRole(req, "customer"), b = await readJson(req);
  const w = String(b.wallet || ""), n = cleanNum(b.number);
  if (!WALLETS.includes(w)) fail("Unknown wallet.");
  if (n.length < 7 || n.length > 12) fail("Enter a valid number.");
  const wallets = JSON.parse(u.wallets || "{}");
  if (wallets[w]) fail("This number is already saved. Contact support to change it.");
  wallets[w] = n;
  await db.run("UPDATE users SET wallets = ? WHERE id = ?", JSON.stringify(wallets), u.id);
  send(res, 200, { user: publicUser({ ...u, wallets: JSON.stringify(wallets) }) });
});

route("GET", "/api/settings", async (req, res) => send(res, 200, publicSettings(await getSettings())));

route("POST", "/api/requests", async (req, res) => {
  const u = await needRole(req, "customer"), b = await readJson(req, 4 * 1024 * 1024), s = await getSettings();
  if (!s.services.some(x => x.id === "ibedel" && x.visible)) fail("iBedel is not available right now.");
  const cur = String(b.cur), from = String(b.from), to = String(b.to), amount = Number(b.amount);
  if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
  // Sending to another person: only their name and phone number are needed. Otherwise the money goes to the
  // customer's own other wallet.
  const other = !!(b.recipient && (b.recipient.name || b.recipient.phone));
  const toName = other ? String(b.recipient.name || "").trim().replace(/\s+/g, " ").slice(0, 60) : "";
  const toPhone = other ? cleanPhone(b.recipient.phone) : "";
  if (other && toName.length < 2) fail("Enter the name of the person you send to.");
  if (other && !/^\d{7,12}$/.test(toPhone)) fail("Enter the phone number of the person you send to.");
  if (!WALLETS.includes(from) || !WALLETS.includes(to) || (from === to && !other)) fail("Choose two different wallets.");
  const on = w => s.show[w]?.on !== false && s.show[w]?.[cur] !== false;
  // Premier Wallet works in USD only.
  if (cur === "SLSH" && (from === "premier" || to === "premier")) fail("Premier Wallet works in USD only. Choose USD.");
  if (!on(from) || !on(to)) fail("That wallet is not available right now.");
  if (!(amount > 0) || amount > 1e9) fail("Enter a valid amount.");
  const wallets = JSON.parse(u.wallets || "{}");
  if (!wallets[from] || (!other && !wallets[to])) fail(other ? "Add your wallet number in Account first." : "Add both wallet numbers in Account first.");
  const toNum = other ? toPhone : wallets[to];
  const amt = cur === "SLSH" ? Math.round(amount) : Math.round(amount * 100) / 100;
  let fee = tierFee(s.tiers[cur], amt); if (cur === "SLSH") fee = Math.round(fee);
  let receive = Math.max(0, amt - fee); receive = cur === "SLSH" ? Math.floor(receive) : Math.floor(receive * 100) / 100;
  if (receive <= 0) fail("The amount is too small after the service charge.");
  // In USD the receiver gets at least $100: the smallest transfer is $100 plus the charge.
  if (cur === "USD" && receive < MIN_USD_RECEIVE) fail(`In USD the smallest transfer is $${MIN_USD_RECEIVE} plus the charge. Enter at least $${minUsdAmount(s.tiers.USD)}.`);
  const id = crypto.randomUUID(), ref = "SR" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
  // Premier Wallet payments are proven with a screenshot instead of a USSD code.
  let proof = null;
  if (PROOF_WALLETS.includes(from)) {
    const m = String(b.proof || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) fail("Upload a photo or screenshot of your Premier Wallet transaction.");
    const img = Buffer.from(m[2], "base64");
    if (img.length < 1000 || img.length > 3 * 1024 * 1024) fail("The picture must be smaller than 3 MB.");
    proof = `proof-${id}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
    await db.files.put(proof, img);
  }
  await db.run(`INSERT INTO requests (id, ref, customer_id, cur, from_wallet, from_num, to_wallet, to_num, to_name, amount, fee, receive, ussd, proof, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ref, u.id, cur, from, wallets[from], to, toNum, toName, amt, fee, receive, proof ? null : buildUssd(s, from, cur, amt), proof, now());
  await pushRequest(id);
  send(res, 200, { request: rowToRequest(await db.get(`${REQ_SELECT} WHERE r.id = ?`, id), false) });
});

// Earnings paid out with iBedel: once the person's earnings reach their withdraw amount, all of it is sent to their
// own ZAAD, eDahab, Soltelco or Premier number. It goes to the iBedel agents like any request (no USSD from the
// customer: Sarrif pays), minus the iBedel charge.
route("POST", "/api/earnings/payout", async (req, res) => {
  const u = await needRole(req, "customer"), b = await readJson(req), s = await getSettings();
  if (!s.services.some(x => x.id === "ibedel" && x.visible)) fail("iBedel is not available right now.");
  const cur = String(b.cur), to = String(b.to);
  if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
  if (!WALLETS.includes(to)) fail("Choose the wallet to receive in.");
  if (cur === "SLSH" && to === "premier") fail("Premier Wallet works in USD only.");
  if (s.show[to]?.on === false || s.show[to]?.[cur] === false) fail("That wallet is not available right now.");
  const wallets = JSON.parse(u.wallets || "{}");
  if (!wallets[to]) fail("Add that wallet number in Account first.");
  let w = {}; try { w = JSON.parse(u.withdraw_at || "{}"); } catch {}
  const limit = Number(w[cur]) || 0;
  const id = crypto.randomUUID(), ref = "SR" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
  await db.tx(async () => {
    const bal = Math.round(Number((await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM earnings WHERE user_id = ? AND cur = ?", u.id, cur)).b) * 100) / 100;
    const amt = cur === "SLSH" ? Math.round(bal) : bal;
    if (!(amt > 0)) fail("You have no earnings to send yet.");
    if (limit > 0 && amt < limit) fail(`You can send your earnings when they reach ${cur === "USD" ? "$" + limit : limit.toLocaleString("en-US") + " SLSH"}.`);
    // The iBedel admin's percentage charge for earnings payouts.
    let fee = amt * (Number(s.earnFeePct) || 0) / 100; fee = cur === "SLSH" ? Math.round(fee) : Math.round(fee * 100) / 100;
    let receive = Math.max(0, amt - fee); receive = cur === "SLSH" ? Math.floor(receive) : Math.floor(receive * 100) / 100;
    if (receive <= 0) fail("Your earnings are too small after the service charge.");
    await db.run("INSERT INTO earnings (user_id, cur, amount, kind, ref, note, created_at) VALUES (?, ?, ?, 'payout', ?, ?, ?)", u.id, cur, -amt, ref, "Sent with iBedel", now());
    await db.run(`INSERT INTO requests (id, ref, customer_id, cur, from_wallet, from_num, to_wallet, to_num, to_name, amount, fee, receive, ussd, proof, created_at)
                VALUES (?, ?, ?, ?, 'earnings', '', ?, ?, '', ?, ?, ?, NULL, NULL, ?)`, id, ref, u.id, cur, to, wallets[to], amt, fee, receive, now());
  });
  await pushRequest(id);
  const bals = {}; for (const c of CURS) bals[c] = Number((await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM earnings WHERE user_id = ? AND cur = ?", u.id, c)).b) || 0;
  broadcast("earnings", { balances: bals }, x => x.id === u.id);
  send(res, 200, { request: rowToRequest(await db.get(`${REQ_SELECT} WHERE r.id = ?`, id), false), earnings: bals });
});

route("GET", "/api/requests/:id/proof", async (req, res, url, [id]) => {
  const u = await needRole(req, "customer", "agent", "admin", "super");
  const r = await db.get("SELECT customer_id, proof FROM requests WHERE id = ?", id);
  const allowed = r && (u.role === "customer" ? r.customer_id === u.id : (u.role === "super" || u.service === "ibedel"));
  if (!allowed || !r.proof) fail("Picture not found.", 404);
  const data = await db.files.get(path.basename(r.proof));
  if (!data) fail("Picture not found.", 404);
  const ext = path.extname(r.proof).slice(1);
  res.writeHead(200, { "Content-Type": ext === "jpg" ? "image/jpeg" : "image/" + ext, "Content-Length": data.length, "Cache-Control": "private, max-age=3600" });
  res.end(data);
});

route("GET", "/api/requests/mine", async (req, res) => {
  const u = await needRole(req, "customer");
  send(res, 200, { requests: (await db.all(`${REQ_SELECT} WHERE r.customer_id = ? ORDER BY r.created_at DESC LIMIT 100`, u.id)).map(r => rowToRequest(r, false)) });
});

route("GET", "/api/requests", async (req, res, url) => {
  await needIbedelStaff(req);
  const status = url.searchParams.get("status") === "sent" ? "sent" : "waiting";
  const order = status === "sent" ? "r.sent_at DESC" : "r.created_at ASC";
  const rows = await db.all(`${REQ_SELECT} WHERE r.status = ? ORDER BY ${order} LIMIT 500`, status);
  const counts = Object.fromEntries((await db.all("SELECT status, COUNT(*) AS n FROM requests GROUP BY status")).map(c => [c.status, c.n]));
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const today = await db.all("SELECT cur, COUNT(*) AS n, SUM(fee) AS fees FROM requests WHERE status = 'sent' AND sent_at >= ? GROUP BY cur", since.getTime());
  send(res, 200, { requests: rows.map(r => rowToRequest(r, true)), counts, today });
});

route("POST", "/api/requests/:id/sent", async (req, res, url, [id]) => {
  const u = await needIbedelStaff(req);
  if (!(await db.run("UPDATE requests SET status = 'sent', acked = 1, sent_at = ?, sent_by = ? WHERE id = ?", now(), u.id, id)).changes) fail("Request not found.", 404);
  await pushRequest(id); send(res, 200, { ok: true });
});
route("POST", "/api/requests/:id/waiting", async (req, res, url, [id]) => {
  await needIbedelStaff(req);
  if (!(await db.run("UPDATE requests SET status = 'waiting', acked = 1, sent_at = NULL, sent_by = NULL WHERE id = ?", id)).changes) fail("Request not found.", 404);
  await pushRequest(id); send(res, 200, { ok: true });
});
// "Stop sound": mark every new waiting request as seen.
route("POST", "/api/requests/ack", async (req, res) => {
  await needIbedelStaff(req);
  const ids = (await db.all("SELECT id FROM requests WHERE status = 'waiting' AND acked = 0")).map(r => r.id);
  await db.run("UPDATE requests SET acked = 1 WHERE status = 'waiting' AND acked = 0");
  for (const rid of ids) await pushRequest(rid);
  send(res, 200, { ok: true, acked: ids.length });
});

route("GET", "/api/events", async (req, res) => {
  const u = await loadUser(req);
  if (!u) { res.writeHead(401); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("event: hello\ndata: {}\n\n");
  const c = { res, user: u }; clients.add(c);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); clients.delete(c); });
});

/* ----- admin ----- */
route("GET", "/api/admin/settings", async (req, res) => { await needIbedelAdmin(req); send(res, 200, await getSettings()); });
route("PUT", "/api/admin/settings", async (req, res) => {
  await needIbedelAdmin(req);
  const b = await readJson(req), patch = {};
  if (b.tiers) {
    const tiers = {};
    for (const c of CURS) {
      const rows = Array.isArray(b.tiers[c]) ? b.tiers[c] : null;
      if (!rows || !rows.length || rows.length > 20) fail(`Check the ${c} charges.`);
      let prev = 0; const out = [];
      rows.forEach((r, i) => {
        const fee = Number(r.fee), last = i === rows.length - 1;
        const upTo = last && (r.upTo == null || r.upTo === "") ? null : Number(r.upTo);
        if (!(fee >= 0)) fail(`Enter a ${c} charge of 0 or more in every band.`);
        if (upTo !== null) { if (!(upTo > prev)) fail(`${c} bands must go up in order.`); prev = upTo; }
        out.push({ upTo, fee: c === "SLSH" ? Math.round(fee) : fee });
      });
      if (out[out.length - 1].upTo !== null) out.push({ upTo: null, fee: out[out.length - 1].fee });
      tiers[c] = out;
    }
    patch.tiers = tiers;
  }
  if (b.earnFeePct != null) {
    const v = Math.round(Number(b.earnFeePct) * 100) / 100;
    if (!(v >= 0 && v <= 50)) fail("The earnings withdraw charge must be between 0% and 50%.");
    patch.earnFeePct = v;
  }
  if (b.show) {
    const show = {};
    for (const w of WALLETS) show[w] = { on: b.show[w]?.on !== false, USD: b.show[w]?.USD !== false, SLSH: b.show[w]?.SLSH !== false };
    if (!CURS.some(c => WALLETS.filter(w => show[w].on && show[w][c]).length >= 2)) fail("Keep at least two wallets on in the same currency.");
    patch.show = show;
  }
  if (b.agentNums || b.ussd) {
    const agentNums = {}, ussd = {};
    for (const w of WALLETS) {
      agentNums[w] = cleanNum(b.agentNums?.[w]); ussd[w] = {};
      for (const c of CURS) {
        const v = String(b.ussd?.[w]?.[c] || "").replace(/\s/g, "");
        if (v && !/^\*?[\d*]+\*?$/.test(v)) fail(`The ${w} ${c} code can only use digits and *.`);
        ussd[w][c] = v;
      }
    }
    patch.agentNums = agentNums; patch.ussd = ussd;
  }
  if (b.support) {
    const n = cleanNum(b.support.whatsapp);
    if (n && n.length < 9) fail("Enter the full WhatsApp number with country code.");
    patch.support = { whatsapp: n };
  }
  if (b.voice) {
    const cur = (await getSettings()).voice;
    patch.voice = { ...cur, script: String(b.voice.script || "").slice(0, 2000) || cur.script, lang: String(b.voice.lang || cur.lang).slice(0, 12) };
  }
  const s = await saveSettings(patch);
  broadcast("settings", publicSettings(s));
  send(res, 200, s);
});

// Voice upload: the browser sends the audio file as the raw request body.
route("POST", "/api/admin/voice", async (req, res) => {
  await needIbedelAdmin(req);
  const mime = String(req.headers["content-type"] || "").split(";")[0];
  if (!/^audio\/[\w.+-]+$/.test(mime)) fail("Choose an audio file.");
  const buf = await readBody(req, 5 * 1024 * 1024);
  if (!buf.length) fail("Choose an audio file.");
  const file = `voice-${now()}.audio`;
  await db.files.put(file, buf);
  const old = (await getSettings()).voice.audio;
  const name = decodeURIComponent(String(req.headers["x-file-name"] || "recording")).slice(0, 120);
  const s = await saveSettings({ voice: { ...(await getSettings()).voice, audio: { file, mime, name, size: buf.length, ver: now().toString(36) } } });
  if (old?.file) await db.files.del(old.file);
  broadcast("settings", publicSettings(s)); send(res, 200, s);
});
route("DELETE", "/api/admin/voice", async (req, res) => {
  await needIbedelAdmin(req);
  const old = (await getSettings()).voice.audio;
  const s = await saveSettings({ voice: { ...(await getSettings()).voice, audio: null } });
  if (old?.file) await db.files.del(old.file);
  broadcast("settings", publicSettings(s)); send(res, 200, s);
});
route("GET", "/voice", async (req, res) => {
  const a = (await getSettings()).voice.audio;
  const data = a && await db.files.get(path.basename(a.file));
  if (!data) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": a.mime, "Content-Length": data.length, "Cache-Control": "public, max-age=3600" });
  res.end(data);
});

route("GET", "/api/admin/users", async (req, res, url) => {
  const me = await needRole(req, "admin", "super");
  const role = ["customer", "agent", "admin"].includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "customer";
  if (role === "customer" && !isSuper(me) && me.service !== "ibedel") fail("You don't have access to this.", 403);
  if (role === "admin" && !isSuper(me)) fail("You don't have access to this.", 403);
  const service = isSuper(me) ? (url.searchParams.get("service") || null) : me.service;
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase(), qd = q.replace(/\D/g, "");
  let rows = await db.all(`SELECT u.*, (SELECT COUNT(*) FROM requests r WHERE r.customer_id = u.id) AS req_count
                         FROM users u WHERE role = ? ORDER BY created_at DESC LIMIT 1000`, role);
  if (role !== "customer" && service) rows = rows.filter(u => u.service === service);
  if (q) rows = rows.filter(u => u.name.toLowerCase().includes(q) || (qd && u.phone.includes(qd)));
  send(res, 200, { users: rows.map(u => ({ ...publicUser(u), requests: u.req_count, locked: !!isLocked(u) })) });
});
route("POST", "/api/admin/agents", async (req, res) => {
  const me = await needRole(req, "admin", "super");
  const b = await readJson(req);
  const service = isSuper(me) ? String(b.service || "") : me.service;
  if (!(await getSettings()).services.some(x => x.id === service)) fail("Choose which service this agent works for.");
  const name = String(b.name || "").trim().slice(0, 80), phone = cleanPhone(b.phone), pin = String(b.pin || "");
  if (name.length < 2) fail("Enter the agent's full name.");
  if (phone.length < 7 || phone.length > 12) fail("Enter a valid phone number.");
  if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
  if (await db.get("SELECT 1 FROM users WHERE phone = ?", phone)) fail("This number already has an account.");
  await db.run("INSERT INTO users (name, phone, role, service, pin_hash, created_at, ref_code) VALUES (?, ?, 'agent', ?, ?, ?, ?)", name, phone, service, hashSecret(pin), now(), await newRefCode());
  send(res, 200, { ok: true });
});
route("POST", "/api/admin/users/:id/reset-pin", async (req, res, url, [id]) => {
  const me = await needRole(req, "admin", "super");
  const pin = String((await readJson(req)).pin || "");
  if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
  const u = await db.get("SELECT * FROM users WHERE id = ?", id);
  if (!canManage(me, u)) fail("User not found.", 404);
  // Bumping token_version logs the person out everywhere.
  await db.run("UPDATE users SET pin_hash = ?, failed = 0, locked_until = 0, token_version = token_version + 1 WHERE id = ?", hashSecret(pin), u.id);
  send(res, 200, { ok: true });
});
route("POST", "/api/admin/users/:id/suspend", async (req, res, url, [id]) => {
  const me = await needRole(req, "admin", "super");
  const b = await readJson(req);
  const u = await db.get("SELECT * FROM users WHERE id = ?", id);
  if (!canManage(me, u)) fail("User not found.", 404);
  const s = b.suspended ? 1 : 0;
  await db.run("UPDATE users SET suspended = ?, token_version = token_version + 1 WHERE id = ?", s, u.id);
  if (s) for (const c of clients) if (c.user.id === u.id) { c.res.write("event: logout\ndata: {}\n\n"); c.res.end(); clients.delete(c); }
  send(res, 200, { ok: true });
});
route("POST", "/api/admin/password", async (req, res) => {
  const u = await needRole(req, "admin", "super"), b = await readJson(req);
  if (!checkSecret(String(b.current || ""), u.pw_hash)) fail("Your current password is wrong.");
  if (String(b.next || "").length < 8) fail("Use at least 8 characters.");
  await db.run("UPDATE users SET pw_hash = ?, token_version = token_version + 1 WHERE id = ?", hashSecret(b.next), u.id);
  startSession(res, await db.get("SELECT * FROM users WHERE id = ?", u.id));
  send(res, 200, { ok: true });
});

/* ----- super admin ----- */
route("GET", "/api/super/overview", async (req, res) => {
  const me = await needRole(req, "super");
  const s = await getSettings();
  const staff = await db.all("SELECT role, service, COUNT(*) AS n FROM users WHERE role IN ('admin','agent') GROUP BY role, service");
  const customers = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND account_type != 'service'")).n;
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const waiting = (await db.get("SELECT COUNT(*) AS n FROM requests WHERE status = 'waiting'")).n;
  const sentMonth = await db.all("SELECT cur, COUNT(*) AS n, SUM(fee) AS fees FROM requests WHERE status = 'sent' AND sent_at >= ? GROUP BY cur", month.getTime());
  send(res, 200, { services: s.services.map(x => ({ ...x, photo: x.photo ? "/media/" + x.photo : null })), staff, customers, ibedel: { waiting, sentMonth } });
});
// A service's videos: up to 10, each a web link (YouTube and others) with an optional title.
// Accepts a list, or text with one video per line: the link, then the title ("https://youtu.be/… Our new shop").
const MAX_SERVICE_VIDEOS = 10;
function cleanVideos(v) {
  const items = Array.isArray(v) ? v : String(v || "").split(/\r?\n/);
  const out = [];
  for (const it of items) {
    let url, title;
    if (it && typeof it === "object") { url = String(it.url || "").trim(); title = String(it.title || "").trim(); }
    else { const line = String(it || "").trim(); if (!line) continue; const sp = line.search(/\s/); url = sp < 0 ? line : line.slice(0, sp); title = sp < 0 ? "" : line.slice(sp).trim(); }
    if (!url) continue;
    if (url.length > 300 || !/^https?:\/\/[^\s<>"']+$/i.test(url)) fail("Each video must start with its link, for example https://youtu.be/…");
    if (!out.some(x => x.url === url)) out.push({ url, title: title.slice(0, 120) });
  }
  if (out.length > MAX_SERVICE_VIDEOS) fail(`A service can have up to ${MAX_SERVICE_VIDEOS} videos.`);
  return out;
}
// A service's photo gallery (the moving pictures on its tile and page): files in storage, each with a name and credit.
const galleryOut = x => (x.gallery || []).map(g => ({ src: "/media/" + g.file, title: g.title || "", credit: g.credit || "" }));
// Older saves kept one "video", or plain links.
const serviceVideos = x => (Array.isArray(x.videos) ? x.videos : x.video ? [x.video] : []).map(v => typeof v === "string" ? { url: v, title: "" } : { url: v.url, title: v.title || "" });
// Fills in missing YouTube titles from YouTube itself (skipped quietly when YouTube can't be reached).
async function fillVideoTitles(videos) {
  await Promise.all(videos.map(async v => {
    if (v.title || !/youtu\.?be/.test(v.url) || typeof fetch !== "function") return;
    try {
      const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(v.url), { signal: AbortSignal.timeout(4000) });
      if (r.ok) v.title = String((await r.json()).title || "").slice(0, 120);
    } catch {}
  }));
  return videos;
}
const cleanPhoneNo = v => { const d = String(v || "").replace(/[^\d+]/g, ""); if (d && !/^\+?\d{5,16}$/.test(d)) fail("Check the phone number to call."); return d; };
const cleanTiktok = v => { v = String(v || "").trim().slice(0, 200); if (v && !/^https:\/\/(www\.)?tiktok\.com\/[^\s<>"']+$/i.test(v)) fail("The TikTok link must look like https://www.tiktok.com/@yourname"); return v; };
const cleanWa = v => { const d = String(v || "").replace(/\D/g, ""); if (d && (d.length < 7 || d.length > 15)) fail("Check the WhatsApp number (country code and number, for example 252634000000)."); return d; };
route("PUT", "/api/super/services", async (req, res) => {
  await needRole(req, "super");
  const b = await readJson(req), cur = (await getSettings()).services;
  if (!Array.isArray(b.services) || !b.services.length || b.services.length > 30) fail("Check the services list.");
  const seen = new Set(), out = [];
  for (const x of b.services) {
    const old = cur.find(c => c.id === x.id);
    let id = old ? old.id : String(x.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
    const name = String(x.name || "").trim().slice(0, 30), sub = String(x.sub || "").trim().slice(0, 60);
    if (name.length < 2) fail("Every service needs a name.");
    if (!id) id = "service";
    while (seen.has(id)) id += "-2";
    seen.add(id);
    // Keep what the service's own admin set (Pay to shop and safe payment numbers, document earnings…).
    out.push({ ...(old || {}), id, name, sub, art: ARTS.includes(x.art) ? x.art : "general", visible: x.visible !== false, ready: old ? !!old.ready : false, builtIn: old ? !!old.builtIn : false, photo: old?.photo || null, videos: await fillVideoTitles(cleanVideos(x.videos ?? x.video)), whatsapp: cleanWa(x.whatsapp), phone: cleanPhoneNo(x.phone), tiktok: cleanTiktok(x.tiktok), gallery: old?.gallery || [] });
  }
  for (const c of cur) if (c.builtIn && !out.some(o => o.id === c.id)) fail(`${c.name} can be hidden but not deleted.`);
  for (const c of cur) if (!out.some(o => o.id === c.id)) { if (c.photo) await db.files.del(c.photo); for (const g of c.gallery || []) await db.files.del(g.file); }
  const s = await saveSettings({ services: out });
  broadcast("settings", publicSettings(s));
  send(res, 200, { services: s.services.map(x => ({ ...x, photo: x.photo ? "/media/" + x.photo : null })) });
});
// The videos page of one service (videos, Call, WhatsApp, TikTok). The super admin can edit any service;
// a service admin only their own. Merchants and customers can't.
async function needPageEditor(req, id) {
  const u = await needRole(req, "super", "admin");
  if (!isSuper(u) && u.service !== id) fail("You can only change your own service's page.", 403);
  const s = await getSettings(), i = s.services.findIndex(x => x.id === id);
  if (i < 0) fail("That service was not found.", 404);
  return { s, i };
}
const pageOf = x => ({ videos: serviceVideos(x), whatsapp: x.whatsapp || "", phone: x.phone || "", merchant: x.merchant || "", tiktok: x.tiktok || "", gallery: galleryOut(x) });
route("GET", "/api/admin/service-page/:id", async (req, res, url, [id]) => {
  const { s, i } = await needPageEditor(req, id);
  send(res, 200, pageOf(s.services[i]));
});
route("PUT", "/api/admin/service-page/:id", async (req, res, url, [id]) => {
  const { i } = await needPageEditor(req, id);
  const b = await readJson(req);
  const merchant = String(b.merchant || "").replace(/\D/g, "").slice(0, 15);
  if (merchant && merchant.length < 4) fail("Check the merchant number.");
  const page = { videos: await fillVideoTitles(cleanVideos(b.videos)), whatsapp: cleanWa(b.whatsapp), phone: cleanPhoneNo(b.phone), merchant, tiktok: cleanTiktok(b.tiktok) };
  const fresh = await getSettings(); // read again: titles may have taken a moment to fetch
  const services = fresh.services.map((x, j) => x.id === id ? { ...x, ...page, video: undefined } : x);
  const ns = await saveSettings({ services });
  broadcast("settings", publicSettings(ns));
  send(res, 200, pageOf(ns.services.find(x => x.id === id)));
});
route("POST", "/api/super/admins", async (req, res) => {
  await needRole(req, "super");
  const b = await readJson(req);
  const name = String(b.name || "").trim().slice(0, 80), phone = cleanPhone(b.phone), pin = String(b.pin || ""), pw = String(b.password || ""), service = String(b.service || "");
  if (!(await getSettings()).services.some(x => x.id === service)) fail("Choose which service this admin runs.");
  if (name.length < 2) fail("Enter the admin's full name.");
  if (phone.length < 7 || phone.length > 12) fail("Enter a valid phone number.");
  if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
  if (pw.length < 8) fail("The password needs at least 8 characters.");
  if (await db.get("SELECT 1 FROM users WHERE phone = ?", phone)) fail("This number already has an account.");
  await db.run("INSERT INTO users (name, phone, role, service, pin_hash, pw_hash, created_at, ref_code) VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)", name, phone, service, hashSecret(pin), hashSecret(pw), now(), await newRefCode());
  send(res, 200, { ok: true });
});
route("POST", "/api/super/admins/:id/reset-password", async (req, res, url, [id]) => {
  await needRole(req, "super");
  const pw = String((await readJson(req)).password || "");
  if (pw.length < 8) fail("The password needs at least 8 characters.");
  const u = await db.get("SELECT * FROM users WHERE id = ? AND role = 'admin'", id);
  if (!u) fail("Admin not found.", 404);
  await db.run("UPDATE users SET pw_hash = ?, failed = 0, locked_until = 0, token_version = token_version + 1 WHERE id = ?", hashSecret(pw), u.id);
  send(res, 200, { ok: true });
});

/* ----- admin: finance ----- */
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
route("GET", "/api/admin/finance", async (req, res, url) => {
  await needIbedelAdmin(req);
  const fromMs = Number(url.searchParams.get("fromMs")), toMs = Number(url.searchParams.get("toMs"));
  const fromDate = url.searchParams.get("fromDate"), toDate = url.searchParams.get("toDate");
  if (!(fromMs >= 0) || !(toMs >= fromMs) || !isYmd(fromDate) || !isYmd(toDate)) fail("Choose a valid date range.");
  // Revenue is counted when a transfer is marked as sent.
  const revenue = await db.all("SELECT sent_at AS at, cur, fee FROM requests WHERE status = 'sent' AND sent_at BETWEEN ? AND ?", fromMs, toMs);
  const expenses = await db.all("SELECT id, date, cur, amount, category, note FROM expenses WHERE date BETWEEN ? AND ? ORDER BY date DESC", fromDate, toDate);
  send(res, 200, { revenue, expenses });
});
route("POST", "/api/admin/expenses", async (req, res) => {
  const u = await needIbedelAdmin(req), b = await readJson(req);
  const cur = String(b.cur), amount = Number(b.amount);
  if (!isYmd(b.date)) fail("Choose the date of the expense.");
  if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
  if (!(amount > 0) || amount > 1e10) fail("Enter an amount above 0.");
  const category = String(b.category || "Other").trim().slice(0, 40) || "Other";
  const id = crypto.randomUUID();
  await db.run("INSERT INTO expenses (id, date, cur, amount, category, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, b.date, cur, cur === "SLSH" ? Math.round(amount) : Math.round(amount * 100) / 100, category, String(b.note || "").trim().slice(0, 120), u.id, now());
  send(res, 200, { ok: true, id });
});
route("DELETE", "/api/admin/expenses/:id", async (req, res, url, [id]) => {
  await needIbedelAdmin(req);
  if (!(await db.run("DELETE FROM expenses WHERE id = ?", id)).changes) fail("Expense not found.", 404);
  send(res, 200, { ok: true });
});

/* ---------- wallets, Suuq, chat, affiliates ---------- */
require("./market")({ hashSecret, nextShopNo, newRefCode, startSession, publicUser, isPin, weakPin, route, db, send, fail, readJson, needRole, loadUser, broadcast, getSettings, saveSettings, isSuper, publicSettings, serviceVideos, needPageEditor, pageOf,
  crypto, fs, path, DATA_DIR, CURS, cleanPhone, now, rateLimit });

/* ---------- static files ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp" };
function serveStatic(req, res, pathname) {
  let p = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!p.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(PUBLIC_DIR, "index.html");
  const ext = path.extname(p);
  res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(p).pipe(res);
}

/* ---------- server ---------- */
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://i.ytimg.com; media-src 'self' blob: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.facebook.com https://www.instagram.com https://www.dailymotion.com https://geo.dailymotion.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
if (SECURE) SECURITY_HEADERS["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.handler(req, res, url, m.slice(1).map(decodeURIComponent));
    }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Not allowed." });
    serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: "Something went wrong on our side. Try again." });
  }
});
const PORT = Number(process.env.PORT) || 3000;
// Set up the database (creates the tables the first time), make sure a super admin exists, then start.
(async () => {
  await init();
  await seedAdmin();
  server.listen(PORT, () => console.log(`Sarrif running on http://localhost:${PORT} (database: ${db.kind === "postgres" ? "PostgreSQL" : "SQLite"})`));
})().catch(e => { console.error("Could not start:", e.message); process.exit(1); });
