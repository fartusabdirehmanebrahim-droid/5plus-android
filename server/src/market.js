// Wallets, the Suuq marketplace, private buyer-seller chat and the affiliate program.
// Loaded by server.js, which passes in its helpers.
module.exports = function market(ctx) {
  const { needPin, readFace, storeFace, hashSecret, nextShopNo, newRefCode, startSession, publicUser, isPin, weakPin, route, db, send, fail, readJson, needRole, loadUser, broadcast, getSettings, saveSettings, isSuper, publicSettings, serviceVideos, needPageEditor, pageOf,
    crypto, fs, path, DATA_DIR, CURS, cleanPhone, now, rateLimit } = ctx;

  /* ---------- money helpers ---------- */
  const round = (cur, v) => cur === "SLSH" ? Math.round(v) : Math.round(v * 100) / 100;
  // A database transaction: all of it happens, or none of it.
  const tx = fn => db.tx(fn);
  async function balance(userId, cur) {
    const r = userId == null
      ? await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM wallet_tx WHERE user_id IS NULL AND cur = ?", cur)
      : await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM wallet_tx WHERE user_id = ? AND cur = ?", userId, cur);
    return round(cur, r.b);
  }
  const balances = async id => Object.fromEntries(await Promise.all(CURS.map(async c => [c, await balance(id, c)])));
  async function ledger(userId, cur, amount, kind, ref, note, byUser) {
    await db.run("INSERT INTO wallet_tx (user_id, cur, amount, kind, ref, note, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", userId, cur, round(cur, amount), kind, ref || null, note || "", byUser || null, now());
    if (userId != null) broadcast("wallet", { balances: await balances(userId) }, u => u.id === userId);
  }
  const KIND_LABEL = { topup: "Top-up", withdraw: "Withdrawal", subscription: "Suuq subscription", order_payment: "Order payment",
    refund: "Refund", sale: "Sale", affiliate: "Affiliate earning", subscription_income: "Subscription income", earnings: "Earnings withdrawn to wallet", affiliate_fee: "Affiliate earning (paid to your shop)", shop_charge: "5PLUS charge (Pay to shop)", shop_charge_income: "Pay to shop charge" };
  /* ---------- affiliate earnings ---------- */
  async function earnBalance(uid, cur) { return round(cur, (await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM earnings WHERE user_id = ? AND cur = ?", uid, cur)).b); }
  const earnBalances = async uid => Object.fromEntries(await Promise.all(CURS.map(async c => [c, await earnBalance(uid, c)])));
  async function addEarning(uid, cur, amount, kind, ref, note) {
    await db.run("INSERT INTO earnings (user_id, cur, amount, kind, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", uid, cur, round(cur, amount), kind, ref || null, note || "", now());
    broadcast("earnings", { balances: await earnBalances(uid) }, x => x.id === uid);
  }
  // The amounts the person withdraws at, one for dollars and one for shillings (set together, once). No exchange:
  // each currency is withdrawn on its own. Older settings ({ cur, amount }) are read for that currency.
  const withdrawAt = u => {
    let w = {}; try { w = JSON.parse(u.withdraw_at || "{}"); } catch {}
    if (CURS.includes(w.cur)) return { USD: 0, SLSH: 0, [w.cur]: Number(w.amount) || 0 };
    return { USD: Number(w.USD) || 0, SLSH: Number(w.SLSH) || 0 };
  };

  const txRow = r => ({ id: r.id, cur: r.cur, amount: r.amount, kind: r.kind, label: KIND_LABEL[r.kind] || r.kind, ref: r.ref, note: r.note, created_at: r.created_at });
  const needUser = async req => { const u = await loadUser(req); if (!u) fail("Please log in again.", 401); return u; };
  const needSuuqAdmin = async req => { const u = await needRole(req, "admin", "super"); if (!isSuper(u) && u.service !== "suuq") fail("You don't have access to this.", 403); return u; };
  // Suuq and Visa are both marketplaces: merchants list products (Suuq) or visas (Visa) from the same shop.
  const MARKETS = ["suuq", "visa", "scholarship", "technician"];
  const MNAME = { suuq: "Suuq", visa: "Visa", scholarship: "Scholarship", ticket: "Ticket", technician: "Technician" };
  // Visas and scholarships are for one country each.
  const hasCountry = m => m === "visa" || m === "scholarship";
  // Only travel agencies the Scholarship admin allowed may post scholarships.
  const scholarAllowed = shop => !!JSON.parse(shop?.profile || "{}").scholar;
  const marketOpen = async m => { m = String(m || ""); const id = m.startsWith("svc:") ? m.slice(4) : m; return (await getSettings()).services.some(x => x.id === id && x.visible); };
  const needMarketAdmin = async (req, m) => { const u = await needRole(req, "admin", "super"); if (!isSuper(u) && u.service !== m) fail("You don't have access to this.", 403); return u; };

  /* ---------- wallet ---------- */
  // Every account has a wallet from the moment it is registered (it starts at 0).
  route("GET", "/api/wallet", async (req, res) => {
    const u = await needUser(req), s = await getSettings();
    const rows = await db.all("SELECT * FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 100", u.id);
    const topups = (await db.all("SELECT * FROM topups WHERE user_id = ? ORDER BY created_at DESC LIMIT 30", u.id)).map(topupRow);
    const pend = await db.all("SELECT cur, SUM(commission) AS total FROM orders WHERE affiliate_id = ? AND commission > 0 AND status IN ('paid','delivered','awaiting_payment') GROUP BY cur", u.id);
    send(res, 200, { balances: await balances(u.id), tx: rows.map(txRow), support: s.support, topups,
      earnings: await earnBalances(u.id), withdraw_at: withdrawAt(u), earn_pending: Object.fromEntries(CURS.map(c => [c, round(c, Number(pend.find(r => r.cur === c)?.total || 0))])),
      topupCfg: { number: s.walletTopup.number, numbers: topupNumbers(s.walletTopup), ussd: s.walletTopup.ussd } });
  });

  /* ---------- top-up by USSD ---------- */
  // The agent number the super admin assigned for each currency (the old single number is used when one is empty).
  const topupNumbers = w => Object.fromEntries(CURS.map(c => [c, String(w.numbers?.[c] || w.number || "").replace(/\D/g, "")]));
  async function topupUssd(cur, amount) {
    const w = (await getSettings()).walletTopup, num = topupNumbers(w)[cur];
    let pre = String(w.ussd[cur] || "").trim();
    if (!num || !pre) return null;
    if (!pre.startsWith("*")) pre = "*" + pre;
    if (!pre.endsWith("*")) pre += "*";
    return `${pre}${num}*${cur === "SLSH" ? Math.round(amount) : Math.round(amount * 100) / 100}#`;
  }
  const topupRow = t => ({ id: t.id, ref: t.ref, cur: t.cur, amount: t.amount, ussd: t.ussd, purpose: t.purpose, plan_id: t.plan_id, status: t.status, note: t.note, created_at: t.created_at, decided_at: t.decided_at });
  // The customer asks for a top-up and their phone dials the USSD code; the super admin approves it once the money arrives.
  route("POST", "/api/wallet/topup", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    const cur = String(b.cur), amount = round(cur, Number(b.amount));
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    if (!(amount > 0) || amount > 1e9) fail("Enter an amount above 0.");
    let purpose = "topup", plan = null;
    if (b.plan_id) {
      plan = (await getSettings()).suuq.plans.find(p => p.id === b.plan_id && p.id !== "free");
      if (!plan) fail("Choose a subscription plan.");
      if (!await shopOf(u.id)) fail("Register as a merchant first.");
      purpose = "subscription";
    }
    const ussd = await topupUssd(cur, amount);
    if (!ussd) fail("Top-up by USSD isn't set up yet. Contact support.");
    const pending = (await db.get("SELECT COUNT(*) AS n FROM topups WHERE user_id = ? AND status = 'pending'", u.id)).n;
    if (pending >= 5) fail("You already have 5 top-ups waiting. Wait for support to confirm them.");
    const id = crypto.randomUUID(), ref = "TP" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
    await db.run("INSERT INTO topups (id, ref, user_id, cur, amount, ussd, purpose, plan_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, ref, u.id, cur, amount, ussd, purpose, plan?.id || null, now());
    broadcast("topup", { id, new: true, name: u.name, amount, cur }, x => x.role === "super");
    send(res, 200, { topup: topupRow(await db.get("SELECT * FROM topups WHERE id = ?", id)) });
  });
  route("POST", "/api/wallet/topup/:id/cancel", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer");
    if (!(await db.run("UPDATE topups SET status = 'rejected', note = 'Cancelled by you', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'", now(), id, u.id)).changes) fail("This top-up can't be cancelled.");
    broadcast("topup", { id }, x => x.role === "super");
    send(res, 200, { ok: true });
  });
  route("GET", "/api/super/topups", async (req, res, url) => {
    await needRole(req, "super");
    const st = url.searchParams.get("status") === "done" ? "done" : "pending";
    const rows = await db.all(`SELECT t.*, u.name, u.phone, u.account_type FROM topups t JOIN users u ON u.id = t.user_id WHERE ${st === "pending" ? "t.status = 'pending'" : "t.status != 'pending'"} ORDER BY t.created_at ${st === "pending" ? "ASC" : "DESC"} LIMIT 200`);
    send(res, 200, { topups: rows.map(t => ({ ...topupRow(t), name: t.name, phone: t.phone, account_type: t.account_type || "customer" })), settings: (await getSettings()).walletTopup });
  });
  route("PUT", "/api/super/wallet-settings", async (req, res) => {
    await needRole(req, "super");
    const b = await readJson(req), num = String(b.number || "").replace(/\D/g, ""), ussd = {}, numbers = {};
    if (num && (num.length < 4 || num.length > 15)) fail("Check the wallet number.");
    for (const c of CURS) {
      const n = String(b.numbers?.[c] ?? "").replace(/\D/g, "");
      if (n && (n.length < 4 || n.length > 15)) fail(`Check the ${c} agent number.`);
      numbers[c] = n;
    }
    for (const c of CURS) {
      const v = String(b.ussd?.[c] || "").replace(/\s/g, "");
      if (v && !/^\*?[\d*]+\*?$/.test(v)) fail(`The ${c} code can only use digits and *.`);
      ussd[c] = v;
    }
    const s = await saveSettings({ walletTopup: { number: num, numbers, ussd } });
    send(res, 200, { settings: s.walletTopup });
  });
  // Approve: the money arrived, so credit the wallet. A subscription payment then renews the shop straight away.
  route("POST", "/api/super/topups/:id/:decision", async (req, res, url, [id, decision]) => {
    const me = await needRole(req, "super"), b = await readJson(req);
    if (!["approve", "reject"].includes(decision)) fail("Not found.", 404);
    let result = {};
    await tx(async () => {
      const t = await db.get("SELECT * FROM topups WHERE id = ?", id);
      if (!t || t.status !== "pending") fail("This top-up was already handled.");
      if (decision === "reject") {
        await db.run("UPDATE topups SET status = 'rejected', note = ?, decided_at = ?, decided_by = ? WHERE id = ?", String(b.note || "Money not received").slice(0, 120), now(), me.id, t.id);
        return;
      }
      await db.run("UPDATE topups SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?", now(), me.id, t.id);
      await ledger(t.user_id, t.cur, t.amount, "topup", t.ref, `USSD ${t.ussd || ""}`.trim(), me.id);
      if (t.purpose === "subscription" && t.plan_id) {
        const plan = (await getSettings()).suuq.plans.find(p => p.id === t.plan_id), shop = await shopOf(t.user_id);
        if (plan && shop && !shop.suspended && plan.cur === t.cur && await balance(t.user_id, plan.cur) >= plan.price) { await buyPlan(t.user_id, shop, plan); result.subscribed = true; }
      }
    });
    const t = await db.get("SELECT user_id FROM topups WHERE id = ?", id);
    broadcast("topup", { id }, x => x.role === "super" || x.id === t.user_id);
    send(res, 200, { ok: true, ...result });
  });

  // Super admin: find a person and top up or withdraw for them.
  route("GET", "/api/super/wallet", async (req, res, url) => {
    await needRole(req, "super");
    const phone = cleanPhone(url.searchParams.get("phone"));
    const u = await db.get("SELECT id, name, phone, role, service, face FROM users WHERE phone = ?", phone);
    if (!u) fail("No account uses this phone number.", 404);
    u.has_face = !!u.face; delete u.face;
    const rows = await db.all("SELECT * FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 50", u.id);
    send(res, 200, { user: u, balances: await balances(u.id), tx: rows.map(txRow) });
  });
  route("POST", "/api/super/wallet/adjust", async (req, res) => {
    const me = await needRole(req, "super"), b = await readJson(req);
    const target = await db.get("SELECT id FROM users WHERE id = ?", Number(b.user_id));
    if (!target) fail("Person not found.", 404);
    const cur = String(b.cur), type = String(b.type), amt = round(cur, Number(b.amount));
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    if (!(amt > 0) || amt > 1e10) fail("Enter an amount above 0.");
    if (!["topup", "withdraw"].includes(type)) fail("Choose top up or withdraw.");
    const note = String(b.note || "").trim().slice(0, 120);
    await tx(async () => {
      if (type === "withdraw" && await balance(target.id, cur) < amt) fail("The wallet doesn't have enough money for this withdrawal.");
      await ledger(target.id, cur, type === "topup" ? amt : -amt, type, null, note, me.id);
    });
    send(res, 200, { balances: await balances(target.id) });
  });
  route("GET", "/api/super/income", async (req, res) => {
    await needRole(req, "super");
    const rows = await db.all("SELECT * FROM wallet_tx WHERE user_id IS NULL ORDER BY id DESC LIMIT 200");
    const held = Object.fromEntries(await Promise.all(CURS.map(async c => [c, round(c, (await db.get("SELECT COALESCE(SUM(amount),0) AS b FROM wallet_tx WHERE user_id IS NOT NULL AND cur = ?", c)).b)])));
    send(res, 200, { balances: await balances(null), customerMoney: held, tx: rows.map(txRow), shopCharge: (await getSettings()).shopCharge });
  });
  // The Pay to shop charge, taken from the merchant's wallet when each Pay to shop order is finished: one rule per
  // merchant country ("*" = every other country), each a percent of the price or a flat amount per order.
  route("PUT", "/api/super/shop-charge", async (req, res) => {
    await needRole(req, "super");
    const b = await readJson(req, 64 * 1024), seen = new Set();
    if (!Array.isArray(b.rules) || b.rules.length > 250) fail("Add the charges again.");
    const rules = b.rules.map(r => {
      const country = String(r.country || ""), type = r.type === "flat" ? "flat" : "pct";
      if (country !== "*" && !COUNTRIES.includes(country)) fail("Choose a country from the list.");
      if (seen.has(country)) fail(`${country === "*" ? "Every other country" : country} is in the list twice.`);
      seen.add(country);
      const name = country === "*" ? "Every other country" : country;
      const pct = Math.round(Number(r.pct || 0) * 100) / 100, usd = round("USD", Number(r.USD || 0)), slsh = round("SLSH", Number(r.SLSH || 0));
      if (type === "pct" && !(pct >= 0 && pct <= 50)) fail(`${name}: enter a percent between 0 and 50.`);
      if (type === "flat" && !(usd >= 0 && usd <= 1000 && slsh >= 0 && slsh <= 10000000)) fail(`${name}: enter a flat amount of 0 or more (up to 1000 USD / 10,000,000 SLSH).`);
      return { country, type, pct: type === "pct" ? pct : 0, USD: type === "flat" ? usd : 0, SLSH: type === "flat" ? slsh : 0 };
    });
    if (!seen.has("*")) rules.unshift({ country: "*", type: "pct", pct: 0, USD: 0, SLSH: 0 });
    rules.sort((a, b) => (a.country === "*" ? -1 : b.country === "*" ? 1 : a.country.localeCompare(b.country)));
    broadcast("settings", publicSettings(await saveSettings({ shopCharge: rules })));
    send(res, 200, { shopCharge: rules });
  });

  /* ---------- media (product pictures) ---------- */
  // Checks every picture first (it must really be a JPEG, PNG or WebP photo), then stores them all.
  const MAX_IMAGES = 10;
  const realImage = (buf, type) =>
    type === "jpeg" ? buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    : type === "png" ? buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  async function saveImages(dataUrls, prefix) {
    const items = dataUrls.map(dataUrl => {
      const m = String(dataUrl || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) fail("A picture could not be read. Use a photo (JPG, PNG or WebP).");
      const buf = Buffer.from(m[2], "base64");
      if (!realImage(buf, m[1])) fail("One of the files is not a real photo. Use a photo (JPG, PNG or WebP).");
      if (buf.length < 2000) fail("A picture is too small. Use a real photo of the product.");
      if (buf.length > 3 * 1024 * 1024) fail("Each picture must be smaller than 3 MB.");
      return { file: `${prefix}-${crypto.randomUUID()}.${m[1] === "jpeg" ? "jpg" : m[1]}`, buf };
    });
    for (const it of items) await db.files.put(it.file, it.buf);
    return items.map(it => it.file);
  }
  route("GET", "/media/:file", async (req, res, url, [file]) => {
    const f = path.basename(file);
    const data = /^(prod|svc|shop)-[\w-]+\.(jpg|png|webp)$/.test(f) ? await db.files.get(f) : null;
    if (!data) { res.writeHead(404); return res.end(); }
    const ext = path.extname(f).slice(1);
    res.writeHead(200, { "Content-Type": ext === "jpg" ? "image/jpeg" : "image/" + ext, "Content-Length": data.length, "Cache-Control": "public, max-age=604800, immutable" });
    res.end(data);
  });

  // The super admin can give any service tile its own photo (shown instead of the built-in picture).
  const svcList = s => s.services.map(x => ({ ...x, photo: x.photo ? "/media/" + x.photo : null }));
  route("POST", "/api/super/services/:id/photo", async (req, res, url, [id]) => {
    await needRole(req, "super");
    const b = await readJson(req), s = await getSettings();
    const i = s.services.findIndex(x => x.id === id); if (i < 0) fail("That service was not found.");
    const [file] = await saveImages([b.image], "svc-" + id.replace(/[^\w-]/g, ""));
    const old = s.services[i].photo;
    const services = s.services.map((x, j) => j === i ? { ...x, photo: file } : x);
    const ns = await saveSettings({ services });
    if (old) await db.files.del(old);
    broadcast("settings", publicSettings(ns));
    send(res, 200, { services: svcList(ns) });
  });
  route("DELETE", "/api/super/services/:id/photo", async (req, res, url, [id]) => {
    await needRole(req, "super");
    const s = await getSettings(), i = s.services.findIndex(x => x.id === id); if (i < 0) fail("That service was not found.");
    const old = s.services[i].photo;
    const ns = await saveSettings({ services: s.services.map((x, j) => j === i ? { ...x, photo: null } : x) });
    if (old) await db.files.del(old);
    broadcast("settings", publicSettings(ns));
    send(res, 200, { services: svcList(ns) });
  });

  // A service's photo gallery. Only the super admin and that service's own admin can change it.
  const MAX_GALLERY = 40;
  route("POST", "/api/admin/service-page/:id/gallery", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const b = await readJson(req, 5 * 1024 * 1024);
    const images = Array.isArray(b.images) ? b.images : [];
    if (!images.length) fail("Choose at least one photo.");
    const s0 = await getSettings(), have = (s0.services.find(x => x.id === id).gallery || []).length;
    if (have + images.length > MAX_GALLERY) fail(`A gallery can have up to ${MAX_GALLERY} photos.`);
    const files = await saveImages(images, "svc-" + id.replace(/[^\w-]/g, "") + "-g");
    const titles = Array.isArray(b.titles) ? b.titles : [], credits = Array.isArray(b.credits) ? b.credits : [];
    const add = files.map((file, k) => ({ file, title: String(titles[k] || "").trim().slice(0, 60), credit: String(credits[k] || "").trim().slice(0, 120) }));
    const s = await getSettings();
    const ns = await saveSettings({ services: s.services.map(x => x.id === id ? { ...x, gallery: [...(x.gallery || []), ...add] } : x) });
    broadcast("settings", publicSettings(ns));
    send(res, 200, pageOf(ns.services.find(x => x.id === id)));
  });
  route("DELETE", "/api/admin/service-page/:id/gallery/:file", async (req, res, url, [id, file]) => {
    await needPageEditor(req, id);
    const f = path.basename(file), s = await getSettings();
    if (!(s.services.find(x => x.id === id).gallery || []).some(g => g.file === f)) fail("That photo was not found.", 404);
    const ns = await saveSettings({ services: s.services.map(x => x.id === id ? { ...x, gallery: x.gallery.filter(g => g.file !== f) } : x) });
    await db.files.del(f);
    broadcast("settings", publicSettings(ns));
    send(res, 200, pageOf(ns.services.find(x => x.id === id)));
  });

  /* ---------- tracking (Saba Multi Services) ---------- */
  // The service's admin (or the super admin) adds tracking numbers and updates them; every update is kept as history.
  // Customers look a number up on the service page, and see the ones made for their own phone number.
  const TRACK_STATUS = ["Order received", "Processing", "Shipped", "In transit", "Arrived", "Ready for pickup", "Delivered", "Cancelled"];
  const tStr = (v, n) => String(v ?? "").trim().slice(0, n);
  const tCode = v => String(v || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  const trackOut = (t, full) => ({ id: t.id, code: t.code, item: t.item, status: t.status, location: t.location, note: t.note, created_at: t.created_at, updated_at: t.updated_at,
    history: JSON.parse(t.history || "[]"), ...(full ? { customer: t.customer, phone: t.phone } : { customer: t.customer ? t.customer.split(" ")[0] : "" }) });
  const readTrack = b => {
    const status = tStr(b.status, 40) || TRACK_STATUS[0];
    if (!TRACK_STATUS.includes(status)) fail("Choose a status from the list.");
    return { customer: tStr(b.customer, 80), phone: cleanPhone(b.phone).slice(0, 15), item: tStr(b.item, 120), status, location: tStr(b.location, 80), note: tStr(b.note, 300) };
  };
  route("GET", "/api/admin/service-page/:id/tracking", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const rows = await db.all("SELECT * FROM trackings WHERE service = ? ORDER BY updated_at DESC LIMIT 300", id);
    send(res, 200, { statuses: TRACK_STATUS, trackings: rows.map(t => trackOut(t, true)) });
  });
  route("POST", "/api/admin/service-page/:id/tracking", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const b = await readJson(req), t = readTrack(b);
    if (!t.item && !t.customer) fail("Enter what is being tracked or the customer's name.");
    let code = tCode(b.code);
    if (b.code && code.length < 4) fail("A tracking number needs at least 4 letters or numbers.");
    if (!code) do code = "SB" + crypto.randomInt(100000, 1000000); while (await db.get("SELECT id FROM trackings WHERE service = ? AND code = ?", id, code));
    else if (await db.get("SELECT id FROM trackings WHERE service = ? AND code = ?", id, code)) fail("That tracking number is already used.");
    const at = now();
    await db.run("INSERT INTO trackings (service, code, customer, phone, item, status, location, note, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, code, t.customer, t.phone, t.item, t.status, t.location, t.note, JSON.stringify([{ at, status: t.status, location: t.location, note: t.note }]), at, at);
    const row = await db.get("SELECT * FROM trackings WHERE service = ? AND code = ?", id, code);
    broadcast("tracking", { service: id });
    send(res, 200, { tracking: trackOut(row, true) });
  });
  route("PUT", "/api/admin/service-page/:id/tracking/:tid", async (req, res, url, [id, tid]) => {
    await needPageEditor(req, id);
    const old = await db.get("SELECT * FROM trackings WHERE id = ? AND service = ?", Number(tid), id);
    if (!old) fail("That tracking number was not found.", 404);
    const b = await readJson(req), t = readTrack({ ...old, ...b }), at = now();
    const history = JSON.parse(old.history || "[]");
    if (t.status !== old.status || t.location !== old.location || t.note !== old.note) history.push({ at, status: t.status, location: t.location, note: t.note });
    await db.run("UPDATE trackings SET customer = ?, phone = ?, item = ?, status = ?, location = ?, note = ?, history = ?, updated_at = ? WHERE id = ?",
      t.customer, t.phone, t.item, t.status, t.location, t.note, JSON.stringify(history.slice(-50)), at, old.id);
    broadcast("tracking", { service: id });
    send(res, 200, { tracking: trackOut(await db.get("SELECT * FROM trackings WHERE id = ?", old.id), true) });
  });
  route("DELETE", "/api/admin/service-page/:id/tracking/:tid", async (req, res, url, [id, tid]) => {
    await needPageEditor(req, id);
    await db.run("DELETE FROM trackings WHERE id = ? AND service = ?", Number(tid), id);
    broadcast("tracking", { service: id });
    send(res, 200, { ok: true });
  });
  // Customers: one number, or every number made for their phone.
  route("GET", "/api/track/:id", async (req, res, url, [id]) => {
    const u = await needUser(req);
    const code = tCode(url.searchParams.get("code"));
    if (code) {
      rateLimit(req, 60, 15 * 60 * 1000, "track");
      const t = await db.get("SELECT * FROM trackings WHERE service = ? AND code = ?", id, code);
      if (!t) fail("No tracking number like that. Check it and try again.", 404);
      return send(res, 200, { tracking: trackOut(t, false) });
    }
    const rows = u.phone ? await db.all("SELECT * FROM trackings WHERE service = ? AND phone = ? ORDER BY updated_at DESC LIMIT 50", id, cleanPhone(u.phone)) : [];
    send(res, 200, { trackings: rows.map(t => trackOut(t, false)) });
  });

  /* ---------- shops and subscriptions ---------- */
  const shopOf = async uid => await db.get("SELECT * FROM shops WHERE owner_id = ?", uid);
  const shopActive = s => s && !s.suspended && s.sub_until > now();
  const publicShop = async s => !s ? null : ({ id: s.id, shop_no: s.shop_no, name: s.name, sub_until: s.sub_until, plan: s.plan, plan_info: (await getSettings()).suuq.plans.find(p => p.id === s.plan) || null, product_count: (await db.get("SELECT COUNT(*) AS n FROM products WHERE shop_id = ? AND deleted = 0 AND service != 'ticket'", s.id)).n, suspended: !!s.suspended, active: shopActive(s), profile: JSON.parse(s.profile || "{}") });

  // Seller registration form. Somaliland and neighbours first, then every other country.
  const COUNTRIES = ["Somaliland", "Somalia", "Djibouti", "Ethiopia", "Kenya", "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Côte d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czechia", "Democratic Republic of the Congo", "Denmark", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "São Tomé and Príncipe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Türkiye", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"];
  // need: a new merchant must choose a business category (older shops may not have one yet).
  function readProfile(b, cats, need) {
    const t = (k, n = 80) => String(b[k] || "").trim().slice(0, n), num = k => String(b[k] || "").replace(/\D/g, "");
    const p = { full_name: t("full_name"), birth_date: t("birth_date", 10), country: t("country", 60), city: t("city", 60), kind: t("kind", 10),
      business_name: t("business_name", 60), address: t("address", 160), phone: num("phone"), zaad_merchant: num("zaad_merchant"), edahab_merchant: num("edahab_merchant"), shop_phone: num("shop_phone") };
    if (p.full_name.length < 3) fail("Enter your full name.");
    const bd = /^\d{4}-\d{2}-\d{2}$/.test(p.birth_date) ? new Date(p.birth_date + "T00:00:00") : null;
    if (!bd || isNaN(bd)) fail("Enter your birth date.");
    const age = (Date.now() - bd.getTime()) / (365.25 * 86400000);
    if (age < 18) fail("Sellers must be at least 18 years old.");
    if (age > 120) fail("Check your birth date.");
    if (!COUNTRIES.includes(p.country)) fail("Choose your country from the list.");
    if (p.city.length < 2) fail("Enter your city.");
    if (!["shop", "company"].includes(p.kind)) fail("Choose Shop or Company.");
    if (p.business_name.length < 2) fail(`Enter the name of your ${p.kind === "company" ? "company" : "shop"}.`);
    if (p.address.length < 4) fail("Enter your address.");
    const cat = (cats || []).find(c => c.name === t("category", 60));
    if (cat) { p.category = cat.name; p.section = cat.section;
      if ((cat.subs || []).length) { if (!cat.subs.includes(t("category_sub", 60))) fail(`Choose the kind of ${cat.name.toLowerCase()}.`); p.category_sub = t("category_sub", 60); } }
    else if (need || t("category")) fail("Choose your business category.");
    if (p.phone.length < 7 || p.phone.length > 15) fail("Enter a valid phone number.");
    for (const [k, label] of [["zaad_merchant", "ZAAD merchant number"], ["edahab_merchant", "eDahab merchant number"], ["shop_phone", "shop phone number"]])
      if (p[k] && (p[k].length < 4 || p[k].length > 15)) fail(`Check the ${label}.`);
    if (!p.zaad_merchant && !p.edahab_merchant) fail("Enter at least one merchant number (ZAAD or eDahab).");
    return p;
  }

  route("GET", "/api/suuq/plans", async (req, res) => { const s = await getSettings(); send(res, 200, { plans: s.suuq.plans, countries: COUNTRIES, categories: s.bizCats }); });
  // Merchant sign-up from the first screen: the seller registration form plus a PIN. The phone is the login.
  route("POST", "/api/auth/signup-merchant", async (req, res) => {
    rateLimit(req);
    const b = await readJson(req, 1024 * 1024), p = readProfile(b.profile || {}, (await getSettings()).bizCats, true), pin = String(b.pin || "");
    const phone = cleanPhone(p.phone);
    if (phone.length < 7 || phone.length > 12) fail("Enter a valid phone number.");
    if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
    if (await db.get("SELECT 1 FROM users WHERE phone = ?", phone)) fail("This phone number already has an account. Log in, then choose “Become a merchant” in Account.");
    p.phone = phone;
    const face = b.face ? readFace(b.face) : null;
    const u = await tx(async () => {
      const info = await db.run("INSERT INTO users (name, phone, role, account_type, pin_hash, wallets, created_at, ref_code) VALUES (?, ?, 'customer', 'merchant', ?, '{}', ?, ?)", p.full_name, phone, hashSecret(pin), now(), await newRefCode());
      await db.run("INSERT INTO shops (owner_id, name, profile, sub_until, plan, shop_no, created_at) VALUES (?, ?, ?, ?, 'free', ?, ?)", info.lastInsertRowid, p.business_name, JSON.stringify(p), await freeUntil(), await nextShopNo(), now());
      return await db.get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid);
    });
    if (face) await storeFace(u.id, face);
    startSession(res, u);
    send(res, 200, { user: publicUser(face ? await db.get("SELECT * FROM users WHERE id = ?", u.id) : u) });
  });
  // An existing customer becomes a merchant by filling in the same form.
  route("POST", "/api/suuq/become-merchant", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    if (await shopOf(u.id)) fail("You are already a merchant.");
    const p = readProfile(b, (await getSettings()).bizCats, true);
    await tx(async () => {
      await db.run("INSERT INTO shops (owner_id, name, profile, sub_until, plan, shop_no, created_at) VALUES (?, ?, ?, ?, 'free', ?, ?)", u.id, p.business_name, JSON.stringify(p), await freeUntil(), await nextShopNo(), now());
      await db.run("UPDATE users SET account_type = 'merchant' WHERE id = ?", u.id);
    });
    send(res, 200, { user: publicUser(await db.get("SELECT * FROM users WHERE id = ?", u.id)), shop: await publicShop(await shopOf(u.id)) });
  });
  // Seller updates their registration details at any time.
  route("PUT", "/api/suuq/shop/profile", async (req, res) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id), b = await readJson(req);
    if (!s) fail("Open your shop first.");
    const p = readProfile(b, (await getSettings()).bizCats, false);
    await db.run("UPDATE shops SET profile = ?, name = ? WHERE id = ?", JSON.stringify(p), p.business_name, s.id);
    if (p.category) await db.run("UPDATE products SET category = ? WHERE shop_id = ? AND service = 'suuq'", p.category, s.id);
    send(res, 200, { shop: await publicShop(await shopOf(u.id)) });
  });
  route("GET", "/api/suuq/my-shop", async (req, res) => { const u = await needUser(req); send(res, 200, { shop: await publicShop(await shopOf(u.id)) }); });

  // Open a shop or renew: the plan price is taken from the seller's wallet and goes to the platform as income.
  // Takes the plan price from the merchant's wallet (platform income) and extends the shop. Call inside tx().
  async function buyPlan(userId, shop, plan) {
    const from = Math.max(now(), shop.sub_until);
    await db.run("UPDATE shops SET sub_until = ?, plan = ? WHERE id = ?", from + plan.days * 86400000, plan.id, shop.id);
    const ref = "SUB-" + shop.id;
    await ledger(userId, plan.cur, -plan.price, "subscription", ref, `${plan.name} for ${shop.name}`);
    await ledger(null, plan.cur, plan.price, "subscription_income", ref, `${shop.name} · ${plan.name}`);
  }
  const freePlan = async () => (await getSettings()).suuq.plans.find(p => p.id === "free");
  const freeUntil = async () => now() + (Number((await freePlan())?.days) || 0) * 86400000;
  const planOf = async s => (await getSettings()).suuq.plans.find(p => p.id === s?.plan);
  route("POST", "/api/suuq/shop", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    const plan = (await getSettings()).suuq.plans.find(p => p.id === b.plan_id && p.id !== "free");
    if (!plan) fail("Choose a subscription plan.");
    let shop = await shopOf(u.id);
    // Only merchants pay for a subscription; they registered with the seller form.
    if (!shop) fail("Register as a merchant first.");
    const name = shop.name, profile = null;
    if (shop?.suspended) fail("Your shop is suspended. Contact support.");
    await needPin(u, b.pin);
    await tx(async () => {
      if (await balance(u.id, plan.cur) < plan.price) fail(`Your wallet needs at least ${plan.cur === "USD" ? "$" + plan.price : plan.price + " SLSH"} for this plan. Top up your wallet or pay by USSD.`);
      await buyPlan(u.id, shop, plan);
    });
    send(res, 200, { shop: await publicShop(await shopOf(u.id)), balances: await balances(u.id) });
  });

  /* ---------- products ---------- */
  const COMMISSION = (p, qty) => {
    const total = p.price * qty;
    const c = p.comm_type === "flat" ? p.comm_value * qty : total * p.comm_value / 100;
    return round(p.cur, Math.min(Math.max(0, c), total));
  };
  function productRow(p, extra = {}) {
    return { id: p.id, name: p.name, description: p.description, price: p.price, cur: p.cur, mode: p.mode,
      images: JSON.parse(p.images || "[]").map(f => "/media/" + f), video: p.video, comm_type: p.comm_type, comm_value: p.comm_value,
      earn: COMMISSION(p, 1), pause: PAUSES.includes(p.shop_pause) ? p.shop_pause : "", shop_id: p.shop_id, shop_no: p.shop_no ?? null, shop_name: p.shop_name, seller_id: p.owner_id, hidden: !!p.hidden,
      admin_hidden: !!p.admin_hidden, created_at: p.created_at, approval: p.approval || "approved", review_note: p.review_note || "", service: p.service || "suuq", country: p.country || "", price_hidden: !!p.price_hidden, price_label: p.price_label || "", category: p.category || "", stock: p.stock ?? -1, unit: p.unit || "",
      pay_shop: p.shop_profile !== undefined ? (n => ({ merchant: !!n.merchant, number: !!n.number }))(shopPayNums(p.shop_profile)) : undefined, ...extra };
  }
  // What a shopper sees: a hidden price is replaced by the seller's word, but the affiliate earning is always shown
  // (as a percentage, or the flat amount the seller set).
  function shopperRow(p, u, extra = {}) {
    const r = productRow(p, extra);
    if (p.price_hidden && p.owner_id !== u.id) { r.price = null; r.earn = p.comm_type === "flat" ? p.comm_value : null; }
    return r;
  }
  const PROD_SELECT = "SELECT p.*, s.name AS shop_name, s.shop_no, s.owner_id, s.sub_until, s.suspended AS shop_suspended, s.profile AS shop_profile, (SELECT pause FROM users WHERE id = s.owner_id) AS shop_pause FROM products p JOIN shops s ON s.id = p.shop_id";
  // Salah time and Sleep time: the seller pauses new orders until they turn it off.
  const PAUSES = ["salah", "sleep"];
  const pauseMsg = (shop, mode) => mode === "salah" ? `${shop} is at Salah time right now. Try again a little later.` : `${shop} is closed for the night (Sleep time). Try again in the morning.`;
  // Shoppers only see products the admin approved, that the seller hasn't hidden, in an open shop.
  const LIVE = "p.deleted = 0 AND p.hidden = 0 AND p.admin_hidden = 0 AND p.approval = 'approved' AND s.suspended = 0 AND s.sub_until > ?";
  // The same, but also a travel agency's ticket item (hidden from the lists; opened from Ticket or a shared link).
  const LIVE_T = LIVE.replace("p.hidden = 0", "(p.hidden = 0 OR p.service = 'ticket' OR p.service LIKE 'svc:%')");
  const suuqOpen = async () => (await getSettings()).services.some(x => x.id === "suuq" && x.visible);

  route("GET", "/api/suuq/products", async (req, res, url) => {
    const u = await needUser(req), m = MARKETS.includes(url.searchParams.get("service")) ? url.searchParams.get("service") : "suuq";
    if (!await marketOpen(m)) fail(`${MNAME[m]} is not available right now.`);
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase(), country = String(url.searchParams.get("country") || "");
    let rows = await db.all(`${PROD_SELECT} WHERE ${LIVE} AND p.service = ? ORDER BY p.created_at DESC LIMIT 500`, now(), m);
    // Visas: the countries that have visas right now (with how many), for the country buttons.
    const countries = hasCountry(m) ? Object.entries(rows.reduce((a, p) => (p.country && (a[p.country] = (a[p.country] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n })) : undefined;
    if (country) rows = rows.filter(p => p.country === country);
    if (q) rows = rows.filter(p => p.name.toLowerCase().includes(q) || p.shop_name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || (p.country || "").toLowerCase().includes(q));
    send(res, 200, { products: rows.map(p => shopperRow(p, u)), countries });
  });
  /* ---------- search (services page) and shop pages ---------- */
  // What a shopper may see about a shop.
  function shopCard(s) {
    const pf = JSON.parse(s.profile || "{}");
    return { id: s.id, shop_no: s.shop_no, name: s.name, kind: pf.kind === "company" ? "company" : "shop", owner_name: pf.full_name || s.owner_name || "",
      city: pf.city || "", country: pf.country || "", product_count: Number(s.product_count) || 0 };
  }
  const SHOP_SELECT = `SELECT s.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.deleted = 0 AND p.hidden = 0 AND p.admin_hidden = 0 AND p.approval = 'approved') AS product_count
    FROM shops s JOIN users u ON u.id = s.owner_id WHERE s.suspended = 0 AND s.sub_until > ?`;
  // One search box for everything: shop number, shop or company name, merchant name, product name, service name.
  route("GET", "/api/search", async (req, res, url) => {
    const u = await needUser(req);
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 60);
    if (!q) return send(res, 200, { services: [], shops: [], products: [] });
    const digits = /^[#\s]*\d+$/.test(q) ? q.replace(/\D/g, "") : "";
    const has = v => String(v || "").toLowerCase().includes(q);
    const s = await getSettings();
    const services = s.services.filter(x => x.visible && (has(x.name) || has(x.sub))).map(x => ({ id: x.id, name: x.name, sub: x.sub, art: x.art, ready: x.ready, photo: x.photo ? "/media/" + x.photo : null, videos: serviceVideos(x), whatsapp: x.whatsapp || "", phone: x.phone || "", tiktok: x.tiktok || "" }));
    const shopRows = (await db.all(`${SHOP_SELECT} ORDER BY s.shop_no`, now())).filter(r => {
      const pf = JSON.parse(r.profile || "{}");
      return (digits && String(r.shop_no).startsWith(digits)) || has(r.name) || has(pf.business_name) || has(pf.full_name) || has(r.owner_name);
    });
    const open = [];
    for (const m of MARKETS) if (await marketOpen(m)) open.push(m);
    const shopIds = new Set(shopRows.map(r => r.id));
    const prodRows = (await db.all(`${PROD_SELECT} WHERE ${LIVE} ORDER BY p.created_at DESC LIMIT 1000`, now())).filter(p => open.includes(p.service || "suuq") &&
      ((digits && String(p.shop_no) === digits) || has(p.name) || has(p.description) || has(p.shop_name) || has(p.country || "") || shopIds.has(p.shop_id)));
    send(res, 200, { services, shops: shopRows.slice(0, 20).map(shopCard), products: prodRows.slice(0, 40).map(p => shopperRow(p, u)) });
  });
  // A shop page: the shop's details and its live products (Suuq and Visa).
  route("GET", "/api/suuq/shops/:id", async (req, res, url, [id]) => {
    const u = await needUser(req);
    const s = await db.get(`${SHOP_SELECT} AND s.id = ?`, now(), Number(id));
    if (!s) fail("This shop is not open right now.", 404);
    const rows = await db.all(`${PROD_SELECT} WHERE ${LIVE} AND p.shop_id = ? ORDER BY p.created_at DESC`, now(), s.id);
    send(res, 200, { shop: shopCard(s), products: rows.map(p => shopperRow(p, u)) });
  });

  /* Affiliate links. Anyone with an app account earns, customer or seller (not staff). The first sender earns: when someone opens a
     product from a shared link, that sender is remembered for them and that product, and stays the earner even if
     the person passes the link on. A seller's own link has no code, so the seller keeps the whole price. */
  const earner = async code => {
    code = String(code || "").trim().toUpperCase(); if (!code) return null;
    const a = await db.get("SELECT id, ref_code, role, account_type FROM users WHERE ref_code = ?", code);
    return a && a.role === "customer" ? a : null;
  };
  async function rememberRef(userId, p, code) {
    const a = await earner(code);
    if (!a || a.id === userId || a.id === p.owner_id) return;
    await db.run("INSERT INTO product_refs (user_id, product_id, ref_user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", userId, p.id, a.id, now());
  }
  async function firstSender(userId, productId) {
    const r = await db.get("SELECT u.ref_code FROM product_refs r JOIN users u ON u.id = r.ref_user_id WHERE r.user_id = ? AND r.product_id = ?", userId, productId);
    return r ? await earner(r.ref_code) : null;
  }
  // The code to put in the links this person shares: the first sender's, else their own. A seller's link to their
  // own product has no code.
  async function shareCode(u, p) {
    if (u.role !== "customer" || p.owner_id === u.id) return null;
    const f = await firstSender(u.id, p.id); return f ? f.ref_code : u.ref_code;
  }

  /* ---------- favourites ---------- */
  route("GET", "/api/suuq/favorites", async (req, res) => {
    const u = await needUser(req);
    const rows = await db.all(`${PROD_SELECT} JOIN favorites f ON f.product_id = p.id WHERE f.user_id = ? AND ${LIVE_T} ORDER BY f.created_at DESC LIMIT 200`, u.id, now());
    send(res, 200, { products: rows.map(p => shopperRow(p, u, { fav: true })) });
  });
  route("POST", "/api/suuq/favorites/:id", async (req, res, url, [id]) => {
    const u = await needUser(req), b = await readJson(req);
    if (b.on) {
      if (!await db.get("SELECT id FROM products WHERE id = ? AND deleted = 0", id)) fail("This product is not available.", 404);
      if (!await db.get("SELECT 1 AS x FROM favorites WHERE user_id = ? AND product_id = ?", u.id, id))
        await db.run("INSERT INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?)", u.id, id, now());
    } else await db.run("DELETE FROM favorites WHERE user_id = ? AND product_id = ?", u.id, id);
    send(res, 200, { fav: !!b.on });
  });
  route("GET", "/api/suuq/products/:id", async (req, res, url, [id]) => {
    const u = await needUser(req);
    const p = await db.get(`${PROD_SELECT} WHERE p.id = ? AND p.deleted = 0`, id);
    const live = p && (!p.hidden || p.service === "ticket" || String(p.service).startsWith("svc:")) && !p.admin_hidden && p.approval === "approved" && !p.shop_suspended && p.sub_until > now();
    if (!p || (!live && p.owner_id !== u.id)) fail("This product is not available.", 404);
    if (live && u.role === "customer") await rememberRef(u.id, p, url.searchParams.get("ref"));
    const code = await shareCode(u, p);
    // Pay to shop: how many items the merchant's wallet can cover the earning for, and whether this buyer earns it.
    // The charge is a percent per item (grows with the quantity) or a flat amount per order (fixed).
    const sells = p.mode === "buy" && !p.price_hidden, per = sells ? COMMISSION(p, 1) : 0, rule = sells ? await chargeRule(p.shop_id) : { type: "pct", pct: 0 };
    const chItem = rule.type === "flat" ? 0 : chargeFor(rule, p.cur, p.price), chFixed = rule.type === "flat" ? chargeFor(rule, p.cur, p.price) : 0;
    const bal = per + chItem + chFixed > 0 ? await balance(p.owner_id, p.cur) : 0;
    const cover = (each, fixed) => bal + 1e-9 < fixed ? 0 : each > 0 ? Math.min(100, Math.floor((bal - fixed) / each + 1e-9)) : 100;
    const fav = !!(await db.get("SELECT 1 AS x FROM favorites WHERE user_id = ? AND product_id = ?", u.id, p.id));
    send(res, 200, { product: shopperRow(p, u, { share_code: code, first_sender: !!code && code !== u.ref_code,
      earn_mine: u.role === "customer" && p.owner_id !== u.id && !!code && code === u.ref_code, shop_cover: cover(per + chItem, chFixed), shop_cover_charge: cover(chItem, chFixed), fav }) });
  });

  async function readProduct(b, existing) {
    const name = String(b.name ?? existing?.name ?? "").trim().slice(0, 60);
    const price = Number(b.price ?? existing?.price), cur = String(b.cur ?? existing?.cur);
    const mode = String(b.mode ?? existing?.mode), comm_type = String(b.comm_type ?? existing?.comm_type ?? "percent");
    const comm_value = Number(b.comm_value ?? existing?.comm_value ?? 0);
    if (name.length < 2) fail("Give the product a short name.");
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    if (!(price > 0) || price > 1e10) fail("Enter a price above 0.");
    if (!["buy", "book"].includes(mode)) fail("Choose Buy or Book.");
    if (!["percent", "flat"].includes(comm_type) || !(comm_value >= 0)) fail("Check the affiliate earning.");
    if (comm_type === "percent" && comm_value > 90) fail("The affiliate percentage can be at most 90%.");
    if (comm_type === "flat" && comm_value >= price) fail("The affiliate amount must be lower than the price.");
    let video = String(b.video ?? existing?.video ?? "").trim();
    if (video && !/^https?:\/\/\S+$/i.test(video)) fail("The video link must start with http:// or https://");
    const service = String(b.service ?? existing?.service ?? "suuq");
    if (!MARKETS.includes(service)) fail("Choose Suuq, Visa, Scholarship or Technician.");
    if (service !== existing?.service && !await marketOpen(service)) fail(`${MNAME[service]} is not open right now.`);
    const price_hidden = b.price_hidden === undefined ? !!existing?.price_hidden : !!b.price_hidden;
    const price_label = price_hidden ? String(b.price_label ?? existing?.price_label ?? "") : "";
    if (price_hidden && !(await getSettings()).priceWords.includes(price_label)) fail("Choose the words to show instead of the price.");
    // A visa is for one country; customers browse visas by country.
    const country = hasCountry(service) ? String(b.country ?? existing?.country ?? "").trim() : "";
    if (hasCountry(service) && !COUNTRIES.includes(country)) fail(service === "visa" ? "Choose the country this visa is for." : "Choose the country of the scholarship.");
    return { service, country, price_hidden: price_hidden ? 1 : 0, price_label, name, description: String(b.description ?? existing?.description ?? "").trim().slice(0, 600), price: round(cur, price), cur, mode, comm_type, comm_value: comm_type === "flat" ? round(cur, comm_value) : Math.round(comm_value * 100) / 100, video: video.slice(0, 500) };
  }
  // A merchant registered under a business category sells only in that category's section:
  // Clothes, Electronics… → Suuq; Barber, Mechanic… → Technician; Travel Agency → visas and scholarships.
  // Shops registered before categories existed have no limit.
  const SECTION_SVCS = { suuq: ["suuq"], technician: ["technician"], ticket: ["visa", "scholarship"] };
  function allowedSvcs(s) {
    let pf = {}; try { pf = JSON.parse(s?.profile || "{}"); } catch {}
    if (!pf.category) return null;
    return { list: SECTION_SVCS[pf.section] || ["suuq"], category: pf.category + (pf.category_sub ? ` (${pf.category_sub})` : "") };
  }
  const shopCategory = s => { try { return JSON.parse(s?.profile || "{}").category || ""; } catch { return ""; } };
  function checkCategory(s, service) {
    const a = allowedSvcs(s); if (!a || a.list.includes(service)) return;
    const words = { suuq: "Suuq products", technician: "Technician services", visa: "visas", scholarship: "scholarships" };
    fail(`Your shop is registered as ${a.category}, so you can only add ${a.list.map(x => words[x]).join(" and ")}.`);
  }
  async function sellerShop(u) {
    const s = await shopOf(u.id);
    if (!s) fail("Open your shop first.");
    if (s.suspended) fail("Your shop is suspended. Contact support.");
    return s;
  }
  route("POST", "/api/suuq/products", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req, 12 * 1024 * 1024), s = await sellerShop(u);
    if (!shopActive(s)) fail("Your subscription has ended. Renew it to post products.");
    const plan = await planOf(s), limit = Number(plan?.maxProducts) || 0;
    const count = (await db.get("SELECT COUNT(*) AS n FROM products WHERE shop_id = ? AND deleted = 0 AND service != 'ticket'", s.id)).n;
    if (limit && count >= limit) fail(`Your ${plan.name} plan allows ${limit} products. Upgrade your plan to post more.`);
    const d = await readProduct(b);
    checkCategory(s, d.service);
    if (d.service === "scholarship" && !scholarAllowed(s)) fail("Only travel agencies allowed by the Scholarship admin can post scholarships.");
    const imgs = (Array.isArray(b.newImages) ? b.newImages : []).slice(0, MAX_IMAGES);
    if (!imgs.length) fail("Add at least one photo of the product.");
    const files = await saveImages(imgs, "prod");
    const id = crypto.randomUUID();
    // Every new product waits for the admin's approval before customers can see it.
    await db.run(`INSERT INTO products (id, shop_id, name, description, price, cur, mode, images, video, comm_type, comm_value, service, price_hidden, price_label, country, approval, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, id, s.id, d.name, d.description, d.price, d.cur, d.mode, JSON.stringify(files), d.video, d.comm_type, d.comm_value, d.service, d.price_hidden, d.price_label, d.country, now(), now());
    // Suuq products take the shop's business category (Clothes, Supermarket…), so buyers can browse by category.
    const shopCat = shopCategory(s); if (d.service === "suuq" && shopCat) await db.run("UPDATE products SET category = ? WHERE id = ?", shopCat, id);
    await announceReview(id);
    send(res, 200, { id, approval: "pending" });
  });
  route("PUT", "/api/suuq/products/:id", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer"), b = await readJson(req, 12 * 1024 * 1024), s = await sellerShop(u);
    const p = await db.get("SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted = 0", id, s.id);
    if (!p) fail("Product not found.", 404);
    if (b.hidden !== undefined && Object.keys(b).length === 1) {
      await db.run("UPDATE products SET hidden = ?, updated_at = ? WHERE id = ?", b.hidden ? 1 : 0, now(), id);
      return send(res, 200, { ok: true });
    }
    const d = await readProduct(b, p);
    checkCategory(s, d.service);
    if (d.service === "scholarship" && !scholarAllowed(s)) fail("Only travel agencies allowed by the Scholarship admin can post scholarships.");
    const old = JSON.parse(p.images || "[]");
    const keep = (Array.isArray(b.keepImages) ? b.keepImages : old.map(f => "/media/" + f)).map(x => path.basename(String(x))).filter(f => old.includes(f));
    const addUrls = (Array.isArray(b.newImages) ? b.newImages : []).slice(0, Math.max(0, MAX_IMAGES - keep.length));
    const add = await saveImages(addUrls, "prod");
    const images = [...keep, ...add];
    if (!images.length) fail("Add at least one photo of the product.");
    await db.run(`UPDATE products SET name = ?, description = ?, price = ?, cur = ?, mode = ?, images = ?, video = ?, comm_type = ?, comm_value = ?, service = ?, price_hidden = ?, price_label = ?, country = ?, approval = 'pending', review_note = '', updated_at = ? WHERE id = ?`, d.name, d.description, d.price, d.cur, d.mode, JSON.stringify(images), d.video, d.comm_type, d.comm_value, d.service, d.price_hidden, d.price_label, d.country, now(), id);
    for (const f of old) if (!images.includes(f)) await db.files.del(f);
    // A changed product goes back to the admin for approval (so an approved product can't be swapped for something else).
    await announceReview(id);
    send(res, 200, { ok: true, approval: "pending" });
  });
  route("DELETE", "/api/suuq/products/:id", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer"), s = await sellerShop(u);
    if (!(await db.run("UPDATE products SET deleted = 1, updated_at = ? WHERE id = ? AND shop_id = ?", now(), id, s.id)).changes) fail("Product not found.", 404);
    send(res, 200, { ok: true });
  });
  route("GET", "/api/suuq/seller/products", async (req, res) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id);
    if (!s) return send(res, 200, { products: [] });
    const rows = await db.all(`${PROD_SELECT} WHERE p.shop_id = ? AND p.deleted = 0 AND p.service != 'ticket' ORDER BY p.created_at DESC`, s.id);
    const sold = Object.fromEntries((await db.all("SELECT product_id, SUM(qty) AS n FROM orders WHERE shop_id = ? AND status = 'completed' GROUP BY product_id", s.id)).map(r => [r.product_id, r.n]));
    send(res, 200, { products: rows.map(p => productRow(p, { sold: sold[p.id] || 0 })) });
  });

  // A seller stops incoming calls for some hours, some days, or until they turn calls back on.
  route("POST", "/api/me/calls-off", async (req, res) => {
    const u = await needUser(req), b = await readJson(req);
    if (u.account_type !== "merchant") fail("Only sellers can pause calls.");
    let until = 0;
    if (b.forever) until = -1;
    else if (Number(b.hours) > 0) until = now() + Math.min(Number(b.hours), 24 * 365) * 3600e3;
    else if (Number(b.days) > 0) { const d = Math.round(Number(b.days)); if (d > 365) fail("Choose up to 365 days."); until = now() + d * 864e5; }
    await db.run("UPDATE users SET calls_off_until = ? WHERE id = ?", until, u.id);
    send(res, 200, { calls_off_until: until });
  });
  route("POST", "/api/me/pause", async (req, res) => {
    const u = await needUser(req), b = await readJson(req), mode = PAUSES.includes(b.mode) ? b.mode : "";
    await db.run("UPDATE users SET pause = ? WHERE id = ?", mode, u.id);
    send(res, 200, { pause: mode });
  });

  /* ---------- three ways to pay for a buy order ---------- */
  // wallet: from the buyer's wallet, held until they confirm they received it.
  // safe:   the phone dials the money processor agent (price + charge); the super admin confirms the money arrived,
  //         then it is held like a wallet payment and reaches the seller when the buyer confirms.
  // shop:   the phone dials the merchant's own number (price + charge); the seller confirms the money arrived.
  //         The money is already with the seller; the affiliate earning is taken from the seller's wallet when it completes.
  // Codes: merchant numbers use *223* (SLSH) / *883* (USD); normal numbers use *220* (SLSH) / *880* (USD).
  const PAY_METHODS = ["wallet", "safe", "shop"];
  const digits = v => String(v || "").replace(/\D/g, "");
  function shopPayNums(profile) {
    let pf = {}; try { pf = typeof profile === "string" ? JSON.parse(profile || "{}") : profile || {}; } catch {}
    return { merchant: digits(pf.zaad_merchant), number: digits(pf.shop_phone || pf.phone) };
  }
  const feeOf = (tiers, amt) => { for (const r of tiers || []) if (r.upTo == null || amt <= Number(r.upTo)) return Number(r.fee) || 0; return 0; };
  const ussdOf = (pre, num, amount, cur) => {
    pre = String(pre || "").trim(); if (!pre.startsWith("*")) pre = "*" + pre; if (!pre.endsWith("*")) pre += "*";
    return `${pre}${num}*${cur === "SLSH" ? Math.round(amount) : Math.round(amount * 100) / 100}#`;
  };
  // Safe payment: the whole amount goes to the admin of that part (Suuq, Technician, Hotels…) on the numbers they set.
  // A part whose admin hasn't set numbers yet uses the main money processor (the super admin) instead.
  const sectionOf = service => { const v = String(service || "suuq"); return v.startsWith("svc:") ? v.slice(4) : v; };
  async function safeNums(section) {
    const s = await getSettings(), x = s.services.find(y => y.id === section), own = { merchant: digits(x?.safe_merchant), number: digits(x?.safe_number) };
    if (section && (own.merchant || own.number)) return { ...own, section };
    return { merchant: digits(s.safePay.merchant), number: digits(s.safePay.number), section: "" };
  }
  async function payPlan(method, via, cur, total, shopProfile, service) {
    const s = await getSettings(), codes = s.safePay.codes[cur];
    const nums = method === "safe" ? await safeNums(sectionOf(service)) : shopPayNums(shopProfile);
    if (!nums.merchant && !nums.number) fail(method === "safe" ? "Safe payment isn't set up yet. Choose another way to pay." : "This shop hasn't added its payment numbers. Choose another way to pay.");
    const useMerchant = via === "normal" ? !nums.number : !!nums.merchant;
    const fee = round(cur, feeOf(s.tiers[cur], total));
    return { fee, section: method === "safe" ? nums.section : "", ussd: ussdOf(useMerchant ? codes.merchant : codes.normal, useMerchant ? nums.merchant : nums.number, total + fee, cur) };
  }
  // Who sees a safe payment: the super admin, and the admin of the part it was paid to.
  const safeAudience = section => x => isSuper(x) || (!!section && x.role === "admin" && x.service === section);
  async function safeAlarm(orderId, section, name, product, amount, cur) {
    broadcast("safepay", { new: true, name, product, amount, cur }, safeAudience(section));
    if (!section) return;
    const ids = (await db.all("SELECT id FROM users WHERE role = 'admin' AND service = ?", section)).map(x => x.id);
    pushLater(ids, { kind: "info", title: "New safe payment", body: `${name} · ${product} · ${amount} ${cur}`, goto: "safepay", tag: "sp-" + orderId });
  }

  // Pay to shop: the merchant already gets all the money, so the earning has to come from somewhere.
  //  "wallet":   the merchant's 5PLUS wallet covers it (taken when the order is finished)
  //  "discount": the buyer earns it themselves, so they simply pay the price minus their earning
  //  "none":     someone else would earn it and the merchant's wallet can't cover it: Pay to shop isn't offered
  // The 5PLUS charge (set by the super admin) is also taken from the merchant's wallet, so the wallet must cover it too.
  async function shopPayMode(sellerId, cur, commission, affId, buyerId, charge = 0) {
    const bal = await balance(sellerId, cur);
    if (!(commission > 0) || !affId) return bal >= charge ? "wallet" : "none";
    if (bal >= commission + charge) return "wallet";
    return affId === buyerId && bal >= charge ? "discount" : "none";
  }
  // The rule for the merchant's country (from their shop details), or the one for every other country.
  async function chargeRule(shopId) {
    const rules = (await getSettings()).shopCharge || [], shop = await db.get("SELECT profile FROM shops WHERE id = ?", shopId);
    let country = ""; try { country = JSON.parse(shop?.profile || "{}").country || ""; } catch {}
    return rules.find(r => r.country === country) || rules.find(r => r.country === "*") || { type: "pct", pct: 0 };
  }
  const chargeFor = (rule, cur, total) => round(cur, rule.type === "flat" ? Math.min(total, Number(rule[cur]) || 0) : total * (Number(rule.pct) || 0) / 100);
  const shopChargeOf = async (cur, total, shopId) => chargeFor(await chargeRule(shopId), cur, total);
  const NO_SHOP_PAY = "Pay to shop isn't available for this item right now. Choose another way to pay.";

  /* ---------- orders ---------- */
  const ORDER_SELECT = `SELECT o.*, b.name AS buyer_name, b.phone AS buyer_phone, s.name AS shop_name, p.images AS p_images, p.price AS p_price, p.service AS p_service, p.comm_type AS p_comm_type, p.comm_value AS p_comm_value, s.profile AS shop_profile
    FROM orders o JOIN users b ON b.id = o.buyer_id JOIN shops s ON s.id = o.shop_id JOIN products p ON p.id = o.product_id`;
  function orderRow(o, forSeller) {
    const img = JSON.parse(o.p_images || "[]")[0];
    const r = { id: o.id, ref: o.ref, product_id: o.product_id, product_name: o.product_name, image: img ? "/media/" + img : null, kind: o.kind,
      qty: o.qty, unit_price: o.unit_price, total: o.total, cur: o.cur, status: o.status, note: o.note, shop_name: o.shop_name,
      created_at: o.created_at, updated_at: o.updated_at, completed_at: o.completed_at, service: o.p_service || "suuq",
      pay_method: o.pay_method || "wallet", pay_fee: o.pay_fee || 0, pay_ussd: o.pay_ussd || "",
      my_earn: !forSeller && o.affiliate_id === o.buyer_id ? o.commission : 0,
      pay_discount: o.pay_discount || 0, buyer_ok: !!o.buyer_ok, book_at: o.book_at || "",
      pay_vias: o.pay_method === "shop" ? (n => ({ merchant: !!n.merchant, number: !!n.number }))(shopPayNums(o.shop_profile)) : undefined };
    // A hidden-price request: the seller sends the price, then the buyer pays it from the wallet.
    if (o.kind === "buy" && (o.status === "requested" || o.status === "accepted")) r.needs_price = true;
    r.offer_desc = o.offer_desc || ""; r.forwarded = !!o.forwarded_to; r.from_order = !!o.from_order;
    if (forSeller && r.needs_price) r.suggested = round(o.cur, o.p_price * o.qty);
    if (forSeller) Object.assign(r, { buyer_name: o.buyer_name, buyer_phone: o.buyer_phone, commission: o.commission, shop_charge: o.shop_charge || 0, net: round(o.cur, o.total - o.commission - (o.shop_charge || 0)), has_affiliate: !!o.affiliate_id });
    return r;
  }
  /* ---------- Push notifications (Firebase Cloud Messaging) ---------- */
  // Order alarms reach the phone even when 5PLUS is closed or the phone is locked. The super admin pastes the Firebase
  // service account key (Super admin → Services → Push notifications), or the server gets FCM_SERVICE_ACCOUNT.
  // The key never leaves the server. Each phone sends its push address after login.
  async function fcmAccount() {
    let raw = process.env.FCM_SERVICE_ACCOUNT || "";
    if (!raw) { const r = await db.get("SELECT value FROM settings WHERE key = 'fcm'"); raw = r ? r.value : ""; }
    if (!raw) return null;
    try { if (!raw.trim().startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8"); const a = JSON.parse(raw); return a.private_key && a.client_email && a.project_id ? a : null; } catch { return null; }
  }
  let fcmAuth = { token: "", until: 0, email: "" };
  async function fcmToken(a) {
    if (fcmAuth.token && fcmAuth.email === a.client_email && fcmAuth.until > now() + 60000) return fcmAuth.token;
    const b64u = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const iat = Math.floor(now() / 1000);
    const head = b64u({ alg: "RS256", typ: "JWT" }), body = b64u({ iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
    const sig = crypto.sign("RSA-SHA256", Buffer.from(head + "." + body), a.private_key).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + body + "." + sig });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error("Firebase login failed: " + (j.error_description || j.error || r.status));
    fcmAuth = { token: j.access_token, until: now() + (Number(j.expires_in) || 3600) * 1000, email: a.client_email };
    return fcmAuth.token;
  }
  // kind: "ring" (25 s alarm), "paid" (10 s alarm) or "info". goto: the page to open when tapped.
  async function pushTo(userIds, msg) {
    try {
      const ids = [...new Set(userIds.filter(Boolean))]; if (!ids.length) return;
      const a = await fcmAccount(); if (!a) return;
      const rows = await db.all(`SELECT token FROM push_tokens WHERE user_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      if (!rows.length) return;
      const bearer = await fcmToken(a);
      const data = { kind: msg.kind || "info", title: String(msg.title || "5PLUS").slice(0, 100), body: String(msg.body || "").slice(0, 300), goto: msg.goto || "", tag: msg.tag || "" };
      await Promise.all(rows.map(async ({ token }) => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, { method: "POST",
          headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", ttl: data.kind === "info" ? "86400s" : "60s" } } }) }).catch(() => null);
        if (r && (r.status === 404 || r.status === 400)) { const j = await r.json().catch(() => ({})); if (/UNREGISTERED|INVALID_ARGUMENT/.test(JSON.stringify(j))) await db.run("DELETE FROM push_tokens WHERE token = ?", token); }
      }));
    } catch (e) { console.warn("Push not sent:", e.message); }
  }
  const pushLater = (ids, msg) => { setTimeout(() => pushTo(ids, msg), 0); };
  route("POST", "/api/push/register", async (req, res) => {
    const u = await needUser(req), b = await readJson(req), token = String(b.token || "").trim();
    if (!/^[\w:.-]{20,4096}$/.test(token)) fail("Bad push address.");
    await db.run("DELETE FROM push_tokens WHERE token = ?", token);
    await db.run("INSERT INTO push_tokens (token, user_id, created_at) VALUES (?, ?, ?)", token, u.id, now());
    send(res, 200, { ok: true, on: !!(await fcmAccount()) });
  });
  route("POST", "/api/push/unregister", async (req, res) => {
    const b = await readJson(req); await db.run("DELETE FROM push_tokens WHERE token = ?", String(b.token || "")); send(res, 200, { ok: true });
  });
  route("GET", "/api/super/push", async (req, res) => {
    await needRole(req, "super"); const a = await fcmAccount();
    const phones = (await db.get("SELECT COUNT(*) AS n FROM push_tokens")).n;
    send(res, 200, { set: !!a, project: a?.project_id || "", email: a?.client_email || "", fromEnv: !!process.env.FCM_SERVICE_ACCOUNT, phones: Number(phones) || 0 });
  });
  route("PUT", "/api/super/push", async (req, res) => {
    const u = await needRole(req, "super"), b = await readJson(req, 64 * 1024);
    if (b.clear) { await db.run("DELETE FROM settings WHERE key = 'fcm'"); fcmAuth = { token: "", until: 0, email: "" }; return send(res, 200, { set: false }); }
    let a; try { a = JSON.parse(String(b.key || "")); } catch { fail("Paste the whole service account key file (it starts with {)."); }
    if (a.type !== "service_account" || !a.private_key || !a.client_email || !a.project_id) fail("This is not a Firebase service account key.");
    try { await fcmToken(a); } catch (e) { fail("Firebase did not accept this key: " + e.message); }
    await db.run("INSERT INTO settings (key, value) VALUES ('fcm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(a));
    send(res, 200, { set: true, project: a.project_id, email: a.client_email });
  });
  // Test: sends an alarm to the super admin's own phones.
  route("POST", "/api/super/push/test", async (req, res) => {
    const u = await needRole(req, "super");
    if (!await fcmAccount()) fail("Add the Firebase key first.");
    const n = (await db.get("SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?", u.id)).n;
    if (!Number(n)) fail("Open the 5PLUS app on your phone and log in first, then try again.");
    await pushTo([u.id], { kind: "ring", title: "Test alarm", body: "Push notifications work. This rings for 25 seconds.", tag: "test" });
    send(res, 200, { ok: true, phones: Number(n) });
  });

  async function pushOrder(id) {
    const o = await db.get(`${ORDER_SELECT} WHERE o.id = ?`, id); if (!o) return;
    broadcast("order", orderRow(o, true), u => u.id === o.seller_id);
    broadcast("order", orderRow(o, false), u => u.id === o.buyer_id);
    // The same news by push, for phones where 5PLUS is closed.
    {
      const svc = String(o.p_service || "").startsWith("svc:") ? o.p_service.slice(4) : null, ref = `${o.product_name} × ${o.qty}`;
      const staff = svc ? (await db.all("SELECT id FROM users WHERE (role = 'admin' AND service = ?) OR role = 'super'", svc)).map(x => x.id) : [o.seller_id];
      const st = o.status, who = o.buyer_name || "A customer";
      if (st === "requested") pushLater(staff, { kind: "ring", title: o.kind === "book" ? "New booking" : "New request", body: `${who} · ${ref}${o.book_at ? " · " + o.book_at : ""}${o.note ? " · “" + o.note + "”" : ""}`, goto: svc ? "desk" : "sellerorders", tag: o.id });
      else if (st === "paid") pushLater(staff, { kind: "paid", title: "Order paid", body: `${who} paid ${o.total} ${o.cur} · ${ref}`, goto: svc ? "desk" : "sellerorders", tag: o.id });
      else if (st === "awaiting_payment" && o.pay_method === "shop") pushLater(staff, { kind: "info", title: "Check the money", body: `${who} says they paid ${o.total} ${o.cur} to your number · ${ref}`, goto: svc ? "desk" : "sellerorders", tag: o.id });
      else if (st === "accepted") pushLater([o.buyer_id], { kind: "info", title: "Request accepted", body: `${ref}: agree the price in chat.`, goto: "orders", tag: o.id });
      else if (st === "quoted") pushLater([o.buyer_id], { kind: "info", title: "Price sent", body: `${ref}: ${o.total} ${o.cur}. Open 5PLUS to pay.`, goto: "orders", tag: o.id });
      else if (st === "delivered") pushLater([o.buyer_id], { kind: "info", title: "Delivered", body: `${ref}: confirm you received it.`, goto: "orders", tag: o.id });
    }
    if (String(o.p_service || "").startsWith("svc:")) {
      const sid = o.p_service.slice(4);
      broadcast("svcorder", { ...orderRow(o, true), desk: sid }, u => u.role === "super" || (u.role === "admin" && u.service === sid));
    }
  }

  route("POST", "/api/suuq/orders", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    let p = await db.get(`${PROD_SELECT} WHERE p.id = ? AND ${LIVE_T}`, String(b.product_id), now());
    if (!p) fail("This product is not available any more.", 404);
    // Ticket: every second request goes to the Ticket admin's agency.
    let chosen = "";
    if (p.service === "ticket" && p.owner_id !== u.id) { const a = await ticketRoute(p, u); if (a) { chosen = p.shop_name; p = a; } }
    if (!await marketOpen(p.service || "suuq")) fail(`${MNAME[p.service || "suuq"]} is not available right now.`);
    if (p.owner_id === u.id) fail("You can't order your own product.");
    if (PAUSES.includes(p.shop_pause)) fail(pauseMsg(p.shop_name, p.shop_pause));
    // Hidden price + Buy: the buyer asks for the price first. Nothing is paid until the seller sends the price.
    const ask = p.mode === "buy" && !!p.price_hidden;
    const qty = Math.floor(Number(b.qty) || 1);
    if (qty < 1 || qty > 100) fail("Choose a quantity between 1 and 100.");
    const total = round(p.cur, p.price * qty);
    // Affiliate: the first person who sent this buyer a link to this product. If there is none, the code in the link
    // (the buyer may use their own). Never the seller of the product.
    await rememberRef(u.id, p, b.ref);
    let aff = (await firstSender(u.id, p.id))?.id || null;
    // Nobody shared it with them: the buyer earns the affiliate earning themselves.
    if (!aff) { const me = await earner(u.ref_code); if (me && me.id === u.id && me.id !== p.owner_id) aff = me.id; }
    const method = PAY_METHODS.includes(b.method) ? b.method : "wallet";
    const commission = p.mode === "buy" && aff && !ask ? COMMISSION(p, qty) : 0;
    let discount = 0, charge = 0;
    if (p.mode === "buy" && !ask && method === "shop") {
      charge = await shopChargeOf(p.cur, total, p.shop_id);
      const mode = await shopPayMode(p.owner_id, p.cur, commission, aff, u.id, charge);
      if (mode === "none") fail(NO_SHOP_PAY);
      if (mode === "discount") discount = commission;
    }
    const plan = p.mode === "buy" && !ask && method !== "wallet" ? await payPlan(method, b.via, p.cur, round(p.cur, total - discount), p.shop_profile, p.service) : null;
    const id = crypto.randomUUID(), ref = "SQ" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
    const note = ((chosen ? `Customer chose ${chosen}. ` : "") + String(b.note || "").trim()).slice(0, 300);
    // Book: the customer picks the date and time they want the service.
    let bookAt = "";
    if (p.mode === "book") {
      const m = String(b.book_at || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
      if (!m) fail("Choose the date and time you want it.");
      const when = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
      if (!(when > now() - 36e5) || when > now() + 366 * 864e5) fail("Choose a date and time from today on.");
      bookAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    }
    const limited = Number(p.stock) >= 0;
    await needPin(u, b.pin); // every order is placed with the PIN
    await tx(async () => {
      // Limited items (hotel rooms…): one is held for this order until it ends.
      if (limited) {
        if ((await db.run("UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0", p.id)).changes !== 1) fail(p.unit === "night" ? "No rooms of this kind are free right now." : "None are free right now.");
      }
      if (p.mode === "buy" && !ask && !plan) {
        if (await balance(u.id, p.cur) < total) fail(`Your wallet doesn't have enough ${p.cur}. Ask support to top up your wallet.`);
        await ledger(u.id, p.cur, -total, "order_payment", ref, `${p.name} × ${qty}`);
      }
      await db.run(`INSERT INTO orders (id, ref, product_id, shop_id, buyer_id, seller_id, kind, product_name, qty, unit_price, total, cur, commission, affiliate_id, status, note, created_at, updated_at, pay_method, pay_fee, pay_ussd)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ref, p.id, p.shop_id, u.id, p.owner_id, p.mode, p.name, qty, ask ? 0 : p.price, ask ? 0 : total, p.cur, commission, aff,
                  p.mode === "buy" && !ask ? (plan ? "awaiting_payment" : "paid") : "requested", note, now(), now(), plan ? method : "wallet", plan ? plan.fee : 0, plan ? plan.ussd : "");
      if (limited) await db.run("UPDATE orders SET reserved = 1 WHERE id = ?", id);
      if (discount) await db.run("UPDATE orders SET pay_discount = ? WHERE id = ?", discount, id);
      if (charge) await db.run("UPDATE orders SET shop_charge = ? WHERE id = ?", charge, id);
      if (bookAt) await db.run("UPDATE orders SET book_at = ? WHERE id = ?", bookAt, id);
      if (plan?.section) await db.run("UPDATE orders SET safe_svc = ? WHERE id = ?", plan.section, id);
    });
    if (plan?.ussd && method === "safe") await safeAlarm(id, plan.section, u.name, p.name, round(p.cur, total - discount + plan.fee), p.cur);
    await pushOrder(id);
    send(res, 200, { order: orderRow(await db.get(`${ORDER_SELECT} WHERE o.id = ?`, id), false), balances: await balances(u.id) });
  });
  // Several products bought together, with no cart: one PIN, one payment (Wallet, or one Safe payment by phone).
  // Each product becomes its own order with its own seller; a Safe payment ties them together (pay_group).
  route("POST", "/api/suuq/orders/multi", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req, 64 * 1024);
    const items = Array.isArray(b.items) ? b.items.slice(0, 21) : [];
    if (!items.length) fail("Choose at least one product.");
    if (items.length > 20) fail("Choose up to 20 products at a time.");
    const method = b.method === "safe" ? "safe" : "wallet", lines = [];
    for (const it of items) {
      const p = await db.get(`${PROD_SELECT} WHERE p.id = ? AND ${LIVE_T}`, String(it.product_id), now());
      if (!p) fail("One of the products is not available any more.", 404);
      if (p.mode !== "buy" || p.price_hidden || p.service === "ticket") fail(`${p.name} can't be bought together with other products. Open it to order it.`);
      if (p.owner_id === u.id) fail("You can't order your own product.");
      if (PAUSES.includes(p.shop_pause)) fail(pauseMsg(p.shop_name, p.shop_pause));
      if (!await marketOpen(p.service || "suuq")) fail(`${MNAME[p.service || "suuq"]} is not available right now.`);
      if (lines.some(l => l.p.id === p.id)) continue;
      const qty = Math.floor(Number(it.qty) || 1); if (qty < 1 || qty > 100) fail("Choose a quantity between 1 and 100.");
      lines.push({ p, qty, ref: it.ref });
    }
    const cur = lines[0].p.cur;
    if (lines.some(l => l.p.cur !== cur)) fail("Choose products in one currency (all USD or all SLSH).");
    for (const l of lines) {
      await rememberRef(u.id, l.p, l.ref);
      let aff = (await firstSender(u.id, l.p.id))?.id || null;
      if (!aff) { const me = await earner(u.ref_code); if (me && me.id === u.id && me.id !== l.p.owner_id) aff = me.id; }
      l.aff = aff; l.total = round(cur, l.p.price * l.qty); l.commission = aff ? COMMISSION(l.p, l.qty) : 0;
    }
    const total = round(cur, lines.reduce((a, l) => a + l.total, 0));
    let plan = null;
    if (method === "safe") {
      const secs = new Set(lines.map(l => sectionOf(l.p.service)));
      if (secs.size > 1) fail("Safe payment works for products from one section at a time. Pay with your wallet, or buy them separately.");
      plan = await payPlan("safe", b.via, cur, total, null, lines[0].p.service);
    }
    await needPin(u, b.pin);
    const group = lines.length > 1 && plan ? crypto.randomUUID() : "", note = String(b.note || "").trim().slice(0, 300), ids = [];
    await tx(async () => {
      if (!plan && await balance(u.id, cur) < total) fail(`Your wallet doesn't have enough ${cur}. Top up your wallet first.`);
      for (const [i, l] of lines.entries()) {
        const p = l.p;
        if (Number(p.stock) >= 0 && (await db.run("UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0", p.id)).changes !== 1) fail(`${p.name} is sold out.`);
        const id = crypto.randomUUID(), ref = "SQ" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
        if (!plan) await ledger(u.id, cur, -l.total, "order_payment", ref, `${p.name} × ${l.qty}`);
        await db.run(`INSERT INTO orders (id, ref, product_id, shop_id, buyer_id, seller_id, kind, product_name, qty, unit_price, total, cur, commission, affiliate_id, status, note, created_at, updated_at, pay_method, pay_fee, pay_ussd)
                    VALUES (?, ?, ?, ?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ref, p.id, p.shop_id, u.id, p.owner_id, p.name, l.qty, p.price, l.total, cur, l.commission, l.aff,
                    plan ? "awaiting_payment" : "paid", note, now(), now(), plan ? "safe" : "wallet", plan && i === 0 ? plan.fee : 0, plan ? plan.ussd : "");
        if (Number(p.stock) >= 0) await db.run("UPDATE orders SET reserved = 1 WHERE id = ?", id);
        if (plan?.section) await db.run("UPDATE orders SET safe_svc = ? WHERE id = ?", plan.section, id);
        if (group) await db.run("UPDATE orders SET pay_group = ? WHERE id = ?", group, id);
        ids.push(id);
      }
    });
    if (plan) await safeAlarm(ids[0], plan.section, u.name, lines.length > 1 ? `${lines.length} products` : lines[0].p.name, round(cur, total + plan.fee), cur);
    for (const id of ids) await pushOrder(id);
    const orders = []; for (const id of ids) orders.push(orderRow(await db.get(`${ORDER_SELECT} WHERE o.id = ?`, id), false));
    send(res, 200, { orders, total, fee: plan ? plan.fee : 0, pay_ussd: plan ? plan.ussd : "", balances: await balances(u.id) });
  });
  route("GET", "/api/suuq/orders/mine", async (req, res) => {
    const u = await needUser(req);
    const rows = await db.all(`${ORDER_SELECT} WHERE o.buyer_id = ? ORDER BY o.created_at DESC LIMIT 200`, u.id), out = [], groups = new Set();
    for (const o of rows) {
      const r = orderRow(o, false);
      // Products bought together are paid with one dial: offer "Dial to pay" on one of them only, for the whole amount.
      r.dial = !!o.pay_ussd && o.status === "awaiting_payment" && !(o.pay_group && groups.has(o.pay_group));
      if (o.pay_group) { r.pay_group = true; groups.add(o.pay_group); }
      if (o.status === "quoted") r.shop_mode = await shopPayMode(o.seller_id, o.cur, o.commission, o.affiliate_id, o.buyer_id, await shopChargeOf(o.cur, o.total, o.shop_id));
      if (o.status === "quoted" && r.shop_mode === "discount") r.shop_discount = o.commission;
      out.push(r);
    }
    send(res, 200, { orders: out });
  });
  route("GET", "/api/suuq/seller/orders", async (req, res) => {
    const u = await needRole(req, "customer");
    send(res, 200, { orders: (await db.all(`${ORDER_SELECT} WHERE o.seller_id = ? ORDER BY o.created_at DESC LIMIT 500`, u.id)).map(o => orderRow(o, true)) });
  });

  // Buy:  paid → delivered (seller) → completed (buyer confirms; money is released). Paid orders can be cancelled with a refund.
  // Book: requested → accepted (seller) → completed (seller). The seller can decline a request.
  async function complete(o) {
    const net = round(o.cur, o.total - o.commission);
    if (o.kind === "buy" && o.pay_method === "safe") {
      // Safe payment, released by the admin: the seller gets the price minus the earning, and the earning goes
      // straight to the wallet of whoever shared the link (or the buyer).
      await ledger(o.seller_id, o.cur, net, "sale", o.ref, `${o.product_name} × ${o.qty}`);
      if (o.affiliate_id && o.commission > 0) await ledger(o.affiliate_id, o.cur, o.commission, "affiliate", o.ref, `${o.product_name} × ${o.qty}`);
    } else if (o.kind === "buy" && o.pay_method !== "shop") {
      await ledger(o.seller_id, o.cur, net, "sale", o.ref, `${o.product_name} × ${o.qty}`);
      if (o.affiliate_id && o.commission > 0) await addEarning(o.affiliate_id, o.cur, o.commission, "affiliate", o.ref, `${o.product_name} × ${o.qty}`);
    } else if (o.kind === "buy" && o.pay_discount > 0) {
      // Pay to shop with the buyer's own earning taken off the price: nothing more to pay out.
    } else if (o.kind === "buy" && o.affiliate_id && o.commission > 0) {
      // Paid to the shop: the seller already has all the money, so the affiliate earning comes from the seller's wallet.
      await ledger(o.seller_id, o.cur, -o.commission, "affiliate_fee", o.ref, `${o.product_name} × ${o.qty}`);
      await addEarning(o.affiliate_id, o.cur, o.commission, "affiliate", o.ref, `${o.product_name} × ${o.qty}`);
    }
    // Pay to shop: the 5PLUS charge comes from the merchant's wallet and goes to the super admin's income.
    if (o.kind === "buy" && o.pay_method === "shop" && o.shop_charge > 0) {
      await ledger(o.seller_id, o.cur, -o.shop_charge, "shop_charge", o.ref, `${o.product_name} × ${o.qty}`);
      const shopName = o.shop_name || (await db.get("SELECT name FROM shops WHERE id = ?", o.shop_id))?.name || "Shop";
      await ledger(null, o.cur, o.shop_charge, "shop_charge_income", o.ref, `${shopName} · ${o.product_name} × ${o.qty}`);
    }
    await db.run("UPDATE orders SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", now(), now(), o.id);
  }
  // A merchant declined a request: pass it to another merchant who sells the same thing (same name, or for visas and
  // scholarships the same country), skipping every merchant this request has already been to. Returns the new order id.
  async function forward(o) {
    const p = await db.get("SELECT * FROM products WHERE id = ?", o.product_id); if (!p) return null;
    const tried = new Set([o.seller_id, o.buyer_id]);
    for (let x = o, n = 0; x && x.from_order && n < 30; n++) { x = await db.get("SELECT seller_id, from_order FROM orders WHERE id = ?", x.from_order); if (x) tried.add(x.seller_id); }
    // A trip request (Ticket): pass it to another travel agency.
    if (p.service === "ticket") {
      const c = await pickAgency(tried); if (!c) return null;
      return await addRequest({ buyer_id: o.buyer_id, affiliate_id: o.affiliate_id, qty: o.qty, note: o.note, from_order: o.id }, c);
    }
    const rows = await db.all(`${PROD_SELECT} WHERE ${LIVE} AND p.service = ? AND p.id != ?`, now(), p.service || "suuq", p.id);
    const words = t => new Set(String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4));
    const name = String(p.name).trim().toLowerCase(), pw = words(p.name);
    const score = c => String(c.name).trim().toLowerCase() === name ? 3 : (hasCountry(p.service) && p.country && c.country === p.country) ? 2 : [...words(c.name)].filter(w => pw.has(w)).length >= 2 ? 1 : 0;
    const best = rows.filter(c => !tried.has(c.owner_id) && !PAUSES.includes(c.shop_pause)).map(c => [score(c), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0] || b[1].created_at - a[1].created_at)[0];
    if (!best) return null;
    const c = best[1], nid = crypto.randomUUID(), ref = "SQ" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
    await db.run(`INSERT INTO orders (id, ref, product_id, shop_id, buyer_id, seller_id, kind, product_name, qty, unit_price, total, cur, commission, affiliate_id, status, note, created_at, updated_at, from_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, 'requested', ?, ?, ?, ?)`, nid, ref, c.id, c.shop_id, o.buyer_id, c.owner_id, c.mode === "book" ? "book" : "buy", c.name, o.qty, c.cur,
                o.affiliate_id && o.affiliate_id !== c.owner_id ? o.affiliate_id : null, o.note, now(), now(), o.id);
    await db.run("UPDATE orders SET forwarded_to = ? WHERE id = ?", nid, o.id);
    return nid;
  }
  // One order step (accept, quote, pay, deliver, received, cancel…) by the buyer or the seller u. Returns the id of a
  // request passed on to another merchant, if any.
  async function orderAction(id, u, b) {
    const action = String(b.action);
    let fwd = null, heldPing = false, safeNote = null, pingSvc = "";
    await tx(async () => {
      const o = await db.get("SELECT * FROM orders WHERE id = ?", id);
      if (!o || (o.buyer_id !== u.id && o.seller_id !== u.id)) fail("Order not found.", 404);
      const svcOf = (await db.get("SELECT service FROM products WHERE id = ?", o.product_id))?.service || "suuq"; pingSvc = o.safe_svc || "";
      const seller = o.seller_id === u.id, set = async st => await db.run("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", st, now(), o.id);
      const refund = async () => { if (o.kind === "buy" && o.pay_method !== "shop") await ledger(o.buyer_id, o.cur, o.total, "refund", o.ref, `${o.product_name} × ${o.qty}`); };
      if (o.kind === "buy") {
        // Price requests (hidden price): requested → quoted (seller sends the price) → paid (buyer pays) → the normal buy steps.
        // The merchant accepts a request, agrees the price with the buyer (in chat), then sends the price with the item name and description.
        if (action === "accept" && seller && o.status === "requested") return await set("accepted");
        if (action === "quote" && seller && (o.status === "requested" || o.status === "accepted")) {
          const total = round(o.cur, Number(b.amount));
          if (!(total > 0) || total > 1e10) fail("Enter the total price for this order.");
          const p = await db.get("SELECT * FROM products WHERE id = ?", o.product_id);
          let commission = 0;
          if (o.affiliate_id && p) {
            commission = round(o.cur, p.comm_type === "flat" ? p.comm_value * o.qty : total * p.comm_value / 100);
            if (commission >= total) fail(`The price must be more than the affiliate earning (${commission} ${o.cur}).`);
          }
          const name = String(b.name || "").trim().slice(0, 120) || o.product_name, desc = String(b.description || "").trim().slice(0, 600);
          await db.run("UPDATE orders SET status = 'quoted', total = ?, unit_price = ?, commission = ?, product_name = ?, offer_desc = ?, updated_at = ? WHERE id = ?", total, round(o.cur, total / o.qty), commission, name, desc, now(), o.id);
          return;
        }
        if (action === "pay" && !seller && o.status === "quoted" && PAY_METHODS.includes(b.method) && b.method !== "wallet") {
          let discount = 0, charge = 0;
          if (b.method === "shop") {
            charge = await shopChargeOf(o.cur, o.total, o.shop_id);
            const mode = await shopPayMode(o.seller_id, o.cur, o.commission, o.affiliate_id, o.buyer_id, charge);
            if (mode === "none") fail(NO_SHOP_PAY);
            if (mode === "discount") discount = o.commission;
          }
          const shop = await db.get("SELECT profile FROM shops WHERE id = ?", o.shop_id), plan = await payPlan(b.method, b.via, o.cur, round(o.cur, o.total - discount), shop?.profile, svcOf);
          await db.run("UPDATE orders SET status = 'awaiting_payment', pay_method = ?, pay_fee = ?, pay_ussd = ?, commission = ?, pay_discount = ?, safe_svc = ?, shop_charge = ?, updated_at = ? WHERE id = ?",
            b.method, plan.fee, plan.ussd, o.commission, discount, plan.section, charge, now(), o.id);
          if (b.method === "safe") safeNote = [plan.section, o.product_name, round(o.cur, o.total - discount + plan.fee), o.cur];
          return;
        }
        // Paid to the shop: the seller confirms the money arrived (or declines if it never came).
        if (action === "money_received" && seller && o.status === "awaiting_payment" && o.pay_method === "shop") return await set("paid");
        if (action === "decline" && seller && o.status === "awaiting_payment" && o.pay_method === "shop") return await set("payment_rejected");
        if (action === "cancel" && !seller && o.status === "awaiting_payment") return await set("cancelled");
        // Try again: dial once more, with the merchant number or the normal number.
        if (action === "retry" && !seller && o.status === "awaiting_payment" && o.pay_group) {
          // Products bought together: dial the whole payment again (the charge stays on the first order).
          const grp = await db.all("SELECT * FROM orders WHERE pay_group = ? AND status = 'awaiting_payment' ORDER BY pay_fee DESC, created_at", o.pay_group);
          const plan = await payPlan("safe", b.via, o.cur, round(o.cur, grp.reduce((a, g) => a + g.total, 0)), null, svcOf);
          for (const [i, g] of grp.entries()) await db.run("UPDATE orders SET pay_fee = ?, pay_ussd = ?, safe_svc = ?, updated_at = ? WHERE id = ?", i === 0 ? plan.fee : 0, plan.ussd, plan.section, now(), g.id);
          broadcast("safepay", {}, safeAudience(plan.section));
          return;
        }
        if (action === "retry" && !seller && o.status === "awaiting_payment") {
          const shop = await db.get("SELECT profile FROM shops WHERE id = ?", o.shop_id), plan = await payPlan(o.pay_method, b.via, o.cur, round(o.cur, o.total - (o.pay_discount || 0)), shop?.profile, svcOf);
          await db.run("UPDATE orders SET pay_fee = ?, pay_ussd = ?, safe_svc = ?, updated_at = ? WHERE id = ?", plan.fee, plan.ussd, plan.section, now(), o.id);
          if (o.pay_method === "safe") broadcast("safepay", {}, safeAudience(plan.section));
          return;
        }
        if (action === "pay" && !seller && o.status === "quoted") {
          if (await balance(u.id, o.cur) < o.total) fail(`Your wallet doesn't have enough ${o.cur}. Top up your wallet first.`);
          await ledger(u.id, o.cur, -o.total, "order_payment", o.ref, `${o.product_name} × ${o.qty}`);
          return await set("paid");
        }
        if (action === "decline" && seller && ["requested", "accepted", "quoted"].includes(o.status)) { await set("declined"); fwd = await forward(o); return; }
        if (action === "cancel" && !seller && ["requested", "accepted", "quoted"].includes(o.status)) return await set("cancelled");
        if (action === "deliver" && seller && o.status === "paid") return await set("delivered");
        // Safe payment: the money stays held until the admin releases it (after calling the customer).
        if (action === "received" && !seller && (o.status === "paid" || o.status === "delivered") && o.pay_method === "safe") {
          await db.run("UPDATE orders SET buyer_ok = 1, updated_at = ? WHERE id = ?", now(), o.id); heldPing = true; return;
        }
        if (action === "received" && !seller && (o.status === "paid" || o.status === "delivered")) return await complete(o);
        if (action === "cancel" && o.status === "paid") { await refund(); return await set(seller ? "cancelled_by_seller" : "cancelled"); }
      } else {
        if (action === "accept" && seller && o.status === "requested") return await set("accepted");
        if (action === "decline" && seller && (o.status === "requested" || o.status === "accepted")) { await set("declined"); fwd = await forward(o); return; }
        // A booking the merchant prices: it becomes a buy order the buyer pays.
        if (action === "quote" && seller && (o.status === "requested" || o.status === "accepted")) {
          const total = round(o.cur, Number(b.amount));
          if (!(total > 0) || total > 1e10) fail("Enter the total price for this order.");
          const name = String(b.name || "").trim().slice(0, 120) || o.product_name, desc = String(b.description || "").trim().slice(0, 600);
          await db.run("UPDATE orders SET kind = 'buy', status = 'quoted', total = ?, unit_price = ?, commission = 0, product_name = ?, offer_desc = ?, updated_at = ? WHERE id = ?", total, round(o.cur, total / o.qty), name, desc, now(), o.id);
          return;
        }
        if (action === "complete" && seller && o.status === "accepted") return await complete(o);
        if (action === "cancel" && !seller && (o.status === "requested" || o.status === "accepted")) return await set("cancelled");
      }
      fail("This order can't be changed that way now.");
    });
    // The order ended: give the held room (or item) back.
    await tx(async () => {
      const o = await db.get("SELECT id, product_id, status, reserved FROM orders WHERE id = ?", id);
      if (o && o.reserved && ["completed", "cancelled", "cancelled_by_seller", "declined", "payment_rejected"].includes(o.status)) {
        await db.run("UPDATE orders SET reserved = 0 WHERE id = ?", o.id);
        await db.run("UPDATE products SET stock = stock + 1 WHERE id = ? AND stock >= 0", o.product_id);
      }
    });
    await pushOrder(id);
    if (fwd) await pushOrder(fwd);
    if (heldPing) broadcast("safepay", {}, safeAudience(pingSvc));
    if (safeNote) await safeAlarm(id, safeNote[0], u.name, safeNote[1], safeNote[2], safeNote[3]);
    return fwd;
  }
  route("POST", "/api/suuq/orders/:id/action", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    if (b.action === "pay" && (!b.method || b.method === "wallet")) await needPin(u, b.pin); // paying a sent price from the wallet
    const fwd = await orderAction(id, u, b);
    send(res, 200, { ok: true, forwarded: !!fwd });
  });

  /* ---------- service desks: orders for services run by their admins (Technician, Hotels, Car rent, Saba…) ---------- */
  // Each such service has a desk: a service account with a hidden shop and one hidden "request" product. Customers ask
  // for the service; the service admins accept, agree the price and send it; the customer pays one of three ways; the
  // money is held until the customer confirms the work is finished, then it reaches the service's account.
  const OWN_FLOW = ["ibedel", "suuq", "visa", "scholarship", "ticket"];
  async function serviceDesk(svcId) {
    const s = await getSettings(), sv = s.services.find(x => x.id === svcId);
    if (!sv || OWN_FLOW.includes(svcId)) fail("This service can't take orders here.", 404);
    const phone = "svc-" + svcId.replace(/[^\w-]/g, "").slice(0, 40);
    let du = await db.get("SELECT * FROM users WHERE phone = ?", phone);
    if (!du) {
      await db.run("INSERT INTO users (name, phone, role, pin_hash, created_at, ref_code, account_type) VALUES (?, ?, 'customer', ?, ?, ?, 'service')",
        sv.name.slice(0, 80), phone, hashSecret(crypto.randomBytes(16).toString("hex")), now(), await newRefCode());
      du = await db.get("SELECT * FROM users WHERE phone = ?", phone);
    }
    const profile = JSON.stringify({ service: svcId, business_name: sv.name, zaad_merchant: String(sv.merchant || "").replace(/\D/g, ""), shop_phone: String(sv.phone || "").replace(/\D/g, "").replace(/^0/, "") });
    let shop = await db.get("SELECT * FROM shops WHERE owner_id = ?", du.id);
    if (!shop) {
      await db.run("INSERT INTO shops (owner_id, name, sub_until, plan, created_at, profile) VALUES (?, ?, ?, 'service', ?, ?)", du.id, sv.name.slice(0, 80), 4102444800000, now(), profile);
      shop = await db.get("SELECT * FROM shops WHERE owner_id = ?", du.id);
    } else if (shop.profile !== profile || shop.name !== sv.name) {
      await db.run("UPDATE shops SET name = ?, profile = ?, suspended = 0, sub_until = 4102444800000 WHERE id = ?", sv.name.slice(0, 80), profile, shop.id);
      shop = await db.get("SELECT * FROM shops WHERE id = ?", shop.id);
    }
    const service = "svc:" + svcId;
    let p = await db.get("SELECT * FROM products WHERE shop_id = ? AND service = ? AND deleted = 0", shop.id, service);
    const pname = `${sv.name} request`.slice(0, 60);
    if (!p) {
      const pid = crypto.randomUUID();
      await db.run(`INSERT INTO products (id, shop_id, name, description, price, cur, mode, images, video, comm_type, comm_value, service, price_hidden, price_label, country, hidden, approval, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1000, 'USD', 'buy', '[]', '', 'percent', 5, ?, 1, 'Ask for the price', '', 1, 'approved', ?, ?)`, pid, shop.id, pname, sv.sub || "", service, now(), now());
      p = await db.get("SELECT * FROM products WHERE id = ?", pid);
    } else if (p.name !== pname) { await db.run("UPDATE products SET name = ?, description = ? WHERE id = ?", pname, sv.sub || "", p.id); }
    return { user: du, shop, product: p, sv };
  }
  // Listings of a service (rooms for Hotels, technicians for Technician, cars for Car rent…). The service admins add
  // them; customers see them on the service page and order one with the usual payments.
  const UNITS = ["", "night", "day", "trip", "hour", "month"];
  const svcItem = (p, u) => shopperRow(p, u);
  route("GET", "/api/services/:id/items", async (req, res, url, [id]) => {
    const u = await needUser(req), d = await serviceDesk(id);
    const rows = await db.all(`${PROD_SELECT} WHERE p.shop_id = ? AND p.id != ? AND p.deleted = 0 AND p.admin_hidden = 0 ORDER BY p.category, p.created_at`, d.shop.id, d.product.id);
    send(res, 200, { items: rows.map(p => svcItem(p, u)) });
  });
  route("GET", "/api/admin/service-items/:id", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id);
    const rows = await db.all(`${PROD_SELECT} WHERE p.shop_id = ? AND p.id != ? AND p.deleted = 0 ORDER BY p.category, p.created_at`, d.shop.id, d.product.id);
    send(res, 200, { items: rows.map(p => productRow(p)) });
  });
  function readItem(b, old) {
    const name = String(b.name ?? old?.name ?? "").trim().slice(0, 60);
    if (name.length < 2) fail("Enter a name.");
    const cur = CURS.includes(b.cur) ? b.cur : old?.cur || "USD";
    const ask = b.price_hidden != null ? !!b.price_hidden : !!old?.price_hidden;
    const price = round(cur, Number(b.price ?? old?.price ?? 0));
    if (!ask && !(price > 0)) fail("Enter the price, or choose \"Ask for the price\".");
    const unit = UNITS.includes(b.unit) ? b.unit : old?.unit || "";
    let stock = b.stock === "" || b.stock == null ? (old ? old.stock : -1) : Math.floor(Number(b.stock));
    if (!(stock >= -1) || stock > 100000) fail("Check how many are available.");
    return { name, cur, price: ask ? (price > 0 ? price : 1000) : price, price_hidden: ask ? 1 : 0, unit, stock,
      category: String(b.category ?? old?.category ?? "").trim().slice(0, 40), description: String(b.description ?? old?.description ?? "").trim().slice(0, 600) };
  }
  route("POST", "/api/admin/service-items/:id", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id), b = await readJson(req, 6 * 1024 * 1024), it = readItem(b);
    const imgs = Array.isArray(b.images) ? b.images.slice(0, 4) : [];
    if (!imgs.length) fail("Add a photo.");
    const files = await saveImages(imgs, "prod");
    const pid = crypto.randomUUID();
    await db.run(`INSERT INTO products (id, shop_id, name, description, price, cur, mode, images, video, comm_type, comm_value, service, price_hidden, price_label, country, hidden, approval, category, stock, unit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'buy', ?, '', 'percent', 5, ?, ?, 'Ask for the price', '', 1, 'approved', ?, ?, ?, ?, ?)`,
      pid, d.shop.id, it.name, it.description, it.price, it.cur, JSON.stringify(files), "svc:" + id, it.price_hidden, it.category, it.stock, it.unit, now(), now());
    if (b.off) await db.run("UPDATE products SET admin_hidden = 1 WHERE id = ?", pid);
    send(res, 200, { item: productRow(await db.get(`${PROD_SELECT} WHERE p.id = ?`, pid)) });
  });
  route("PUT", "/api/admin/service-items/:id/:pid", async (req, res, url, [id, pid]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id), old = await db.get("SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted = 0", pid, d.shop.id);
    if (!old || pid === d.product.id) fail("Not found.", 404);
    const b = await readJson(req, 6 * 1024 * 1024), it = readItem(b, old);
    let images = JSON.parse(old.images || "[]");
    if (Array.isArray(b.images) && b.images.length) images = await saveImages(b.images.slice(0, 4), "prod");
    await db.run("UPDATE products SET name = ?, description = ?, price = ?, cur = ?, price_hidden = ?, category = ?, stock = ?, unit = ?, images = ?, admin_hidden = ?, updated_at = ? WHERE id = ?",
      it.name, it.description, it.price, it.cur, it.price_hidden, it.category, it.stock, it.unit, JSON.stringify(images), b.off ? 1 : 0, now(), pid);
    send(res, 200, { item: productRow(await db.get(`${PROD_SELECT} WHERE p.id = ?`, pid)) });
  });
  route("DELETE", "/api/admin/service-items/:id/:pid", async (req, res, url, [id, pid]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id);
    if (pid === d.product.id) fail("Not found.", 404);
    await db.run("UPDATE products SET deleted = 1, updated_at = ? WHERE id = ? AND shop_id = ?", now(), pid, d.shop.id);
    send(res, 200, { ok: true });
  });
  route("GET", "/api/services/:id/request", async (req, res, url, [id]) => {
    await needUser(req);
    const d = await serviceDesk(id);
    send(res, 200, { product_id: d.product.id });
  });
  // The service admins (and the super admin): the desk's orders and its account balance.
  route("GET", "/api/admin/service-orders/:id", async (req, res, url, [id]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id);
    const rows = await db.all(`${ORDER_SELECT} WHERE o.shop_id = ? ORDER BY o.updated_at DESC LIMIT 200`, d.shop.id);
    const held = await db.all("SELECT cur, SUM(total) AS t FROM orders WHERE shop_id = ? AND status IN ('paid','delivered') AND pay_method != 'shop' GROUP BY cur", d.shop.id);
    send(res, 200, { orders: rows.map(o => orderRow(o, true)), balances: await balances(d.user.id),
      held: Object.fromEntries(CURS.map(c => [c, round(c, Number(held.find(r => r.cur === c)?.t || 0))])) });
  });
  route("POST", "/api/admin/service-orders/:id/:oid", async (req, res, url, [id, oid]) => {
    await needPageEditor(req, id);
    const d = await serviceDesk(id), b = await readJson(req);
    const o = await db.get("SELECT shop_id FROM orders WHERE id = ?", oid);
    if (!o || o.shop_id !== d.shop.id) fail("Order not found.", 404);
    if (!["accept", "decline", "quote", "money_received", "deliver"].includes(String(b.action))) fail("This order can't be changed that way now.");
    await orderAction(oid, d.user, b);
    send(res, 200, { ok: true });
  });

  /* ---------- Business categories (super admin) ---------- */
  route("GET", "/api/super/biz-categories", async (req, res) => { await needRole(req, "super"); send(res, 200, { categories: (await getSettings()).bizCats }); });
  route("PUT", "/api/super/biz-categories", async (req, res) => {
    await needRole(req, "super"); const b = await readJson(req, 64 * 1024), sv = (await getSettings()).services.map(x => x.id);
    if (!Array.isArray(b.categories) || b.categories.length > 200) fail("Check the categories list.");
    const seen = new Set(), out = [];
    for (const c of b.categories) {
      const name = String(c?.name || "").trim().slice(0, 40); if (!name) continue;
      if (name.length < 2) fail("Each category needs a name.");
      if (seen.has(name.toLowerCase())) fail(`“${name}” is in the list twice.`); seen.add(name.toLowerCase());
      if (!sv.includes(c.section)) fail(`Choose a section for “${name}”.`);
      const subs = [...new Set((Array.isArray(c.subs) ? c.subs : String(c.subs || "").split(",")).map(x => String(x).trim().slice(0, 40)).filter(Boolean))].slice(0, 10);
      const photo = typeof c.photo === "string" && /^\/(photos\/cats\/[\w-]+\.jpg|media\/svc-cat-[\w-]+\.(jpg|png|webp))$/.test(c.photo) ? c.photo : "";
      out.push({ name, section: c.section, subs, photo, home: !!c.home });
    }
    if (!out.length) fail("Keep at least one category.");
    // Photos uploaded for categories that were removed are deleted.
    for (const c of (await getSettings()).bizCats) if (String(c.photo || "").startsWith("/media/svc-cat-") && !out.some(o => o.photo === c.photo)) { try { await db.files.del(c.photo.slice(7)); } catch {} }
    const ns = await saveSettings({ bizCats: out }); broadcast("settings", publicSettings(ns));
    send(res, 200, { categories: ns.bizCats });
  });

  // A real photo for a category tile (Shop by category). Replaces the built-in or earlier photo.
  route("POST", "/api/super/biz-categories/photo", async (req, res) => {
    await needRole(req, "super"); const b = await readJson(req, 4 * 1024 * 1024), s = await getSettings();
    const i = s.bizCats.findIndex(c => c.name === String(b.name || "")); if (i < 0) fail("Save the category first, then add its photo.", 404);
    let photo = "";
    if (b.image) { const [file] = await saveImages([b.image], "svc-cat"); photo = "/media/" + file; }
    const old = s.bizCats[i].photo || "";
    if (old.startsWith("/media/svc-cat-")) { try { await db.files.del(old.slice(7)); } catch {} }
    const bizCats = s.bizCats.map((c, j) => j === i ? { ...c, photo: b.image ? photo : (b.builtin ? (require("./db").DEFAULT_BIZ_CATS || []).find(d => d.name === c.name)?.photo || "" : "") } : c);
    const ns = await saveSettings({ bizCats }); broadcast("settings", publicSettings(ns));
    send(res, 200, { categories: ns.bizCats });
  });

  /* ---------- Internet calls (like WhatsApp): voice goes phone to phone (WebRTC) ---------- */
  // The server only introduces the two phones: it rings the other person (live, and by a Firebase push when 5PLUS is
  // closed), passes the connection details between them, and ends the call. The voice itself never passes through it.
  // A chat with a service (Saba…) rings that service's admins; the first to answer takes the call.
  const calls = new Map(); // id → call
  const RING_MS = 45_000;
  async function callTurn() {
    const env = process.env.TURN_URLS ? { urls: process.env.TURN_URLS, username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" } : null;
    if (env) return env;
    const r = await db.get("SELECT value FROM settings WHERE key = 'callturn'"); try { return r ? JSON.parse(r.value) : null; } catch { return null; }
  }
  async function iceServers() {
    const list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }], t = await callTurn();
    if (t && t.urls) list.push({ urls: String(t.urls).split(/[\s,]+/).filter(Boolean), username: t.username || "", credential: t.credential || "" });
    return list;
  }
  // Who is calling whom from this chat. A service admin calls the customer from the service's desk.
  async function callSides(u, convId) {
    const c = await db.get("SELECT * FROM conversations WHERE id = ?", convId); if (!c) fail("Chat not found.", 404);
    const p = await db.get("SELECT name FROM products WHERE id = ?", c.product_id);
    if (c.buyer_id === u.id || c.seller_id === u.id) {
      const other = u.id === c.buyer_id ? c.seller_id : c.buyer_id, x = await db.get("SELECT name, phone, account_type FROM users WHERE id = ?", other);
      if (x?.account_type === "service") {
        const svc = String(x.phone).replace(/^svc-/, ""), sv = (await getSettings()).services.find(v => v.id === svc);
        let ids = (await db.all("SELECT id FROM users WHERE role = 'admin' AND service = ? AND suspended = 0", svc)).map(r => r.id);
        if (!ids.length) ids = (await db.all("SELECT id FROM users WHERE role = 'super'")).map(r => r.id);
        return { c, from_name: u.name, to: ids, to_name: sv?.name || x.name, topic: p?.name || "" };
      }
      return { c, from_name: u.name, to: [other], to_name: x?.name || "", topic: p?.name || "" };
    }
    // A service admin answering from the desk.
    if (u.role === "admin" || u.role === "super") {
      const s = await db.get("SELECT phone, account_type FROM users WHERE id = ?", c.seller_id);
      const svc = s?.account_type === "service" ? String(s.phone).replace(/^svc-/, "") : null;
      if (svc && (isSuper(u) || u.service === svc)) {
        const sv = (await getSettings()).services.find(v => v.id === svc), b = await db.get("SELECT name FROM users WHERE id = ?", c.buyer_id);
        return { c, from_name: sv?.name || u.name, to: [c.buyer_id], to_name: b?.name || "", topic: p?.name || "" };
      }
    }
    fail("Chat not found.", 404);
  }
  const inCall = (k, uid) => k.from === uid || k.callee === uid || (!k.callee && k.to.includes(uid));
  const busyNow = uid => [...calls.values()].some(k => k.state === "active" && (k.from === uid || k.callee === uid));
  function callOut(k, uid) {
    return { id: k.id, conv_id: k.conv_id, state: k.state, caller: k.from === uid, from_name: k.from_name, to_name: k.to_name, topic: k.topic,
      offer: k.from !== uid ? k.offer : undefined, ice: k.from !== uid ? k.ice_from : k.ice_to, created_at: k.created_at };
  }
  // The call is written in the chat, so both people can see if it was answered (and how long), declined or missed.
  async function logCall(k, status) {
    try {
      const c = await db.get("SELECT * FROM conversations WHERE id = ?", k.conv_id); if (!c) return;
      const sender = k.from === c.buyer_id ? c.buyer_id : c.seller_id, t = now();
      const secs = status === "answered" && k.answered_at ? Math.max(1, Math.round((t - k.answered_at) / 1000)) : 0;
      const att = JSON.stringify({ kind: "call", status, secs });
      const info = await db.run("INSERT INTO messages (conv_id, sender_id, body, created_at, att) VALUES (?, ?, ?, ?, ?)", c.id, sender, "", t, att);
      await db.run(`UPDATE conversations SET last_at = ?, ${sender === c.buyer_id ? "buyer_read_at" : "seller_read_at"} = ? WHERE id = ?`, t, t, c.id);
      const m = { id: Number(info.lastInsertRowid), conv_id: c.id, sender_id: sender, body: "", created_at: t, att: attOut({ id: 0, att }), calllog: true, preview: msgPreview({ att }) };
      const aud = await chatAudience(c, sender);
      broadcast("chat", m, x => x.id === c.buyer_id || x.id === c.seller_id || aud.ids.includes(x.id));
      if (aud.svc) broadcast("deskchat", { svc: aud.svc, conv_id: c.id, from_name: k.from_name, preview: m.preview }, x => aud.ids.includes(x.id));
    } catch {}
  }
  function endCall(k, reason, by) {
    if (!calls.has(k.id)) return;
    calls.delete(k.id); clearTimeout(k.timer);
    logCall(k, k.state === "active" ? "answered" : reason === "declined" ? "declined" : "missed");
    const everyone = [k.from, ...(k.callee ? [k.callee] : k.to)];
    broadcast("call", { type: "end", id: k.id, reason }, x => everyone.includes(x.id) && x.id !== by);
    pushLater(k.callee ? [k.callee] : k.to, { kind: "cancel", tag: "call-" + k.id });
    if (reason === "missed") pushLater(k.to, { kind: "info", title: "Missed call", body: `${k.from_name} called you on 5PLUS`, goto: "chat:" + k.conv_id, tag: "missed-" + k.id });
  }
  route("GET", "/api/call/config", async (req, res) => { await needUser(req); send(res, 200, { iceServers: await iceServers() }); });
  route("POST", "/api/call/start", async (req, res) => {
    const u = await needUser(req), b = await readJson(req, 64 * 1024);
    const sd = await callSides(u, String(b.conv_id || ""));
    if (!b.offer || b.offer.type !== "offer" || typeof b.offer.sdp !== "string" || b.offer.sdp.length > 20000) fail("The call could not start. Try again.");
    if (busyNow(u.id)) fail("You are already in a call.");
    const to = sd.to.filter(id => id !== u.id); if (!to.length) fail("There is nobody to call in this chat.");
    if (to.length === 1 && busyNow(to[0])) fail(`${sd.to_name} is on another call. Try again later.`);
    if (to.length === 1 && callsOffUntil((await db.get("SELECT calls_off_until FROM users WHERE id = ?", to[0]))?.calls_off_until)) fail(`${sd.to_name} isn't taking calls right now. Send a message instead.`);
    const k = { id: crypto.randomUUID(), conv_id: sd.c.id, from: u.id, from_name: sd.from_name, to, to_name: sd.to_name, topic: sd.topic, callee: null,
      state: "ringing", offer: { type: "offer", sdp: b.offer.sdp }, ice_from: [], ice_to: [], created_at: now() };
    k.timer = setTimeout(() => endCall(k, "missed"), RING_MS);
    calls.set(k.id, k);
    broadcast("call", { type: "ring", id: k.id, conv_id: k.conv_id, from_name: k.from_name, topic: k.topic }, x => to.includes(x.id));
    pushLater(to, { kind: "call", title: "Incoming call", body: `${k.from_name} is calling you on 5PLUS${k.topic ? " · " + k.topic : ""}`, goto: "call:" + k.id, tag: "call-" + k.id });
    send(res, 200, { call: callOut(k, u.id), iceServers: await iceServers() });
  });
  route("GET", "/api/call/:id", async (req, res, url, [id]) => {
    const u = await needUser(req), k = calls.get(id);
    if (!k || !inCall(k, u.id)) return send(res, 200, { call: null });
    send(res, 200, { call: callOut(k, u.id), iceServers: await iceServers() });
  });
  route("POST", "/api/call/:id/answer", async (req, res, url, [id]) => {
    const u = await needUser(req), b = await readJson(req, 64 * 1024), k = calls.get(id);
    if (!k || !inCall(k, u.id) || k.from === u.id) fail("This call has ended.", 404);
    if (k.state !== "ringing") fail("This call was answered on another phone.");
    if (!b.answer || b.answer.type !== "answer" || typeof b.answer.sdp !== "string" || b.answer.sdp.length > 20000) fail("The call could not connect.");
    clearTimeout(k.timer); k.state = "active"; k.callee = u.id; k.answered_at = now();
    broadcast("call", { type: "answer", id: k.id, answer: { type: "answer", sdp: b.answer.sdp } }, x => x.id === k.from);
    broadcast("call", { type: "end", id: k.id, reason: "taken" }, x => k.to.includes(x.id) && x.id !== u.id);
    pushLater(k.to, { kind: "cancel", tag: "call-" + k.id });
    send(res, 200, { ok: true });
  });
  // Connection details (ICE candidates) found by one phone, passed to the other.
  route("POST", "/api/call/:id/ice", async (req, res, url, [id]) => {
    const u = await needUser(req), b = await readJson(req, 16 * 1024), k = calls.get(id);
    if (!k || !inCall(k, u.id)) return send(res, 200, { ok: false });
    const cand = b.candidate && typeof b.candidate.candidate === "string" && b.candidate.candidate.length < 1000 ? { candidate: b.candidate.candidate, sdpMid: b.candidate.sdpMid ?? null, sdpMLineIndex: b.candidate.sdpMLineIndex ?? null } : null;
    if (!cand) return send(res, 200, { ok: false });
    if (k.from === u.id) {
      if (k.ice_from.length < 60) k.ice_from.push(cand);
      if (k.callee) broadcast("call", { type: "ice", id: k.id, candidate: cand }, x => x.id === k.callee);
    } else {
      if (k.ice_to.length < 60) k.ice_to.push(cand);
      broadcast("call", { type: "ice", id: k.id, candidate: cand }, x => x.id === k.from);
    }
    send(res, 200, { ok: true });
  });
  route("POST", "/api/call/:id/end", async (req, res, url, [id]) => {
    const u = await needUser(req), b = await readJson(req), k = calls.get(id);
    if (k && inCall(k, u.id)) {
      // One admin of a service declining doesn't stop the others' phones ringing.
      if (b.reason === "declined" && k.state === "ringing" && k.from !== u.id && k.to.length > 1) {
        k.to = k.to.filter(x => x !== u.id); pushLater([u.id], { kind: "cancel", tag: "call-" + k.id });
      } else endCall(k, k.from === u.id && k.state === "ringing" ? "cancelled" : b.reason === "declined" ? "declined" : "ended", u.id);
    }
    send(res, 200, { ok: true });
  });
  // TURN server (optional): lets calls connect when both phones are behind strict mobile networks.
  route("GET", "/api/super/call-settings", async (req, res) => {
    await needRole(req, "super"); const t = await callTurn();
    send(res, 200, { urls: t?.urls || "", username: t?.username || "", has_credential: !!t?.credential, fromEnv: !!process.env.TURN_URLS });
  });
  route("PUT", "/api/super/call-settings", async (req, res) => {
    await needRole(req, "super"); const b = await readJson(req);
    const urls = String(b.urls || "").trim().slice(0, 500), username = String(b.username || "").trim().slice(0, 200);
    const old = await callTurn(), credential = b.credential ? String(b.credential).slice(0, 200) : old?.credential || "";
    if (urls && !String(urls).split(/[\s,]+/).filter(Boolean).every(x => /^turns?:[^\s]+$/.test(x))) fail("TURN addresses start with turn: or turns:");
    await db.run("INSERT INTO settings (key, value) VALUES ('callturn', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(urls ? { urls, username, credential } : {}));
    send(res, 200, { urls, username, has_credential: !!(urls && credential) });
  });

  /* ---------- safe payments (super admin) ---------- */
  // The super admin sees every safe payment; the admin of a part (Suuq, Technician…) sees the ones paid to them.
  const safeScope = u => isSuper(u) ? { sql: "1 = 1", args: [] } : { sql: "o.safe_svc = ?", args: [u.service] };
  const needSafeAdmin = req => needRole(req, "super", "admin");
  const canSafe = (u, o) => isSuper(u) || (!!o.safe_svc && o.safe_svc === u.service);
  // Each safe payment, spelled out for the admin: the buyer, the seller's price, and who earns what.
  async function safeRow(o) {
    const aff = o.affiliate_id ? await db.get("SELECT name, phone FROM users WHERE id = ?", o.affiliate_id) : null;
    const seller = await db.get("SELECT name, phone, face FROM users WHERE id = ?", o.seller_id), buyer = await db.get("SELECT face FROM users WHERE id = ?", o.buyer_id);
    const svcs = (await getSettings()).services, sec = svcs.find(x => x.id === o.safe_svc);
    const earner = !o.affiliate_id || !(o.commission > 0) ? "none" : o.affiliate_id === o.buyer_id ? "buyer" : "linker";
    return { ...orderRow(o, true), buyer_name: o.buyer_name, buyer_phone: o.buyer_phone, seller_name: seller?.name || "", seller_phone: seller?.phone || "",
      buyer_id: o.buyer_id, seller_id: o.seller_id, buyer_face: !!buyer?.face, seller_face: !!seller?.face, earner, earner_name: earner === "none" ? "" : earner === "buyer" ? o.buyer_name : aff?.name || "", earner_phone: earner === "linker" ? aff?.phone || "" : "",
      group_count: o.pay_group ? (await db.get("SELECT COUNT(*) AS n FROM orders WHERE pay_group = ?", o.pay_group)).n : 1,
      group_paid: o.pay_group ? (r => round(o.cur, Number(r.t) || 0))(await db.get("SELECT SUM(total + pay_fee) AS t FROM orders WHERE pay_group = ?", o.pay_group)) : 0,
      paid_amount: round(o.cur, o.total - (o.pay_discount || 0) + (o.pay_fee || 0)), paid_to: o.safe_svc ? `${sec?.name || o.safe_svc} admin` : "Main money processor", section: o.safe_svc || "" };
  }
  route("GET", "/api/super/safepay", async (req, res, url) => {
    const u = await needSafeAdmin(req), sc = safeScope(u);
    const pend = url.searchParams.get("status") !== "done";
    const rows = await db.all(`${ORDER_SELECT} WHERE o.pay_method = 'safe' AND ${sc.sql} AND ${pend ? "o.status = 'awaiting_payment'" : "o.status != 'awaiting_payment'"} ORDER BY o.updated_at DESC LIMIT 100`, ...sc.args);
    const out = []; for (const o of rows) out.push(await safeRow(o));
    const s = await getSettings(), mine = !isSuper(u) && s.services.find(x => x.id === u.service);
    send(res, 200, { orders: out, settings: isSuper(u) ? s.safePay : null, own: mine ? { merchant: mine.safe_merchant || "", number: mine.safe_number || "", name: mine.name } : null });
  });
  // The admin of a part sets the numbers their safe payments go to.
  route("PUT", "/api/admin/safepay-numbers", async (req, res) => {
    const u = await needRole(req, "admin"), b = await readJson(req), merchant = digits(b.merchant).slice(0, 15), number = digits(b.number).slice(0, 15);
    for (const n of [merchant, number]) if (n && (n.length < 4 || n.length > 15)) fail("Check the numbers.");
    const s = await getSettings();
    if (!s.services.some(x => x.id === u.service)) fail("Your service was not found.", 404);
    await saveSettings({ services: s.services.map(x => x.id === u.service ? { ...x, safe_merchant: merchant, safe_number: number } : x) });
    send(res, 200, { own: { merchant, number } });
  });
  route("POST", "/api/super/safepay/:id/:decision", async (req, res, url, [id, decision]) => {
    const u = await needSafeAdmin(req);
    if (!["confirm", "reject"].includes(decision)) fail("Not found.", 404);
    let sec = ""; const touched = [];
    await tx(async () => {
      const o = await db.get("SELECT * FROM orders WHERE id = ?", id);
      if (!o || o.pay_method !== "safe" || !canSafe(u, o)) fail("Order not found.", 404);
      sec = o.safe_svc || "";
      if (o.status !== "awaiting_payment") fail("This payment was already handled.");
      // Products bought together were paid in one payment: they are confirmed (or rejected) together.
      const group = o.pay_group ? await db.all("SELECT * FROM orders WHERE pay_group = ? AND status = 'awaiting_payment'", o.pay_group) : [o];
      for (const g of group) {
        await db.run("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", decision === "confirm" ? "paid" : "payment_rejected", now(), g.id);
        if (decision !== "confirm" && g.reserved) { await db.run("UPDATE orders SET reserved = 0 WHERE id = ?", g.id); await db.run("UPDATE products SET stock = stock + 1 WHERE id = ? AND stock >= 0", g.product_id); }
        touched.push(g.id);
      }
    });
    for (const t of touched) await pushOrder(t);
    broadcast("safepay", {}, safeAudience(sec));
    send(res, 200, { ok: true });
  });
  // Held safely: Safe payments the admin confirmed. The admin calls the customer, asks if they received it, then releases:
  // the seller gets the price minus the earning, and the earning goes to the wallet of whoever shared the link (or the buyer).
  route("GET", "/api/super/held", async (req, res) => {
    const u = await needSafeAdmin(req), sc = safeScope(u);
    const rows = await db.all(`${ORDER_SELECT} WHERE o.pay_method = 'safe' AND ${sc.sql} AND o.status IN ('paid', 'delivered') ORDER BY o.buyer_ok DESC, o.updated_at DESC LIMIT 200`, ...sc.args);
    const out = []; for (const o of rows) out.push(await safeRow(o));
    const totals = {}; for (const o of rows) totals[o.cur] = round(o.cur, (totals[o.cur] || 0) + o.total);
    send(res, 200, { orders: out, totals });
  });
  route("POST", "/api/super/held/:id/release", async (req, res, url, [id]) => {
    const u = await needSafeAdmin(req);
    let sec = "";
    await tx(async () => {
      const o = await db.get("SELECT * FROM orders WHERE id = ?", id);
      if (!o || o.pay_method !== "safe" || !canSafe(u, o)) fail("Order not found.", 404);
      sec = o.safe_svc || "";
      if (!["paid", "delivered"].includes(o.status)) fail("This order was already released or ended.");
      await complete(o);
      if (o.reserved) { await db.run("UPDATE orders SET reserved = 0 WHERE id = ?", o.id); await db.run("UPDATE products SET stock = stock + 1 WHERE id = ? AND stock >= 0", o.product_id); }
    });
    await pushOrder(id);
    broadcast("safepay", {}, safeAudience(sec));
    send(res, 200, { ok: true });
  });

  route("PUT", "/api/super/safepay-settings", async (req, res) => {
    await needRole(req, "super");
    const b = await readJson(req), merchant = digits(b.merchant), number = digits(b.number), codes = {};
    for (const n of [merchant, number]) if (n && (n.length < 4 || n.length > 15)) fail("Check the money processor numbers.");
    for (const c of CURS) {
      codes[c] = {};
      for (const k of ["merchant", "normal"]) {
        const v = String(b.codes?.[c]?.[k] || "").replace(/\s/g, "");
        if (!/^\*?[\d*]+\*?$/.test(v)) fail(`The ${c} code can only use digits and *.`);
        codes[c][k] = v;
      }
    }
    const s = await saveSettings({ safePay: { merchant, number, codes } });
    broadcast("settings", publicSettings(s));
    send(res, 200, { settings: s.safePay });
  });

  /* ---------- report download: PDF or Word ---------- */
  // The app sends the report as it shows it; the server makes the file and keeps it for 10 minutes behind a link
  // only this person can open (the phone's download manager uses that link).
  const { makePdf, makeDocx } = require("./report");
  const exports_ = new Map();
  route("POST", "/api/report/export", async (req, res) => {
    const u = await needUser(req), b = await readJson(req, 512 * 1024);
    const fmt = b.format === "docx" ? "docx" : "pdf";
    const data = fmt === "pdf" ? makePdf(b.report) : makeDocx(b.report);
    const base = String(b.name || "report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report";
    const token = crypto.randomUUID(), t = now();
    for (const [k, v] of exports_) if (v.until < t) exports_.delete(k);
    exports_.set(token, { uid: u.id, data, name: `${base}.${fmt}`, type: fmt === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", until: t + 10 * 60e3 });
    send(res, 200, { url: `/api/report/file/${token}`, name: `${base}.${fmt}` });
  });
  route("GET", "/api/report/file/:token", async (req, res, url, [token]) => {
    const u = await needUser(req), f = exports_.get(token);
    if (!f || f.uid !== u.id || f.until < now()) fail("This download has expired. Press Download again.", 404);
    const buf = Buffer.from(f.data);
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": buf.length, "Content-Disposition": `attachment; filename="${f.name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  });

  /* ---------- seller report and expenses ---------- */
  const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  route("GET", "/api/suuq/seller/report", async (req, res, url) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id);
    const fromMs = Number(url.searchParams.get("fromMs")), toMs = Number(url.searchParams.get("toMs"));
    const fromDate = url.searchParams.get("fromDate"), toDate = url.searchParams.get("toDate");
    if (!(fromMs >= 0) || !(toMs >= fromMs) || !isYmd(fromDate) || !isYmd(toDate)) fail("Choose a valid date range.");
    if (!s) return send(res, 200, { revenue: [], expenses: [] });
    // Revenue for a seller = what they keep from completed buy orders (price minus affiliate earnings).
    const revenue = await db.all("SELECT completed_at AS at, cur, total - commission - shop_charge AS fee FROM orders WHERE seller_id = ? AND kind = 'buy' AND status = 'completed' AND completed_at BETWEEN ? AND ?", u.id, fromMs, toMs);
    const expenses = await db.all("SELECT id, date, cur, amount, category, note FROM shop_expenses WHERE shop_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC", s.id, fromDate, toDate);
    send(res, 200, { revenue, expenses });
  });
  route("POST", "/api/suuq/seller/expenses", async (req, res) => {
    const u = await needRole(req, "customer"), s = await sellerShop(u), b = await readJson(req);
    const cur = String(b.cur), amount = Number(b.amount);
    if (!isYmd(b.date)) fail("Choose the date of the expense.");
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    if (!(amount > 0) || amount > 1e10) fail("Enter an amount above 0.");
    await db.run("INSERT INTO shop_expenses (id, shop_id, date, cur, amount, category, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", crypto.randomUUID(), s.id, b.date, cur, round(cur, amount), String(b.category || "Other").slice(0, 40), String(b.note || "").trim().slice(0, 120), now());
    send(res, 200, { ok: true });
  });
  route("DELETE", "/api/suuq/seller/expenses/:id", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer"), s = await sellerShop(u);
    if (!(await db.run("DELETE FROM shop_expenses WHERE id = ? AND shop_id = ?", id, s.id)).changes) fail("Expense not found.", 404);
    send(res, 200, { ok: true });
  });

  /* ---------- private chat (only the buyer and the seller of a product) ---------- */
  /* ---------- chat: call, pictures, voice messages and files ---------- */
  const ATT_KIND = { image: ["image/jpeg", "image/png", "image/webp"], voice: ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/aac", "audio/wav"],
    file: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] };
  const attOut = (m) => { if (!m.att) return null; try { const a = JSON.parse(m.att);
    if (a.kind === "call") return { kind: "call", status: a.status, secs: a.secs || 0 }; // a call record, not a file
    return { kind: a.kind, name: a.name, size: a.size, dur: a.dur || 0, url: `/api/chatfile/${m.id}` }; } catch { return null; } };
  const callWords = a => a.status === "answered" ? `📞 Voice call · ${Math.floor(a.secs / 60)}:${String(a.secs % 60).padStart(2, "0")}` : a.status === "declined" ? "📞 Call declined" : "📞 Missed call";
  const msgPreview = m => m.body || (m.att ? (() => { let a = {}; try { a = JSON.parse(m.att); } catch {} return a.kind === "call" ? callWords(a) : ({ image: "📷 Photo", voice: "🎤 Voice message", file: "📎 File" })[a.kind] || "📎 File"; })() : "");
  // The number the Call button dials: the person's phone; for a service desk (Saba…), the service's phone.
  async function callNumber(uid, service) {
    const x = await db.get("SELECT phone, account_type FROM users WHERE id = ?", uid); if (!x) return "";
    if (x.account_type === "service") { const id = String(x.phone).replace(/^svc-/, ""); const sv = (await getSettings()).services.find(v => v.id === id); return String(sv?.phone || "").replace(/[^\d+]/g, ""); }
    return /^\d{6,15}$/.test(x.phone) ? "+252" + x.phone.replace(/^0/, "") : "";
  }
  // Who hears about a chat message: the other person, or, for a service desk, that service's admins.
  async function chatAudience(c, senderId) {
    const other = senderId === c.buyer_id ? c.seller_id : c.buyer_id;
    const x = await db.get("SELECT phone, account_type FROM users WHERE id = ?", other);
    if (x?.account_type === "service") { const svc = String(x.phone).replace(/^svc-/, ""); return { svc, ids: (await db.all("SELECT id FROM users WHERE (role = 'admin' AND service = ?) OR role = 'super'", svc)).map(r => r.id) }; }
    return { svc: null, ids: [other] };
  }
  // A message with an optional attachment. Returns the message as the sender sees it.
  async function postMessage(c, senderId, senderName, b) {
    const body = String(b.body || "").trim().slice(0, 1000);
    let att = "";
    if (b.att && b.att.data) {
      const kind = ["image", "voice", "file"].includes(b.att.kind) ? b.att.kind : "file";
      const mm = String(b.att.data).match(/^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/); if (!mm) fail("The file could not be read.");
      const type = mm[1].split(";")[0].toLowerCase();
      if (!ATT_KIND[kind].includes(type)) fail(kind === "image" ? "Send a JPG, PNG or WebP picture." : kind === "voice" ? "This voice message can't be sent." : "Send a picture, PDF or Word file.");
      const buf = Buffer.from(mm[2], "base64"); if (!buf.length) fail("The file is empty."); if (buf.length > 10 * 1024 * 1024) fail("Files must be 10 MB or smaller.");
      const name = String(b.att.name || kind).replace(/[\\/\r\n"]/g, "_").slice(0, 120);
      const file = `chat-${crypto.randomUUID()}`; await db.files.put(file, buf);
      att = JSON.stringify({ kind, name, type, size: buf.length, file, dur: Math.min(600, Math.max(0, Math.round(Number(b.att.dur) || 0))) });
    }
    if (!body && !att) fail("Write a message first.");
    const t = now();
    const info = await db.run("INSERT INTO messages (conv_id, sender_id, body, created_at, att) VALUES (?, ?, ?, ?, ?)", c.id, senderId, body, t, att);
    await db.run(`UPDATE conversations SET last_at = ?, ${senderId === c.buyer_id ? "buyer_read_at" : "seller_read_at"} = ? WHERE id = ?`, t, t, c.id);
    const m = { id: Number(info.lastInsertRowid), conv_id: c.id, sender_id: senderId, body, created_at: t, att: null };
    m.att = attOut({ id: m.id, att });
    const preview = msgPreview({ body, att });
    // The buyer's first message: the merchant's phone rings so they can answer quickly.
    if (senderId === c.buyer_id && (await db.get("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id = ?", c.id, senderId)).n === 1)
      Object.assign(m, { new_chat: true, product_name: (await db.get("SELECT name FROM products WHERE id = ?", c.product_id))?.name || "" });
    Object.assign(m, { from_name: senderName, preview });
    const aud = await chatAudience(c, senderId);
    broadcast("chat", m, x => x.id === c.buyer_id || x.id === c.seller_id || aud.ids.includes(x.id));
    if (aud.svc) broadcast("deskchat", { svc: aud.svc, conv_id: c.id, from_name: senderName, preview }, x => aud.ids.includes(x.id));
    pushLater(aud.ids, { kind: m.new_chat ? "ring" : "info", title: m.new_chat ? "New chat" : (senderName || "New message"), body: `${m.new_chat ? senderName + ": " : ""}${preview}`.slice(0, 160),
      goto: aud.svc ? "desk" : "chat:" + c.id, tag: "chat-" + c.id });
    return { ...m, mine: true };
  }
  // A chat file: only the two people in the chat (or the service's admins for a service desk) can open it.
  route("GET", "/api/chatfile/:id", async (req, res, url, [id]) => {
    const u = await needUser(req), m = await db.get("SELECT * FROM messages WHERE id = ?", Number(id));
    if (!m || !m.att) fail("File not found.", 404);
    const c = await db.get("SELECT * FROM conversations WHERE id = ?", m.conv_id);
    let ok = c && (c.buyer_id === u.id || c.seller_id === u.id);
    if (!ok && c) { const aud = await chatAudience(c, c.buyer_id); ok = !!aud.svc && aud.ids.includes(u.id); }
    if (!ok) fail("File not found.", 404);
    const a = JSON.parse(m.att), data = await db.files.get(a.file); if (!data) fail("File not found.", 404);
    const inline = a.kind !== "file" || a.type === "application/pdf";
    res.writeHead(200, { "Content-Type": a.type, "Content-Length": data.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${String(a.name).replace(/[^\x20-\x7e]/g, "_")}"` });
    res.end(data);
  });

  // Read receipts: when someone opens a chat, the other side's ticks turn green.
  async function readPing(c, readerId, at) {
    const aud = await chatAudience(c, readerId);
    broadcast("chatread", { conv_id: c.id, at }, x => (x.id !== readerId && (x.id === c.buyer_id || x.id === c.seller_id)) || aud.ids.includes(x.id));
  }
  // Calls paused by a seller: 0 = taking calls, -1 = until they turn calls back on, otherwise until that time.
  const callsOffUntil = v => { v = Number(v) || 0; return v === -1 || v > now() ? v : 0; };
  async function convRow(c, me) {
    const other = me === c.buyer_id ? c.seller_id : c.buyer_id;
    const o = await db.get("SELECT name FROM users WHERE id = ?", other);
    const last = await db.get("SELECT body, att, sender_id, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1", c.id);
    const readAt = me === c.buyer_id ? c.buyer_read_at : c.seller_read_at;
    const unread = (await db.get("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ? AND created_at > ?", c.id, me, readAt)).n;
    const p = await db.get("SELECT p.name, p.images, p.service, s.name AS shop_name FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?", c.product_id);
    const img = JSON.parse(p?.images || "[]")[0], ticket = p?.service === "ticket";
    return { id: c.id, product_id: c.product_id, product_name: ticket ? "Ticket enquiry" : p?.name || "Product", image: img ? "/media/" + img : null, kind: ticket ? "ticket" : "product",
      with_name: ticket && me === c.buyer_id ? p.shop_name : o?.name || "Someone", i_am: me === c.buyer_id ? "buyer" : "seller", last: last && { ...last, body: msgPreview(last) }, unread, last_at: c.last_at,
      with_phone: await callNumber(other, p?.service), other_read_at: (me === c.buyer_id ? c.seller_read_at : c.buyer_read_at) || 0,
      with_calls_off: me === c.buyer_id ? callsOffUntil((await db.get("SELECT calls_off_until FROM users WHERE id = ?", other))?.calls_off_until) : 0 };
  }
  const convFor = async (id, u) => { const c = await db.get("SELECT * FROM conversations WHERE id = ?", id); if (!c || (c.buyer_id !== u.id && c.seller_id !== u.id)) fail("Chat not found.", 404); return c; };
  route("POST", "/api/suuq/chat/start", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    const p = await db.get(`${PROD_SELECT} WHERE p.id = ? AND p.deleted = 0`, String(b.product_id));
    if (!p) fail("Product not found.", 404);
    if (p.owner_id === u.id) fail("This is your own product.");
    let c = await db.get("SELECT * FROM conversations WHERE product_id = ? AND buyer_id = ?", p.id, u.id);
    if (!c) {
      const id = crypto.randomUUID();
      await db.run("INSERT INTO conversations (id, product_id, buyer_id, seller_id, last_at) VALUES (?, ?, ?, ?, ?)", id, p.id, u.id, p.owner_id, now());
      c = await db.get("SELECT * FROM conversations WHERE id = ?", id);
    }
    send(res, 200, { chat: await convRow(c, u.id) });
  });
  route("GET", "/api/suuq/chats", async (req, res) => {
    const u = await needUser(req);
    const rows = await db.all("SELECT * FROM conversations WHERE buyer_id = ? OR seller_id = ? ORDER BY last_at DESC LIMIT 200", u.id, u.id);
    send(res, 200, { chats: (await Promise.all(rows.map(c => convRow(c, u.id)))).filter(c => c.last || c.i_am === "buyer") });
  });
  route("GET", "/api/suuq/chats/:id/messages", async (req, res, url, [id]) => {
    const u = await needUser(req), c = await convFor(id, u), at = now();
    await db.run(`UPDATE conversations SET ${u.id === c.buyer_id ? "buyer_read_at" : "seller_read_at"} = ? WHERE id = ?`, at, c.id);
    await readPing(c, u.id, at);
    const msgs = (await db.all("SELECT id, sender_id, body, att, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 300", c.id)).reverse();
    send(res, 200, { chat: await convRow(c, u.id), messages: msgs.map(m => ({ ...m, att: attOut(m), mine: m.sender_id === u.id })) });
  });
  route("POST", "/api/suuq/chats/:id/messages", async (req, res, url, [id]) => {
    const u = await needUser(req), c = await convFor(id, u), b = await readJson(req, 15 * 1024 * 1024);
    rateLimit(req, 60, 60000, "chat");
    send(res, 200, { message: await postMessage(c, u.id, u.name, b) });
  });

  /* ---------- chat with a service (Saba Multi Services and other services run by their admins) ---------- */
  // The customer chats with the service; the service's admins answer from the service dashboard.
  route("POST", "/api/services/:id/chat", async (req, res, url, [svc]) => {
    const u = await needRole(req, "customer"), d = await serviceDesk(svc);
    let c = await db.get("SELECT * FROM conversations WHERE product_id = ? AND buyer_id = ?", d.product.id, u.id);
    if (!c) {
      const cid = crypto.randomUUID();
      await db.run("INSERT INTO conversations (id, product_id, buyer_id, seller_id, last_at) VALUES (?, ?, ?, ?, ?)", cid, d.product.id, u.id, d.user.id, now());
      c = await db.get("SELECT * FROM conversations WHERE id = ?", cid);
    }
    const row = await convRow(c, u.id); row.with_name = d.sv.name; row.product_name = d.sv.name;
    send(res, 200, { chat: row });
  });
  const deskConv = async (svc, cid) => { const d = await serviceDesk(svc); const c = await db.get("SELECT * FROM conversations WHERE id = ? AND seller_id = ?", cid, d.user.id); if (!c) fail("Chat not found.", 404); return { d, c }; };
  route("GET", "/api/admin/service-chats/:id", async (req, res, url, [svc]) => {
    await needPageEditor(req, svc); const d = await serviceDesk(svc);
    const rows = await db.all("SELECT c.*, u.name AS bname, u.phone AS bphone FROM conversations c JOIN users u ON u.id = c.buyer_id WHERE c.seller_id = ? ORDER BY c.last_at DESC LIMIT 200", d.user.id);
    const out = [];
    for (const c of rows) {
      const last = await db.get("SELECT body, att, sender_id, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1", c.id); if (!last) continue;
      const unread = (await db.get("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ? AND created_at > ?", c.id, d.user.id, c.seller_read_at)).n;
      out.push({ id: c.id, name: c.bname, phone: c.bphone, last: { ...last, body: msgPreview(last), mine: last.sender_id === d.user.id }, unread: Number(unread) || 0, last_at: c.last_at });
    }
    send(res, 200, { chats: out });
  });
  route("GET", "/api/admin/service-chats/:id/:cid", async (req, res, url, [svc, cid]) => {
    await needPageEditor(req, svc); const { d, c } = await deskConv(svc, cid);
    const at = now(); await db.run("UPDATE conversations SET seller_read_at = ? WHERE id = ?", at, c.id); await readPing(c, c.seller_id, at);
    const b = await db.get("SELECT name, phone FROM users WHERE id = ?", c.buyer_id);
    const msgs = (await db.all("SELECT id, sender_id, body, att, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 300", c.id)).reverse();
    send(res, 200, { chat: { id: c.id, name: b?.name || "", phone: b?.phone || "", other_read_at: c.buyer_read_at || 0 }, messages: msgs.map(m => ({ ...m, att: attOut(m), mine: m.sender_id === d.user.id })) });
  });
  route("POST", "/api/admin/service-chats/:id/:cid", async (req, res, url, [svc, cid]) => {
    await needPageEditor(req, svc); const { d, c } = await deskConv(svc, cid), b = await readJson(req, 15 * 1024 * 1024);
    rateLimit(req, 120, 60000, "deskchat");
    send(res, 200, { message: await postMessage(c, d.user.id, d.sv.name, b) });
  });

  /* ---------- Documents for a service's admins (Saba Multi Services and other video-page services) ---------- */
  // The customer sends one or more pictures, PDF or Word files (passport, photos, letters…) with a note; that service's
  // admins (and the super admin) receive them in the service's dashboard.
  const DOC_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const isDocAdmin = (u, svc) => u && (isSuper(u) || (u.role === "admin" && u.service === svc));
  const docOut = (d, extra = {}) => ({ id: d.id, note: d.note, status: d.status, created_at: d.created_at, earn_amount: Number(d.earn_amount) || 0, earn_cur: d.earn_cur || "",
    files: JSON.parse(d.files || "[]").map((f, n) => ({ name: f.name, type: f.type, size: f.size, url: `/api/docs/${d.id}/file/${n}` })), ...extra });
  route("POST", "/api/services/:id/docs", async (req, res, url, [svc]) => {
    const u = await needRole(req, "customer"), b = await readJson(req, 40 * 1024 * 1024);
    if (!(await getSettings()).services.some(x => x.id === svc && x.visible)) fail("This service is not available right now.", 404);
    rateLimit(req, 20, 3600000, "svcdocs");
    const list = Array.isArray(b.files) ? b.files : [];
    if (!list.length) fail("Choose at least one file.");
    if (list.length > 10) fail("Send up to 10 files at a time.");
    const id = crypto.randomUUID(), saved = [];
    let total = 0;
    for (const f of list) {
      const name = String(f.name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 120), ext = (name.split(".").pop() || "").toLowerCase();
      const type = DOC_TYPES[ext]; if (!type) fail(`${name}: send pictures (JPG, PNG), PDF or Word files only.`);
      const m = String(f.data || "").match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/); if (!m) fail(`${name} could not be read.`);
      const buf = Buffer.from(m[1], "base64");
      if (!buf.length) fail(`${name} is empty.`);
      if (buf.length > 10 * 1024 * 1024) fail(`${name} is bigger than 10 MB.`);
      total += buf.length; if (total > 30 * 1024 * 1024) fail("The files together are bigger than 30 MB. Send fewer at a time.");
      saved.push({ buf, name, type, ext });
    }
    const files = [];
    for (const [n, f] of saved.entries()) { const file = `sdoc-${id}-${n}.${f.ext}`; await db.files.put(file, f.buf); files.push({ file, name: f.name, type: f.type, size: f.buf.length }); }
    const note = String(b.note || "").trim().slice(0, 500);
    await db.run("INSERT INTO service_docs (id, service, user_id, note, files, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)", id, svc, u.id, note, JSON.stringify(files), now());
    const d = await db.get("SELECT * FROM service_docs WHERE id = ?", id);
    broadcast("servicedoc", docOut(d, { name: u.name, phone: u.phone, service: svc }), x => isDocAdmin(x, svc));
    pushLater((await db.all("SELECT id FROM users WHERE (role = 'admin' AND service = ?) OR role = 'super'", svc)).map(x => x.id), { kind: "info", title: "New documents", body: `${u.name} sent ${files.length} file${files.length > 1 ? "s" : ""}${note ? ": " + note.slice(0, 100) : ""}`, goto: "docs", tag: "doc-" + id });
    send(res, 200, { doc: docOut(d) });
  });
  route("GET", "/api/services/:id/docs", async (req, res, url, [svc]) => {
    const u = await needRole(req, "customer");
    send(res, 200, { docs: (await db.all("SELECT * FROM service_docs WHERE user_id = ? AND service = ? ORDER BY created_at DESC LIMIT 50", u.id, svc)).map(d => docOut(d)) });
  });
  route("GET", "/api/docs/:id/file/:n", async (req, res, url, [id, n]) => {
    const u = await needUser(req), d = await db.get("SELECT * FROM service_docs WHERE id = ?", id);
    if (!d || !(d.user_id === u.id || isDocAdmin(u, d.service))) fail("File not found.", 404);
    const f = JSON.parse(d.files || "[]")[Number(n)]; if (!f) fail("File not found.", 404);
    const data = await db.files.get(f.file); if (!data) fail("File not found.", 404);
    const inline = /^image\/|pdf$/.test(f.type) && url.searchParams.get("download") !== "1";
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": data.length, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
    res.end(data);
  });
  route("GET", "/api/admin/service-docs/:id", async (req, res, url, [svc]) => {
    await needPageEditor(req, svc);
    const st = url.searchParams.get("status") === "done" ? "done" : "new";
    const rows = await db.all(`SELECT d.*, u.name, u.phone FROM service_docs d JOIN users u ON u.id = d.user_id WHERE d.service = ? AND d.status = ? ORDER BY d.created_at DESC LIMIT 200`, svc, st);
    const count = (await db.get("SELECT COUNT(*) AS n FROM service_docs WHERE service = ? AND status = 'new'", svc)).n;
    const sv = (await getSettings()).services.find(x => x.id === svc);
    send(res, 200, { docs: rows.map(d => docOut(d, { name: d.name, phone: d.phone })), new: Number(count) || 0, earn_default: sv?.doc_earn || { amount: 0, cur: "USD" } });
  });
  // Earnings for documents: the admin gives the person who sent a set of documents a fixed earning (once per set).
  // It goes to their "My earnings". The amount used becomes the default for the next set.
  route("POST", "/api/admin/service-docs/:id/:doc/earn", async (req, res, url, [svc, id]) => {
    await needPageEditor(req, svc);
    const b = await readJson(req), amount = round(String(b.cur), Number(b.amount)), cur = String(b.cur);
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    if (!(amount > 0) || amount > 1e7) fail("Enter an earning above 0.");
    const name = (await getSettings()).services.find(x => x.id === svc)?.name || "Service";
    await tx(async () => {
      const d = await db.get("SELECT * FROM service_docs WHERE id = ? AND service = ?", id, svc); if (!d) fail("Not found.", 404);
      if (Number(d.earn_amount) > 0) fail("This person already got an earning for these documents.");
      await db.run("UPDATE service_docs SET earn_amount = ?, earn_cur = ? WHERE id = ?", amount, cur, id);
      await addEarning(d.user_id, cur, amount, "documents", "DOC-" + id.slice(0, 8), `${name} · documents`);
    });
    const s2 = await getSettings(), i = s2.services.findIndex(x => x.id === svc);
    if (i >= 0) { const services = s2.services.slice(); services[i] = { ...services[i], doc_earn: { amount, cur } }; await saveSettings({ services }); }
    send(res, 200, { ok: true });
  });
  // The customer's own earnings from a service's documents (each person sees only their own).
  route("GET", "/api/services/:id/earnings", async (req, res, url, [svc]) => {
    const u = await needRole(req, "customer");
    const docs = await db.all("SELECT * FROM service_docs WHERE user_id = ? AND service = ? ORDER BY created_at DESC LIMIT 100", u.id, svc);
    const totals = {}; for (const d of docs) if (d.earn_amount > 0) totals[d.earn_cur] = round(d.earn_cur, (totals[d.earn_cur] || 0) + d.earn_amount);
    send(res, 200, { docs: docs.map(d => docOut(d)), totals, balances: await earnBalances(u.id), withdraw_at: withdrawAt(u) });
  });
  route("POST", "/api/admin/service-docs/:id/:doc", async (req, res, url, [svc, id]) => {
    await needPageEditor(req, svc);
    const b = await readJson(req), st = b.status === "new" ? "new" : "done";
    if ((await db.run("UPDATE service_docs SET status = ? WHERE id = ? AND service = ?", st, id, svc)).changes !== 1) fail("Not found.", 404);
    send(res, 200, { ok: true });
  });
  /* ---------- Ticket: travel agencies ---------- */
  // A shop is a travel agency when its owner switched it on (My shop), or when it lists visas.
  const isTravel = (s, pf) => !!pf.travel || !!s.has_visa;
  // Each agency's ticket item: the customer asks for the ticket price, the agency sends it, the customer pays from the
  // wallet. The agency chooses the affiliate earning (default 5%); whoever shared the agency earns it (or the buyer).
  const ticketComm = pf => { const c = pf.ticket_comm || {}; return { type: c.type === "flat" ? "flat" : "percent", value: Number.isFinite(Number(c.value)) ? Number(c.value) : 5 }; };
  async function ticketProduct(s) {
    const pf = JSON.parse(s.profile || "{}"), c = ticketComm(pf);
    let p = await db.get("SELECT * FROM products WHERE shop_id = ? AND service = 'ticket' AND deleted = 0", s.id);
    if (!p) {
      const pid = crypto.randomUUID();
      await db.run(`INSERT INTO products (id, shop_id, name, description, price, cur, mode, images, video, comm_type, comm_value, service, price_hidden, price_label, country, hidden, approval, created_at, updated_at)
        VALUES (?, ?, 'Ticket enquiry', '', 1000, 'USD', 'buy', ?, '', ?, ?, 'ticket', 1, 'Ask for the ticket price', '', 1, 'approved', ?, ?)`, pid, s.id, "[]", c.type, c.value, now(), now());
      p = await db.get("SELECT * FROM products WHERE id = ?", pid);
    } else if (p.mode !== "buy" || !p.price_hidden || p.comm_type !== c.type || Number(p.comm_value) !== c.value || p.name !== `Ticket · ${s.name}`) {
      await db.run("UPDATE products SET mode = 'buy', price_hidden = 1, price_label = 'Ask for the ticket price', price = 1000, comm_type = ?, comm_value = ?, name = ?, updated_at = ? WHERE id = ?", c.type, c.value, `Ticket · ${s.name}`.slice(0, 60), now(), p.id);
      p = await db.get("SELECT * FROM products WHERE id = ?", p.id);
    }
    if (p.name === "Ticket enquiry") { await db.run("UPDATE products SET name = ? WHERE id = ?", `Ticket · ${s.name}`.slice(0, 60), p.id); p.name = `Ticket · ${s.name}`; }
    return p;
  }
  route("POST", "/api/suuq/shop/ticket-earn", async (req, res) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id), b = await readJson(req);
    if (!s) fail("Open your shop first.");
    const type = b.type === "flat" ? "flat" : "percent", value = Number(b.value);
    if (!(value >= 0) || (type === "percent" && value > 90) || value > 1e6) fail("Check the ticket earning.");
    const pf = { ...JSON.parse(s.profile || "{}"), ticket_comm: { type, value } };
    await db.run("UPDATE shops SET profile = ? WHERE id = ?", JSON.stringify(pf), s.id);
    await ticketProduct(await shopOf(u.id));
    send(res, 200, { shop: await publicShop(await shopOf(u.id)) });
  });
  // Travel agencies that can take trip requests (not suspended, subscription paid).
  async function travelShops() {
    const rows = await db.all(`SELECT s.*, EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id AND p.service = 'visa' AND p.deleted = 0 AND p.approval = 'approved') AS has_visa
      FROM shops s WHERE s.suspended = 0 AND s.sub_until > ? ORDER BY s.name`, now());
    return rows.filter(s => isTravel(s, JSON.parse(s.profile || "{}")));
  }
  // The agency with the fewest open requests gets the next one (ties: a random one). Owners in skip are left out.
  async function pickAgency(skip) {
    const shops = (await travelShops()).filter(s => !skip.has(s.owner_id)); if (!shops.length) return null;
    const busy = async s => (await db.get("SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND status IN ('requested', 'accepted', 'quoted')", s.id)).n;
    const scored = []; for (const s of shops) scored.push([Number(await busy(s)), Math.random(), s]);
    const s = scored.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0][2], t = await ticketProduct(s);
    return { ...t, owner_id: s.owner_id, shop_name: s.name };
  }
  // A price request on the agency's ticket item (the same steps as "Ask for ticket price").
  async function addRequest(o, c) {
    const nid = crypto.randomUUID(), ref = "SQ" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
    await db.run(`INSERT INTO orders (id, ref, product_id, shop_id, buyer_id, seller_id, kind, product_name, qty, unit_price, total, cur, commission, affiliate_id, status, note, created_at, updated_at, from_order)
                VALUES (?, ?, ?, ?, ?, ?, 'buy', ?, ?, 0, 0, ?, 0, ?, 'requested', ?, ?, ?, ?)`, nid, ref, c.id, c.shop_id, o.buyer_id, c.owner_id, c.name, o.qty || 1, c.cur,
                o.affiliate_id && o.affiliate_id !== c.owner_id ? o.affiliate_id : null, o.note, now(), now(), o.from_order || "");
    if (o.from_order) await db.run("UPDATE orders SET forwarded_to = ? WHERE id = ?", nid, o.from_order);
    return nid;
  }
  // The Ticket admin's own agency gets half of all new ticket requests: every second request goes to it, whichever
  // agency the customer chose (the other half goes to the agency they chose). Requests passed on after a rejection don't count.
  async function ticketStats(adminShop) {
    const r = await db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN o.shop_id = ? THEN 1 ELSE 0 END) AS admin FROM orders o JOIN products p ON p.id = o.product_id
      WHERE p.service = 'ticket' AND o.from_order = ''`, adminShop || 0);
    return { total: Number(r.total) || 0, admin: Number(r.admin) || 0 };
  }
  async function ticketRoute(p, u) {
    const id = (await getSettings()).ticketAdminAgency; if (!id || p.shop_id === id) return null;
    const shop = (await travelShops()).find(x => x.id === id); if (!shop || shop.owner_id === u.id) return null;
    const { total, admin } = await ticketStats(id);
    if (admin * 2 >= total + 1) return null; // the admin agency already has its half
    const t = await ticketProduct(shop), a = await db.get(`${PROD_SELECT} WHERE p.id = ?`, t.id);
    return a && PAUSES.includes(a.shop_pause) ? null : a; // the admin agency is at Salah or Sleep time: the customer's choice gets it
  }
  route("GET", "/api/admin/ticket-agency", async (req, res) => {
    await needPageEditor(req, "ticket");
    const id = (await getSettings()).ticketAdminAgency;
    send(res, 200, { agency: id, agencies: (await travelShops()).map(s => { const pf = JSON.parse(s.profile || "{}"); return { id: s.id, name: s.name, city: pf.city || "" }; }), stats: await ticketStats(id) });
  });
  route("PUT", "/api/admin/ticket-agency", async (req, res) => {
    await needPageEditor(req, "ticket");
    const b = await readJson(req), id = Number(b.agency) || 0;
    if (id && !(await travelShops()).some(s => s.id === id)) fail("Choose one of the travel agencies.");
    await saveSettings({ ticketAdminAgency: id });
    send(res, 200, { agency: id, stats: await ticketStats(id) });
  });
  route("GET", "/api/ticket/agencies", async (req, res) => {
    await needUser(req);
    const rows = await db.all(`SELECT s.*, EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id AND p.service = 'visa' AND p.deleted = 0 AND p.approval = 'approved') AS has_visa
      FROM shops s WHERE s.suspended = 0 AND s.sub_until > ? ORDER BY s.name`, now());
    const u = await loadUser(req);
    const list = rows.map(s => ({ s, pf: JSON.parse(s.profile || "{}") })).filter(({ s, pf }) => isTravel(s, pf));
    const agencies = [];
    for (const { s, pf } of list) {
      const t = await ticketProduct(s), c = ticketComm(pf);
      agencies.push({ id: s.id, shop_no: s.shop_no, name: s.name, city: pf.city || "", country: pf.country || "", address: pf.address || "",
        kind: pf.kind === "company" ? "company" : "shop", logo: pf.logo ? "/media/" + pf.logo : null,
        ticket_id: t.id, comm_type: c.type, comm_value: c.value, mine: s.owner_id === u?.id });
    }
    send(res, 200, { agencies });
  });
  // Starts (or reopens) a private chat between the customer and the agency. The chat hangs on a hidden
  // "Ticket enquiry" item of the agency, so it works like every other chat in the app.
  route("POST", "/api/ticket/agencies/:id/chat", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer");
    const s = await db.get("SELECT * FROM shops WHERE id = ? AND suspended = 0", Number(id));
    if (!s) fail("This travel agency is not available right now.", 404);
    if (s.owner_id === u.id) fail("This is your own agency.");
    const p = await ticketProduct(s);
    let c = await db.get("SELECT * FROM conversations WHERE product_id = ? AND buyer_id = ?", p.id, u.id);
    if (!c) {
      const cid = crypto.randomUUID();
      await db.run("INSERT INTO conversations (id, product_id, buyer_id, seller_id, last_at) VALUES (?, ?, ?, ?, ?)", cid, p.id, u.id, s.owner_id, now());
      c = await db.get("SELECT * FROM conversations WHERE id = ?", cid);
    }
    send(res, 200, { chat: await convRow(c, u.id) });
  });
  // The shop's logo (shown in Ticket and on the shop page).
  route("POST", "/api/suuq/shop/logo", async (req, res) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id), b = await readJson(req, 5 * 1024 * 1024);
    if (!s) fail("Open your shop first.");
    const pf = JSON.parse(s.profile || "{}"), old = pf.logo;
    if (b.image) { [pf.logo] = await saveImages([b.image], "shop-" + s.id); } else delete pf.logo;
    await db.run("UPDATE shops SET profile = ? WHERE id = ?", JSON.stringify(pf), s.id);
    if (old && old !== pf.logo) await db.files.del(old);
    send(res, 200, { shop: await publicShop(await shopOf(u.id)) });
  });
  // The shop owner lists (or unlists) their business in Ticket.
  route("POST", "/api/suuq/shop/travel", async (req, res) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id), b = await readJson(req);
    if (!s) fail("Open your shop first.");
    const pf = { ...JSON.parse(s.profile || "{}"), travel: !!b.on };
    await db.run("UPDATE shops SET profile = ? WHERE id = ?", JSON.stringify(pf), s.id);
    send(res, 200, { shop: await publicShop(await shopOf(u.id)) });
  });

  /* ---------- affiliate program ---------- */
  route("GET", "/api/affiliate", async (req, res) => {
    const u = await needUser(req);
    // Earned: everything ever earned (older earnings went straight to the wallet, newer ones collect in earnings).
    const earnedRows = [...await db.all("SELECT cur, SUM(amount) AS total FROM wallet_tx WHERE user_id = ? AND kind = 'affiliate' GROUP BY cur", u.id),
      ...await db.all("SELECT cur, SUM(amount) AS total FROM earnings WHERE user_id = ? AND kind = 'affiliate' GROUP BY cur", u.id)];
    const earned = CURS.map(c => ({ cur: c, total: round(c, earnedRows.filter(r => r.cur === c).reduce((a, r) => a + Number(r.total || 0), 0)) })).filter(r => r.total > 0);
    const pending = await db.all("SELECT cur, SUM(commission) AS total, COUNT(*) AS n FROM orders WHERE affiliate_id = ? AND commission > 0 AND status IN ('paid','delivered','awaiting_payment') GROUP BY cur", u.id);
    const list = await db.all("SELECT ref, product_name, qty, cur, commission, status, created_at, completed_at FROM orders WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 100", u.id);
    const flags = await Promise.all(MARKETS.map(m => marketOpen(m))), open = MARKETS.filter((m, i) => flags[i]);
    if (await marketOpen("ticket")) open.push("ticket");
    const prodRows = open.length ? (await db.all(`${PROD_SELECT} WHERE ${LIVE_T} AND p.mode = 'buy' AND p.comm_value > 0 ORDER BY p.created_at DESC LIMIT 100`, now()))
      .filter(p => open.includes(p.service)) : [];
    const products = await Promise.all(prodRows.map(async p => { const c = await shareCode(u, p); return shopperRow(p, u, { share_code: c, first_sender: !!c && c !== u.ref_code }); }));
    const fresh = await db.get("SELECT withdraw_at FROM users WHERE id = ?", u.id);
    send(res, 200, { code: u.ref_code, earned, pending, list, products, earnings: await earnBalances(u.id), withdraw_at: withdrawAt(fresh || {}),
      earn_tx: await db.all("SELECT cur, amount, kind, ref, note, created_at FROM earnings WHERE user_id = ? ORDER BY id DESC LIMIT 50", u.id) });
  });
  // The amount the person wants to withdraw at (asked on the first screen, changeable on the Affiliate page).
  route("PUT", "/api/earnings/limit", async (req, res) => {
    const u = await needUser(req), b = await readJson(req), w = withdrawAt(u);
    // Set once: after the amounts are chosen they can't be changed.
    if (w.USD > 0 || w.SLSH > 0) fail("Your withdraw amounts are already set. They can't be changed.");
    if (CURS.includes(b.cur)) b[b.cur] = b.amount; // the first screen may send { cur, amount }
    for (const c of CURS) if (b[c] != null && b[c] !== "") {
      const v = round(c, Number(b[c]));
      if (!(v >= 0) || v > 1e9) fail("Enter an amount of 0 or more.");
      w[c] = v;
    }
    await db.run("UPDATE users SET withdraw_at = ? WHERE id = ?", JSON.stringify(w), u.id);
    send(res, 200, { withdraw_at: w });
  });
  // Withdraw one currency: its earnings move to the wallet of the same currency, once they reach its amount.
  route("POST", "/api/earnings/withdraw", async (req, res) => {
    const u = await needUser(req), b = await readJson(req), cur = String(b.cur);
    if (!CURS.includes(cur)) fail("Choose USD or SLSH.");
    await needPin(u, b.pin);
    const limit = withdrawAt(u)[cur];
    await tx(async () => {
      const bal = await earnBalance(u.id, cur);
      if (!(bal > 0)) fail("You have no earnings to withdraw yet.");
      if (limit > 0 && bal < limit) fail(`You can withdraw when your earnings reach ${cur === "USD" ? "$" + limit : limit.toLocaleString("en-US") + " SLSH"}.`);
      const ref = "EW" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
      await addEarning(u.id, cur, -bal, "withdraw", ref, "To wallet");
      await ledger(u.id, cur, bal, "earnings", ref, "Affiliate earnings");
    });
    send(res, 200, { earnings: await earnBalances(u.id), balances: await balances(u.id) });
  });

  /* ---------- Suuq admin ---------- */
  // Visa admin: the visa listings (hide any), and the words sellers can show instead of a price.
  route("GET", "/api/visa/admin/overview", async (req, res) => {
    await needMarketAdmin(req, "visa");
    const products = await db.all(`${PROD_SELECT} WHERE p.deleted = 0 AND p.service = 'visa' ORDER BY CASE p.approval WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at DESC LIMIT 300`);
    const orders = await db.all("SELECT o.status, o.cur, COUNT(*) AS n, SUM(o.total) AS total FROM orders o JOIN products p ON p.id = o.product_id WHERE p.service = 'visa' GROUP BY o.status, o.cur");
    send(res, 200, { products: products.map(p => productRow(p)), orders, priceWords: (await getSettings()).priceWords });
  });
  route("PUT", "/api/visa/admin/price-words", async (req, res) => {
    await needMarketAdmin(req, "visa");
    const b = await readJson(req), seen = new Set();
    const words = (Array.isArray(b.words) ? b.words : []).map(w => String(w || "").trim().slice(0, 40)).filter(w => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
    if (!words.length) fail("Keep at least one choice.");
    if (words.length > 20) fail("Use at most 20 choices.");
    await saveSettings({ priceWords: words });
    send(res, 200, { priceWords: words });
  });

  // Scholarship admin: the scholarship listings, and which travel agencies may post them.
  route("GET", "/api/scholar/admin/overview", async (req, res) => {
    await needMarketAdmin(req, "scholarship");
    const products = await db.all(`${PROD_SELECT} WHERE p.deleted = 0 AND p.service = 'scholarship' ORDER BY CASE p.approval WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at DESC LIMIT 300`);
    const shops = await db.all(`SELECT s.*, u.name AS owner_name, u.phone AS owner_phone, u.face AS owner_face,
        EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id AND p.service = 'visa' AND p.deleted = 0) AS has_visa
      FROM shops s JOIN users u ON u.id = s.owner_id ORDER BY s.name`);
    const agencies = shops.map(s => ({ s, pf: JSON.parse(s.profile || "{}") })).filter(({ s, pf }) => pf.travel || s.has_visa || pf.scholar)
      .map(({ s, pf }) => ({ id: s.id, shop_no: s.shop_no, name: s.name, city: pf.city || "", country: pf.country || "", owner_name: s.owner_name, owner_phone: s.owner_phone,
        allowed: !!pf.scholar, suspended: !!s.suspended, logo: pf.logo ? "/media/" + pf.logo : null }));
    send(res, 200, { products: products.map(p => productRow(p)), agencies });
  });
  route("POST", "/api/scholar/admin/agencies/:id", async (req, res, url, [id]) => {
    await needMarketAdmin(req, "scholarship");
    const b = await readJson(req), s = await db.get("SELECT * FROM shops WHERE id = ?", Number(id));
    if (!s) fail("Shop not found.", 404);
    const pf = { ...JSON.parse(s.profile || "{}"), scholar: !!b.allow };
    await db.run("UPDATE shops SET profile = ? WHERE id = ?", JSON.stringify(pf), s.id);
    broadcast("shop", { scholar: pf.scholar }, u => u.id === s.owner_id);
    send(res, 200, { ok: true, allowed: pf.scholar });
  });
  route("GET", "/api/suuq/admin/overview", async (req, res) => {
    await needSuuqAdmin(req);
    const shops = await db.all(`SELECT s.*, u.name AS owner_name, u.phone AS owner_phone, u.face AS owner_face,
        (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.deleted = 0 AND p.service != 'ticket') AS products,
        (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id AND o.status = 'completed') AS sales
      FROM shops s JOIN users u ON u.id = s.owner_id ORDER BY s.created_at DESC`);
    const products = await db.all(`${PROD_SELECT} WHERE p.deleted = 0 AND p.service = 'suuq' ORDER BY CASE p.approval WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at DESC LIMIT 300`);
    const orders = await db.all("SELECT status, cur, COUNT(*) AS n, SUM(total) AS total FROM orders GROUP BY status, cur");
    const subs = await db.all("SELECT cur, SUM(amount) AS total FROM wallet_tx WHERE user_id IS NULL AND kind = 'subscription_income' GROUP BY cur");
    send(res, 200, { plans: (await getSettings()).suuq.plans,
      shops: await Promise.all(shops.map(async s => ({ ...await publicShop(s), owner_name: s.owner_name, owner_phone: s.owner_phone, owner_id: s.owner_id, owner_face: !!s.owner_face, products: s.products, sales: s.sales }))),
      products: products.map(p => productRow(p)), orders, subs });
  });
  route("PUT", "/api/suuq/admin/plans", async (req, res) => {
    await needSuuqAdmin(req);
    const b = await readJson(req);
    if (!Array.isArray(b.plans) || !b.plans.length || b.plans.length > 10) fail("Add at least one plan.");
    const plans = b.plans.map((p, i) => {
      const name = String(p.name || "").trim().slice(0, 30), days = Math.floor(Number(p.days)), cur = String(p.cur), price = Number(p.price);
      if (name.length < 2) fail("Every plan needs a name.");
      if (!(days >= 1 && days <= 3660)) fail(`${name}: days must be between 1 and 3660.`);
      if (!CURS.includes(cur)) fail(`${name}: choose USD or SLSH.`);
      if (!(price >= 0)) fail(`${name}: enter a price of 0 or more.`);
      const maxProducts = Math.floor(Number(p.maxProducts) || 0);
      if (!(maxProducts >= 0 && maxProducts <= 100000)) fail(`${name}: products must be 0 (unlimited) or more.`);
      const id = String(p.id || "").replace(/[^\w-]/g, "").slice(0, 20) || "plan" + (i + 1) + "-" + crypto.randomBytes(2).toString("hex");
      return { id, name, days, cur, price: id === "free" ? 0 : round(cur, price), maxProducts };
    });
    if (!plans.some(p => p.id === "free")) fail("Keep the Free plan. New merchants get it when they register.");
    if (plans.filter(p => p.id !== "free").length < 1) fail("Add at least one paid plan.");
    const s = await saveSettings({ suuq: { ...(await getSettings()).suuq, plans } });
    send(res, 200, { plans: s.suuq.plans });
  });
  route("POST", "/api/suuq/admin/shops/:id/suspend", async (req, res, url, [id]) => {
    await needSuuqAdmin(req);
    const b = await readJson(req);
    if (!(await db.run("UPDATE shops SET suspended = ? WHERE id = ?", b.suspended ? 1 : 0, id)).changes) fail("Shop not found.", 404);
    send(res, 200, { ok: true });
  });
  /* ---------- product approval ---------- */
  // Tells the admins of that service (and the super admin) that a product is waiting.
  async function announceReview(id) {
    const p = await db.get("SELECT id, name, service FROM products WHERE id = ?", id); if (!p) return;
    const pending = (await db.get("SELECT COUNT(*) AS n FROM products WHERE deleted = 0 AND approval = 'pending' AND service = ?", p.service)).n;
    broadcast("review", { service: p.service, pending, product: { id: p.id, name: p.name } }, u => u.role === "super" || (u.role === "admin" && u.service === p.service));
  }
  // Products sellers list in a service market that has its own admin (Technician): to approve or reject.
  route("GET", "/api/market/:m/admin/products", async (req, res, url, [m]) => {
    if (!MARKETS.includes(m)) fail("Not found.", 404);
    await needMarketAdmin(req, m);
    const rows = await db.all(`${PROD_SELECT} WHERE p.deleted = 0 AND p.service = ? ORDER BY CASE p.approval WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at DESC LIMIT 300`, m);
    send(res, 200, { products: rows.map(p => productRow(p)) });
  });
  route("POST", "/api/suuq/admin/products/:id/review", async (req, res, url, [id]) => {
    const pr = await db.get("SELECT p.id, p.name, p.service, s.owner_id FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ? AND p.deleted = 0", id);
    if (!pr) fail("Product not found.", 404);
    await needMarketAdmin(req, pr.service || "suuq");
    const b = await readJson(req), decision = String(b.decision);
    if (!["approve", "reject"].includes(decision)) fail("Choose approve or reject.");
    const note = String(b.note || "").trim().slice(0, 200);
    if (decision === "reject" && note.length < 3) fail("Tell the seller why, so they can fix it.");
    const approval = decision === "approve" ? "approved" : "rejected";
    await db.run("UPDATE products SET approval = ?, review_note = ? WHERE id = ?", approval, decision === "approve" ? "" : note, id);
    broadcast("product", { id, name: pr.name, approval, note: decision === "approve" ? "" : note }, u => u.id === pr.owner_id);
    await announceReview(id);
    send(res, 200, { ok: true, approval });
  });

  route("POST", "/api/suuq/admin/products/:id/hide", async (req, res, url, [id]) => {
    const pr = await db.get("SELECT service FROM products WHERE id = ?", id);
    if (!pr) fail("Product not found.", 404);
    await needMarketAdmin(req, pr.service || "suuq");
    const b = await readJson(req);
    if (!(await db.run("UPDATE products SET admin_hidden = ? WHERE id = ?", b.hidden ? 1 : 0, id)).changes) fail("Product not found.", 404);
    send(res, 200, { ok: true });
  });

  return { balances };
};
