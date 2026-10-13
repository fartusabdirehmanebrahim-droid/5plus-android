// Wallets, the Suuq marketplace, private buyer-seller chat and the affiliate program.
// Loaded by server.js, which passes in its helpers.
module.exports = function market(ctx) {
  const { hashSecret, nextShopNo, newRefCode, startSession, publicUser, isPin, weakPin, route, db, send, fail, readJson, needRole, loadUser, broadcast, getSettings, saveSettings, isSuper, publicSettings, serviceVideos, needPageEditor, pageOf,
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
    refund: "Refund", sale: "Sale", affiliate: "Affiliate earning", subscription_income: "Subscription income", earnings: "Earnings withdrawn to wallet", affiliate_fee: "Affiliate earning (paid to your shop)" };
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
  const MARKETS = ["suuq", "visa", "scholarship"];
  const MNAME = { suuq: "Suuq", visa: "Visa", scholarship: "Scholarship", ticket: "Ticket" };
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
    const u = await db.get("SELECT id, name, phone, role, service FROM users WHERE phone = ?", phone);
    if (!u) fail("No account uses this phone number.", 404);
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
    send(res, 200, { balances: await balances(null), customerMoney: held, tx: rows.map(txRow) });
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
  function readProfile(b) {
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
    if (p.phone.length < 7 || p.phone.length > 15) fail("Enter a valid phone number.");
    for (const [k, label] of [["zaad_merchant", "ZAAD merchant number"], ["edahab_merchant", "eDahab merchant number"], ["shop_phone", "shop phone number"]])
      if (p[k] && (p[k].length < 4 || p[k].length > 15)) fail(`Check the ${label}.`);
    if (!p.zaad_merchant && !p.edahab_merchant) fail("Enter at least one merchant number (ZAAD or eDahab).");
    return p;
  }

  route("GET", "/api/suuq/plans", async (req, res) => send(res, 200, { plans: (await getSettings()).suuq.plans, countries: COUNTRIES }));
  // Merchant sign-up from the first screen: the seller registration form plus a PIN. The phone is the login.
  route("POST", "/api/auth/signup-merchant", async (req, res) => {
    rateLimit(req);
    const b = await readJson(req), p = readProfile(b.profile || {}), pin = String(b.pin || "");
    const phone = cleanPhone(p.phone);
    if (phone.length < 7 || phone.length > 12) fail("Enter a valid phone number.");
    if (!isPin(pin) || weakPin(pin)) fail("Choose a 4-digit PIN.");
    if (await db.get("SELECT 1 FROM users WHERE phone = ?", phone)) fail("This phone number already has an account. Log in, then choose “Become a merchant” in Account.");
    p.phone = phone;
    const u = await tx(async () => {
      const info = await db.run("INSERT INTO users (name, phone, role, account_type, pin_hash, wallets, created_at, ref_code) VALUES (?, ?, 'customer', 'merchant', ?, '{}', ?, ?)", p.full_name, phone, hashSecret(pin), now(), await newRefCode());
      await db.run("INSERT INTO shops (owner_id, name, profile, sub_until, plan, shop_no, created_at) VALUES (?, ?, ?, ?, 'free', ?, ?)", info.lastInsertRowid, p.business_name, JSON.stringify(p), await freeUntil(), await nextShopNo(), now());
      return await db.get("SELECT * FROM users WHERE id = ?", info.lastInsertRowid);
    });
    startSession(res, u);
    send(res, 200, { user: publicUser(u) });
  });
  // An existing customer becomes a merchant by filling in the same form.
  route("POST", "/api/suuq/become-merchant", async (req, res) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
    if (await shopOf(u.id)) fail("You are already a merchant.");
    const p = readProfile(b);
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
    const p = readProfile(b);
    await db.run("UPDATE shops SET profile = ?, name = ? WHERE id = ?", JSON.stringify(p), p.business_name, s.id);
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
      earn: COMMISSION(p, 1), shop_id: p.shop_id, shop_no: p.shop_no ?? null, shop_name: p.shop_name, seller_id: p.owner_id, hidden: !!p.hidden,
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
  const PROD_SELECT = "SELECT p.*, s.name AS shop_name, s.shop_no, s.owner_id, s.sub_until, s.suspended AS shop_suspended, s.profile AS shop_profile FROM products p JOIN shops s ON s.id = p.shop_id";
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

  route("GET", "/api/suuq/products/:id", async (req, res, url, [id]) => {
    const u = await needUser(req);
    const p = await db.get(`${PROD_SELECT} WHERE p.id = ? AND p.deleted = 0`, id);
    const live = p && (!p.hidden || p.service === "ticket" || String(p.service).startsWith("svc:")) && !p.admin_hidden && p.approval === "approved" && !p.shop_suspended && p.sub_until > now();
    if (!p || (!live && p.owner_id !== u.id)) fail("This product is not available.", 404);
    if (live && u.role === "customer") await rememberRef(u.id, p, url.searchParams.get("ref"));
    const code = await shareCode(u, p);
    send(res, 200, { product: shopperRow(p, u, { share_code: code, first_sender: !!code && code !== u.ref_code }) });
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
    if (!MARKETS.includes(service)) fail("Choose Suuq, Visa or Scholarship.");
    if (service !== existing?.service && !await marketOpen(service)) fail(`${MNAME[service]} is not open right now.`);
    const price_hidden = b.price_hidden === undefined ? !!existing?.price_hidden : !!b.price_hidden;
    const price_label = price_hidden ? String(b.price_label ?? existing?.price_label ?? "") : "";
    if (price_hidden && !(await getSettings()).priceWords.includes(price_label)) fail("Choose the words to show instead of the price.");
    // A visa is for one country; customers browse visas by country.
    const country = hasCountry(service) ? String(b.country ?? existing?.country ?? "").trim() : "";
    if (hasCountry(service) && !COUNTRIES.includes(country)) fail(service === "visa" ? "Choose the country this visa is for." : "Choose the country of the scholarship.");
    return { service, country, price_hidden: price_hidden ? 1 : 0, price_label, name, description: String(b.description ?? existing?.description ?? "").trim().slice(0, 600), price: round(cur, price), cur, mode, comm_type, comm_value: comm_type === "flat" ? round(cur, comm_value) : Math.round(comm_value * 100) / 100, video: video.slice(0, 500) };
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
    if (d.service === "scholarship" && !scholarAllowed(s)) fail("Only travel agencies allowed by the Scholarship admin can post scholarships.");
    const imgs = (Array.isArray(b.newImages) ? b.newImages : []).slice(0, MAX_IMAGES);
    if (!imgs.length) fail("Add at least one photo of the product.");
    const files = await saveImages(imgs, "prod");
    const id = crypto.randomUUID();
    // Every new product waits for the admin's approval before customers can see it.
    await db.run(`INSERT INTO products (id, shop_id, name, description, price, cur, mode, images, video, comm_type, comm_value, service, price_hidden, price_label, country, approval, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, id, s.id, d.name, d.description, d.price, d.cur, d.mode, JSON.stringify(files), d.video, d.comm_type, d.comm_value, d.service, d.price_hidden, d.price_label, d.country, now(), now());
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
  async function payPlan(method, via, cur, total, shopProfile) {
    const s = await getSettings(), codes = s.safePay.codes[cur];
    const nums = method === "safe" ? { merchant: digits(s.safePay.merchant), number: digits(s.safePay.number) } : shopPayNums(shopProfile);
    if (!nums.merchant && !nums.number) fail(method === "safe" ? "Safe payment isn't set up yet. Choose another way to pay." : "This shop hasn't added its payment numbers. Choose another way to pay.");
    const useMerchant = via === "normal" ? !nums.number : !!nums.merchant;
    const fee = round(cur, feeOf(s.tiers[cur], total));
    return { fee, ussd: ussdOf(useMerchant ? codes.merchant : codes.normal, useMerchant ? nums.merchant : nums.number, total + fee, cur) };
  }

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
      pay_vias: o.pay_method === "shop" ? (n => ({ merchant: !!n.merchant, number: !!n.number }))(shopPayNums(o.shop_profile)) : undefined };
    // A hidden-price request: the seller sends the price, then the buyer pays it from the wallet.
    if (o.kind === "buy" && (o.status === "requested" || o.status === "accepted")) r.needs_price = true;
    r.offer_desc = o.offer_desc || ""; r.forwarded = !!o.forwarded_to; r.from_order = !!o.from_order;
    if (forSeller && r.needs_price) r.suggested = round(o.cur, o.p_price * o.qty);
    if (forSeller) Object.assign(r, { buyer_name: o.buyer_name, buyer_phone: o.buyer_phone, commission: o.commission, net: round(o.cur, o.total - o.commission), has_affiliate: !!o.affiliate_id });
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
      if (st === "requested") pushLater(staff, { kind: "ring", title: o.kind === "book" ? "New booking" : "New request", body: `${who} · ${ref}${o.note ? " · “" + o.note + "”" : ""}`, goto: svc ? "desk" : "sellerorders", tag: o.id });
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
    const plan = p.mode === "buy" && !ask && method !== "wallet" ? await payPlan(method, b.via, p.cur, total, p.shop_profile) : null;
    const commission = p.mode === "buy" && aff && !ask ? COMMISSION(p, qty) : 0;
    const id = crypto.randomUUID(), ref = "SQ" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 7);
    const note = ((chosen ? `Customer chose ${chosen}. ` : "") + String(b.note || "").trim()).slice(0, 300);
    const limited = Number(p.stock) >= 0;
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
    });
    if (plan?.ussd && method === "safe") broadcast("safepay", { new: true, name: u.name, product: p.name, amount: total + plan.fee, cur: p.cur }, x => isSuper(x));
    await pushOrder(id);
    send(res, 200, { order: orderRow(await db.get(`${ORDER_SELECT} WHERE o.id = ?`, id), false), balances: await balances(u.id) });
  });
  route("GET", "/api/suuq/orders/mine", async (req, res) => {
    const u = await needUser(req);
    send(res, 200, { orders: (await db.all(`${ORDER_SELECT} WHERE o.buyer_id = ? ORDER BY o.created_at DESC LIMIT 200`, u.id)).map(o => orderRow(o, false)) });
  });
  route("GET", "/api/suuq/seller/orders", async (req, res) => {
    const u = await needRole(req, "customer");
    send(res, 200, { orders: (await db.all(`${ORDER_SELECT} WHERE o.seller_id = ? ORDER BY o.created_at DESC LIMIT 500`, u.id)).map(o => orderRow(o, true)) });
  });

  // Buy:  paid → delivered (seller) → completed (buyer confirms; money is released). Paid orders can be cancelled with a refund.
  // Book: requested → accepted (seller) → completed (seller). The seller can decline a request.
  async function complete(o) {
    const net = round(o.cur, o.total - o.commission);
    if (o.kind === "buy" && o.pay_method !== "shop") {
      await ledger(o.seller_id, o.cur, net, "sale", o.ref, `${o.product_name} × ${o.qty}`);
      if (o.affiliate_id && o.commission > 0) await addEarning(o.affiliate_id, o.cur, o.commission, "affiliate", o.ref, `${o.product_name} × ${o.qty}`);
    } else if (o.kind === "buy" && o.affiliate_id && o.commission > 0) {
      // Paid to the shop: the seller already has all the money, so the affiliate earning comes from the seller's wallet.
      await ledger(o.seller_id, o.cur, -o.commission, "affiliate_fee", o.ref, `${o.product_name} × ${o.qty}`);
      await addEarning(o.affiliate_id, o.cur, o.commission, "affiliate", o.ref, `${o.product_name} × ${o.qty}`);
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
    const best = rows.filter(c => !tried.has(c.owner_id)).map(c => [score(c), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0] || b[1].created_at - a[1].created_at)[0];
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
    let fwd = null;
    await tx(async () => {
      const o = await db.get("SELECT * FROM orders WHERE id = ?", id);
      if (!o || (o.buyer_id !== u.id && o.seller_id !== u.id)) fail("Order not found.", 404);
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
          const shop = await db.get("SELECT profile FROM shops WHERE id = ?", o.shop_id), plan = await payPlan(b.method, b.via, o.cur, o.total, shop?.profile);
          await db.run("UPDATE orders SET status = 'awaiting_payment', pay_method = ?, pay_fee = ?, pay_ussd = ?, commission = ?, updated_at = ? WHERE id = ?",
            b.method, plan.fee, plan.ussd, o.commission, now(), o.id);
          if (b.method === "safe") broadcast("safepay", { new: true, name: u.name, product: o.product_name, amount: o.total + plan.fee, cur: o.cur }, x => isSuper(x));
          return;
        }
        // Paid to the shop: the seller confirms the money arrived (or declines if it never came).
        if (action === "money_received" && seller && o.status === "awaiting_payment" && o.pay_method === "shop") return await set("paid");
        if (action === "decline" && seller && o.status === "awaiting_payment" && o.pay_method === "shop") return await set("payment_rejected");
        if (action === "cancel" && !seller && o.status === "awaiting_payment") return await set("cancelled");
        // Try again: dial once more, with the merchant number or the normal number.
        if (action === "retry" && !seller && o.status === "awaiting_payment") {
          const shop = await db.get("SELECT profile FROM shops WHERE id = ?", o.shop_id), plan = await payPlan(o.pay_method, b.via, o.cur, o.total, shop?.profile);
          await db.run("UPDATE orders SET pay_fee = ?, pay_ussd = ?, updated_at = ? WHERE id = ?", plan.fee, plan.ussd, now(), o.id);
          if (o.pay_method === "safe") broadcast("safepay", {}, x => isSuper(x));
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
    return fwd;
  }
  route("POST", "/api/suuq/orders/:id/action", async (req, res, url, [id]) => {
    const u = await needRole(req, "customer"), b = await readJson(req);
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

  /* ---------- safe payments (super admin) ---------- */
  route("GET", "/api/super/safepay", async (req, res, url) => {
    await needRole(req, "super");
    const pend = url.searchParams.get("status") !== "done";
    const rows = await db.all(`${ORDER_SELECT} WHERE o.pay_method = 'safe' AND ${pend ? "o.status = 'awaiting_payment'" : "o.status != 'awaiting_payment'"} ORDER BY o.updated_at DESC LIMIT 100`);
    send(res, 200, { orders: rows.map(o => ({ ...orderRow(o, true), buyer_name: o.buyer_name, buyer_phone: o.buyer_phone })), settings: (await getSettings()).safePay });
  });
  route("POST", "/api/super/safepay/:id/:decision", async (req, res, url, [id, decision]) => {
    await needRole(req, "super");
    if (!["confirm", "reject"].includes(decision)) fail("Not found.", 404);
    await tx(async () => {
      const o = await db.get("SELECT * FROM orders WHERE id = ?", id);
      if (!o || o.pay_method !== "safe") fail("Order not found.", 404);
      if (o.status !== "awaiting_payment") fail("This payment was already handled.");
      await db.run("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", decision === "confirm" ? "paid" : "payment_rejected", now(), o.id);
      if (decision !== "confirm" && o.reserved) { await db.run("UPDATE orders SET reserved = 0 WHERE id = ?", o.id); await db.run("UPDATE products SET stock = stock + 1 WHERE id = ? AND stock >= 0", o.product_id); }
    });
    await pushOrder(id);
    broadcast("safepay", {}, x => isSuper(x));
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

  /* ---------- seller report and expenses ---------- */
  const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  route("GET", "/api/suuq/seller/report", async (req, res, url) => {
    const u = await needRole(req, "customer"), s = await shopOf(u.id);
    const fromMs = Number(url.searchParams.get("fromMs")), toMs = Number(url.searchParams.get("toMs"));
    const fromDate = url.searchParams.get("fromDate"), toDate = url.searchParams.get("toDate");
    if (!(fromMs >= 0) || !(toMs >= fromMs) || !isYmd(fromDate) || !isYmd(toDate)) fail("Choose a valid date range.");
    if (!s) return send(res, 200, { revenue: [], expenses: [] });
    // Revenue for a seller = what they keep from completed buy orders (price minus affiliate earnings).
    const revenue = await db.all("SELECT completed_at AS at, cur, total - commission AS fee FROM orders WHERE seller_id = ? AND kind = 'buy' AND status = 'completed' AND completed_at BETWEEN ? AND ?", u.id, fromMs, toMs);
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
  async function convRow(c, me) {
    const other = me === c.buyer_id ? c.seller_id : c.buyer_id;
    const o = await db.get("SELECT name FROM users WHERE id = ?", other);
    const last = await db.get("SELECT body, sender_id, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1", c.id);
    const readAt = me === c.buyer_id ? c.buyer_read_at : c.seller_read_at;
    const unread = (await db.get("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id != ? AND created_at > ?", c.id, me, readAt)).n;
    const p = await db.get("SELECT p.name, p.images, p.service, s.name AS shop_name FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ?", c.product_id);
    const img = JSON.parse(p?.images || "[]")[0], ticket = p?.service === "ticket";
    return { id: c.id, product_id: c.product_id, product_name: ticket ? "Ticket enquiry" : p?.name || "Product", image: img ? "/media/" + img : null, kind: ticket ? "ticket" : "product",
      with_name: ticket && me === c.buyer_id ? p.shop_name : o?.name || "Someone", i_am: me === c.buyer_id ? "buyer" : "seller", last, unread, last_at: c.last_at };
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
    const u = await needUser(req), c = await convFor(id, u);
    await db.run(`UPDATE conversations SET ${u.id === c.buyer_id ? "buyer_read_at" : "seller_read_at"} = ? WHERE id = ?`, now(), c.id);
    const msgs = (await db.all("SELECT id, sender_id, body, created_at FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 300", c.id)).reverse();
    send(res, 200, { chat: await convRow(c, u.id), messages: msgs.map(m => ({ ...m, mine: m.sender_id === u.id })) });
  });
  route("POST", "/api/suuq/chats/:id/messages", async (req, res, url, [id]) => {
    const u = await needUser(req), c = await convFor(id, u), b = await readJson(req);
    rateLimit(req, 60, 60000, "chat");
    const body = String(b.body || "").trim().slice(0, 1000);
    if (!body) fail("Write a message first.");
    const t = now();
    const info = await db.run("INSERT INTO messages (conv_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", c.id, u.id, body, t);
    await db.run(`UPDATE conversations SET last_at = ?, ${u.id === c.buyer_id ? "buyer_read_at" : "seller_read_at"} = ? WHERE id = ?`, t, t, c.id);
    const m = { id: Number(info.lastInsertRowid), conv_id: c.id, sender_id: u.id, body, created_at: t };
    // The buyer's first message: the merchant's phone rings so they can answer quickly.
    if (u.id === c.buyer_id && (await db.get("SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND sender_id = ?", c.id, u.id)).n === 1)
      Object.assign(m, { new_chat: true, from_name: u.name, product_name: (await db.get("SELECT name FROM products WHERE id = ?", c.product_id))?.name || "" });
    broadcast("chat", m, x => x.id === c.buyer_id || x.id === c.seller_id);
    if (m.new_chat) pushLater([c.seller_id], { kind: "ring", title: "New chat", body: `${u.name}: ${body.slice(0, 120)}`, goto: "chats", tag: "chat-" + c.id });
    else pushLater([u.id === c.buyer_id ? c.seller_id : c.buyer_id], { kind: "info", title: u.name || "New message", body: body.slice(0, 160), goto: "chats", tag: "chat-" + c.id });
    send(res, 200, { message: { ...m, mine: true } });
  });

  /* ---------- Documents for a service's admins (Saba Multi Services and other video-page services) ---------- */
  // The customer sends one or more pictures, PDF or Word files (passport, photos, letters…) with a note; that service's
  // admins (and the super admin) receive them in the service's dashboard.
  const DOC_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const isDocAdmin = (u, svc) => u && (isSuper(u) || (u.role === "admin" && u.service === svc));
  const docOut = (d, extra = {}) => ({ id: d.id, note: d.note, status: d.status, created_at: d.created_at,
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
    send(res, 200, { docs: rows.map(d => docOut(d, { name: d.name, phone: d.phone })), new: Number(count) || 0 });
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
    const t = await ticketProduct(shop);
    return await db.get(`${PROD_SELECT} WHERE p.id = ?`, t.id);
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
    const shops = await db.all(`SELECT s.*, u.name AS owner_name, u.phone AS owner_phone,
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
    const shops = await db.all(`SELECT s.*, u.name AS owner_name, u.phone AS owner_phone,
        (SELECT COUNT(*) FROM products p WHERE p.shop_id = s.id AND p.deleted = 0 AND p.service != 'ticket') AS products,
        (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id AND o.status = 'completed') AS sales
      FROM shops s JOIN users u ON u.id = s.owner_id ORDER BY s.created_at DESC`);
    const products = await db.all(`${PROD_SELECT} WHERE p.deleted = 0 AND p.service = 'suuq' ORDER BY CASE p.approval WHEN 'pending' THEN 0 ELSE 1 END, p.updated_at DESC LIMIT 300`);
    const orders = await db.all("SELECT status, cur, COUNT(*) AS n, SUM(total) AS total FROM orders GROUP BY status, cur");
    const subs = await db.all("SELECT cur, SUM(amount) AS total FROM wallet_tx WHERE user_id IS NULL AND kind = 'subscription_income' GROUP BY cur");
    send(res, 200, { plans: (await getSettings()).suuq.plans,
      shops: await Promise.all(shops.map(async s => ({ ...await publicShop(s), owner_name: s.owner_name, owner_phone: s.owner_phone, products: s.products, sales: s.sales }))),
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
