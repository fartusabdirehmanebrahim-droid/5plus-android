"use strict";
/* Sarrif web app: customers, agents and admin share one login screen. All data comes from the server API. */

const SERVICES = [
  { id: "zaad", name: "ZAAD", company: "Telesom" },
  { id: "edahab", name: "eDahab", company: "eDahab" },
  { id: "soltelco", name: "Soltelco", company: "Soltelco" },
  { id: "premier", name: "Premier Wallet", company: "Premier Bank" },
];
const CURS = ["USD", "SLSH"];
const LOGO = id => `/logos/${id}.png`;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const svc = id => SERVICES.find(s => s.id === id) || (id === "earnings" ? { id, name: "My earnings", company: "Sarrif earnings" } : { name: id, company: id });
function fmt(n, cur) {
  if (!isFinite(n)) n = 0;
  if (cur === "USD") return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Math.round(n).toLocaleString("en-US") + " SLSH";
}
const timeAgo = t => { const m = Math.round((Date.now() - t) / 60000); if (m < 1) return "just now"; if (m < 60) return m + " min ago"; const h = Math.round(m / 60); if (h < 24) return h + " h ago"; return new Date(t).toLocaleDateString(); };
function msg(id, text, kind) { const el = $(id); if (el) { el.textContent = text; el.className = "status-msg " + (kind || ""); } }
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
  if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  let res;
  try { res = await fetch(path, init); } catch { throw new Error("No connection. Check your internet and try again."); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.user && !path.startsWith("/api/auth")) { S.user = null; S.screen = "login"; S.err = "Please log in again."; render(); }
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}
// Asks for the 4-digit PIN before money moves (the server checks it). Resolves with the PIN, or null if cancelled.
function askPin(title, detail) {
  return new Promise(resolve => {
    const back = document.activeElement, box = document.createElement("div");
    box.className = "pin-ask";
    box.innerHTML = `<div class="pin-card" role="dialog" aria-modal="true" aria-labelledby="pa-t"><b id="pa-t">${esc(title)}</b>${detail ? `<p class="note" style="margin:0">${esc(detail)}</p>` : ""}
      <label for="pa-pin" class="label">Enter your 4-digit PIN</label>
      <input id="pa-pin" class="input pa-pin num" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off">
      <div class="row-actions"><button class="btn btn-ghost" data-pa="no">Cancel</button><button class="btn btn-primary" data-pa="ok" disabled>Confirm</button></div></div>`;
    document.body.appendChild(box);
    const inp = box.querySelector("#pa-pin"), ok = box.querySelector('[data-pa="ok"]');
    const done = v => { box.remove(); try { back && back.focus(); } catch {} resolve(v); };
    inp.oninput = () => { inp.value = inp.value.replace(/\D/g, "").slice(0, 4); ok.disabled = inp.value.length !== 4; };
    inp.onkeydown = e => { if (e.key === "Enter" && inp.value.length === 4) done(inp.value); if (e.key === "Escape") done(null); };
    ok.onclick = () => done(inp.value); box.querySelector('[data-pa="no"]').onclick = () => done(null);
    box.onclick = e => { if (e.target === box) done(null); };
    setTimeout(() => inp.focus(), 30);
  });
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); if (btn) { const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => btn.textContent = o, 1200); } }
  catch { if (btn) btn.textContent = text; }
}

/* ---------- state ---------- */
let settings = { tiers: { USD: [], SLSH: [] }, show: {}, support: {}, voice: {} };
const S = {
  user: null, screen: "welcome", tab: "send",
  q: { cur: "SLSH", from: null, to: null, amount: "", who: "me", toName: "", toPhone: "" },
  login: { phone: "", pin: "" }, signup: { name: "", phone: "", pin: "", pin2: "", wallets: {} },
  ticket: null, err: "", sheet: null, sheetPin: "", last: null, mine: [], busy: false,
};

// Premier Wallet works in USD only.
const curOn = (id, c) => !(id === "premier" && c === "SLSH") && settings.show[id]?.on !== false && settings.show[id]?.[c] !== false;
// USD: the receiver gets at least $100 (settings.minUsd); the smallest amount is that plus the charge.
const minUsd = () => Number(settings.minUsd) || 0;
function minUsdAmount() { let a = minUsd(); for (let i = 0; i < 6; i++) a = Math.round((minUsd() + tierFee(a, "USD")) * 100) / 100; return a; }
const belowMin = () => { const q = S.q, r = quote(); return q.cur === "USD" && minUsd() > 0 && r.amt > 0 && r.get < minUsd(); };
const svcOn = id => CURS.some(c => curOn(id, c));
const activeServices = () => SERVICES.filter(s => svcOn(s.id));
const wallets = () => S.user?.wallets || {};
const myWalletsFor = cur => SERVICES.filter(s => curOn(s.id, cur) && wallets()[s.id]);
// Sending to myself needs two of my wallets in a currency; sending to another person needs one.
const toOther = () => S.q.who === "other";
const usableCurs = () => CURS.filter(c => myWalletsFor(c).length >= (toOther() ? 1 : 2));
const allWalletsFor = cur => SERVICES.filter(s => curOn(s.id, cur));
const otherPhoneOk = () => /^\d{7,12}$/.test(String(S.q.toPhone || "").replace(/\D/g, "").replace(/^252/, "").replace(/^0/, ""));
function tierFee(amt, cur) {
  const rows = settings.tiers[cur] || [];
  for (const r of rows) if (r.upTo == null || amt <= Number(r.upTo)) return Number(r.fee) || 0;
  return rows.length ? Number(rows[rows.length - 1].fee) || 0 : 0;
}
function quote() {
  const q = S.q, amt = parseFloat(q.amount) || 0;
  let fee = amt > 0 ? tierFee(amt, q.cur) : 0; if (q.cur === "SLSH") fee = Math.round(fee);
  let get = Math.max(0, amt - fee); get = q.cur === "SLSH" ? Math.floor(get) : Math.floor(get * 100) / 100;
  return { amt, fee, get };
}
function normalizeQuote() {
  const q = S.q, curs = usableCurs(); if (!curs.length) return;
  if (!curs.includes(q.cur)) q.cur = curs[0];
  const w = myWalletsFor(q.cur).map(s => s.id);
  if (!w.includes(q.from)) q.from = w[0];
  if (toOther()) { const all = allWalletsFor(q.cur).map(s => s.id); if (!all.includes(q.to)) q.to = q.from; return; }
  if (!w.includes(q.to) || q.to === q.from) q.to = w.find(id => id !== q.from);
}

const ICON = {
  play: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  swap: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg>',
  send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14M13 6l6 6-6 6"/></svg>',
  hist: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  me: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="9" r="4"/><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg>',
  tick: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  bell: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  mute: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l1.5 2h-11M10 20a2 2 0 0 0 4 0M3 3l18 18"/></svg>',
  arrow: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14M13 6l6 6-6 6"/></svg>',
  wa: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>',
};

/* ---------- voice guide ---------- */
let audioEl = null, speaking = false;
function stopVoice() { if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; } try { speechSynthesis.cancel(); } catch {} speaking = false; syncVoiceBtn(); }
function syncVoiceBtn() {
  const b = document.getElementById("voice-btn"); if (!b) return;
  b.classList.toggle("playing", speaking);
  b.querySelector(".disc").innerHTML = speaking ? ICON.stop : ICON.play;
  b.querySelector("b").textContent = speaking ? "Playing guide…" : "Listen to the guide";
}
async function playVoice() {
  if (speaking) return stopVoice();
  if (settings.voice.hasAudio) {
    audioEl = audioEl || new Audio();
    audioEl.src = "/voice?v=" + encodeURIComponent(settings.voice.audioVer || "");
    audioEl.onended = () => { speaking = false; syncVoiceBtn(); };
    speaking = true; syncVoiceBtn();
    try { await audioEl.play(); return; } catch { speaking = false; syncVoiceBtn(); }
  }
  try {
    const u = new SpeechSynthesisUtterance(settings.voice.script || "");
    u.lang = settings.voice.lang || "en-US"; u.rate = .95;
    u.onend = u.onerror = () => { speaking = false; syncVoiceBtn(); };
    speaking = true; syncVoiceBtn(); speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { speaking = false; syncVoiceBtn(); }
}

/* ---------- customer & login screens ---------- */
const appEl = $("#app");
function render() {
  if (S.screen !== "welcome" && speaking) stopVoice();
  applyRole();
  if (S.user && S.user.role !== "customer") return;
  if (S.user) normalizeQuote();
  const views = { welcome: vWelcome, login: vLogin, adminpw: vAdminPw, signup: vSignup, merchant: vMerchantSignup, home: vHome };
  appEl.innerHTML = views[S.user ? "home" : S.screen]();
  bind();
}
// Only on the demo page (the real app has no demo logins).
const demoLink = () => window.SarrifDemo?.showLogins ? `<button class="link-btn demo-link" data-demo-logins>Demo logins</button>` : "";
function vWelcome() {
  const act = activeServices();
  return `<div class="view">
    <div class="welcome-top">${langButton()}</div>
    <img class="welcome-logo" src="/logos/5plus.png" alt="5PLUS · Hal meel ka adeego">
    <div style="flex:1"></div>
    <button class="btn btn-primary btn-block" data-go="login">Log in</button>
    <button class="btn btn-ghost btn-block" data-go="signup">Create customer account</button>
    <button class="btn btn-merchant btn-block" data-go="merchant">${SUUQ_ICONS.shop}Register as merchant</button>
    ${demoLink()}
  </div>`;
}
// PIN is typed in a normal field (hidden digits, number keyboard on phones).
const pinInput = (id, value, auto = "current-password", placeholder = "4-digit PIN") =>
  `<input class="input pin-input" id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="${auto}" placeholder="${placeholder}" value="${esc(value || "")}">`;
const EASY_PINS = ["1234", "1111", "0000"]; // not allowed for a new PIN (the server checks too)
function pinOn(id, set, onChange, onEnter) {
  const el = document.getElementById(id); if (!el) return;
  el.oninput = () => { const v = el.value.replace(/\D/g, "").slice(0, 4); if (v !== el.value) el.value = v; set(v); if (onChange) onChange(v); };
  el.onkeydown = e => { if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); } };
}
const pinDots = n => `<div class="pin-dots" aria-hidden="true">${[0, 1, 2, 3].map(i => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</div>`;
const pad = id => `<div class="pad" id="${id}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => `<button data-k="${d}">${d}</button>`).join("")}
  <button class="muted" data-k="clear">Clear</button><button data-k="0">0</button><button class="muted" data-k="del" aria-label="Delete">⌫</button></div>`;
function vLogin() {
  return `<div class="view">
    <button class="back" data-go="welcome" aria-label="Back">${ICON.back}</button>
    <div><h2 style="font-size:24px">Log in</h2><p class="note" style="margin:4px 0 0">Use your phone number and PIN.</p></div>
    <div class="field"><label for="l-phone">Phone number</label>
      <div class="phone-input"><span>+252</span><input id="l-phone" inputmode="tel" autocomplete="tel" placeholder="63 4123456" value="${esc(S.login.phone)}"></div></div>
    <div class="field"><label for="l-pin">PIN</label>${pinInput("l-pin", S.login.pin)}</div>
    <div class="err" role="alert">${esc(S.err)}</div>
    <button class="btn btn-primary btn-block" id="do-login" ${S.login.pin.length === 4 && !S.busy ? "" : "disabled"}>Log in</button>
    <button class="btn-link" data-go="signup">No account yet? Create one</button>
    ${demoLink()}
  </div>`;
}
function vAdminPw() {
  return `<div class="view">
    <button class="back" data-go="login" aria-label="Back">${ICON.back}</button>
    <div><h2 style="font-size:24px">Admin password</h2><p class="note" style="margin:4px 0 0">Admins need their password as well as their PIN.</p></div>
    <div class="field"><label for="a-pw">Password</label><input class="input" id="a-pw" type="password" autocomplete="current-password"></div>
    <div class="err" role="alert">${esc(S.err)}</div>
    <button class="btn btn-primary btn-block" id="do-adminpw">Log in as admin</button>
  </div>`;
}
/* ---------- Face photo at registration: private, only the 5PLUS administration sees it ---------- */
const FACE_ICON = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="9" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
const CAM_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-inline-end:6px;vertical-align:-3px"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const LOCK_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
// account: the person already has an account (Account page); otherwise it is part of a registration form.
function faceField(account) {
  const f = account ? "" : S.face, has = account && S.user?.has_face;
  return `<div class="field face-field"><label>Photo of your face</label>
    <div class="face-box">
      <div class="face-pv">${f ? `<img src="${f}" alt="Your face photo">` : has ? `<span class="face-ok">✓</span>` : FACE_ICON}</div>
      <div class="face-t">
        ${has ? `<small><b>Your face photo is saved.</b></small>` : ""}
        <div class="face-acts"><label class="btn btn-ghost">${CAM_ICON}${f || has ? "Take a new photo" : "Take photo"}<input type="file" accept="image/*" capture="user" data-face="${account ? "account" : "form"}" hidden></label></div>
        <span class="status-msg" id="st-face" role="status"></span>
      </div></div></div>`;
}
// Android may close the app while the camera is open (phones with little memory). Before the camera opens, the
// registration filled in so far is saved on the phone (never the PIN); when the app starts again it opens the same
// form and the photo the app kept is put in (SarrifAndroid.pendingPhoto).
const REG_KEY = "sarrif.regDraft";
function saveRegDraft(kind) {
  try {
    if (kind === "account") { localStorage.setItem(REG_KEY, JSON.stringify({ kind, at: Date.now() })); return; }
    if (S.screen !== "signup" && S.screen !== "merchant") return;
    if (S.screen === "merchant") SUUQ.keepPf();
    const { name, phone, wallets } = S.signup;
    localStorage.setItem(REG_KEY, JSON.stringify({ kind: S.screen, at: Date.now(), signup: { name, phone, wallets }, step: S.merchant?.step || 1,
      pf: S.screen === "merchant" ? SUUQ.pfDraft() : null, face: S.face || null }));
  } catch {}
}
const clearRegDraft = () => { try { localStorage.removeItem(REG_KEY); } catch {} };
function readRegDraft() { try { const d = JSON.parse(localStorage.getItem(REG_KEY) || "null"); return d && Date.now() - d.at < 2 * 3600e3 ? d : null; } catch { return null; } }
async function cameraPhoto() {
  let data = ""; try { data = window.SarrifAndroid?.pendingPhoto?.() || ""; } catch {}
  return data ? await compressImage(await (await fetch(data)).blob(), 300_000) : "";
}
// After the app was closed and opened again: back to the registration (or the Account page) with the photo.
async function resumeAfterCamera() {
  const d = readRegDraft(), photo = await cameraPhoto().catch(() => "");
  if (!d) return;
  if (d.kind === "account") {
    clearRegDraft();
    if (S.user && photo) { try { const r = await api("/api/me/face", { body: { image: photo } }); S.user = r.user; } catch {} }
    return;
  }
  if (S.user) { clearRegDraft(); return; }
  S.signup = { ...S.signup, ...(d.signup || {}), wallets: { ...(d.signup?.wallets || {}) } };
  if (d.kind === "merchant") { S.merchant = { pin: "", pin2: "", step: d.step || 1 }; if (d.pf) SUUQ.setPf(d.pf); }
  S.face = photo || d.face || null; S.err = ""; S.screen = d.kind;
  saveRegDraft();
}
window.__cameraPhoto = async () => { const p = await cameraPhoto().catch(() => ""); if (p && !S.user && (S.screen === "signup" || S.screen === "merchant")) { S.face = p; saveRegDraft(); render(); } };
function bindFace() {
  document.querySelectorAll("[data-face]").forEach(i => {
    i.onclick = () => saveRegDraft(i.dataset.face === "account" ? "account" : undefined);
    i.onchange = async () => {
      const f = i.files[0]; if (!f) return;
      try {
        const url = await compressImage(f, 300_000);
        if (i.dataset.face === "account") { clearRegDraft(); msg("#st-face", "Saving…"); const r = await api("/api/me/face", { body: { image: url } }); S.user = r.user; render(); msg("#st-face", "Saved. Thank you.", "ok"); }
        else { if (S.screen === "merchant") SUUQ.keepPf(); S.face = url; S.err = ""; saveRegDraft(); render(); }
      } catch (e) { msg("#st-face", e.message || "That photo could not be used.", "bad"); }
    };
  });
}
function walletFields(prefix, vals, list) {
  return `<div class="wallet-nums">${list.map(s => `<label class="wnum" for="${prefix}-${s.id}"><img src="${LOGO(s.id)}" alt=""><span>${esc(s.company)}</span><input id="${prefix}-${s.id}" data-w="${s.id}" inputmode="tel" placeholder="${esc(s.name)} number" value="${esc(vals[s.id] || "")}"></label>`).join("")}</div>`;
}
// Merchant (seller) registration from the first screen, in four steps: about you, business, numbers, PIN.
const M_STEPS = () => [...SUUQ.PF_STEPS, "PIN and check"];
function vMerchantSignup() {
  if (!SUUQ.state.countries) { SUUQ.loadCountries().then(() => { if (S.screen === "merchant" && !S.user) render(); }); }
  const m = S.merchant || (S.merchant = { pin: "", pin2: "", step: 1 });
  const steps = M_STEPS(), n = steps.length, k = m.step, last = k === n;
  const d = SUUQ.pfDraft(), dash = v => v ? esc(v) : "—";
  const review = [
    [1, [["Full name", d.full_name], ["Birth date", SarrifDate.disp(d.birth_date)], ["Country", d.country], ["City", d.city]]],
    [2, [[d.kind === "company" ? "Company" : "Shop", d.business_name], ["Address", d.address]]],
    [3, [["Phone", d.phone], ["ZAAD merchant", d.zaad_merchant], ["eDahab merchant", d.edahab_merchant], ["Shop number", d.shop_phone]]],
  ];
  return `<div class="view">
    <button class="back" id="m-back" aria-label="${k > 1 ? "Previous step" : "Back"}">${ICON.back}</button>
    <div><span class="label">Merchant account</span><h2 style="font-size:24px">Merchant registration</h2>${k === 1 ? `<p class="note" style="margin:4px 0 0">For shops and companies that sell in Suuq. Your first month is free, and your wallet is created when you register.</p>` : ""}</div>
    <div class="steps" aria-label="Step ${k} of ${n}">
      <div class="steps-bar">${steps.map((_, i) => `<i class="${i + 1 < k ? "done" : i + 1 === k ? "on" : ""}"></i>`).join("")}</div>
      <div class="steps-txt"><span class="label">Step ${k} of ${n}</span><b>${esc(steps[k - 1])}</b></div>
    </div>
    ${last ? `<div class="m-review">${review.map(([s, rows]) => `<div class="m-rev"><div class="m-rev-h"><b>${esc(steps[s - 1])}</b><button class="btn-link" data-mstep="${s}">Edit</button></div>
        ${rows.map(([l, v]) => `<div class="m-rev-r"><span>${l}</span><b>${dash(v)}</b></div>`).join("")}</div>`).join("")}</div>
      <div class="field"><label for="m-pin">Choose a 4-digit PIN</label>${pinInput("m-pin", m.pin, "new-password")}</div>
      <div class="field"><label for="m-pin2">Enter the PIN again</label>${pinInput("m-pin2", m.pin2, "new-password", "Same PIN again")}</div>`
      : SUUQ.profileForm(true, k) + (k === 1 ? faceField() : "")}
    <div class="err" role="alert" id="m-err">${esc(S.err)}</div>
    <div class="m-nav">
      ${k > 1 ? `<button class="btn btn-ghost" id="m-prev">Back</button>` : ""}
      <button class="btn btn-primary" id="${last ? "do-merchant" : "m-next"}">${last ? "Register as merchant" : "Next"}</button>
    </div>
    <button class="btn-link" data-go="login">Already registered? Log in</button>
  </div>`;
}
function merchantStep(to) {
  const m = S.merchant; SUUQ.keepPf();
  if (to > m.step) { const e = SUUQ.pfCheck(m.step) || (m.step === 1 && !S.face ? "Please take a photo of your face. Thank you." : ""); if (e) { S.err = e; render(); return; } }
  S.err = ""; m.step = to; render();
  const v = document.querySelector("#app .view"); if (v) v.scrollTop = 0; window.scrollTo(0, 0);
  const first = document.querySelector("#app input:not([type=hidden]), #app select"); if (first && to < M_STEPS().length) first.focus();
}
async function doMerchantSignup() {
  const m = S.merchant; SUUQ.keepPf();
  const fail = t => { S.err = t; render(); const e = document.getElementById("m-err"); if (e) e.scrollIntoView({ block: "center" }); };
  // Send the person back to any step that still has a problem.
  for (let s = 1; s < M_STEPS().length; s++) { const e = SUUQ.pfCheck(s); if (e) { m.step = s; return fail(e); } }
  if (!S.face) { m.step = 1; return fail("Please take a photo of your face. Thank you."); }
  if (m.pin.length !== 4 || m.pin !== m.pin2) return fail("Enter the same 4-digit PIN in both PIN fields.");
  if (EASY_PINS.includes(m.pin)) { m.pin = ""; m.pin2 = ""; return fail("1234, 1111 and 0000 are too easy to guess. Choose another PIN."); }
  const b = document.getElementById("do-merchant"); if (b) b.disabled = true;
  try {
    const r = await api("/api/auth/signup-merchant", { body: { profile: SUUQ.pfDraft(), pin: m.pin, face: S.face } });
    S.merchant = null; S.face = null; SUUQ.resetPf(); clearRegDraft(); await loggedIn(r.user); S.service = "suuq"; SUUQ.state.tab = "sell"; await SUUQ.open("suuq");
  } catch (e) { m.pin = ""; m.pin2 = ""; fail(e.message); }
}
function vSignup() {
  const s = S.signup;
  return `<div class="view">
    <button class="back" data-go="welcome" aria-label="Back">${ICON.back}</button>
    <div><h2 style="font-size:24px">Create account</h2><p class="note" style="margin:4px 0 0">Pick a 4-digit PIN. You'll use it to log in and confirm every transfer.</p></div>
    <div class="field"><label for="s-name">Full name</label><input class="input" id="s-name" autocomplete="name" placeholder="Hodan Ahmed" value="${esc(s.name)}"></div>
    <div class="field"><label for="s-phone">Phone number</label>
      <div class="phone-input"><span>+252</span><input id="s-phone" inputmode="tel" autocomplete="tel" placeholder="63 4123456" value="${esc(s.phone)}"></div></div>
    <div class="field"><label>Your wallet numbers</label>${walletFields("sw", s.wallets, activeServices())}<span class="note">Enter these once. Add every wallet you use (at least two) so you can send between them.</span></div>
    ${faceField()}
    <div class="field"><label for="s-pin">Choose a 4-digit PIN</label>${pinInput("s-pin", s.pin, "new-password")}</div>
    <div class="field"><label for="s-pin2">Enter the PIN again</label>${pinInput("s-pin2", s.pin2, "new-password", "Same PIN again")}</div>
    <div class="err" role="alert">${esc(S.err)}</div>
    <button class="btn btn-primary btn-block" id="do-signup" ${s.pin.length === 4 && s.pin2.length === 4 && !S.busy ? "" : "disabled"}>Create account</button>
  </div>`;
}

const ART = (k, photo) => window.SarrifArt ? window.SarrifArt.art(k, photo) : "";
// A service with videos is open: its page shows the videos.
const hubServices = () => (settings.services || []).map(x => x.id === "ticket" || x.id === "scholarship" || (x.videos || []).length || (x.gallery || []).length ? { ...x, ready: true } : x);
const SUUQ_ICONS = {
  wallet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></svg>',
  shop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 11z"/><path d="M5 13.5V20h14v-6.5M10 20v-4h4v4"/></svg>',
  aff: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.7l6.8-3.4M8.6 13.3l6.8 3.4"/></svg>',
};
const MENU_ICONS = {
  phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  user: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && S.drawer) { S.drawer = false; render(); const m = document.querySelector(".menu-btn"); if (m) m.focus(); } });
// Side menu on the services page: Affiliate, Account and support (and My shop for merchants). Opens and hides.
/* ---------- language ---------- */
// The language screen: on first launch, and whenever someone taps "Language". It covers every screen (customers and staff).
const I18N = window.SarrifI18n;
function langButton(cls = "") {
  if (!I18N) return "";
  const L = I18N.LANGS.find(l => l.code === I18N.lang) || I18N.LANGS[2];
  return `<button type="button" class="lang-btn ${cls}" data-lang-open aria-label="Language"><span class="flag">${I18N.flag(L.code)}</span><span>${esc(L.name)}</span></button>`;
}
function showLanguages() {
  if (!I18N || document.getElementById("lang-screen")) return;
  const el = document.createElement("div");
  el.id = "lang-screen"; el.className = "lang-screen"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Choose your language");
  el.setAttribute("data-no-i18n", "");
  el.innerHTML = `<div class="lang-box">
    <img class="lang-logo" src="/logos/5plus.png" alt="5PLUS">
    <h2>Dooro luqadda · اختر اللغة · Choose your language</h2>
    <p>ቋንቋ ይምረጡ · Choisissez votre langue</p>
    <div class="lang-list">${I18N.LANGS.map(l => `<button type="button" class="lang-choice" data-lang="${l.code}" dir="${l.dir}" aria-pressed="${I18N.lang === l.code}"><span class="flag">${I18N.flag(l.code)}</span><b>${esc(l.name)}</b></button>`).join("")}</div>
  </div>`;
  const firstRun = !I18N.lang;
  el.querySelectorAll("[data-lang]").forEach(b => b.onclick = () => {
    I18N.set(b.dataset.lang);
    el.remove(); S.drawer = false;
    render(); applyRole();
    if (firstRun) showEarnIntro();
  });
  document.body.appendChild(el);
  (el.querySelector('[aria-pressed="true"]') || el.querySelector("[data-lang]")).focus();
}
document.addEventListener("click", e => { if (e.target.closest && e.target.closest("[data-lang-open]")) showLanguages(); });
/* First launch, after the language: everyone earns from what they buy and from people who use their link.
   They choose the amount they want to withdraw at; it is saved to their account when they log in. */
const WITHDRAW_KEY = "sarrif.withdrawAt";
function showEarnIntro() {
  if (document.getElementById("earn-intro")) return;
  const el = document.createElement("div");
  el.id = "earn-intro"; el.className = "lang-screen earn-intro"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Earn with every purchase");
  // One screen, set once: an amount for dollars and an amount for shillings. Each is withdrawn on its own.
  const OPTS = { USD: [50, 80, 150, 300, 500], SLSH: [500000, 800000, 1500000, 3000000, 5000000] };
  const pick = { USD: 50, SLSH: 500000 };
  const label = (v, c) => c === "USD" ? "$" + v : (v >= 1000000 ? v / 1000000 + "M" : v / 1000 + "k");
  const draw = () => {
    el.innerHTML = `<div class="lang-box">
      <span class="earn-badge" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5M12 6v1.5M12 16.5V18"/></svg></span>
      <h2>Earn with every purchase</h2>
      <p>You get money every time you buy something and every time someone else buys through your link.</p>
      <p>Your earnings collect in your account. At what amount would you like to move them to your wallet?</p>
      ${["USD", "SLSH"].map(c => `<div class="earn-cur"><span class="cur cur-${c}">${c}</span>
        <div class="earn-chips" role="radiogroup" aria-label="${c} withdraw amount">${OPTS[c].map(v => `<button type="button" role="radio" data-earnpick="${v}" data-earncur="${c}" aria-checked="${pick[c] === v}"><span class="num">${label(v, c)}</span></button>`).join("")}</div></div>`).join("")}
      <p class="note" style="margin:0">Dollars and shillings are withdrawn separately. You can change these later on the Affiliate page.</p>
      <button type="button" class="btn btn-primary btn-block" id="earn-go">Continue</button>
      <button type="button" class="link-btn" id="earn-skip">Later</button></div>`;
    el.querySelectorAll("[data-earnpick]").forEach(b => b.onclick = () => { pick[b.dataset.earncur] = Number(b.dataset.earnpick); draw(); });
    el.querySelector("#earn-go").onclick = () => { saveWithdrawAt(pick); el.remove(); };
    el.querySelector("#earn-skip").onclick = () => el.remove();
  };
  draw(); document.body.appendChild(el);
}
function saveWithdrawAt(w) {
  try { localStorage.setItem(WITHDRAW_KEY, JSON.stringify({ USD: w.USD, SLSH: w.SLSH })); } catch {}
  syncWithdrawAt();
}
async function syncWithdrawAt() {
  if (!S.user) return;
  let w = null; try { w = JSON.parse(localStorage.getItem(WITHDRAW_KEY) || "null"); } catch {}
  if (!w) return;
  try { await api("/api/earnings/limit", { method: "PUT", body: w }); localStorage.removeItem(WITHDRAW_KEY); } catch {}
}
// My earnings on the home screen: what has collected, what is on the way, and the amount I withdraw at.
function earnRow(w) {
  const e = w.earnings, p = w.earn_pending || {}, lim = w.withdraw_at || {};
  const has = c => (e[c] || 0) > 0 || (p[c] || 0) > 0;
  const cs = ["USD", "SLSH"].filter(has); if (!cs.length) cs.push("USD");
  const ready = cs.some(c => (e[c] || 0) > 0 && (e[c] || 0) >= (lim[c] || 0));
  return `<button class="wt-earn" data-svcgo="affiliate"><span class="wt-earn-ic" aria-hidden="true">★</span>
    <span class="wt-earn-t"><small>My earnings</small><b class="num">${cs.map(c => fmt(e[c] || 0, c)).join(" · ")}</b>
      <small>${cs.some(c => (p[c] || 0) > 0) ? `On the way ${cs.filter(c => (p[c] || 0) > 0).map(c => fmt(p[c], c)).join(" · ")} · ` : ""}${lim.USD || lim.SLSH ? `Withdraw at ${["USD", "SLSH"].filter(c => lim[c]).map(c => fmt(lim[c], c)).join(" · ")}` : "Earn on every purchase"}</small></span>
    <span class="wt-go">${ready ? "Withdraw ›" : "›"}</span></button>`;
}
// Salah time and Sleep time: a seller pauses new orders until they turn it off again.
const PAUSE_ICONS = {
  salah: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v2"/><path d="M6 21v-7a6 6 0 0 1 12 0v7"/><path d="M3 21h18"/><path d="M10 21v-3a2 2 0 0 1 4 0v3"/><path d="M12 8a6 6 0 0 0-1.2.12"/></svg>',
  sleep: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="M15 4h3l-3 4h3"/></svg>',
};
const PAUSE_TEXT = {
  salah: { name: "Salah time", mode: "Salah time mode", off: "Stop new orders while you pray", on: "On · you're not receiving orders" },
  sleep: { name: "Sleep time", mode: "Night sleep mode", off: "Stop new orders for the night", on: "On · you're not receiving orders" },
};
const canPause = () => S.user && S.user.account_type === "merchant";
function pauseBanner() {
  const m = S.user && S.user.pause; if (!m || !PAUSE_TEXT[m]) return "";
  return `<div class="pause-banner ${m}" role="status"><span class="pb-ic">${PAUSE_ICONS[m]}</span>
    <span class="pb-t"><b>${PAUSE_TEXT[m].mode}</b><small>You're not receiving orders. Customers see that you're ${m === "salah" ? "at prayer" : "closed for the night"} and can still chat with you.</small></span>
    <button class="btn btn-ghost" data-pause-off>Turn off</button></div>`;
}
async function setPause(mode) {
  try { const r = await api("/api/me/pause", { body: { mode } }); S.user.pause = r.pause; }
  catch (e) { alert(e.message); }
  render();
}
// Calls: a seller stops incoming internet calls for a while (customers then see "Not taking calls").
const callsOff = () => { const v = Number(S.user?.calls_off_until) || 0; return v === -1 || v > Date.now() ? v : 0; };
function callsMenu() {
  const off = callsOff(), open = S.callsMenu;
  return `<button class="drawer-item" data-callsmenu aria-expanded="${!!open}"><span class="hm-ic ${off ? "calls-off" : "calls"}">${MENU_ICONS.phone}</span><span class="pi-t"><b>Calls</b><small>${off ? SUUQ.callsOffText(off, false) : "Taking calls"}</small></span><span aria-hidden="true">${open ? "▴" : "▾"}</span></button>
    ${open ? `<div class="calls-menu" role="group" aria-label="Pause calls">
      <span class="note">Stop customers calling you for:</span>
      <div class="cm-opts">${[[1, "1 hour"], [5, "5 hours"], [10, "10 hours"]].map(([h, l]) => `<button class="btn btn-ghost" data-calloff-h="${h}">${l}</button>`).join("")}<button class="btn btn-ghost" data-calloff-forever>Until I turn them on</button></div>
      <div class="cm-days"><input class="input" id="calloff-days" type="number" min="1" max="365" inputmode="numeric" placeholder="Days" aria-label="Number of days"><button class="btn btn-ghost" data-calloff-days>Pause for these days</button></div>
      ${off ? `<button class="btn btn-primary btn-block" data-calloff-clear>Take calls again</button>` : ""}
      <span class="status-msg" id="st-calloff" role="status"></span></div>` : ""}`;
}
async function setCallsOff(body) {
  try { const r = await api("/api/me/calls-off", { body }); S.user.calls_off_until = r.calls_off_until; S.callsMenu = false; render(); }
  catch (e) { msg("#st-calloff", e.message, "bad"); }
}
function vDrawer() {
  if (!S.drawer) return "";
  const item = (go, icon, cls, title, sub) => `<button class="drawer-item" data-svcgo="${go}"><span class="hm-ic ${cls}">${icon}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
  return `<div class="drawer" id="drawer">
    <div class="drawer-bg" data-drawer="close"></div>
    <nav class="drawer-panel" aria-label="Menu">
      <div class="drawer-head"><div><span class="label">Salaan</span><b>Hi ${esc((S.user.name || "").split(" ")[0])}</b><small class="num">+252 ${esc(S.user.phone)}</small></div>
        <button class="icon-btn" data-drawer="close" aria-label="Hide menu">${MENU_ICONS.close}</button></div>
      ${S.user.account_type === "merchant" ? item("myshop", SUUQ_ICONS.shop, "shop", "My shop", "Products, orders and report") : ""}
      ${item("affiliate", SUUQ_ICONS.aff, "aff", "Affiliate", "Share products and earn")}
      ${item("account", MENU_ICONS.user, "", "Account and support", "Your details, PIN and WhatsApp help")}
      ${canPause() ? callsMenu() : ""}
      ${canPause() ? ["salah", "sleep"].map(m => `<label class="drawer-item pause-item"><span class="hm-ic ${m}">${PAUSE_ICONS[m]}</span><span class="pi-t"><b>${PAUSE_TEXT[m].name}</b><small>${S.user.pause === m ? PAUSE_TEXT[m].on : PAUSE_TEXT[m].off}</small></span>
        <span class="switch"><input type="checkbox" role="switch" data-pause="${m}" aria-label="${PAUSE_TEXT[m].name}" ${S.user.pause === m ? "checked" : ""}><span></span></span></label>`).join("") : ""}
      ${I18N ? `<button class="drawer-item" data-lang-open><span class="hm-ic flag-ic">${I18N.flag(I18N.lang || "en")}</span><span><b>Language</b><small>${esc((I18N.LANGS.find(l => l.code === I18N.lang) || I18N.LANGS[2]).name)}</small></span></button>` : ""}
    </nav></div>`;
}
// The wallet card on the services page can be hidden to save space; the choice is remembered on this phone.
// The wallet on the home screen is always hidden; it shows only after pressing Show, and hides again on leaving home.
let walletShown = false;
const walletHidden = () => !walletShown;
// Search on the services page: shop number, shop or company name, merchant name, product name or service name.
// One service tile, the same on "Choose a service" and in search results.
const hubTile = h => `<button class="hub-tile ${h.ready ? "is-ready" : ""}" data-svcgo="${esc(h.id)}">
      <span class="hub-art">${(h.gallery || []).length ? slideShow(h.gallery) : ART(h.art, h.photo)}${window.SarrifArt ? SarrifArt.icon(h.art) : ""}</span>
      <span class="hub-body"><b>${esc(h.name)}</b><small>${esc(h.sub)}</small></span></button>`;
// Services match by name or description, in English or in the chosen language, as soon as the person types.
function hubServiceMatches(q) {
  const k = q.trim().toLowerCase(); if (!k) return [];
  const tr = x => window.SarrifI18n ? SarrifI18n.t(x || "") : x || "";
  const hasPage = h => (h.videos || []).length || (h.gallery || []).length;
  return hubServices().filter(h => [h.name, h.sub, tr(h.name), tr(h.sub), h.id].some(x => String(x || "").toLowerCase().includes(k))
    || (hasPage(h) && ["tracking", tr("Tracking").toLowerCase(), "video"].some(w => w.startsWith(k) && k.length > 2)));
}
function hubResults() {
  const r = S.hubRes, q = (S.hubQ || "").trim();
  if (!q) return "";
  const svcs = hubServiceMatches(q);
  const svcPart = svcs.length ? `<h3 class="res-h">Services</h3><div class="hub-grid">${svcs.map(hubTile).join("")}</div>` : "";
  if (!r) return svcPart + `<div class="empty">Searching…</div>`;
  const shopLine = s => `${s.kind === "company" ? "Company" : "Shop"} no. <span class="num">${esc(s.shop_no)}</span>${s.owner_name ? " · " + esc(s.owner_name) : ""}${s.city ? " · " + esc(s.city) : ""} · ${s.product_count} product${s.product_count === 1 ? "" : "s"}`;
  const parts = svcPart ? [svcPart] : [];
  if (r.shops.length) parts.push(`<h3 class="res-h">Shops</h3><div class="res-list">${r.shops.map(s => `<button class="res-row" data-openshop="${s.id}"><span class="hm-ic shop">${SUUQ_ICONS.shop}</span><span><b>${esc(s.name)}</b><small>${shopLine(s)}</small></span></button>`).join("")}</div>`);
  if (r.products.length) parts.push(`<h3 class="res-h">Products</h3><div class="pgrid">${r.products.map(p => SUUQ.productCard(p)).join("")}</div>`);
  return parts.join("") || `<div class="empty">Nothing found for “${esc(q)}”. Try a shop number like 1001, a shop name or a product.</div>`;
}
function openService(v) {
  if (v !== "hub") walletShown = false;
  S.drawer = false; S.footChats = false; S.service = v === "hub" ? null : v; S.tab = "send"; S.sheet = null; S.ytTab = "videos"; S.trk = null;
  if (S.svcItems) delete S.svcItems[v]; // fresh availability each time
  if (v === "technician") S.tech = { view: null, q: "" };
  if (v === "ibedel") { loadMine(); SUUQ.loadWallet().then(() => { if (S.service === "ibedel") render(); }); }
  if (v === "ticket") S.ticket = { list: null, q: "", open: null };
  if (v === "technician") S.techMk = undefined;
  if (v === "myshop") { S.service = "suuq"; SUUQ.state.tab = "sell"; return SUUQ.open("suuq"); }
  if (["suuq", "visa", "scholarship", "wallet", "affiliate"].includes(v)) return SUUQ.open(v);
  if (v === "hub") SUUQ.loadWallet().then(render);
  render();
  scrollTo(0, 0); // each service opens at its top
}
let hubTimer = null;
function bindHubSearch() {
  const i = document.getElementById("hub-q"); if (!i) return;
  const show = () => {
    const box = document.getElementById("hub-results"), main = document.getElementById("hub-main"); if (!box) return;
    box.hidden = !S.hubQ; main.hidden = !!S.hubQ; box.innerHTML = hubResults(); bindHubResults(box);
  };
  i.oninput = () => {
    S.hubQ = i.value; S.hubRes = null; show(); clearTimeout(hubTimer);
    if (!S.hubQ.trim()) return;
    const q = S.hubQ;
    hubTimer = setTimeout(async () => { try { const r = await api("/api/search?q=" + encodeURIComponent(q)); if (S.hubQ === q) { S.hubRes = r; show(); } } catch {} }, 250);
  };
  i.onkeydown = e => { if (e.key === "Escape") { i.value = ""; i.oninput(); } };
  bindHubResults(document.getElementById("hub-results"));
}
function bindHubResults(box) {
  if (!box) return;
  box.querySelectorAll("[data-svcgo]").forEach(b => b.onclick = () => openService(b.dataset.svcgo));
  SUUQ.bindTikTok(box);
  box.querySelectorAll("[data-openshop]").forEach(b => b.onclick = async () => { S.service = "suuq"; SUUQ.state.fromHub = true; await SUUQ.openShop(Number(b.dataset.openshop)); });
  box.querySelectorAll("[data-prod]").forEach(b => b.onclick = async () => {
    const p = (S.hubRes?.products || []).find(x => x.id === b.dataset.prod), m = (p?.service || "suuq");
    S.service = m; await SUUQ.open(m, { product: b.dataset.prod, fromHub: true });
  });
}
function vHub() {
  const first = (S.user.name || "").split(" ")[0], list = hubServices(), w = SUUQ.state.wallet;
  return `<div class="view">
    <div class="hello"><label class="hub-search"><span aria-hidden="true">${MENU_ICONS.search}</span><input id="hub-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="Shop no., shop, merchant, product, service" aria-label="Search shop number, shop, company, merchant, product or service" value="${esc(S.hubQ || "")}"></label>
      <button class="avatar" data-svcgo="account" aria-label="Account and support" style="border:0">${esc((first[0] || "?").toUpperCase())}</button>
      <button class="icon-btn menu-btn" data-drawer="open" aria-label="Open menu" aria-expanded="${!!S.drawer}">${MENU_ICONS.menu}</button></div>
    <div id="hub-results" ${S.hubQ ? "" : "hidden"}>${hubResults()}</div>
    <div id="hub-main" ${S.hubQ ? "hidden" : ""}>
    ${walletHidden() ? `<div class="wallet-top is-hidden">
        <button class="wt-open" data-svcgo="wallet"><span class="hm-ic">${SUUQ_ICONS.wallet}</span><b>Wallet</b></button>
        <button class="wt-topup" data-svcgo="wallet">+ Top up</button>
        <span class="wt-end"><button class="wt-toggle" data-wtoggle aria-expanded="false" aria-label="Show wallet">Show ▾</button></span></div>`
      : `<div class="wallet-top">
        <div class="wt-head"><button class="wt-open" data-svcgo="wallet"><span class="hm-ic">${SUUQ_ICONS.wallet}</span><b>Wallet</b><span class="wt-go">Top up ›</span></button>
          <button class="wt-toggle" data-wtoggle aria-expanded="true" aria-label="Hide wallet">Hide ▴</button></div>
        <button class="wt-bal" data-svcgo="wallet" aria-label="Open wallet"><span><small>US Dollar</small><b class="num">${w ? fmt(w.balances.USD, "USD") : "—"}</b></span><span><small>Shilling</small><b class="num">${w ? fmt(w.balances.SLSH, "SLSH") : "—"}</b></span></button>
        ${w && w.earnings ? earnRow(w) : ""}</div>`}
    ${S.user.account_type === "merchant" ? `<button class="merchant-card" data-svcgo="myshop"><span class="hm-ic">${SUUQ_ICONS.shop}</span><span><span class="label">Merchant</span><b>My shop dashboard</b><small>Products, orders, sales report and subscription</small></span><span aria-hidden="true">›</span></button>` : ""}
    <h3 style="font-size:17px">Choose a service</h3>
    ${list.length ? `<div class="hub-grid">${list.map((h, i) => hubTile(h) + (i === Math.min(1, list.length - 1) ? pauseBanner() : "")).join("")}</div>`
      : `<div class="empty">No services are open right now. Please check again later.</div>`}
    ${(settings.homeCats || []).length ? `<h3 style="font-size:17px">Shop by category</h3><div class="hub-grid">${settings.homeCats.map(SUUQ.catTile).join("")}</div>` : ""}
    </div>
  </div>${vDrawer()}`;
}
/* ---------- Ticket: travel agencies ---------- */
// A list of travel agencies: logo, name and city. "More" shows the address; "Chat" opens a private chat in the app.
async function loadAgencies() {
  try { S.ticket.list = (await api("/api/ticket/agencies")).agencies; } catch (e) { S.ticket.list = []; S.ticket.err = e.message; }
  if (S.service === "ticket") render();
}
/* ---------- Documents tab (Saba Multi Services and other video-page services) ---------- */
// The customer picks one or more pictures, PDF or Word files, adds a note and sends them; the service's admins receive them.
const DOC_ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,.pdf,application/pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const kb = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const docKind = name => /\.pdf$/i.test(name) ? "PDF" : /\.docx?$/i.test(name) ? "Word" : "Picture";
function docsCard(h) {
  const D = S.docs && S.docs.svc === h.id ? S.docs : (S.docs = { svc: h.id, files: [], note: "", msg: "", ok: false, mine: null, busy: false });
  if (D.mine === null) { D.mine = []; api(`/api/services/${encodeURIComponent(h.id)}/docs`).then(r => { D.mine = r.docs; if (S.service === h.id) render(); }).catch(() => {}); }
  return `<div class="docs-card">
    <h2 style="font-size:20px;margin:0">Send documents</h2>
    <p class="note" style="margin:0">Send your papers, photos, invoices or letters to ${esc(h.name)}: pictures, PDF or Word, one or many.</p>
    <label class="btn btn-ghost btn-block doc-pick">${DOC_ICON}Choose files<input type="file" id="doc-files" accept="${DOC_ACCEPT}" multiple hidden></label>
    ${D.files.length ? `<div class="doc-list">${D.files.map((f, i) => `<div class="doc-item">${f.data.startsWith("data:image/") ? `<img src="${esc(f.data)}" alt="">` : `<span class="doc-ic">${DOC_ICON}</span>`}
      <span class="doc-t"><b>${esc(f.name)}</b><small>${docKind(f.name)} · ${kb(f.size)}</small></span><button class="icon-btn" data-docrm="${i}" aria-label="Remove ${esc(f.name)}">✕</button></div>`).join("")}</div>` : ""}
    <input class="input" id="doc-note" maxlength="500" placeholder="Note (optional), e.g. invoice for my order" value="${esc(D.note)}" aria-label="Note">
    ${D.msg ? `<small class="${D.ok ? "ok-msg" : "err"}">${esc(D.msg)}</small>` : ""}
    <button class="btn btn-primary btn-block" id="doc-send" ${D.files.length && !D.busy ? "" : "disabled"}>${D.busy ? "Sending…" : D.files.length ? `Send ${D.files.length} file${D.files.length > 1 ? "s" : ""}` : "Send"}</button>
    ${D.mine.length ? `<div class="doc-mine"><small class="label">Sent to ${esc(h.name)}</small>${D.mine.slice(0, 5).map(d => `<div class="doc-sent"><span>${d.files.length} file${d.files.length > 1 ? "s" : ""} · ${new Date(d.created_at).toLocaleDateString()}</span><span class="pill ${d.status === "done" ? "ok" : ""}">${d.status === "done" ? "Seen" : "Sent"}</span></div>`).join("")}</div>` : ""}
  </div>`;
}
function bindDocs() {
  const D = S.docs; if (!D || !document.getElementById("doc-send")) return;
  const keepNote = () => { const n = document.getElementById("doc-note"); if (n) D.note = n.value; };
  const inp = document.getElementById("doc-files");
  if (inp) inp.onchange = async () => {
    keepNote(); D.msg = ""; D.ok = false;
    for (const f of [...inp.files]) {
      if (D.files.length >= 10) { D.msg = "Send up to 10 files at a time."; break; }
      if (!/\.(jpe?g|png|webp|pdf|docx?)$/i.test(f.name)) { D.msg = `${f.name}: send pictures (JPG, PNG), PDF or Word files only.`; continue; }
      if (f.size > 10 * 1024 * 1024) { D.msg = `${f.name} is bigger than 10 MB.`; continue; }
      const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); }).catch(() => null);
      if (data) D.files.push({ name: f.name, size: f.size, data });
    }
    render();
  };
  appEl.querySelectorAll("[data-docrm]").forEach(b => b.onclick = () => { keepNote(); D.files.splice(Number(b.dataset.docrm), 1); render(); });
  const send = document.getElementById("doc-send");
  if (send) send.onclick = async () => {
    keepNote(); D.busy = true; D.msg = ""; render();
    try {
      const r = await api(`/api/services/${encodeURIComponent(D.svc)}/docs`, { method: "POST", body: { note: D.note, files: D.files.map(f => ({ name: f.name, data: f.data })) } });
      D.mine.unshift(r.doc); D.msg = `Sent. ${r.doc.files.length} file${r.doc.files.length > 1 ? "s were" : " was"} received.`; D.ok = true; D.files = []; D.note = "";
    } catch (e) { D.msg = e.message; D.ok = false; }
    D.busy = false; render();
  };
}
function vTicket(h) {
  const T = S.ticket || (S.ticket = { list: null, q: "", open: null });
  if (T.list === null) { loadAgencies(); return `<div class="view"><div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><b>${esc(h.name)}</b></div><div class="empty">Loading…</div></div>`; }
  const q = T.q.trim().toLowerCase();
  const list = T.list.filter(a => !q || [a.name, a.city, a.country, String(a.shop_no || "")].some(x => (x || "").toLowerCase().includes(q)));
  return `<div class="view">
    <div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><b>${esc(h.name)}</b></div>
    <div><h2 style="font-size:20px">Travel agencies</h2></div>
    <div class="sq-search"><input class="input" id="tk-q" placeholder="Search agency or city" value="${esc(T.q)}" aria-label="Search agency or city"></div>
    ${list.length ? `<div class="agency-list">${list.map(a => `<div class="agency ${T.open === a.id ? "open" : ""}">
      <div class="agency-row">
        <span class="agency-logo">${a.logo ? `<img src="${esc(a.logo)}" alt="">` : SUUQ.PLANE}</span>
        <span class="agency-t"><b>${esc(a.name)}</b><small>${esc([a.city, a.country].filter(Boolean).join(", "))}</small></span>
        <button class="btn btn-ghost agency-more" data-agmore="${a.id}" aria-expanded="${T.open === a.id}">${T.open === a.id ? "Less" : "More"}</button>
      </div>
      ${T.open === a.id ? `<div class="agency-more-box">
        <div><small class="label">Address</small><span>${esc(a.address || "—")}</span></div>
        <div><small class="label">City</small><span>${esc([a.city, a.country].filter(Boolean).join(", ") || "—")}</span></div>
        ${a.shop_no ? `<div><small class="label">Shop number</small><span class="num">${esc(a.shop_no)}</span></div>` : ""}
      </div>` : ""}
      ${!a.mine && SUUQ.earnLabel(a.comm_type, a.comm_value) ? `<span class="earn agency-earn">${esc(SUUQ.earnLabel(a.comm_type, a.comm_value))}</span>` : ""}
      <div class="agency-acts">
        ${a.mine ? "" : `<button class="btn btn-primary" data-agticket="${esc(a.ticket_id)}">Ask for ticket price</button>`}
        <button class="btn btn-ghost" data-agchat="${a.id}">${SUUQ_ICONS.chat || ""}Chat</button>
        ${a.mine || !(a.comm_value > 0) ? "" : `<button class="btn btn-ghost" data-agshare="${esc(a.ticket_id)}">Share and earn</button>`}
      </div>
    </div>`).join("")}</div>` : `<div class="empty">${q ? "No agency matches your search." : "No travel agencies yet. They will appear here soon."}</div>`}
  </div>`;
}
function bindTicket() {
  const T = S.ticket; if (!T) return;
  const q = document.getElementById("tk-q");
  if (q) { let t; q.oninput = () => { T.q = q.value; clearTimeout(t); t = setTimeout(() => { render(); const i = document.getElementById("tk-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); }; }
  appEl.querySelectorAll("[data-agmore]").forEach(b => b.onclick = () => { const id = Number(b.dataset.agmore); T.open = T.open === id ? null : id; render(); });
  appEl.querySelectorAll("[data-agticket]").forEach(b => b.onclick = () => SUUQ.openTicket(b.dataset.agticket));
  appEl.querySelectorAll("[data-agshare]").forEach(b => b.onclick = () => SUUQ.shareTicket(b.dataset.agshare, b));
  appEl.querySelectorAll("[data-agchat]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const r = await api(`/api/ticket/agencies/${b.dataset.agchat}/chat`, { method: "POST", body: {} }); await SUUQ.openTicketChat(r.chat.id); }
    catch (e) { b.disabled = false; b.insertAdjacentHTML("afterend", `<small class="err">${esc(e.message)}</small>`); }
  });
}
/* Listings on a service page (rooms, technicians, cars…): photo, name, category, price and what is free. */
const ITEM_BTN = { hotels: "Book", technician: "Request", "car-rent": "Rent", "school-bus": "Book", restaurant: "Order" };
function svcItems(h) {
  const L = S.svcItems || (S.svcItems = {});
  if (!(h.id in L)) { L[h.id] = null; api(`/api/services/${encodeURIComponent(h.id)}/items`).then(r => { L[h.id] = r.items; if (S.service === h.id) render(); }).catch(() => { L[h.id] = []; }); }
  const list = L[h.id]; if (!list || !list.length) return "";
  const U = SUUQ.UNIT_NAME, cats = [...new Set(list.map(x => x.category).filter(Boolean))], cat = S.svcCat?.[h.id] || "";
  const shown = list.filter(x => !cat || x.category === cat);
  return `<div class="svc-list">
    ${cats.length > 1 ? `<div class="country-chips" role="group" aria-label="Categories"><button data-svccat="" data-svcid="${esc(h.id)}" aria-pressed="${!cat}">All</button>${cats.map(c => `<button data-svccat="${esc(c)}" data-svcid="${esc(h.id)}" aria-pressed="${cat === c}">${esc(c)}</button>`).join("")}</div>` : ""}
    <div class="hlist">${shown.map(x => { const full = x.stock === 0; return `<div class="hcard-w"><button class="hcard" data-svcitem="${esc(x.id)}" data-svcid="${esc(h.id)}" ${full ? "disabled" : ""}>
      <span class="hcard-img">${x.images[0] ? `<img src="${esc(x.images[0])}" alt="" loading="lazy">` : ""}</span>
      <span class="hcard-t"><b data-no-i18n>${esc(x.name)}</b>${x.category ? `<span class="cat-chip">${esc(x.category)}</span>` : ""}
        <span class="price ${x.price == null ? "hidden-price" : "num"}">${x.price == null ? esc(x.price_label || "Ask for the price") : esc(fmt(x.price, x.cur) + (U[x.unit] ? " / " + U[x.unit][0] : ""))}</span>
        ${x.stock >= 0 ? `<small class="${full ? "avail-none" : "avail"}">${full ? "Fully booked" : x.unit === "night" ? `${x.stock} room${x.stock === 1 ? "" : "s"} available` : `${x.stock} available`}</small>` : ""}
        <span class="btn btn-primary btn-sm">${esc(ITEM_BTN[h.id] || "Order")}</span></span></button></div>`; }).join("")}</div></div>`;
}
/* Technician page (home-services design): search, category chips, then sections of photo cards with "See all". */
function vTechnician(h) {
  const L = S.svcItems || (S.svcItems = {});
  if (!(h.id in L)) { L[h.id] = null; api(`/api/services/${encodeURIComponent(h.id)}/items`).then(r => { L[h.id] = r.items; if (S.service === h.id) render(); }).catch(() => { L[h.id] = []; }); }
  const list = L[h.id] || [], T = S.tech || (S.tech = { view: null, q: "" }), I = SUUQ.TECH_ICONS, U = SUUQ.UNIT_NAME;
  // Services that sellers list themselves (like Suuq): Buy, or Book with a date and time.
  if (S.techMk === undefined) { S.techMk = null; api("/api/suuq/products?service=technician").then(r => { S.techMk = r.products; if (S.service === h.id) render(); }).catch(() => { S.techMk = []; }); }
  const mk = S.techMk || [];
  const mkBlock = items => `<div class="ts-sec"><h3 class="ts-h">From sellers</h3><button class="link-btn" data-technew>+ Add your service</button></div>
    ${items.length ? `<div class="pgrid">${items.map(SUUQ.productCard).join("")}</div>` : `<div class="empty">No services from sellers yet. Tap “Add your service” to list yours.</div>`}`;
  const card = x => `<div class="hcard-w"><button class="hcard" data-svcitem="${esc(x.id)}" data-svcid="${esc(h.id)}">
      <span class="hcard-img">${x.images[0] ? `<img src="${esc(x.images[0])}" alt="" loading="lazy">` : ""}</span>
      <span class="hcard-t"><b data-no-i18n>${esc(x.name)}</b><span class="cat-chip">${esc(x.category)}</span>
        <span class="price ${x.price == null ? "hidden-price" : "num"}">${x.price == null ? esc(x.price_label || "Ask for the price") : esc(fmt(x.price, x.cur) + (U[x.unit] ? " / " + U[x.unit][0] : ""))}</span>
        <span class="btn btn-primary btn-sm">Book</span></span></button></div>`;
  const ask = `<button class="btn btn-ghost btn-block" data-svcreq="${esc(h.id)}">Can't find it? Ask Technician</button>`;
  const head = `<div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><b>${esc(h.name)}</b></div>
    <label class="ts-search"><input id="ts-q" type="search" placeholder="Search for services" value="${esc(T.q)}" aria-label="Search for services"><span aria-hidden="true">${MENU_ICONS.search}</span></label>`;
  const q = T.q.trim().toLowerCase();
  if (q || T.view) {
    let title, shown;
    if (q) { title = "Results"; shown = list.filter(x => [x.name, x.category, x.description].some(v => String(v || "").toLowerCase().includes(q))); }
    else if (T.view.type === "all") { title = "All technicians"; shown = list; }
    else if (T.view.type === "group") { const g = SUUQ.TECH_GROUPS.find(g => g.name === T.view.key); title = g.name; shown = list.filter(x => g.cats.some(c => c[0] === x.category)); }
    else { title = T.view.key; shown = list.filter(x => x.category === T.view.key); }
    return `<div class="view ts">${head}
      <button class="link-btn" data-tview="" style="align-self:flex-start">‹ All categories</button>
      <h3 class="ts-h">${esc(title)}</h3>
      ${shown.length ? `<div class="hlist">${shown.map(card).join("")}</div>` : `<div class="empty">No technicians here yet.</div>`}
      ${q ? mkBlock(mk.filter(p => [p.name, p.description, p.shop_name].some(v => String(v || "").toLowerCase().includes(q)))) : T.view.type === "all" ? mkBlock(mk) : ""}
      ${ask}</div>`;
  }
  const photoOf = cat => (list.find(x => x.category === cat && x.images[0]) || {}).images?.[0];
  return `<div class="view ts">${head}
    <div class="ts-sec"><h3 class="ts-h">Categories</h3><button class="link-btn" data-tview="all">See all</button></div>
    <div class="ts-cats">${SUUQ.TECH_CHIPS.map(([n, ic, grp]) => `<button class="ts-cat" data-tview="${grp ? "group" : "cat"}" data-tkey="${esc(grp || n)}"><span class="ts-cat-ic">${SUUQ.techPhoto(n) ? `<img src="${SUUQ.techPhoto(n)}" alt="" loading="lazy">` : I[ic]}</span><b>${esc(n)}</b></button>`).join("")}</div>
    ${mkBlock(mk)}
    ${SUUQ.TECH_GROUPS.map(g => `<div class="ts-sec"><h3 class="ts-h">${esc(g.name)}</h3><button class="link-btn" data-tview="group" data-tkey="${esc(g.name)}">See all</button></div>
      <div class="ts-row">${g.cats.map(([n, ic]) => { const ph = SUUQ.techPhoto(n) || photoOf(n), c = list.filter(x => x.category === n).length; return `<button class="ts-card" data-tview="cat" data-tkey="${esc(n)}">
        ${ph ? `<img src="${esc(ph)}" alt="" loading="lazy">` : `<span class="ts-card-ic">${I[ic]}</span>`}<span class="ts-card-l">${esc(n)}${c ? ` <small>· ${c}</small>` : ""}</span></button>`; }).join("")}</div>`).join("")}
    ${ask}</div>`;
}
function vSoon() {
  const h = hubServices().find(x => x.id === S.service);
  if (!h) { S.service = null; return vHub(); }
  if (h.id === "ticket") return vTicket(h);
  if (h.id === "technician") return vTechnician(h);
  if (h.id === "restaurant") return `<div class="view"><div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button></div></div>`;
  if ((h.videos || []).length || (h.gallery || []).length) return vVideos(h);
  // A service without its own page yet: its photo, name and description, and a way to contact it.
  const wa = String(h.whatsapp || settings.support?.whatsapp || "").replace(/\D/g, ""), phone = String(h.phone || "").replace(/[^\d+]/g, "");
  return `<div class="view">
    <div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><b>${esc(h.name)}</b></div>
    <div class="soon-card"><div class="soon-art">${ART(h.art, h.photo)}${window.SarrifArt ? SarrifArt.icon(h.art) : ""}</div>
      <h2 style="font-size:24px">${esc(h.name)}</h2>
      ${h.sub ? `<p class="note" style="margin:0;max-width:30ch">${esc(h.sub)}</p>` : ""}</div>
    ${svcItems(h)}
    <button class="btn ${(S.svcItems?.[h.id] || []).length ? "btn-ghost" : "btn-primary"} btn-block" data-svcreq="${esc(h.id)}">${(S.svcItems?.[h.id] || []).length ? "Something else? Ask " + esc(h.name) : "Request " + esc(h.name)}</button>
    ${phone || wa ? `<div class="yt-contact">${phone ? `<button class="btn call-btn" data-call="${esc(phone)}">${SVC_ICONS.call}Call</button>` : ""}${wa ? `<a class="btn wa-btn" href="https://wa.me/${wa}?text=${encodeURIComponent("Salaan, " + h.name)}" target="_blank" rel="noopener">${ICON.wa}WhatsApp</a>` : ""}</div>` : ""}
  </div>`;
}
// Moving pictures: the photos fade from one to the next (tiles), or slide along (service page).
// Only the photo showing and the next one are loaded, so 25+ photos don't slow the page.
const slideShow = g => `<span class="slides" data-slides>${g.map((x, i) => `<img class="art-photo${i ? "" : " on"}" ${i < 2 ? "src" : "data-src"}="${esc(x.src)}" alt="${esc(x.title || "")}">`).join("")}</span>`;
function loadImg(img) { if (img && !img.getAttribute("src") && img.dataset.src) img.src = img.dataset.src; }
let galleryTouched = 0;
setInterval(() => {
  if (document.hidden) return;
  document.querySelectorAll("[data-slides]").forEach(box => {
    const on = box.querySelector("img.on") || box.firstElementChild; if (!on) return;
    const next = on.nextElementSibling || box.firstElementChild;
    loadImg(next); loadImg(next.nextElementSibling || box.firstElementChild);
    if (!next.complete) return; // wait until it has loaded
    on.classList.remove("on"); next.classList.add("on");
  });
  if (Date.now() - galleryTouched < 6000) return; // the customer is swiping: don't move it for them
  document.querySelectorAll("[data-gallery]").forEach(strip => {
    const w = strip.clientWidth; if (!w) return;
    const at = Math.round(strip.scrollLeft / w), count = strip.children.length;
    const to = at + 1 >= count ? 0 : at + 1;
    strip.children[to]?.querySelectorAll("img").forEach(loadImg);
    strip.children[to + 1]?.querySelectorAll("img").forEach(loadImg);
    strip.scrollTo({ left: to * w, behavior: to ? "smooth" : "auto" });
  });
}, 3000);
function galleryStrip(g) {
  return `<div class="yt-gallery" data-gallery>${g.map((x, i) => `<figure class="gal-slide">
    <img ${i < 2 ? "src" : "data-src"}="${esc(x.src)}" alt="${esc(x.title || "")}">
    ${x.title ? `<figcaption><b>${esc(x.title)}</b>${x.credit ? `<small>${esc(x.credit)}</small>` : ""}</figcaption>` : x.credit ? `<figcaption><small>${esc(x.credit)}</small></figcaption>` : ""}
  </figure>`).join("")}</div>`;
}
// A service page made of videos, like YouTube: a header with Call, WhatsApp and TikTok, then each video
// (it plays when tapped, or by itself when it reaches the middle of the screen), its title, and quick buttons.
const SVC_ICONS = {
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3z"/></svg>',
  track: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 4h13v11H1z"/><path d="M14 8h4l3 3v4h-7"/><circle cx="5.5" cy="17.5" r="2"/><circle cx="17.5" cy="17.5" r="2"/></svg>',
  pin: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  call: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  tiktok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.6 2h-3.3v13.2a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9a6.3 6.3 0 1 0 5.3 6.2V8.5a7.9 7.9 0 0 0 4.4 1.3V6.5a4.5 4.5 0 0 1-4.4-4.5z"/></svg>',
};
function vVideos(h) {
  const wa = String(h.whatsapp || settings.support?.whatsapp || "").replace(/\D/g, "");
  const phone = String(h.phone || "").replace(/[^\d+]/g, "");
  const initial = esc((h.name || "?").trim()[0] || "?").toUpperCase();
  const avatar = h.photo ? `<img src="${esc(h.photo)}" alt="">` : initial;
  const callBtn = cls => phone ? `<button class="btn ${cls} call-btn" data-call="${esc(phone)}">${SVC_ICONS.call}Call</button>` : "";
  const waBtn = (cls, text) => wa ? `<a class="btn ${cls} wa-btn" href="https://wa.me/${wa}${text ? "?text=" + encodeURIComponent(text) : ""}" target="_blank" rel="noopener">${ICON.wa}WhatsApp</a>` : "";
  const card = (v, n) => {
    const title = v.title || `${h.name} video ${n + 1}`;
    return `<article class="yt-card">
      ${SUUQ.videoEmbed(v.url, { autoplay: true, title })}
      <div class="yt-meta"><span class="yt-avatar">${avatar}</span>
        <div class="yt-text"><b class="yt-title">${esc(title)}</b><small>${esc(h.name)}</small></div></div>
      <div class="yt-actions">${callBtn("")}${waBtn("", `Salaan ${h.name}, waxaan daawaday: ${title}`)}
        <a class="btn btn-ghost" href="https://wa.me/?text=${encodeURIComponent(title + " " + v.url)}" target="_blank" rel="noopener">Share</a></div></article>`;
  };
  return `<div class="view yt-view">
    <div class="yt-channel"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><span class="yt-avatar big">${avatar}</span><div class="yt-text"><b>${esc(h.name)}</b><small>${esc(h.sub || "")}</small></div></div>
    ${svcItems(h)}
    ${phone || wa || h.tiktok ? `<div class="yt-contact">${callBtn("")}${waBtn("", "")}${h.tiktok ? `<a class="btn tt-btn" href="${esc(h.tiktok)}" target="_blank" rel="noopener">${SVC_ICONS.tiktok}TikTok</a>` : ""}</div>` : ""}
    <nav class="yt-tabs" role="tablist">
      <button role="tab" data-yttab="videos" aria-selected="${!["track", "docs", "earn"].includes(S.ytTab)}">${SVC_ICONS.play}Videos</button>
      <button role="tab" data-yttab="track" aria-selected="${S.ytTab === "track"}">${SVC_ICONS.track}Tracking</button>
      <button role="tab" data-yttab="docs" aria-selected="${S.ytTab === "docs"}">${DOC_ICON}Documents</button>
      <button role="tab" data-ytchat="${esc(h.id)}" aria-selected="false">${SUUQ.CHAT.CI.send}Chat</button>
      <button role="tab" data-yttab="earn" aria-selected="${S.ytTab === "earn"}">${EARN_ICON}Earn</button></nav>
    ${S.ytTab === "track" ? vTracking(h) : S.ytTab === "docs" ? docsCard(h) : S.ytTab === "earn" ? vSvcEarn(h) : `${(h.gallery || []).length ? galleryStrip(h.gallery) : ""}
    <div class="yt-feed">${h.videos.length ? h.videos.map(card).join("") : `<div class="empty">No videos yet.</div>`}</div>`}
  </div>`;
}
// Earn: what you earned for documents you sent to this service (each person sees only their own).
const EARN_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.6-.9-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 2.9 6 1.5 6 4.4 0 1.3-1.3 2.4-3 2.4-1.4 0-2.6-.6-3.2-1.6M12 6v2M12 16.5v1.5"/></svg>';
function vSvcEarn(h) {
  const E = S.svcEarn && S.svcEarn.svc === h.id ? S.svcEarn : (S.svcEarn = { svc: h.id, data: null });
  if (E.data === null) { E.data = undefined; api(`/api/services/${encodeURIComponent(h.id)}/earnings`).then(r => { E.data = r; if (S.service === h.id && S.ytTab === "earn") render(); }).catch(() => { E.data = { docs: [], totals: {}, balances: {} }; render(); }); }
  const d = E.data; if (!d) return `<div class="empty">Loading…</div>`;
  const tot = Object.entries(d.totals || {}).map(([c, v]) => fmt(v, c)).join(" · ");
  return `<div class="svc-earn">
    <div class="earn-hero"><small class="label">You earned from ${esc(h.name)}</small><b class="num">${tot || fmt(0, "USD")}</b>
      <span>In My earnings now: <b class="num">${CURS.map(c => fmt(d.balances?.[c] || 0, c)).join(" · ")}</b></span></div>
    ${(d.docs || []).length ? `<div class="doc-mine">${d.docs.map(x => `<div class="doc-sent"><span>${x.files.length} file${x.files.length > 1 ? "s" : ""} · ${new Date(x.created_at).toLocaleDateString()}</span>
      ${x.earn_amount > 0 ? `<b class="num earn-plus">+ ${esc(fmt(x.earn_amount, x.earn_cur))}</b>` : `<span class="pill">${x.status === "done" ? "Seen" : "Waiting"}</span>`}</div>`).join("")}</div>`
      : `<div class="empty">No documents yet.</div>`}
  </div>`;
}
/* ---------- Tracking: customers look up the tracking number the service gave them ---------- */
const TRACK_STEPS = ["Order received", "Processing", "Shipped", "In transit", "Arrived", "Ready for pickup", "Delivered"];
const when = t => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
function trackCard(t) {
  const at = TRACK_STEPS.indexOf(t.status), cancelled = t.status === "Cancelled";
  return `<article class="trk-card ${cancelled ? "is-cancel" : ""}">
    <div class="trk-top"><div><small>Tracking number</small><b class="num" data-no-i18n>${esc(t.code)}</b></div><span class="trk-status s${Math.max(at, 0)}">${esc(t.status)}</span></div>
    ${t.item ? `<p class="trk-item">${esc(t.item)}</p>` : ""}
    ${t.location ? `<p class="trk-loc">${SVC_ICONS.pin}<span>Now at: <b data-no-i18n>${esc(t.location)}</b></span></p>` : ""}
    ${cancelled ? "" : `<ol class="trk-steps">${TRACK_STEPS.map((x, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><span></span><small>${esc(x)}</small></li>`).join("")}</ol>`}
    ${t.note ? `<p class="note" style="margin:0" data-no-i18n>${esc(t.note)}</p>` : ""}
    <details class="trk-hist" open><summary>Updates (${t.history.length})</summary><ul>${t.history.slice().reverse().map(u => `<li><b>${esc(u.status)}</b>${u.location ? ` · <span data-no-i18n>${esc(u.location)}</span>` : ""}<small>${when(u.at)}</small>${u.note ? `<p data-no-i18n>${esc(u.note)}</p>` : ""}</li>`).join("")}</ul></details>
    <small class="trk-upd">Last update: ${when(t.updated_at)}</small></article>`;
}
function vTracking(h) {
  const T = S.trk && S.trk.svc === h.id ? S.trk : (S.trk = { svc: h.id, code: "", result: null, err: "", mine: null });
  if (T.mine === null) { T.mine = []; api(`/api/track/${encodeURIComponent(h.id)}`).then(r => { T.mine = r.trackings; if (S.ytTab === "track") render(); }).catch(() => {}); }
  return `<div class="trk">
    <div class="panel trk-search"><label for="trk-code"><b>Track your order</b></label>
      <p class="note" style="margin:0">Enter the tracking number ${esc(h.name)} gave you.</p>
      <div class="trk-form"><input class="input" id="trk-code" placeholder="e.g. SB123456" autocapitalize="characters" autocomplete="off" value="${esc(T.code)}" aria-label="Tracking number">
        <button class="btn btn-primary" id="trk-go">Track</button></div>
      ${T.err ? `<p class="status-msg bad" role="alert">${esc(T.err)}</p>` : ""}</div>
    ${T.result ? trackCard(T.result) : ""}
    ${T.mine.length ? `<h3 style="font-size:16px;margin:6px 0 0">Your tracking numbers</h3>${T.mine.filter(x => !T.result || x.id !== T.result.id).map(trackCard).join("")}` : ""}
  </div>`;
}
function bindTracking() {
  { const t = appEl.querySelector('.yt-tabs [aria-selected="true"]'), nav = t && t.parentElement; if (nav) nav.scrollLeft = Math.max(0, t.offsetLeft - nav.offsetLeft - 16); }
  appEl.querySelectorAll("[data-yttab]").forEach(b => b.onclick = () => { S.ytTab = b.dataset.yttab; if (S.trk) S.trk.mine = null; if (S.docs) S.docs.mine = null; if (S.svcEarn) S.svcEarn.data = null; render(); });
  appEl.querySelectorAll("[data-ytchat]").forEach(b => b.onclick = () => SUUQ.openSvcChat(b.dataset.ytchat));
  bindDocs();
  const go = document.getElementById("trk-go"), inp = document.getElementById("trk-code"); if (!go) return;
  const T = S.trk;
  const run = async () => {
    T.code = inp.value.trim(); if (!T.code) { inp.focus(); return; }
    go.disabled = true; T.err = "";
    try { T.result = (await api(`/api/track/${encodeURIComponent(T.svc)}?code=${encodeURIComponent(T.code)}`)).tracking; }
    catch (e) { T.result = null; T.err = e.message; }
    render();
  };
  go.onclick = run; inp.onkeydown = e => { if (e.key === "Enter") run(); };
}
/* ---------- Footer: Home, History, Chats, Favourites ---------- */
const FOOT_IC = {
  home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  history: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  chats: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>',
  favs: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.7 4.5c2.2 0 3.6 1.3 5.3 3.3 1.7-2 3.1-3.3 5.3-3.3 3.8 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>',
};
const footNav = cur => `<nav class="foot-nav" aria-label="Main">${[["home", "Home"], ["history", "History"], ["chats", "Chats"], ["favs", "Favourites"]].map(([k, l]) =>
  `<button data-foot="${k}" aria-current="${cur === k ? "page" : "false"}">${FOOT_IC[k]}<span>${l}</span></button>`).join("")}</nav>`;
async function goFoot(k) {
  S.drawer = false; S.sheet = null; S.footChats = false;
  if (k === "home") return openService("hub");
  if (k === "chats") { S.footChats = true; await SUUQ.openChats(); return; }
  S.service = k; scrollTo(0, 0);
  if (k === "history") { S.act = S.act || { tab: "orders", orders: null }; S.act.orders = null; loadActOrders(); loadMine(); }
  if (k === "favs") { S.favList = null; loadFavs(); }
  render();
}
// History: your orders and bookings in every service, and your money transfers (iBedel).
async function loadActOrders() { try { S.act.orders = (await api("/api/suuq/orders/mine")).orders; } catch { S.act.orders = []; } if (S.service === "history") render(); }
function vActivity() {
  const A = S.act || (S.act = { tab: "orders", orders: null }), list = A.orders;
  const ord = list === null ? `<div class="empty">Loading…</div>` : list.length ? `<div class="act-list">${list.map(o => `<button class="act-item" data-actorder="${esc(o.id)}">
      <span class="act-img">${o.image ? `<img src="${esc(o.image)}" alt="" loading="lazy">` : ""}</span>
      <span class="act-t"><b>${esc(o.product_name)}${o.qty > 1 ? " × " + o.qty : ""}</b><small>${esc(o.shop_name || "")} · ${new Date(o.created_at).toLocaleDateString()}</small><span class="act-st">${esc(SUUQ.orderLabel(o))}</span></span>
      <b class="num act-amt">${o.total ? esc(fmt(o.total, o.cur)) : ""}</b></button>`).join("")}</div>`
    : `<div class="empty">Your orders and bookings will show here.</div>`;
  return `<div class="view"><h2 style="font-size:22px">History</h2>
    <div class="seg" role="group" aria-label="History"><button data-acttab="orders" aria-pressed="${A.tab === "orders"}">Orders</button><button data-acttab="money" aria-pressed="${A.tab === "money"}">Money transfers</button></div>
    ${A.tab === "orders" ? ord : vHistory().replace(/<h2[^>]*>History<\/h2>/, "")}</div>`;
}
// Favourites: products you saved with the heart.
async function loadFavs() { try { S.favList = (await api("/api/suuq/favorites")).products; } catch { S.favList = []; } if (S.service === "favs") render(); }
function vFavs() {
  const L = S.favList;
  return `<div class="view"><h2 style="font-size:22px">Favourites</h2>
    ${L === null || L === undefined ? `<div class="empty">Loading…</div>` : L.length ? `<div class="pgrid">${L.map(SUUQ.productCard).join("")}</div>`
      : `<div class="empty">Tap the heart on any product to save it here.</div>`}</div>`;
}
function bindFoot() {
  appEl.querySelectorAll("[data-foot]").forEach(b => b.onclick = () => goFoot(b.dataset.foot));
  appEl.querySelectorAll("[data-acttab]").forEach(b => b.onclick = () => { S.act.tab = b.dataset.acttab; render(); });
  appEl.querySelectorAll("[data-actorder]").forEach(b => b.onclick = () => SUUQ.openMyOrders());
  if (S.service === "favs") appEl.querySelectorAll("[data-prod]").forEach(b => b.onclick = () => SUUQ.openFavProduct(b.dataset.prod));
}
function vHome() {
  const tabs = `<nav class="tabs">
    <button data-tab="send" aria-current="${S.tab === "send" ? "page" : "false"}">${ICON.send}Send</button>
    <button data-tab="history" aria-current="${S.tab === "history" ? "page" : "false"}">${ICON.hist}History</button>
    <button data-tab="me" aria-current="${S.tab === "me" ? "page" : "false"}">${ICON.me}Account</button></nav>`;
  if (!S.service) return vHub() + footNav("home");
  if (S.service === "history") return vActivity() + footNav("history");
  if (S.service === "favs") return vFavs() + footNav("favs");
  if (S.service === "suuq" && S.footChats && SUUQ.state.tab === "chats" && !SUUQ.state.chat && !SUUQ.state.product) return SUUQ.view() + footNav("chats");
  if (["suuq", "visa", "scholarship", "wallet", "affiliate"].includes(S.service)) return SUUQ.view();
  if (S.service === "account") return `<div class="view"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button>${vMe()}</div>`;
  if (S.service !== "ibedel" || !hubServices().some(x => x.id === "ibedel")) return vSoon();
  const bar = `<div class="svc-bar"><button class="back" data-svcgo="hub" aria-label="Back to services">${ICON.back}</button><b>iBedel</b></div>`;
  const body = S.tab === "send" ? vSend() : S.tab === "history" ? vHistory() : vMe();
  return `<div class="view">${bar}${body}</div>${tabs}${S.sheet ? vSheet() : ""}`;
}
function svcPicker(side) {
  const q = S.q, list = side === "to" && toOther() ? allWalletsFor(q.cur) : myWalletsFor(q.cur).filter(s => side === "from" || s.id !== q.from);
  return `<div class="svc-grid" role="group">${list.map(s => `<button class="svc" data-svc="${side}:${s.id}" aria-pressed="${q[side] === s.id}"><img src="${LOGO(s.id)}" alt="">${esc(s.name)}</button>`).join("")}</div>`;
}

// Premier Wallet: the customer pays in their Premier app and uploads a picture of the payment. No USSD.
const PROOF_WALLETS = ["premier"];
const needsProof = w => PROOF_WALLETS.includes(w);
async function compressImage(file, maxChars) {
  const src = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(file); });
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });
  let max = 1400, q = 0.82, out = "";
  for (let i = 0; i < 8; i++) {
    const sc = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    out = c.toDataURL("image/jpeg", q);
    if (out.length <= maxChars) return out;
    max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.08);
  }
  return out;
}
function proofBox() {
  if (!needsProof(S.q.from)) return "";
  const payTo = (settings.premierPayTo || "");
  return `<div class="proof-box">
    <b>Upload your Premier Wallet payment</b>
    <small>Send money from Premier app first to our Agent${payTo ? ` <span class="payto">${esc(payTo)}</span>` : ""}, then upload send screenshot or photo of that payment.</small>
    ${S.q.proof ? `<div class="proof-prev"><img src="${S.q.proof}" alt="Your payment picture"><button class="btn btn-ghost" id="proof-change">Change picture</button></div>`
      : `<label class="btn btn-ghost btn-block" for="proof-file" style="cursor:pointer">Choose screenshot or photo</label>`}
    <input type="file" id="proof-file" accept="image/*" hidden>
    <span class="err" id="proof-err" style="min-height:0"></span></div>`;
}
function bindProof() {
  const f = document.getElementById("proof-file"); if (!f) return;
  f.onchange = async () => {
    const file = f.files[0]; if (!file) return;
    const err = document.getElementById("proof-err");
    if (!/^image\//.test(file.type)) { err.textContent = "Choose a picture (photo or screenshot)."; return; }
    try { S.q.proof = await compressImage(file, 2500000); render(); }
    catch { err.textContent = "That picture couldn't be opened. Try another one."; }
  };
  const ch = document.getElementById("proof-change"); if (ch) ch.onclick = () => f.click();
}
function showLightbox(src, caption) {
  const d = document.createElement("div"); d.className = "lightbox"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Payment picture");
  d.innerHTML = `<button class="btn btn-ghost">Close</button><div><img alt="Payment picture"><p></p></div>`;
  d.querySelector("img").src = src; d.querySelector("p").textContent = caption || "";
  const im = d.querySelector("img"); im.title = "Tap to zoom"; im.onclick = e => { e.stopPropagation(); d.classList.toggle("zoom"); };
  const close = () => d.remove();
  d.onclick = e => { if (e.target === d || e.target.tagName === "BUTTON") close(); };
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  document.body.appendChild(d);
}

const canContinue = () => { const r = quote(); return r.amt > 0 && r.get > 0 && !belowMin() && S.q.from && S.q.to && (toOther() ? S.q.toName.trim().length >= 2 && otherPhoneOk() : S.q.from !== S.q.to) && (!needsProof(S.q.from) || !!S.q.proof); };
/* Earnings ready to send: when a currency reaches the person's withdraw amount, they send all of it with iBedel to
   their own ZAAD, eDahab, Soltelco or Premier number. Sarrif pays it (the iBedel charge comes off). */
function earnReady() {
  const w = SUUQ.state.wallet; if (!w || !w.earnings) return [];
  const lim = w.withdraw_at || {};
  return ["USD", "SLSH"].filter(c => (w.earnings[c] || 0) > 0 && (w.earnings[c] || 0) >= (lim[c] || 0));
}
function earnPayCard() {
  const ready = earnReady(); if (!ready.length) return "";
  const P = S.earnPay || (S.earnPay = { cur: ready[0], to: null, err: "" });
  if (!ready.includes(P.cur)) P.cur = ready[0];
  const cur = P.cur, amt = SUUQ.state.wallet.earnings[cur], w = wallets();
  const opts = SERVICES.filter(x => w[x.id] && !(cur === "SLSH" && x.id === "premier") && settings.show?.[x.id]?.on !== false && settings.show?.[x.id]?.[cur] !== false);
  if (!opts.some(x => x.id === P.to)) P.to = opts[0]?.id || null;
  const pct = Number(settings.earnFeePct) || 0;
  let fee = amt * pct / 100; fee = cur === "SLSH" ? Math.round(fee) : Math.round(fee * 100) / 100;
  const get = Math.max(0, cur === "SLSH" ? Math.floor(amt - fee) : Math.floor((amt - fee) * 100) / 100);
  return `<div class="leg earn-pay"><div class="leg-head"><span class="leg-title">Your earnings are ready</span></div>
    ${ready.length > 1 ? `<div class="cur-toggle" style="grid-template-columns:1fr 1fr">${ready.map(c => `<button class="${c}" data-epcur="${c}" aria-pressed="${cur === c}">${c}</button>`).join("")}</div>` : ""}
    <div class="sum-row total"><span>My earnings</span><b class="num">${fmt(amt, cur)}</b></div>
    ${opts.length ? `<span class="note">Send to my</span><div class="ep-wallets">${opts.map(x => `<button data-epto="${x.id}" aria-pressed="${P.to === x.id}"><img src="${LOGO(x.id)}" alt=""><span><b>${esc(x.name)}</b><small class="num">${esc(w[x.id])}</small></span></button>`).join("")}</div>
      <div class="sum-row fee"><span>Service charge (${esc(pct)}%)</span><b class="num">${fmt(fee, cur)}</b></div>
      <div class="sum-row"><span>You get</span><b class="num">${fmt(get, cur)}</b></div>
      <div class="err" role="alert">${esc(P.err || "")}</div>
      <button class="btn btn-primary btn-block" id="ep-send">Send ${fmt(get, cur)} to my ${esc(svc(P.to).name)}</button>`
      : `<span class="note">Add your ZAAD, eDahab, Soltelco or Premier number in Account to receive your earnings.</span>`}</div>`;
}
function bindEarnPay() {
  document.querySelectorAll("[data-epcur]").forEach(b => b.onclick = () => { S.earnPay.cur = b.dataset.epcur; S.earnPay.err = ""; render(); });
  document.querySelectorAll("[data-epto]").forEach(b => b.onclick = () => { S.earnPay.to = b.dataset.epto; S.earnPay.err = ""; render(); });
  const go = document.getElementById("ep-send"); if (!go) return;
  go.onclick = async () => {
    const P = S.earnPay;
    const pin = await askPin("Send your earnings", go.textContent.trim()); if (!pin) return;
    go.disabled = true;
    try {
      const r = await api("/api/earnings/payout", { body: { cur: P.cur, to: P.to, pin } });
      if (SUUQ.state.wallet) SUUQ.state.wallet.earnings = r.earnings;
      S.mine.unshift(r.request); S.last = r.request; S.sheet = "done"; S.earnPay = null; render();
    } catch (e) { P.err = e.message; render(); }
  };
}
function vSend() {
  const q = S.q, first = (S.user.name || "").split(" ")[0], curs = usableCurs();
  const whoToggle = `<div class="cur-toggle who-toggle" role="group" aria-label="Send to" style="grid-template-columns:1fr 1fr"><button class="USD" data-who="me" aria-pressed="${!toOther()}">To me</button><button class="SLSH" data-who="other" aria-pressed="${toOther()}">Another person</button></div>`;
  if (!curs.length) return `${earnPayCard()}${whoToggle}<div class="empty">${toOther() ? "Add your wallet number in Account first." : "To send money you need numbers for at least two wallets in the same currency. Add another wallet number in Account."}</div>`;
  return `
    <div class="hello"><div><span class="label">Salaan</span><h2>Hi ${esc(first)}</h2></div><div class="avatar">${esc((first[0] || "?").toUpperCase())}</div></div>
    ${earnPayCard()}
    ${whoToggle}
    <div class="leg">
      <div class="leg-head"><span class="leg-title">Dooro lacagta aad bedelayso</span></div>
      <div class="cur-toggle" role="group" aria-label="Currency" style="grid-template-columns:repeat(${curs.length},1fr)">${curs.map(c => `<button class="${c}" data-cur="${c}" aria-pressed="${q.cur === c}">${c === "USD" ? "USD · Dollar" : "SLSH · Shilling"}</button>`).join("")}</div>
      ${svcPicker("from")}
      <div class="amount-box"><span>${q.cur === "USD" ? "$" : "SLSH"}</span><input id="amount" inputmode="decimal" aria-label="Amount to send" value="${esc(q.amount)}" placeholder="0"></div>
      ${q.cur === "USD" && minUsd() ? `<span class="note min-note ${belowMin() ? "bad" : ""}" id="min-note">Smallest transfer: ${fmt(minUsdAmount(), "USD")} ($${minUsd()} plus the charge).</span>` : ""}
      ${proofBox()}
    </div>
    ${toOther() ? "" : `<button class="swap" id="swap" aria-label="Swap wallets">${ICON.swap}</button>`}
    <div class="leg">
      <div class="leg-head"><span class="leg-title">Dooro lacagta aad doonayso</span><span class="cur cur-${q.cur}" style="white-space:nowrap">${q.cur}</span></div>
      ${toOther() ? `<div class="field"><label for="to-name">Their name</label><input class="input" id="to-name" maxlength="60" autocomplete="off" value="${esc(q.toName)}" placeholder="Full name"></div>
      <div class="field"><label for="to-phone">Their phone number</label><div class="phone-input"><span>+252</span><input id="to-phone" inputmode="tel" autocomplete="off" placeholder="63 4123456" value="${esc(q.toPhone)}"></div></div>
      <span class="note">Which wallet do they receive it in?</span>` : ""}
      ${svcPicker("to")}
      <span class="note">${toOther() ? `Same currency both sides. They receive ${q.cur === "USD" ? "dollars" : "shillings"} in ${esc(svc(q.to).name)}.` : `Same currency both sides. You receive ${q.cur === "USD" ? "dollars" : "shillings"} in ${esc(svc(q.to).name)}.`}</span>
    </div>
    <div class="summary" id="summary">${summaryHtml()}</div>
    <button class="btn btn-primary btn-block" id="continue" ${canContinue() ? "" : "disabled"}>Send request</button>`;
}
function summaryHtml() {
  const q = S.q, r = quote();
  return `<div class="sum-row"><span>You send from ${esc(svc(q.from).name)}</span><b class="num">${fmt(r.amt, q.cur)}</b></div>
    <div class="sum-row fee"><span>Service charge (flat)</span><b class="num">− ${fmt(r.fee, q.cur)}</b></div>
    <div class="sum-row total"><span>${toOther() ? `${esc(q.toName.trim() || "They")} gets in ${esc(svc(q.to).name)}` : `You get in ${esc(svc(q.to).name)}`}</span><b class="num">${fmt(r.get, q.cur)}</b></div>`;
}
function vHistory() {
  if (!S.mine.length) return `<h2 style="font-size:20px">History</h2><div class="empty">Your transfers will show here.</div>`;
  return `<h2 style="font-size:20px">History</h2><div class="hist">${S.mine.map(t => `
    <div class="hist-item"><img src="${LOGO(t.from)}" alt="">
      <div class="t"><b>${esc(svc(t.from).name)} → ${esc(svc(t.to).name)}${t.to_name ? ` · ${esc(t.to_name)}` : ""}</b><small>${new Date(t.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · Ref ${esc(t.ref)}</small></div>
      <div class="a num"><div>${fmt(t.receive, t.cur)}</div><span class="pill ${t.status}">${t.status === "sent" ? "Sent" : "Waiting"}</span></div></div>`).join("")}</div>`;
}
function vMe() {
  const w = wallets(), act = activeServices(), have = act.filter(s => w[s.id]), missing = act.filter(s => !w[s.id]);
  const wa = String(settings.support.whatsapp || "").replace(/\D/g, "");
  return `<h2 style="font-size:20px">Account</h2>
    <div class="leg"><div class="sum-row"><span>Name</span><b>${esc(S.user.name)}</b></div>
    <div class="sum-row"><span>Phone</span><b class="num">+252 ${esc(S.user.phone)}</b></div></div>
    ${S.user.role === "customer" ? faceField(true) : ""}
    <div class="field"><label>Your wallet numbers</label><div class="wallet-nums">
      ${have.map(s => `<div class="wnum"><img src="${LOGO(s.id)}" alt=""><span>${esc(s.company)}</span><b class="num" style="padding:7px 0">${esc(w[s.id])}</b></div>`).join("")}
    </div><span class="note">Saved at signup. To change a saved number, contact support.</span></div>
    ${missing.length ? `<div class="field"><label>Add a missing wallet</label>${walletFields("aw", {}, missing)}</div>
      <div class="row-actions"><button class="btn btn-primary" id="save-wallets" style="min-height:42px;padding:10px 16px">Add number</button><span class="note" id="w-msg" role="status"></span></div>` : ""}
    <div class="leg"><div><b style="font-family:var(--display)">Technical support</b><p class="note" style="margin:4px 0 0">Having a problem? Chat with our team on WhatsApp.</p></div>
      ${wa ? `<a class="btn wa-btn btn-block" href="https://wa.me/${wa}" target="_blank" rel="noopener">${ICON.wa}Chat on WhatsApp</a><span class="note">WhatsApp: <span class="num">+${wa}</span></span>` : `<span class="note">Support contact coming soon.</span>`}
    </div>
    ${S.user.account_type === "merchant" ? `<div class="leg"><div class="sum-row"><span>Account type</span><b>Merchant</b></div></div>` : `<div class="leg"><b style="font-family:var(--display)">Want to sell in Suuq?</b><p class="note" style="margin:0">Register as a merchant with your shop or company details.</p><button class="btn btn-merchant btn-block" id="become-merchant">${SUUQ_ICONS.shop}Become a merchant</button></div>`}
    ${tonePicker()}
    <button class="btn btn-ghost btn-block" id="logout">Log out</button>`;
}
// Alarm ringtone: 40 to choose from; ▶ plays it. Saved on this phone.
function tonePicker() {
  const A = SUUQ.alarm; let cur = 0; try { cur = Number(localStorage.getItem(A.TONE_KEY)) || 0; } catch {}
  return `<div class="leg"><b style="font-family:var(--display)">Alarm ringtone</b><p class="note" style="margin:0">Rings for new orders, requests and chats. Tap ▶ to listen.</p>
    <div class="tone-list" role="radiogroup" aria-label="Alarm ringtone">${A.TONES.map((t, i) => `<div class="tone-item"><button type="button" role="radio" class="tone-pick" data-tone="${i}" aria-checked="${i === cur}"><span class="num">${i + 1}</span><b data-no-i18n>${esc(t.name)}</b></button><button type="button" class="tone-play" data-toneplay="${i}" aria-label="Play ${esc(t.name)}">▶</button></div>`).join("")}</div></div>`;
}
document.addEventListener("click", e => {
  const p = e.target.closest && e.target.closest("[data-toneplay]"); if (p) { SUUQ.alarm.preview(+p.dataset.toneplay); return; }
  const t = e.target.closest && e.target.closest("[data-tone]"); if (!t) return;
  try { localStorage.setItem(SUUQ.alarm.TONE_KEY, t.dataset.tone); } catch {}
  document.querySelectorAll("[data-tone]").forEach(b => b.setAttribute("aria-checked", String(b === t)));
  SUUQ.alarm.preview(+t.dataset.tone);
});
// Staff alerts (special staff tone): new top-ups and safe payments for the super admin, products to approve for
// service admins, new iBedel requests for iBedel staff.
function staffRing(key, title, body, go) {
  if (!S.user || S.user.role === "customer") return;
  SUUQ.alarm.show({ key, secs: 10, tone: "staff", title, body, actions: [{ label: "See", cls: "btn-primary", fn: go }] });
}
function vSheet() {
  if (S.sheet === "done") {
    const t = S.last;
    return `<div class="sheet"><div class="sheet-card">
      <div class="receipt"><div class="tick">${ICON.tick}</div><span class="pill waiting" style="align-self:center">Waiting for agent</span>
      <h3 style="font-size:20px">Request sent to the agent</h3>
      ${t.hasProof ? `<div class="instr">Your Premier Wallet payment picture was sent to the agent. They check it, then send your money.</div>` : ""}
      <div class="sum-row"><span>From ${esc(svc(t.from).name)}</span><b class="num">${fmt(t.amount, t.cur)}</b></div>
      <div class="sum-row fee"><span>Service charge</span><b class="num">${fmt(t.fee, t.cur)}</b></div>
      <div class="sum-row total"><span>To ${esc(svc(t.to).name)}</span><b class="num">${fmt(t.receive, t.cur)}</b></div>
      ${t.to_name ? `<div class="to-person"><small class="label">Send to</small><b>${esc(t.to_name)}</b><span class="num">+252 ${esc(t.to_num)}</span></div>` : ""}
      <p class="note" style="margin:0">Ref <span class="num">${esc(t.ref)}</span> · Check History to see when it's sent.</p></div>
      <button class="btn btn-primary btn-block" id="sheet-close">Done</button></div></div>`;
  }
  const q = S.q, r = quote();
  return `<div class="sheet"><div class="sheet-card">
    <h3 style="font-size:19px">Confirm with your PIN</h3>
    <p class="note" style="margin:0">${fmt(r.amt, q.cur)} from ${esc(svc(q.from).name)} → <b style="color:var(--ink)">${fmt(r.get, q.cur)}</b> to ${esc(svc(q.to).name)}. Charge ${fmt(r.fee, q.cur)}.</p>
    ${toOther() ? `<div class="to-person"><small class="label">Send to</small><b>${esc(q.toName.trim())}</b><span class="num">+252 ${esc(String(q.toPhone).replace(/\D/g, "").replace(/^252/, "").replace(/^0/, ""))}</span></div>` : ""}
    <div class="field"><label for="c-pin">Your PIN</label>${pinInput("c-pin", S.sheetPin)}</div>
    <div class="err" role="alert">${esc(S.err)}</div>
    <button class="btn btn-primary btn-block" id="c-go" ${S.sheetPin.length === 4 ? "" : "disabled"}>Confirm and send</button>
    <button class="btn btn-ghost btn-block" id="sheet-cancel">Cancel</button></div></div>`;
}

/* ---------- customer events ---------- */
function go(screen) { if (screen === "welcome" || screen === "login") clearRegDraft(); S.screen = screen; S.err = ""; render(); }
const padKey = (v, k) => k === "del" ? v.slice(0, -1) : k === "clear" ? "" : v.length < 4 ? v + k : v;
function bindPad(id, fn) { const p = document.getElementById(id); if (p) p.querySelectorAll("[data-k]").forEach(b => b.onclick = () => fn(b.dataset.k)); }
function bind() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.oninput = e => fn(e.target.value); };
  const click = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  bindFace();
  appEl.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
  appEl.querySelectorAll("[data-svcgo]").forEach(b => b.onclick = () => openService(b.dataset.svcgo));
  appEl.querySelectorAll("[data-catgo]").forEach(b => b.onclick = () => SUUQ.openCategory(b.dataset.catgo, b.dataset.catsec));
  bindHubSearch();
  bindEarnPay();
  if (["suuq", "visa", "scholarship", "wallet", "affiliate"].includes(S.service) && S.user?.role === "customer") SUUQ.bind(appEl);
  SUUQ.bindAutoplay(appEl);
  if (S.service === "ticket") bindTicket();
  bindFoot();
  bindTracking();
  appEl.querySelectorAll("[data-demo-logins]").forEach(b => b.onclick = () => window.SarrifDemo?.showLogins());
  appEl.querySelectorAll("[data-call]").forEach(b => b.onclick = () => dialUssd(b.dataset.call));
  appEl.querySelectorAll("[data-svcreq]").forEach(b => b.onclick = () => SUUQ.openServiceRequest(b.dataset.svcreq));
  appEl.querySelectorAll("[data-svcitem]").forEach(b => b.onclick = () => SUUQ.openSvcItem(b.dataset.svcitem, b.dataset.svcid));
  if (S.service === "technician") {
    appEl.querySelectorAll("[data-prod]").forEach(b => b.onclick = () => SUUQ.openSvcItem(b.dataset.prod, "technician"));
    appEl.querySelectorAll("[data-technew]").forEach(b => b.onclick = () => SUUQ.newTechProduct());
  }
  appEl.querySelectorAll("[data-tview]").forEach(b => b.onclick = () => { const T = S.tech || (S.tech = { q: "" }); const v = b.dataset.tview; T.q = "";
    T.view = !v ? null : v === "all" ? { type: "all" } : { type: v, key: b.dataset.tkey }; render(); scrollTo(0, 0); });
  const tq = document.getElementById("ts-q"); if (tq) { tq.oninput = () => { S.tech.q = tq.value; clearTimeout(tq._t); tq._t = setTimeout(() => { render(); const i = document.getElementById("ts-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); }; }
  appEl.querySelectorAll("[data-svccat]").forEach(b => b.onclick = () => { (S.svcCat || (S.svcCat = {}))[b.dataset.svcid] = b.dataset.svccat; render(); });
  appEl.querySelectorAll("[data-gallery]").forEach(strip => {
    const touched = () => { galleryTouched = Date.now(); };
    strip.addEventListener("pointerdown", touched, { passive: true }); strip.addEventListener("touchstart", touched, { passive: true }); strip.addEventListener("wheel", touched, { passive: true });
    strip.querySelectorAll(".gal-slide img").forEach((im, i, all) => { im.style.cursor = "zoom-in"; im.onclick = () => SUUQ.zoom.open([...all].map(x => x.dataset.src || x.getAttribute("src")), i, im.alt || ""); });
    strip.addEventListener("scroll", () => { const at = Math.round(strip.scrollLeft / (strip.clientWidth || 1)); [at, at + 1].forEach(k => strip.children[k]?.querySelectorAll("img").forEach(loadImg)); }, { passive: true });
  });
  appEl.querySelectorAll("[data-wtoggle]").forEach(b => b.onclick = () => {
    walletShown = !walletShown;
    render(); const t = appEl.querySelector("[data-wtoggle]"); if (t) t.focus();
  });
  appEl.querySelectorAll("[data-callsmenu]").forEach(b => b.onclick = () => { S.callsMenu = !S.callsMenu; render(); });
  appEl.querySelectorAll("[data-calloff-h]").forEach(b => b.onclick = () => setCallsOff({ hours: Number(b.dataset.calloffH) }));
  appEl.querySelectorAll("[data-calloff-forever]").forEach(b => b.onclick = () => setCallsOff({ forever: true }));
  appEl.querySelectorAll("[data-calloff-days]").forEach(b => b.onclick = () => { const d = Number($("#calloff-days").value); if (!(d >= 1 && d <= 365)) return msg("#st-calloff", "Enter 1 to 365 days.", "bad"); setCallsOff({ days: d }); });
  appEl.querySelectorAll("[data-calloff-clear]").forEach(b => b.onclick = () => setCallsOff({}));
  appEl.querySelectorAll("[data-pause]").forEach(i => i.onchange = () => setPause(i.checked ? i.dataset.pause : ""));
  appEl.querySelectorAll("[data-pause-off]").forEach(b => b.onclick = () => { b.disabled = true; setPause(""); });
  appEl.querySelectorAll("[data-drawer]").forEach(b => b.onclick = () => {
    S.drawer = b.dataset.drawer === "open"; render();
    if (S.drawer) { const f = appEl.querySelector(".drawer-item"); if (f) f.focus(); } else { const m = appEl.querySelector(".menu-btn"); if (m) m.focus(); }
  });
  click("voice-btn", playVoice); syncVoiceBtn();
  on("l-phone", v => S.login.phone = v); on("s-name", v => S.signup.name = v); on("s-phone", v => S.signup.phone = v);
  appEl.querySelectorAll('[id^="sw-"]').forEach(i => i.oninput = e => S.signup.wallets[i.dataset.w] = e.target.value);
  const enable = (id, ok) => { const b = document.getElementById(id); if (b) b.disabled = !ok || S.busy; };
  pinOn("l-pin", v => S.login.pin = v, v => enable("do-login", v.length === 4), () => { if (S.login.pin.length === 4) doLogin(); });
  const suOk = () => S.signup.pin.length === 4 && S.signup.pin2.length === 4;
  pinOn("s-pin", v => S.signup.pin = v, () => enable("do-signup", suOk()), () => document.getElementById("s-pin2").focus());
  pinOn("s-pin2", v => S.signup.pin2 = v, () => enable("do-signup", suOk()), () => { if (suOk()) doSignup(); });
  pinOn("c-pin", v => S.sheetPin = v, v => enable("c-go", v.length === 4), () => { if (S.sheetPin.length === 4) submitTx(); });
  click("c-go", () => submitTx());
  const cp = document.getElementById("c-pin"); if (cp && !cp.value) cp.focus();
  click("do-login", doLogin); click("do-signup", doSignup); click("do-adminpw", doAdminPw);
  if (S.screen === "merchant" && !S.user) {
    pinOn("m-pin", v => S.merchant.pin = v, null, () => document.getElementById("m-pin2").focus()); pinOn("m-pin2", v => S.merchant.pin2 = v, null, () => doMerchantSignup());
    click("do-merchant", doMerchantSignup); SUUQ.bindPf(appEl);
    const ms = S.merchant;
    click("m-next", () => merchantStep(ms.step + 1)); click("m-prev", () => merchantStep(ms.step - 1));
    click("m-back", () => { if (ms.step > 1) merchantStep(ms.step - 1); else { SUUQ.keepPf(); go("welcome"); } });
    appEl.querySelectorAll("[data-mstep]").forEach(b => b.onclick = () => merchantStep(Number(b.dataset.mstep)));
    appEl.querySelectorAll(".pf input").forEach(i => i.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); merchantStep(ms.step + 1); } });
  }
  click("become-merchant", async () => { S.service = "suuq"; SUUQ.state.tab = "sell"; await SUUQ.open("suuq"); });
  const apw = document.getElementById("a-pw"); if (apw) { apw.focus(); apw.onkeydown = e => { if (e.key === "Enter") doAdminPw(); }; }
  appEl.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; if (S.tab === "history") loadMine(); render(); });
  appEl.querySelectorAll("[data-cur]").forEach(b => b.onclick = () => { S.q.cur = b.dataset.cur; render(); });
  appEl.querySelectorAll("[data-who]").forEach(b => b.onclick = () => { S.q.who = b.dataset.who; S.q.to = null; normalizeQuote(); render(); });
  const keepCaret = (id) => { const i = document.getElementById(id); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } };
  const tn = document.getElementById("to-name"); if (tn) tn.oninput = () => { S.q.toName = tn.value; const sm = document.getElementById("summary"); if (sm) sm.innerHTML = summaryHtml(); const c = document.getElementById("continue"); if (c) c.disabled = !canContinue(); };
  const tp = document.getElementById("to-phone"); if (tp) tp.oninput = () => { S.q.toPhone = tp.value.replace(/[^\d +]/g, ""); const c = document.getElementById("continue"); if (c) c.disabled = !canContinue(); };
  appEl.querySelectorAll("[data-svc]").forEach(b => b.onclick = () => { const [side, id] = b.dataset.svc.split(":"); S.q[side] = id; if (side === "from") { S.q.proof = null; if (S.q.to === id) S.q.to = null; } render(); });
  on("amount", v => { S.q.amount = v.replace(/[^\d.]/g, ""); const el = $("#summary"); if (el) el.innerHTML = summaryHtml(); const c = $("#continue"); if (c) c.disabled = !canContinue(); const mn = $("#min-note"); if (mn) mn.classList.toggle("bad", belowMin()); });
  click("swap", () => { [S.q.from, S.q.to] = [S.q.to, S.q.from]; render(); });
  click("continue", () => { S.sheet = "pin"; S.sheetPin = ""; S.err = ""; render(); });
  click("sheet-cancel", () => { S.sheet = null; S.err = ""; render(); });
  click("sheet-close", () => { S.sheet = null; S.q.amount = ""; render(); });
  bindProof();
  appEl.querySelectorAll("[data-copyussd]").forEach(b => b.onclick = () => copyText(b.dataset.copyussd, b));
  click("save-wallets", async () => {
    const inputs = [...appEl.querySelectorAll('[id^="aw-"]')].filter(i => i.value.trim());
    if (!inputs.length) return (document.getElementById("w-msg").textContent = "Enter a number first.");
    try { for (const i of inputs) { const r = await api("/api/me/wallets", { body: { wallet: i.dataset.w, number: i.value } }); S.user = r.user; } render(); }
    catch (e) { document.getElementById("w-msg").textContent = e.message; }
  });
  click("logout", logout);
}
async function doLogin() {
  S.busy = true; render();
  try {
    const r = await api("/api/auth/login", { body: { phone: S.login.phone, pin: S.login.pin } });
    S.login.pin = "";
    if (r.needPassword) { S.ticket = r.ticket; S.busy = false; return go("adminpw"); }
    await loggedIn(r.user);
  } catch (e) { S.err = e.message; S.login.pin = ""; }
  S.busy = false; render();
}
async function doAdminPw() {
  try { const r = await api("/api/auth/admin-password", { body: { ticket: S.ticket, password: $("#a-pw").value } }); S.ticket = null; await loggedIn(r.user); }
  catch (e) { S.err = e.message; }
  render();
}
async function doSignup() {
  const s = S.signup;
  if (s.pin !== s.pin2) { S.err = "The two PINs don't match. Choose your PIN again."; s.pin = ""; s.pin2 = ""; return render(); }
  if (EASY_PINS.includes(s.pin)) { S.err = "1234, 1111 and 0000 are too easy to guess. Choose another PIN."; s.pin = ""; s.pin2 = ""; return render(); }
  if (!S.face) { S.err = "Please take a photo of your face. Thank you."; return render(); }
  S.busy = true; render();
  try { const r = await api("/api/auth/signup", { body: { name: s.name, phone: s.phone, pin: s.pin, wallets: s.wallets, face: S.face } }); S.signup = { name: "", phone: "", pin: "", pin2: "", wallets: {} }; S.face = null; clearRegDraft(); await loggedIn(r.user); }
  catch (e) { S.err = e.message; s.pin = ""; s.pin2 = ""; }
  S.busy = false; render();
}
async function openSharedProduct() {
  let pid = null; try { pid = localStorage.getItem("sarrif.open"); localStorage.removeItem("sarrif.open"); } catch {}
  if (pid && S.user?.role === "customer") { S.service = "suuq"; await SUUQ.open("suuq", { product: pid }); }
}
/* ---------- Push notifications (in the 5PLUS Android app) ---------- */
// The app gives this phone's Firebase address; the server uses it to ring the phone when 5PLUS is closed.
let pushSent = "";
function registerPush(tries = 0) {
  const A = window.SarrifAndroid; if (!A || !A.pushToken || !S.user) return;
  let t = ""; try { t = A.pushToken() || ""; } catch {}
  if (!t) { if (tries < 15) setTimeout(() => registerPush(tries + 1), 2000); return; } // Firebase is still starting
  if (t === pushSent) return;
  api("/api/push/register", { body: { token: t } }).then(() => { pushSent = t; }).catch(() => {});
}
async function unregisterPush() {
  const A = window.SarrifAndroid; let t = ""; try { t = A && A.pushToken ? A.pushToken() : ""; } catch {}
  if (t) { try { await api("/api/push/unregister", { body: { token: t } }); } catch {} } pushSent = "";
}
// A tapped notification opens the page it is about.
window.__pushOpen = goto => {
  if (!S.user) return;
  if (S.user.role === "customer") {
    if (goto === "sellerorders") SUUQ.goSellerOrders();
    else if (goto === "orders") SUUQ.openMyOrders();
    else if (goto === "chats") SUUQ.openChats();
    else if (String(goto).startsWith("chat:")) SUUQ.openChatById(String(goto).slice(5));
  }
  // An incoming internet call (the notification was tapped).
  if (String(goto).startsWith("call:")) return SUUQ.CALL.openFromPush(String(goto).slice(5));
  // A part admin opens their safe payments.
  if (S.user.role === "admin" && goto === "safepay") {
    SUUQ.goSafeTab(S.user.service); SUUQ.resetSafe(); renderSvcDash();
    setTimeout(() => document.getElementById("safe-desk")?.scrollIntoView({ behavior: "smooth", block: "start" }), 600);
  }
};
async function loggedIn(user) {
  SUUQ.reset();
  S.user = user; S.err = ""; S.tab = "send"; S.screen = "home"; S.service = null; S.viewAs = null;
  connectEvents();
  registerPush();
  if (user.role !== "customer") { try { allServices = (await api("/api/me")).services || []; } catch {} }
  if (user.role === "customer") { loadMine(); await SUUQ.loadWallet(); syncWithdrawAt(); }
  if (mode().startsWith("ibedel")) loadRequests();
  if (mode() === "ibedel-admin") loadAdminSettings();
  if (user.role === "super") await loadSuper();
  if (user.role === "customer") setTimeout(openSharedProduct, 0);
}
async function logout() {
  await unregisterPush();
  try { await api("/api/auth/logout", { body: {} }); } catch {}
  S.user = null; S.viewAs = null; S.screen = "welcome"; S.sheet = null; if (es) { es.close(); es = null; } stopRing(); render();
}
async function loadMine() { try { S.mine = (await api("/api/requests/mine")).requests; if (S.tab === "history" && !S.sheet) render(); } catch {} }
async function submitTx() {
  // The server checks the PIN with every transfer.
  try {
    const q = S.q, r = await api("/api/requests", { body: { pin: S.sheetPin, cur: q.cur, from: q.from, to: q.to, amount: q.amount, proof: needsProof(q.from) ? q.proof : undefined,
      recipient: toOther() ? { name: q.toName, phone: q.toPhone } : undefined } });
    S.q.proof = null; S.last = r.request; S.sheet = "done"; S.sheetPin = ""; S.mine.unshift(r.request); render();
    // Every wallet except Premier pays the agent by USSD: dial the code (USD or SLSH) automatically one second after
    // the request is sent. The code itself is not shown on the screen.
    if (r.request.ussd) setTimeout(() => { if (S.sheet === "done" && S.last?.id === r.request.id) dialUssd(r.request.ussd); }, 1000);
  } catch (e) { S.err = e.message; S.sheetPin = ""; render(); }
}
function dialUssd(code) {
  // Inside the 5PLUS Android app the call is placed straight away (no green button to press).
  if (window.SarrifAndroid?.call) { window.SarrifAndroid.call(code); return; }
  if (window.__demoDial) { window.__demoDial(code); return; } // the browser demo can't open the dialer
  const a = document.createElement("a"); a.href = "tel:" + code.replace(/#/g, "%23"); a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------- live updates ---------- */
let es = null;
function connectEvents() {
  if (es) es.close();
  es = new EventSource("/api/events");
  es.addEventListener("hello", () => setSync(true));
  es.onerror = () => setSync(false);
  es.addEventListener("tracking", e => { const d = JSON.parse(e.data || "{}"); if (S.trk && S.trk.svc === d.service && S.ytTab === "track" && S.user?.role === "customer") { S.trk.mine = null; if (S.trk.result) api(`/api/track/${encodeURIComponent(d.service)}?code=${encodeURIComponent(S.trk.result.code)}`).then(r => { S.trk.result = r.tracking; render(); }).catch(() => {}); render(); } if (typeof trkAdminReload === "function") trkAdminReload(d.service); });
  es.addEventListener("settings", e => { settings = JSON.parse(e.data); if (S.user?.role === "customer" && !S.sheet) { if (S.service && !hubServices().some(x => x.id === S.service)) S.service = null; render(); } });
  es.addEventListener("logout", () => { S.user = null; S.screen = "login"; S.err = "This account is suspended. Contact support."; es.close(); es = null; render(); });
  es.addEventListener("chatread", e => { try { SUUQ.onChatRead(JSON.parse(e.data)); } catch {} });
  es.addEventListener("call", e => { try { SUUQ.CALL.onEvent(JSON.parse(e.data)); } catch {} });
  es.addEventListener("chat", e => { if (S.user?.role === "customer") SUUQ.onChat(JSON.parse(e.data)); });
  es.addEventListener("order", e => { if (S.user?.role === "customer") SUUQ.onOrder(JSON.parse(e.data)); });
  es.addEventListener("earnings", () => { if (S.user?.role === "customer") SUUQ.onEarnings(); });
  es.addEventListener("deskchat", e => { if (S.user && S.user.role !== "customer") { const d = JSON.parse(e.data || "{}"); if (document.getElementById("svc-admin-chats")?.dataset.svc === d.svc) { const typing = document.querySelector("#desk-composer [data-chatin]")?.value; if (!typing) loadDeskChats(true); } try { SUUQ.alarm.preview(0); } catch {} } });
  es.addEventListener("servicedoc", e => { if (S.user && S.user.role !== "customer") { try { SUUQ.alarm.preview(0); } catch {} if (document.getElementById("svc-admin-docs")?.dataset.svc === JSON.parse(e.data || "{}").service) { tkDocsTab = "new"; loadSvcDocs(); } } });
  es.addEventListener("svcorder", e => { if (S.user && S.user.role !== "customer") SUUQ.onDeskOrder(JSON.parse(e.data)); });
  es.addEventListener("safepay", e => {
    const d = JSON.parse(e.data || "{}");
    if (S.user?.role === "super" && !S.viewAs && supTab === "wallets") { SUUQ.resetSuper(); SUUQ.renderSuperWallets(); }
    if (d.new && S.user?.role === "super") staffRing("sp" + Date.now(), "New safe payment", `<b>${esc(d.name || "")}</b> · ${esc(d.product || "")}<br>${esc(fmt(d.amount || 0, d.cur || "USD"))}`, goSupWallets);
    // The admin of a part (Suuq, Technician…): the safe payments sent to them.
    if (S.user?.role === "admin") {
      const box = document.getElementById("safe-desk"); SUUQ.resetSafe(); if (box) SUUQ.renderSafeDesk(box);
      if (d.new) staffRing("sp" + Date.now(), "New safe payment", `<b>${esc(d.name || "")}</b> · ${esc(d.product || "")}<br>${esc(fmt(d.amount || 0, d.cur || "USD"))}`, () => window.__pushOpen("safepay"));
    }
  });
  es.addEventListener("topup", e => { const d = JSON.parse(e.data || "{}"); if (d.new && S.user?.role === "super") staffRing("tp" + d.id, "New top-up request", `<b>${esc(d.name || "")}</b> · ${esc(fmt(d.amount || 0, d.cur || "USD"))}`, goSupWallets); });
  es.addEventListener("topup", () => {
    if (S.user?.role === "customer") SUUQ.onTopup();
    if (S.user?.role === "super" && !S.viewAs && supTab === "wallets") { SUUQ.resetSuper(); SUUQ.renderSuperWallets(); }
  });
  // Product approval: merchants hear the admin's decision; admins see new products to approve.
  es.addEventListener("product", e => { if (S.user?.role === "customer") SUUQ.onProduct(JSON.parse(e.data)); });
  es.addEventListener("review", e => {
    const d = JSON.parse(e.data); SUUQ.onReview(d);
    if (d.product && (S.user?.role === "admin" || S.user?.role === "super")) staffRing("rv" + d.product.id, "Product waiting for approval", `<b>${esc(d.product.name)}</b> · ${esc(d.pending)} waiting`, async () => {});
    if (mode() === "svc-admin" && currentService() === d.service) renderSvcDash();
  });
  es.addEventListener("wallet", e => { if (S.user?.role === "customer") SUUQ.onWallet(JSON.parse(e.data)); });
  es.addEventListener("request", e => {
    const t = JSON.parse(e.data);
    if (!S.user) return;
    if (S.user.role === "customer") { const i = S.mine.findIndex(x => x.id === t.id); if (i >= 0) S.mine[i] = t; else S.mine.unshift(t); if (S.tab === "history" && !S.sheet) render(); }
    else if (mode().startsWith("ibedel")) { const i = reqs.findIndex(x => x.id === t.id); if (i >= 0) reqs[i] = t; else { reqs.push(t); if (t.status === "waiting") staffRing("rq" + t.id, "New iBedel request", `<b>${esc(t.customer_name || "")}</b> · ${esc(fmt(t.amount || 0, t.cur || "USD"))}`, async () => {}); } loadRequests(); }
  });
}
async function goSupWallets() {
  if (S.user?.role !== "super") return;
  if (S.viewAs) { S.viewAs = null; applyRole(); }
  document.querySelector('#sup-tabs [data-stab="wallets"]')?.click();
}
function setSync(ok) { const s = $("#sync"); if (!s) return; s.className = "sync " + (ok ? "live" : "local"); s.querySelector("span").textContent = ok ? "Live" : "Reconnecting…"; }

/* ---------- role layout ---------- */
let admTab = "requests";
// What the signed-in person sees: the super admin can also open any service's dashboard (S.viewAs).
function mode() {
  const u = S.user; if (!u) return "guest";
  if (u.role === "customer") return "customer";
  if (u.role === "super") return !S.viewAs ? "super" : S.viewAs === "ibedel" ? "ibedel-admin" : "svc-admin";
  if (u.role === "admin") return u.service === "ibedel" ? "ibedel-admin" : "svc-admin";
  return u.service === "ibedel" ? "ibedel-agent" : "svc-agent";
}
const currentService = () => S.user?.role === "super" ? S.viewAs : S.user?.service;
const serviceName = id => (allServices.find(x => x.id === id) || hubServices().find(x => x.id === id) || { name: id }).name;
let allServices = [];
function applyRole() {
  const m = mode(), role = S.user?.role || null, staff = m !== "customer" && m !== "guest";
  $("#customer-area").hidden = staff;
  // Customers see only the app itself; staff keep the top bar with their name and Log out.
  document.querySelector(".topbar").hidden = !staff; document.body.classList.toggle("no-top", !staff);
  $("#super").hidden = m !== "super";
  $("#svcdash").hidden = !(m === "svc-admin" || m === "svc-agent");
  $("#admin").hidden = m !== "ibedel-admin";
  $("#agent").hidden = !(m === "ibedel-agent" || (m === "ibedel-admin" && admTab === "requests"));
  $("#agent-head").hidden = m === "ibedel-admin";
  const vb = $("#viewbar");
  if (role === "super" && S.viewAs) {
    vb.hidden = false;
    vb.innerHTML = `<b>You're viewing the ${esc(serviceName(S.viewAs))} dashboard as super admin.</b><button class="btn btn-primary" id="back-super">Back to super admin</button>`;
    $("#back-super").onclick = () => { S.viewAs = null; loadSuper(); render(); };
  } else { vb.hidden = true; vb.innerHTML = ""; }
  const ub = $("#userbar");
  if (staff) {
    ub.hidden = false;
    const label = role === "super" ? "super admin" : `${role} · ${serviceName(S.user.service)}`;
    ub.innerHTML = `<div class="who"><b>${esc(S.user.name)}</b><small><span class="role-pill">${esc(label)}</span></small></div>${langButton("staff")}<button class="btn btn-ghost" id="staff-logout">Log out</button>`;
    $("#staff-logout").onclick = logout;
  } else { ub.hidden = true; ub.innerHTML = ""; }
  if (m === "super") paintSuperTabs();
  if (m === "svc-admin" || m === "svc-agent") renderSvcDash();
  if (m === "ibedel-admin") {
    document.querySelectorAll("#adm-tabs [data-atab]").forEach(b => b.setAttribute("aria-pressed", b.dataset.atab === admTab));
    document.querySelectorAll("#admin [data-pane]").forEach(p => p.hidden = p.dataset.pane !== admTab);
    const t = { requests: ["Requests", "Transfer requests from customers. Mark each one as sent after you pay it out."], customers: ["Customers", "Everyone who registered in the app."], agents: ["Agents", "The staff who pay out transfer requests."], finance: ["Finance", "Revenue from service charges, your expenses and profit."], settings: ["Settings", "Charges, wallets, USSD codes, support and voice guide."] }[admTab];
    $("#adm-title").textContent = t[0]; $("#adm-sub").textContent = t[1];
  }
  syncRinging();
}
document.querySelectorAll("#adm-tabs [data-atab]").forEach(b => b.onclick = () => {
  admTab = b.dataset.atab; applyRole();
  if (admTab === "customers" || admTab === "agents") loadPeople();
  if (admTab === "settings") loadAdminSettings();
  if (admTab === "finance") openFinance();
});
let finance = null;
function openFinance() {
  if (finance) return finance.reload();
  finance = window.SarrifFinance.mount($("#finance-root"), {
    canEdit: true, reportTitle: "5PLUS · iBedel finance report", reportName: "iBedel finance report",
    load: (fromMs, toMs, fromDate, toDate) => api(`/api/admin/finance?fromMs=${fromMs}&toMs=${toMs}&fromDate=${fromDate}&toDate=${toDate}`),
    addExpense: e => api("/api/admin/expenses", { body: e }),
    deleteExpense: id => api(`/api/admin/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  });
}

/* ---------- agent dashboard ---------- */
let reqs = [], agentTab = "waiting", counts = {}, today = [], soundOn = false, audioCtx = null, ringTimer = null;
async function loadRequests() {
  try { const r = await api("/api/requests?status=" + agentTab); reqs = r.requests; counts = r.counts; today = r.today; renderAgent(); } catch {}
}
const unacked = () => agentTab === "waiting" ? reqs.filter(t => t.status === "waiting" && !t.acked) : [];
let pendingNew = 0;
function beep() {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  [0, .22, .44].forEach((d, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "square"; o.frequency.value = i === 1 ? 1320 : 990;
    g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.25, t0 + d + .02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + .18);
    o.connect(g).connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + .2);
  });
}
function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
function syncRinging() {
  const visible = mode() === "ibedel-agent" || (mode() === "ibedel-admin" && admTab === "requests");
  pendingNew = unacked().length;
  const should = visible && soundOn && pendingNew > 0;
  if (should && !ringTimer) { beep(); ringTimer = setInterval(beep, 1400); }
  if (!should) stopRing();
  document.title = visible && pendingNew ? `(${pendingNew}) New request · Sarrif` : "Sarrif";
}
async function enableSound() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); soundOn = true; } catch { soundOn = false; }
  renderAgent();
}
async function stopAlarm() { stopRing(); try { await api("/api/requests/ack", { body: {} }); } catch {} loadRequests(); }
function renderAgent() {
  const al = $("#alarm"), n = unacked().length;
  if (n) {
    al.className = "alarm" + (soundOn ? " ringing" : "");
    al.innerHTML = `<div class="ic">${ICON.bell}</div><div class="t"><b>${n} new request${n > 1 ? "s" : ""}</b><small>${soundOn ? "The alert keeps ringing until you stop it." : "Turn on sound to hear alerts for new requests."}</small></div>
      ${soundOn ? `<button class="btn" id="stop-alarm">Stop sound</button>` : `<button class="btn btn-primary" id="sound-on">Turn on alert sound</button><button class="btn btn-ghost" id="stop-alarm">Mark as seen</button>`}`;
  } else {
    al.className = "alarm";
    al.innerHTML = `<div class="ic">${soundOn ? ICON.bell : ICON.mute}</div><div class="t"><b>${soundOn ? "Alert sound is on" : "Alert sound is off"}</b><small>${soundOn ? "New requests ring here until you stop them." : "Browsers block sound until you tap once. Turn it on at the start of your shift."}</small></div>
      ${soundOn ? "" : `<button class="btn btn-primary" id="sound-on">Turn on alert sound</button>`}`;
  }
  const so = $("#sound-on"); if (so) so.onclick = enableSound;
  const sa = $("#stop-alarm"); if (sa) sa.onclick = stopAlarm;
  const sentToday = today.reduce((a, r) => a + r.n, 0);
  $("#kpis").innerHTML = `
    <div class="kpi warn"><span class="label">Waiting</span><b class="num">${counts.waiting || 0}</b></div>
    <div class="kpi"><span class="label">Sent today</span><b class="num">${sentToday}</b></div>
    <div class="kpi"><span class="label">Charges today</span><b class="num" style="font-size:15px;line-height:1.9">${today.filter(r => r.fees).map(r => fmt(r.fees, r.cur)).join(" · ") || "—"}</b></div>`;
  $("#at-waiting").textContent = `Waiting (${counts.waiting || 0})`; $("#at-sent").textContent = `Sent (${counts.sent || 0})`;
  $("#at-waiting").setAttribute("aria-pressed", agentTab === "waiting"); $("#at-sent").setAttribute("aria-pressed", agentTab === "sent");
  const list = reqs.filter(t => t.status === agentTab);
  $("#req-list").innerHTML = list.length ? list.map(t => {
    const isNew = t.status === "waiting" && !t.acked;
    return `<article class="req ${isNew ? "new" : ""}">
      <div class="req-top"><div class="who"><b>${esc(t.customer_name)}</b><small>+252 ${esc(t.customer_phone)} · ${timeAgo(t.created_at)} · Ref <span class="num">${esc(t.ref)}</span></small></div>
        <span class="pill ${t.status}">${t.status === "sent" ? "Sent" : "Waiting"}</span></div>
      <div class="route">
        <div class="end"><img src="${LOGO(t.from)}" alt=""><div class="t"><small>From ${esc(svc(t.from).name)}</small><b>${esc(t.from_num)}</b></div></div>
        <span class="arrow">${ICON.arrow}</span>
        <div class="end to"><img src="${LOGO(t.to)}" alt=""><div class="t"><small>Send to ${esc(svc(t.to).name)}</small>${t.to_name ? `<small class="to-who">${esc(t.to_name)} (another person)</small>` : ""}<b>${esc(t.to_num)}<button class="copy" data-copy="${esc(t.to_num)}">Copy</button></b></div></div>
      </div>
      ${t.from === "earnings" ? `<div class="instr">Earnings payout: Sarrif pays. Nothing to receive from the customer — send ${fmt(t.receive, t.cur)} to their number.</div>` : ""}
      <div class="req-money"><span>Customer sends <b>${fmt(t.amount, t.cur)}</b></span><span>Charge <b>${fmt(t.fee, t.cur)}</b></span><span class="big">Agent sends <b>${fmt(t.receive, t.cur)}</b></span>${t.hasProof ? `<span class="proof-pill">Payment picture attached</span>` : ""}</div>
      <div class="req-actions">${t.status === "waiting"
        ? `${t.hasProof ? `<button class="btn btn-ghost" data-proof="${t.id}" data-cap="${esc(t.customer_name)} · ${esc(fmt(t.amount, t.cur))} from Premier Wallet">View payment picture</button>` : ""}<button class="btn btn-primary" data-sent="${t.id}">Mark as sent</button>`
        : `${t.hasProof ? `<button class="btn btn-ghost" data-proof="${t.id}" data-cap="${esc(t.customer_name)} · ${esc(fmt(t.amount, t.cur))} from Premier Wallet">View payment picture</button>` : ""}<span class="note">Sent ${t.sent_at ? timeAgo(t.sent_at) : ""}</span><button class="btn btn-ghost" data-undo="${t.id}">Move back to waiting</button>`}</div>
    </article>`;
  }).join("") : `<div class="panel empty">${agentTab === "waiting" ? "No requests waiting. New ones appear here with an alert." : "No sent requests yet."}</div>`;
  document.querySelectorAll("[data-sent]").forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = "Saving…"; try { await api(`/api/requests/${b.dataset.sent}/sent`, { body: {} }); } catch (e) { b.disabled = false; b.textContent = "Mark as sent"; } loadRequests(); });
  document.querySelectorAll("[data-undo]").forEach(b => b.onclick = async () => { try { await api(`/api/requests/${b.dataset.undo}/waiting`, { body: {} }); } catch {} loadRequests(); });
  document.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyText(b.dataset.copy, b));
  document.querySelectorAll("[data-proof]").forEach(b => b.onclick = () => showLightbox(`/api/requests/${b.dataset.proof}/proof`, b.dataset.cap));
  syncRinging();
}
$("#at-waiting").onclick = () => { agentTab = "waiting"; loadRequests(); };
$("#at-sent").onclick = () => { agentTab = "sent"; loadRequests(); };
setInterval(() => { if (mode().startsWith("ibedel")) loadRequests(); }, 60000);

/* ---------- admin: people ---------- */
const openReset = {};
async function loadPeople() {
  try {
    const q = encodeURIComponent($("#cust-search").value || "");
    const [c, a] = await Promise.all([api("/api/admin/users?role=customer&q=" + q), api("/api/admin/users?role=agent&service=ibedel")]);
    renderPeople(c.users, a.users);
  } catch (e) { $("#cust-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
let searchTimer = null;
$("#cust-search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadPeople, 250); };
const openPw = {};
// A person's face photo, for admins only (the server refuses everyone else). Tap to see it bigger.
function faceAvatar(id, name, has, cls = "") {
  const L = esc(String(name || "?")[0].toUpperCase());
  return has && id ? `<button type="button" class="avatar face-av ${cls}" data-facezoom="/api/admin/face/${encodeURIComponent(id)}" data-facename="${esc(name || "")}" aria-label="Face photo of ${esc(name || "")}">${L}<img src="/api/admin/face/${encodeURIComponent(id)}" alt="" loading="lazy"></button>` : `<div class="avatar ${cls}">${L}</div>`;
}
document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-facezoom]"); if (b) { e.preventDefault(); SUUQ.zoom.open([b.dataset.facezoom], 0, b.dataset.facename || "Face photo"); } });
document.addEventListener("error", e => { if (e.target && e.target.matches && e.target.matches(".face-av img")) e.target.remove(); }, true);
function personCard(u) {
  const w = u.wallets || {}, admin = u.role === "admin";
  return `<div class="person ${u.suspended ? "susp" : ""}">
    <div class="person-top">${faceAvatar(u.id, u.name, u.has_face)}
      <div class="t"><b>${esc(u.name)}</b><small>+252 ${esc(u.phone)}${admin ? ` · admin of <b>${esc(serviceName(u.service))}</b>` : ""} · joined ${new Date(u.created_at).toLocaleDateString()}${u.role === "customer" ? ` · ${u.requests} request${u.requests === 1 ? "" : "s"}` : ""}${u.locked ? " · locked after wrong tries" : ""}</small></div>
      <span class="pill ${u.suspended ? "susp" : "active"}">${u.suspended ? "Suspended" : "Active"}</span></div>
    ${u.role === "customer" ? `<div class="wchips">${SERVICES.filter(s => w[s.id]).map(s => `<span class="wchip"><img src="${LOGO(s.id)}" alt="">${esc(w[s.id])}</span>`).join("") || `<span class="note">No wallet numbers</span>`}</div>` : ""}
    <div class="person-actions">
      ${openReset[u.id] ? `<div class="inline-form"><input class="input" id="rp-${u.id}" type="password" inputmode="numeric" maxlength="4" placeholder="New 4-digit PIN" autocomplete="new-password"><button class="btn btn-primary" data-rpsave="${u.id}">Save PIN</button><button class="btn btn-ghost" data-rpcancel="${u.id}">Cancel</button></div>`
        : `<button class="btn btn-ghost" data-rp="${u.id}">Reset PIN</button>`}
      ${admin ? (openPw[u.id] ? `<div class="inline-form"><input class="input" id="rw-${u.id}" type="password" placeholder="New password (8+)" autocomplete="new-password"><button class="btn btn-primary" data-rwsave="${u.id}">Save password</button><button class="btn btn-ghost" data-rwcancel="${u.id}">Cancel</button></div>`
        : `<button class="btn btn-ghost" data-rw="${u.id}">Reset password</button>`) : ""}
      <button class="btn ${u.suspended ? "btn-primary" : "btn-danger"}" data-susp="${u.id}" data-to="${u.suspended ? 0 : 1}">${u.suspended ? "Reactivate" : "Suspend"}</button>
      <span class="status-msg" id="pm-${u.id}"></span>
    </div></div>`;
}
// Wires the buttons inside one list; reload() fetches fresh data and repaints that list.
function bindPeople(box, reload) {
  const q = sel => box.querySelectorAll(sel);
  const note = (id, t, k) => setTimeout(() => msg("#pm-" + id, t, k), 0);
  q("[data-rp]").forEach(b => b.onclick = async () => { openReset[b.dataset.rp] = true; await reload(); const i = document.getElementById("rp-" + b.dataset.rp); if (i) i.focus(); });
  q("[data-rpcancel]").forEach(b => b.onclick = async () => { delete openReset[b.dataset.rpcancel]; await reload(); });
  q("[data-rpsave]").forEach(b => b.onclick = async () => {
    const id = b.dataset.rpsave, pin = document.getElementById("rp-" + id).value;
    try { await api(`/api/admin/users/${id}/reset-pin`, { body: { pin } }); delete openReset[id]; await reload(); note(id, "PIN changed. Give the new PIN to the person.", "ok"); }
    catch (e) { msg("#pm-" + id, e.message, "bad"); }
  });
  q("[data-rw]").forEach(b => b.onclick = async () => { openPw[b.dataset.rw] = true; await reload(); });
  q("[data-rwcancel]").forEach(b => b.onclick = async () => { delete openPw[b.dataset.rwcancel]; await reload(); });
  q("[data-rwsave]").forEach(b => b.onclick = async () => {
    const id = b.dataset.rwsave, password = document.getElementById("rw-" + id).value;
    try { await api(`/api/super/admins/${id}/reset-password`, { body: { password } }); delete openPw[id]; await reload(); note(id, "Password changed.", "ok"); }
    catch (e) { msg("#pm-" + id, e.message, "bad"); }
  });
  q("[data-susp]").forEach(b => b.onclick = async () => {
    const id = b.dataset.susp, to = b.dataset.to === "1";
    try { await api(`/api/admin/users/${id}/suspend`, { body: { suspended: to } }); await reload(); note(id, to ? "Suspended. They can't log in now." : "Reactivated.", to ? "bad" : "ok"); }
    catch (e) { msg("#pm-" + id, e.message, "bad"); }
  });
}
function renderPeople(customers, agents) {
  $("#cust-list").innerHTML = customers.length ? customers.map(u => personCard(u)).join("") : `<div class="empty">No customers found.</div>`;
  $("#agent-list").innerHTML = agents.length ? agents.map(u => personCard(u)).join("") : `<div class="empty">No agents yet. Add one above.</div>`;
  bindPeople($("#cust-list"), loadPeople); bindPeople($("#agent-list"), loadPeople);
}
$("#ag-add").onclick = async () => {
  try {
    await api("/api/admin/agents", { body: { name: $("#ag-name").value, phone: $("#ag-phone").value, pin: $("#ag-pin").value, service: "ibedel" } });
    msg("#st-ag", `Agent added. They can log in with their phone number and the PIN you set.`, "ok");
    $("#ag-name").value = ""; $("#ag-phone").value = ""; $("#ag-pin").value = ""; loadPeople();
  } catch (e) { msg("#st-ag", e.message, "bad"); }
};

/* ---------- admin: settings ---------- */
let full = null, tierDraft = null;
document.addEventListener("click", async e => {
  if (!e.target.closest || !e.target.closest("#save-earnfee")) return;
  try { full = await api("/api/admin/settings", { method: "PUT", body: { earnFeePct: $("#earn-fee").value.replace(/[^\d.]/g, "") || 0 } }); fillAdmin(); msg("#st-earnfee", "Saved. The app is updated.", "ok"); }
  catch (err) { msg("#st-earnfee", err.message, "bad"); }
});
async function loadAdminSettings() { try { full = await api("/api/admin/settings"); fillAdmin(); } catch {} }
async function saveSettings(patch, stId) {
  msg(stId, "Saving…");
  try { full = await api("/api/admin/settings", { method: "PUT", body: patch }); fillAdmin(); msg(stId, "Saved. The app is updated.", "ok"); }
  catch (e) { msg(stId, e.message, "bad"); }
}
function renderTiers(t) {
  tierDraft = structuredClone(t);
  const el = $("#tier-editor");
  el.innerHTML = CURS.map(c => `<div class="cur-block"><h4><span class="cur cur-${c}">${c}</span>${c === "USD" ? "US Dollar" : "Somaliland Shilling"}</h4>
    <div class="tier-head"><span>Amount sent up to</span><span>Flat charge</span><span></span></div>
    <div class="tiers">${tierDraft[c].map((r, i) => `<div class="tier">
      <div class="suffix">${r.upTo == null && i === tierDraft[c].length - 1 ? `<input value="Above that" disabled>` : `<input data-t="${c}:${i}:upTo" inputmode="decimal" value="${r.upTo ?? ""}">`}</div>
      <div class="suffix">${c === "USD" ? "<span>$</span>" : ""}<input data-t="${c}:${i}:fee" inputmode="decimal" value="${r.fee}">${c === "SLSH" ? "<span>SLSH</span>" : ""}</div>
      ${tierDraft[c].length > 1 && i < tierDraft[c].length - 1 ? `<button class="tier-del" data-del="${c}:${i}" aria-label="Remove band">✕</button>` : `<span></span>`}
    </div>`).join("")}</div>
    <button class="btn-link" data-add="${c}" style="align-self:flex-start">+ Add band</button></div>`).join("");
  el.querySelectorAll("[data-t]").forEach(i => i.oninput = () => { const [c, ix, f] = i.dataset.t.split(":"); tierDraft[c][+ix][f] = i.value; });
  el.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { const [c, ix] = b.dataset.del.split(":"); tierDraft[c].splice(+ix, 1); renderTiers(tierDraft); });
  el.querySelectorAll("[data-add]").forEach(b => b.onclick = () => { const c = b.dataset.add, rows = tierDraft[c], last = rows[rows.length - 1]; const prev = rows.length > 1 ? Number(rows[rows.length - 2].upTo) || 0 : 0; rows.splice(rows.length - 1, 0, { upTo: prev ? prev * 2 : (c === "USD" ? 35 : 350000), fee: last.fee }); renderTiers(tierDraft); });
}
function fillAdmin() {
  if (!full) return;
  renderTiers(full.tiers);
  const ef = $("#earn-fee"); if (ef) ef.value = full.earnFeePct ?? 0;
  $("#svc-admin").innerHTML = SERVICES.map(s => { const v = full.show[s.id]; return `<div class="vis-card ${v.on !== false ? "" : "off"}">
    <div class="vis-top"><img src="${LOGO(s.id)}" alt=""><b>${esc(s.name)}</b><label class="switch"><input type="checkbox" id="vis-${s.id}-on" ${v.on !== false ? "checked" : ""} aria-label="Show ${esc(s.name)}"><span></span></label></div>
    <div class="vis-curs">${CURS.map(c => `<label class="chk"><input type="checkbox" id="vis-${s.id}-${c}" ${v[c] !== false ? "checked" : ""}><span class="cur cur-${c}">${c}</span>${c === "USD" ? "Dollar" : "Shilling"}</label>`).join("")}</div></div>`; }).join("");
  $("#agentnums").innerHTML = SERVICES.map(s => `<div class="cur-block">
    <h4><img src="${LOGO(s.id)}" alt="" style="width:26px;height:26px;border-radius:7px">${esc(s.name)}</h4>
    <div class="mini"><label for="an-${s.id}">${s.id === "premier" ? "Agent number customers send to (shown on the upload screen)" : "Agent receiving number"}</label><div class="suffix"><input id="an-${s.id}" inputmode="tel" value="${esc(full.agentNums[s.id] || "")}"></div></div>
    <div class="grid2" style="grid-template-columns:1fr 1fr">
      <div class="mini"><label for="us-${s.id}-SLSH"><span class="cur cur-SLSH">SLSH</span> code</label><div class="suffix"><input id="us-${s.id}-SLSH" placeholder="*220*" value="${esc(full.ussd[s.id]?.SLSH || "")}"></div></div>
      <div class="mini"><label for="us-${s.id}-USD"><span class="cur cur-USD">USD</span> code</label><div class="suffix"><input id="us-${s.id}-USD" placeholder="*880*" value="${esc(full.ussd[s.id]?.USD || "")}"></div></div>
    </div></div>`).join("");
  $("#wa-num").value = full.support.whatsapp || "";
  $("#voice-script").value = full.voice.script || "";
  const a = full.voice.audio;
  $("#voice-now").innerHTML = a ? `<span class="pill sent">Recording</span><span>${esc(a.name)} · ${(a.size / 1024).toFixed(0)} KB</span>` : `<span class="pill waiting">Spoken text</span><span>No recording yet. The app reads the text below aloud.</span>`;
  $("#remove-audio").hidden = !a;
}
$("#save-fees").onclick = () => saveSettings({ tiers: tierDraft }, "#st-fees");
$("#save-svc").onclick = () => {
  const show = {}; SERVICES.forEach(s => show[s.id] = { on: $(`#vis-${s.id}-on`).checked, USD: $(`#vis-${s.id}-USD`).checked, SLSH: $(`#vis-${s.id}-SLSH`).checked });
  saveSettings({ show }, "#st-svc");
};
$("#save-agentnums").onclick = () => {
  const agentNums = {}, ussd = {};
  SERVICES.forEach(s => { agentNums[s.id] = $(`#an-${s.id}`).value; ussd[s.id] = { SLSH: $(`#us-${s.id}-SLSH`).value, USD: $(`#us-${s.id}-USD`).value }; });
  saveSettings({ agentNums, ussd }, "#st-agentnums");
};
$("#save-support").onclick = () => saveSettings({ support: { whatsapp: $("#wa-num").value } }, "#st-support");
let pendingFile = null;
$("#voice-file").onchange = e => { pendingFile = e.target.files[0] || null; if (pendingFile) msg("#st-voice", `“${pendingFile.name}” is ready. Press Save voice guide.`); };
$("#save-voice").onclick = async () => {
  try {
    if (pendingFile) {
      msg("#st-voice", "Uploading…");
      const r = await fetch("/api/admin/voice", { method: "POST", credentials: "same-origin", body: pendingFile,
        headers: { "Content-Type": pendingFile.type || "audio/mpeg", "X-File-Name": encodeURIComponent(pendingFile.name) } });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Upload failed."); full = d; pendingFile = null;
    }
    full = await api("/api/admin/settings", { method: "PUT", body: { voice: { script: $("#voice-script").value, lang: full.voice.lang } } });
    fillAdmin(); msg("#st-voice", "Saved. Customers hear the new guide.", "ok");
  } catch (e) { msg("#st-voice", e.message, "bad"); }
};
$("#remove-audio").onclick = async () => { try { full = await api("/api/admin/voice", { method: "DELETE" }); fillAdmin(); msg("#st-voice", "Recording removed.", "ok"); } catch (e) { msg("#st-voice", e.message, "bad"); } };
$("#save-pw").onclick = async () => {
  try { await api("/api/admin/password", { body: { current: $("#pw-cur").value, next: $("#pw-new").value } }); $("#pw-cur").value = ""; $("#pw-new").value = ""; msg("#st-pw", "Password changed.", "ok"); }
  catch (e) { msg("#st-pw", e.message, "bad"); }
};

/* ---------- super admin ---------- */
let supTab = "overview", overview = null, svcDraft = [], supAdmins = [];
const ARTS = () => Object.keys(window.SarrifArt?.LABELS || { general: 1 });
async function loadSuper() {
  try { overview = await api("/api/super/overview"); allServices = overview.services; svcDraft = structuredClone(allServices); } catch {}
  if (supTab === "admins") await loadSupAdmins();
  renderSuper();
}
function paintSuperTabs() {
  document.querySelectorAll("#sup-tabs [data-stab]").forEach(b => b.setAttribute("aria-pressed", b.dataset.stab === supTab));
  document.querySelectorAll("#super [data-spane]").forEach(p => p.hidden = p.dataset.spane !== supTab);
  const t = { wallets: ["Wallets", "Top up or withdraw for customers and sellers, and see your income."], overview: ["Overview", "Every service at a glance. Open a dashboard to work inside a service."], services: ["Services", "Choose what customers see on the home page. Use your own photo on any tile."], admins: ["Admins", "Give each service its own admin."] }[supTab];
  $("#sup-title").textContent = t[0]; $("#sup-sub").textContent = t[1];
}
// Push notifications settings (super admin).
// Business categories merchants choose from, each under a section (Suuq, Technician…).
let bizCats = null;
async function loadBizCats() {
  const el = document.getElementById("biz-cats-panel"); if (!el) return;
  if (!bizCats) { try { bizCats = (await api("/api/super/biz-categories")).categories.map(c => ({ ...c, subs: (c.subs || []).join(", ") })); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; } }
  const secs = (overview?.services || settings.services || []).filter(x => x.id !== "ibedel");
  el.innerHTML = `<div class="panel-head"><div><h3>Business categories (${bizCats.length})</h3><p>Merchants choose one when they register. Put each category under a section. Choices after a comma become a second question (for example Clothes → Men’s Clothing, Women’s Clothing). Tick “Shop by category” to show it on the home screen, with its photo.</p></div>
      <div class="row-actions"><span class="status-msg" id="st-bc"></span><button class="btn btn-primary" id="bc-save">Save</button></div></div>
    ${secs.map(sv => { const rows = bizCats.map((c, i) => [c, i]).filter(([c]) => c.section === sv.id); return rows.length ? `<h4 class="bc-sec">${esc(sv.name)} <span class="pill">${rows.length}</span></h4>
      <div class="bc-list">${rows.map(([c, i]) => `<div class="bc-row"><input class="input" data-bc="${i}:name" value="${esc(c.name)}" aria-label="Category name" maxlength="40">
        <select class="input" data-bc="${i}:section" aria-label="Section">${secs.map(x => `<option value="${esc(x.id)}" ${x.id === c.section ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        <input class="input" data-bc="${i}:subs" value="${esc(c.subs)}" placeholder="Second choices (optional)" aria-label="Second choices, separated by commas">
        <div class="bc-extra"><label class="bc-home"><input type="checkbox" data-bc="${i}:home" ${c.home ? "checked" : ""}> Shop by category</label>
          <span class="bc-photo">${c.photo ? `<img src="${esc(c.photo)}" alt="">` : ""}<label class="link-btn">${c.photo ? "Change photo" : "Add photo"}<input type="file" accept="image/jpeg,image/png,image/webp" data-bcph="${i}" hidden></label>${c.photo ? `<button class="link-btn" data-bcphrm="${i}">Remove photo</button>` : ""}</span>
          <button class="icon-btn" data-bcrm="${i}" aria-label="Remove ${esc(c.name)}">✕</button></div></div>`).join("")}</div>` : ""; }).join("")}
    <div class="bc-row bc-new"><input class="input" id="bc-name" placeholder="New category" maxlength="40" aria-label="New category name">
      <select class="input" id="bc-sec" aria-label="Section">${secs.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select>
      <input class="input" id="bc-subs" placeholder="Second choices (optional)" aria-label="Second choices"><button class="btn btn-ghost" id="bc-add">Add</button></div>`;
  const keep = () => el.querySelectorAll("[data-bc]").forEach(i => { const [ix, f] = i.dataset.bc.split(":"); bizCats[+ix][f] = i.type === "checkbox" ? i.checked : i.value; });
  const saveList = async () => { bizCats = (await api("/api/super/biz-categories", { method: "PUT", body: { categories: bizCats.map(c => ({ ...c, subs: String(c.subs || "").split(",") })) } })).categories.map(c => ({ ...c, subs: c.subs.join(", ") })); };
  // A photo is saved straight away (the list is saved first, so a new or renamed category is known).
  el.querySelectorAll("[data-bcph]").forEach(inp => inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return; keep(); const name = bizCats[+inp.dataset.bcph].name;
    msg("#st-bc", "Saving the photo…");
    try { await saveList(); const image = await compressImage(f, 700_000);
      bizCats = (await api("/api/super/biz-categories/photo", { body: { name, image } })).categories.map(c => ({ ...c, subs: c.subs.join(", ") }));
      await loadBizCats(); msg("#st-bc", "Photo saved.", "ok"); }
    catch (e) { msg("#st-bc", e.message, "bad"); }
  });
  el.querySelectorAll("[data-bcphrm]").forEach(b => b.onclick = async () => {
    keep(); const name = bizCats[+b.dataset.bcphrm].name;
    try { await saveList(); bizCats = (await api("/api/super/biz-categories/photo", { body: { name } })).categories.map(c => ({ ...c, subs: c.subs.join(", ") })); await loadBizCats(); msg("#st-bc", "Photo removed.", "ok"); }
    catch (e) { msg("#st-bc", e.message, "bad"); }
  });
  el.querySelectorAll("[data-bc]").forEach(i => i.onchange = () => { keep(); if (i.dataset.bc.endsWith(":section")) loadBizCats(); });
  el.querySelectorAll("[data-bcrm]").forEach(b => b.onclick = () => { keep(); bizCats.splice(+b.dataset.bcrm, 1); loadBizCats(); });
  $("#bc-add").onclick = () => { keep(); const n = $("#bc-name").value.trim(); if (!n) return $("#bc-name").focus(); bizCats.push({ name: n, section: $("#bc-sec").value, subs: $("#bc-subs").value, home: $("#bc-sec").value === "suuq", photo: "" }); loadBizCats().then(() => msg("#st-bc", "Added. Press Save to keep it.", "")); };
  $("#bc-save").onclick = async () => { keep();
    try { await saveList(); await loadBizCats(); msg("#st-bc", "Saved. New merchants see this list.", "ok"); }
    catch (e) { msg("#st-bc", e.message, "bad"); } };
}
async function loadCallSettings() {
  const el = document.getElementById("call-state"); if (!el) return;
  try { const r = await api("/api/super/call-settings");
    $("#turn-urls").value = r.urls; $("#turn-user").value = r.username;
    el.textContent = r.urls ? `TURN relay on${r.fromEnv ? " (from the server settings)" : ""}. Calls connect on strict networks too.` : "No TURN relay yet. Calls connect directly when the networks allow it.";
  } catch (e) { el.textContent = e.message; }
}
if (document.getElementById("turn-save")) $("#turn-save").onclick = async () => {
  try { await api("/api/super/call-settings", { method: "PUT", body: { urls: $("#turn-urls").value, username: $("#turn-user").value, credential: $("#turn-pass").value } }); $("#turn-pass").value = ""; msg("#st-turn", "Saved.", "ok"); loadCallSettings(); }
  catch (e) { msg("#st-turn", e.message, "bad"); }
};
async function loadPush() {
  const el = document.getElementById("push-state"); if (!el) return;
  loadCallSettings(); loadBizCats();
  try { const r = await api("/api/super/push");
    el.textContent = r.set ? `On · Firebase project ${r.project}${r.fromEnv ? " (from the server settings)" : ""} · ${r.phones} phone${r.phones === 1 ? "" : "s"} registered` : `Off · ${r.phones} phone${r.phones === 1 ? "" : "s"} ready. Paste the key to turn it on.`;
  } catch (e) { el.textContent = e.message; }
}
if (document.getElementById("push-save")) {
  $("#push-save").onclick = async () => { try { await api("/api/super/push", { method: "PUT", body: { key: $("#push-key").value.trim() } }); $("#push-key").value = ""; msg("#st-push", "Saved. Alarms now reach phones when 5PLUS is closed.", "ok"); loadPush(); } catch (e) { msg("#st-push", e.message, "bad"); } };
  $("#push-test").onclick = async () => { try { const r = await api("/api/super/push/test", { body: {} }); msg("#st-push", `Sent to ${r.phones} phone${r.phones === 1 ? "" : "s"}. Close the app to hear it ring.`, "ok"); } catch (e) { msg("#st-push", e.message, "bad"); } };
  $("#push-off").onclick = async () => { try { await api("/api/super/push", { method: "PUT", body: { clear: true } }); msg("#st-push", "Removed.", ""); loadPush(); } catch (e) { msg("#st-push", e.message, "bad"); } };
}
document.querySelectorAll("#sup-tabs [data-stab]").forEach(b => b.onclick = async () => { supTab = b.dataset.stab; paintSuperTabs(); if (supTab === "services") loadPush(); if (supTab === "wallets") { SUUQ.resetSuper(); return SUUQ.renderSuperWallets(); } if (supTab === "admins") await loadSupAdmins(); renderSuper(); });
function staffCount(role, service) { return (overview?.staff || []).filter(x => x.role === role && x.service === service).reduce((a, x) => a + x.n, 0); }
function renderSuper() {
  if (!overview) return;
  paintSuperTabs();
  const ib = overview.ibedel;
  $("#sup-overview").innerHTML = overview.services.map(sv => `<div class="sup-card">
    <span class="hub-art">${ART(sv.art, sv.photo)}</span>
    <div class="body">
      <div class="top"><b>${esc(sv.name)}</b>${sv.visible ? `<span class="pill active">Visible</span>` : `<span class="pill hidden-pill">Hidden</span>`}${sv.ready ? "" : `<span class="soon">Coming soon</span>`}</div>
      <div class="sup-stats">
        <div><b>${staffCount("admin", sv.id)}</b>admin${staffCount("admin", sv.id) === 1 ? "" : "s"}</div>
        <div><b>${staffCount("agent", sv.id)}</b>agent${staffCount("agent", sv.id) === 1 ? "" : "s"}</div>
        ${sv.id === "ibedel" ? `<div><b>${ib.waiting}</b>waiting requests</div><div><b>${ib.sentMonth.map(r => fmt(r.fees || 0, r.cur)).join(" · ") || "—"}</b>charges this month</div>` : ""}
      </div>
      ${staffCount("admin", sv.id) ? "" : `<span class="note" style="color:var(--danger)">No admin yet. Add one in the Admins tab.</span>`}
      <button class="btn btn-primary" data-open="${esc(sv.id)}">Open dashboard</button>
    </div></div>`).join("") + `<div class="sup-card" style="justify-content:center;align-items:center;padding:20px;text-align:center;gap:8px"><b style="font-family:var(--display)">${overview.customers}</b><span class="note">registered customers in total</span></div>`;
  document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openDashboard(b.dataset.open));
  // services editor
  $("#ns-art").innerHTML = ARTS().map(k => `<option value="${k}">${esc(window.SarrifArt.LABELS[k])}</option>`).join("");
  $("#svc-edit").innerHTML = svcDraft.map((sv, i) => `<div class="svc-edit ${sv.visible ? "" : "off"}">
    <div class="thumb">${sv._photoData ? `<img class="art-photo" src="${sv._photoData}" alt="">` : ART(sv.art, sv.photo)}</div>
    <div class="fields">
      <input class="input" data-f="name" data-i="${i}" value="${esc(sv.name)}" maxlength="30" aria-label="Name">
      <input class="input" data-f="sub" data-i="${i}" value="${esc(sv.sub)}" maxlength="60" aria-label="Description">
      <textarea class="input svc-vids" data-f="videos" data-i="${i}" rows="3" placeholder="Videos, one per line: the YouTube link, then the title (optional)" aria-label="Videos, one per line: the YouTube link, then the title">${esc(videoLines(sv))}</textarea>
      <input class="input" data-f="whatsapp" data-i="${i}" value="${esc(sv.whatsapp || "")}" inputmode="tel" placeholder="WhatsApp number for this service (optional)" aria-label="WhatsApp number for this service">
      <input class="input" data-f="phone" data-i="${i}" value="${esc(sv.phone || "")}" inputmode="tel" placeholder="Phone number for the Call button (optional)" aria-label="Phone number for the Call button">
      <input class="input" data-f="tiktok" data-i="${i}" value="${esc(sv.tiktok || "")}" inputmode="url" placeholder="TikTok link (optional)" aria-label="TikTok link">
      <select class="input" data-f="art" data-i="${i}" aria-label="Picture">${ARTS().map(k => `<option value="${k}" ${k === sv.art ? "selected" : ""}>${esc(window.SarrifArt.LABELS[k])}</option>`).join("")}</select>
    </div>
    <div class="acts">
      <button class="icon-btn" data-mv="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
      <button class="icon-btn" data-mv="${i}:1" ${i === svcDraft.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
      <label class="chk"><input type="checkbox" data-vis="${i}" ${sv.visible ? "checked" : ""}>Visible</label>
      ${sv.id ? `<label class="btn btn-ghost svc-photo-btn">${sv.photo ? "Change photo" : "Use my photo"}<input type="file" accept="image/jpeg,image/png,image/webp" data-svcphoto="${esc(sv.id)}" hidden></label>${sv.photo ? `<button class="btn btn-ghost svc-photo-btn" data-svcnophoto="${esc(sv.id)}">Remove photo</button>` : ""}`
        : `<label class="btn btn-ghost svc-photo-btn">${sv._photoData ? "Change photo" : "Use my photo"}<input type="file" accept="image/jpeg,image/png,image/webp" data-svcnewphoto="${i}" hidden></label>${sv._photoData ? `<button class="btn btn-ghost svc-photo-btn" data-svcnewnophoto="${i}">Remove photo</button>` : ""}`}
      ${sv.builtIn ? "" : (sv._confirm ? `<button class="btn btn-danger" data-rmyes="${i}" style="min-height:34px;padding:5px 10px">Delete</button><button class="btn btn-ghost" data-rmno="${i}" style="min-height:34px;padding:5px 10px">Keep</button>` : `<button class="icon-btn" data-rm="${i}" aria-label="Delete service">✕</button>`)}
    </div></div>`).join("");
  document.querySelectorAll("#svc-edit [data-f]").forEach(el => el.oninput = el.onchange = () => { svcDraft[+el.dataset.i][el.dataset.f] = el.value; if (el.dataset.f === "art") renderSuper(); });
  document.querySelectorAll("#svc-edit [data-vis]").forEach(el => el.onchange = () => { svcDraft[+el.dataset.vis].visible = el.checked; renderSuper(); });
  document.querySelectorAll("#svc-edit [data-mv]").forEach(el => el.onclick = () => { const [i, d] = el.dataset.mv.split(":").map(Number); const t = svcDraft[i]; svcDraft[i] = svcDraft[i + d]; svcDraft[i + d] = t; renderSuper(); });
  document.querySelectorAll("#svc-edit [data-svcphoto]").forEach(el => el.onchange = async () => {
    const f = el.files[0]; if (!f) return;
    try {
      msg("#st-svcs", "Uploading the photo…");
      const image = await compressImage(f, 2_000_000);
      await svcPhotoDone(await api(`/api/super/services/${encodeURIComponent(el.dataset.svcphoto)}/photo`, { body: { image } }), "Photo saved. Customers see it on the home page now.");
    } catch (e) { msg("#st-svcs", e.message || "That photo could not be used.", "bad"); }
  });
  // A service that isn't saved yet keeps its photo in the list; it is uploaded when you press Save services.
  document.querySelectorAll("#svc-edit [data-svcnewphoto]").forEach(el => el.onchange = async () => {
    const f = el.files[0]; if (!f) return;
    try { svcDraft[+el.dataset.svcnewphoto]._photoData = await compressImage(f, 2_000_000); renderSuper(); msg("#st-svcs", "Photo chosen. Press Save services to publish it.", "ok"); }
    catch { msg("#st-svcs", "That photo could not be used. Choose a JPG, PNG or WebP photo.", "bad"); }
  });
  document.querySelectorAll("#svc-edit [data-svcnewnophoto]").forEach(el => el.onclick = () => { delete svcDraft[+el.dataset.svcnewnophoto]._photoData; renderSuper(); });
  document.querySelectorAll("#svc-edit [data-svcnophoto]").forEach(el => el.onclick = async () => {
    try { await svcPhotoDone(await api(`/api/super/services/${encodeURIComponent(el.dataset.svcnophoto)}/photo`, { method: "DELETE" }), "Photo removed. The standard picture is back."); }
    catch (e) { msg("#st-svcs", e.message, "bad"); }
  });
  document.querySelectorAll("#svc-edit [data-rm]").forEach(el => el.onclick = () => { svcDraft[+el.dataset.rm]._confirm = true; renderSuper(); });
  document.querySelectorAll("#svc-edit [data-rmno]").forEach(el => el.onclick = () => { delete svcDraft[+el.dataset.rmno]._confirm; renderSuper(); });
  document.querySelectorAll("#svc-edit [data-rmyes]").forEach(el => el.onclick = () => { svcDraft.splice(+el.dataset.rmyes, 1); msg("#st-svcs", "Removed from the list. Press Save services to apply."); renderSuper(); });
  $("#sa-service").innerHTML = allServices.map(sv => `<option value="${esc(sv.id)}">${esc(sv.name)}</option>`).join("");
  $("#sup-admins").innerHTML = supAdmins.length ? supAdmins.map(u => personCard(u, true)).join("") : `<div class="empty">No service admins yet. Add one above.</div>`;
  bindPeople($("#sup-admins"), loadSupAdminsAndPaint);
}
// Videos as the admin edits them: one per line, the link then the title.
const videoLines = sv => typeof sv.videos === "string" ? sv.videos
  : (Array.isArray(sv.videos) ? sv.videos : sv.video ? [sv.video] : []).map(v => typeof v === "string" ? v : `${v.url}${v.title ? " " + v.title : ""}`).join("\n");
// A new photo only changes that one service; any other edits not saved yet stay in the draft.
async function svcPhotoDone(r, note) {
  const byId = Object.fromEntries(r.services.map(x => [x.id, x.photo]));
  svcDraft.forEach(x => { if (x.id in byId) x.photo = byId[x.id]; });
  if (overview) overview.services.forEach(x => { if (x.id in byId) x.photo = byId[x.id]; });
  allServices = allServices.map(x => x.id in byId ? { ...x, photo: byId[x.id] } : x);
  renderSuper(); msg("#st-svcs", note, "ok");
}
async function loadSupAdmins() { try { supAdmins = (await api("/api/admin/users?role=admin")).users; } catch { supAdmins = []; } }
async function loadSupAdminsAndPaint() { await loadSupAdmins(); renderSuper(); }
function openDashboard(id) { S.viewAs = id; admTab = "requests"; if (id === "ibedel") { loadRequests(); loadAdminSettings(); } render(); }
$("#ns-add").onclick = async () => {
  const name = $("#ns-name").value.trim(), sub = $("#ns-sub").value.trim();
  if (name.length < 2) return msg("#st-ns", "Enter a name for the service.", "bad");
  if (svcDraft.some(x => x.name.toLowerCase() === name.toLowerCase())) return msg("#st-ns", "A service with this name already exists.", "bad");
  const file = $("#ns-photo").files[0];
  let _photoData;
  if (file) { try { _photoData = await compressImage(file, 2_000_000); } catch { return msg("#st-ns", "That photo could not be used. Choose a JPG, PNG or WebP photo.", "bad"); } }
  const btn = $("#ns-add"); btn.disabled = true; msg("#st-ns", "Adding…");
  svcDraft.push({ id: "", name, sub, videos: $("#ns-video").value.trim(), whatsapp: $("#ns-wa").value.trim(), phone: $("#ns-phone").value.trim(), tiktok: $("#ns-tiktok").value.trim(), art: $("#ns-art").value, visible: true, ready: false, builtIn: false, ...(_photoData ? { _photoData } : {}) });
  try {
    const failed = await saveServices();
    $("#ns-name").value = ""; $("#ns-sub").value = ""; $("#ns-photo").value = ""; $("#ns-video").value = ""; $("#ns-wa").value = ""; $("#ns-phone").value = ""; $("#ns-tiktok").value = "";
    msg("#st-ns", failed ? `${name} is on the services page now, but its photo could not be uploaded. Use Change photo in the list.` : `${name} is on the services page now, marked “Coming soon”.`, failed ? "bad" : "ok");
  } catch (e) {
    svcDraft = svcDraft.filter(x => !(x.id === "" && x.name === name)); renderSuper();
    msg("#st-ns", e.message, "bad");
  } finally { btn.disabled = false; }
};
// Saves the whole list (and uploads photos chosen before saving). Returns how many photos failed.
async function saveServices() {
  const pending = svcDraft.map((x, i) => x._photoData ? { i, data: x._photoData } : null).filter(Boolean);
  const r = await api("/api/super/services", { method: "PUT", body: { services: svcDraft.map(({ _confirm, _photoData, ...x }) => x) } });
  allServices = r.services;
  // The server keeps the order of the list, so position i is the same service.
  let failed = 0;
  for (const p of pending) {
    const sv = r.services[p.i]; if (!sv) continue;
    try { await api(`/api/super/services/${encodeURIComponent(sv.id)}/photo`, { body: { image: p.data } }); } catch { failed++; }
  }
  await loadSuper();
  return failed;
}
$("#save-svcs").onclick = async () => {
  try {
    const failed = await saveServices();
    msg("#st-svcs", failed ? "Saved, but a photo could not be uploaded. Try Change photo again." : "Saved. Customers see the new home page now.", failed ? "bad" : "ok");
  } catch (e) { msg("#st-svcs", e.message, "bad"); }
};
$("#sa-add").onclick = async () => {
  try {
    await api("/api/super/admins", { body: { service: $("#sa-service").value, name: $("#sa-name").value, phone: $("#sa-phone").value, pin: $("#sa-pin").value, password: $("#sa-pw").value } });
    msg("#st-sa", `Admin added for ${serviceName($("#sa-service").value)}.`, "ok");
    ["#sa-name", "#sa-phone", "#sa-pin", "#sa-pw"].forEach(k => $(k).value = "");
    await loadSupAdmins(); await loadSuper();
  } catch (e) { msg("#st-sa", e.message, "bad"); }
};

/* ---------- dashboard for services that are not built yet ---------- */
// Service admin (Saba…): documents customers sent (pictures, PDF, Word). Open or download each file; mark the set done.
let tkDocsTab = "new";
async function loadSvcDocs() {
  const el = document.getElementById("svc-admin-docs"); if (!el) return;
  const svc = el.dataset.svc;
  let r; try { r = await api(`/api/admin/service-docs/${encodeURIComponent(svc)}?status=` + tkDocsTab); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const fileEl = f => f.type.startsWith("image/")
    ? `<a class="doc-thumb" href="${esc(f.url)}" target="_blank" rel="noopener" title="${esc(f.name)}"><img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy"></a>`
    : `<a class="doc-chip" href="${esc(f.url)}${f.type === "application/pdf" ? "" : "?download=1"}" target="_blank" rel="noopener" download="${esc(f.name)}">${DOC_ICON}<span><b>${esc(f.name)}</b><small>${docKind(f.name)} · ${kb(f.size)}</small></span></a>`;
  el.innerHTML = `<div class="panel-head"><div><h3>Documents from customers${r.new ? ` <span class="pill warn">${r.new} new</span>` : ""}</h3><p>Pictures, PDF and Word files customers send from the Documents tab. Tap a file to open it. Give each person a fixed earning for their documents; it goes to their My earnings and they see it in the Earn tab.</p></div></div>
    <div class="agent-tabs" role="group"><button data-tkdt="new" aria-pressed="${tkDocsTab === "new"}">New</button><button data-tkdt="done" aria-pressed="${tkDocsTab === "done"}">Done</button></div>
    <div class="people">${r.docs.length ? r.docs.map(d => `<div class="person doc-set"><div class="person-top"><div class="avatar">${esc((d.name || "?")[0].toUpperCase())}</div>
      <div class="t"><b>${esc(d.name)}</b><small><a href="tel:+252${esc(d.phone)}">+252 ${esc(d.phone)}</a> · ${new Date(d.created_at).toLocaleString()} · ${d.files.length} file${d.files.length > 1 ? "s" : ""}</small></div></div>
      ${d.note ? `<p class="onote" style="margin:0">“${esc(d.note)}”</p>` : ""}
      <div class="doc-files">${d.files.map(fileEl).join("")}</div>
      ${d.earn_amount > 0 ? `<p class="note" style="margin:0">Earning given: <b class="num">${esc(fmt(d.earn_amount, d.earn_cur))}</b></p>`
        : `<div class="earn-give"><label class="mini"><span class="label">Earning for ${esc(d.name)}</span><div class="suffix"><select data-ecur="${esc(d.id)}">${CURS.map(c => `<option ${(r.earn_default?.cur || "USD") === c ? "selected" : ""}>${c}</option>`).join("")}</select><input data-eamt="${esc(d.id)}" inputmode="decimal" value="${r.earn_default?.amount ? esc(r.earn_default.amount) : ""}" placeholder="0"></div></label><button class="btn btn-ghost" data-egive="${esc(d.id)}">Give earning</button></div>`}
      <div class="person-actions"><button class="btn ${d.status === "new" ? "btn-primary" : "btn-ghost"}" data-tkdone="${esc(d.id)}" data-to="${d.status === "new" ? "done" : "new"}">${d.status === "new" ? "Mark done" : "Move back to new"}</button></div></div>`).join("")
      : `<div class="empty">${tkDocsTab === "new" ? "No new documents." : "Nothing here yet."}</div>`}</div>`;
  el.querySelectorAll("[data-tkdt]").forEach(b => b.onclick = () => { tkDocsTab = b.dataset.tkdt; loadSvcDocs(); });
  el.querySelectorAll("[data-egive]").forEach(b => b.onclick = async () => {
    const id = b.dataset.egive, amount = el.querySelector(`[data-eamt="${id}"]`).value.replace(/[^\d.]/g, ""), cur = el.querySelector(`[data-ecur="${id}"]`).value;
    b.disabled = true;
    try { await api(`/api/admin/service-docs/${encodeURIComponent(svc)}/${id}/earn`, { body: { amount: Number(amount), cur } }); loadSvcDocs(); }
    catch (e) { b.disabled = false; alert(e.message); }
  });
  el.querySelectorAll("[data-tkdone]").forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/api/admin/service-docs/${encodeURIComponent(svc)}/${b.dataset.tkdone}`, { body: { status: b.dataset.to } }); } catch {} loadSvcDocs(); });
}
// Service admin: chats with customers (the Chat tab on the service page). Reply with text, pictures, files or voice.
let deskChat = { list: null, open: null, msgs: [] };
async function loadDeskChats(keepOpen) {
  const el = document.getElementById("svc-admin-chats"); if (!el) return;
  const svc = el.dataset.svc, C = SUUQ.CHAT;
  try { deskChat.list = (await api(`/api/admin/service-chats/${encodeURIComponent(svc)}`)).chats; } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (keepOpen && deskChat.open) { try { const r = await api(`/api/admin/service-chats/${encodeURIComponent(svc)}/${deskChat.open.id}`); deskChat.open = r.chat; deskChat.msgs = r.messages; } catch {} }
  const o = deskChat.open;
  el.innerHTML = `<div class="panel-head"><div><h3>Customer chats${deskChat.list.some(c => c.unread) ? ` <span class="pill warn">${deskChat.list.reduce((a, c) => a + c.unread, 0)} new</span>` : ""}</h3><p>Customers chat from the Chat tab on the service page. Only admins of this service see these chats.</p></div></div>
    ${o ? `<div class="desk-thread"><div class="svc-bar"><button class="btn btn-ghost" data-dcback>‹ All chats</button><div style="flex:1;min-width:0"><b>${esc(o.name)}</b><small class="note" style="display:block">+252 ${esc(o.phone)}</small></div>${C.callBtn(o.id, o.name, "+252" + o.phone)}</div>
      <div class="msgs" id="desk-msgs" data-conv="${esc(o.id)}">${deskChat.msgs.map(m => C.msgHtml(m, o.other_read_at)).join("") || `<div class="empty">No messages yet.</div>`}</div>${C.composerHtml("desk-composer")}</div>`
    : deskChat.list.length ? `<div class="olist">${deskChat.list.map(c => `<button class="ccard" data-dcopen="${esc(c.id)}"><span class="noimg">${esc((c.name || "?")[0].toUpperCase())}</span>
        <span class="t"><b>${esc(c.name)}</b><small>+252 ${esc(c.phone)}</small><small class="last">${c.last.mine ? "You: " : ""}${esc(c.last.body)}</small></span>${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</button>`).join("")}</div>`
    : `<div class="empty">No chats yet.</div>`}`;
  el.querySelectorAll("[data-dcopen]").forEach(b => b.onclick = async () => { const r = await api(`/api/admin/service-chats/${encodeURIComponent(svc)}/${b.dataset.dcopen}`); deskChat.open = r.chat; deskChat.msgs = r.messages; loadDeskChats(); });
  const back = el.querySelector("[data-dcback]"); if (back) back.onclick = () => { deskChat.open = null; loadDeskChats(); };
  if (o) {
    C.bindMsgs(document.getElementById("desk-msgs"));
    C.bindComposer(document.getElementById("desk-composer"), async payload => { await api(`/api/admin/service-chats/${encodeURIComponent(svc)}/${o.id}`, { body: payload }); await loadDeskChats(true); });
  }
}
// Ticket admin: choose the admin's own travel agency. It gets half of all new ticket requests (every second one).
async function loadTicketAgency() {
  const el = document.getElementById("tk-admin-agency"); if (!el) return;
  let r; try { r = await api("/api/admin/ticket-agency"); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const pct = r.stats.total ? Math.round(r.stats.admin * 100 / r.stats.total) : 0;
  el.innerHTML = `<div class="panel-head"><div><h3>Admin agency</h3><p>Your own travel agency gets half of all ticket requests: every second request goes to it, whichever agency the customer chose. The agency accepts or rejects; a rejected request goes to another agency.</p></div></div>
    <div class="grid2"><div class="mini"><label for="tk-ag">Admin agency</label><select class="input" id="tk-ag"><option value="0">None (customers' choice only)</option>${r.agencies.map(a => `<option value="${a.id}" ${a.id === r.agency ? "selected" : ""}>${esc(a.name)}${a.city ? " · " + esc(a.city) : ""}</option>`).join("")}</select></div></div>
    <div class="kpis"><div class="kpi"><span class="label">Ticket requests</span><b class="num">${r.stats.total}</b></div><div class="kpi"><span class="label">To the admin agency</span><b class="num">${r.stats.admin} (${pct}%)</b></div></div>
    <div class="row-actions"><button class="btn btn-primary" id="tk-ag-save">Save</button><span class="status-msg" id="st-tkag"></span></div>`;
  $("#tk-ag-save").onclick = async () => { try { await api("/api/admin/ticket-agency", { method: "PUT", body: { agency: Number($("#tk-ag").value) } }); await loadTicketAgency(); msg("#st-tkag", "Saved.", "ok"); } catch (e) { msg("#st-tkag", e.message, "bad"); } };
}
let svcAgents = [], svcPage = null;
async function loadSvcAgents() {
  try { svcAgents = (await api(`/api/admin/users?role=agent&service=${encodeURIComponent(currentService())}`)).users; } catch { svcAgents = []; }
  try { svcPage = currentService() === "ibedel" ? null : await api(`/api/admin/service-page/${encodeURIComponent(currentService())}`); } catch { svcPage = null; }
  renderSvcDash(true);
}
/* Tracking numbers (admin side): add one, then update its status, place and note as it moves. */
let trkAdm = { svc: null, list: null, statuses: [], q: "", edit: null };
function trkAdminReload(svc) {
  if (trkAdm.svc !== svc || !document.getElementById("trk-admin")) return;
  api(`/api/admin/service-page/${encodeURIComponent(svc)}/tracking`).then(r => { trkAdm.list = r.trackings; trkAdm.statuses = r.statuses; drawTrkList(); }).catch(() => {});
}
function trkAdminPanel(id, name) {
  if (trkAdm.svc !== id) trkAdm = { svc: id, list: null, statuses: [], q: "", edit: null };
  if (trkAdm.list === null) setTimeout(() => trkAdminReload(id), 0);
  return `<div class="panel" id="trk-admin">
    <div class="panel-head"><div><h3>${esc(name)} tracking</h3><p>Give customers a tracking number, then update it as the order moves. They see it in the Tracking tab.</p></div></div>
    <div class="grid2">
      <div class="mini"><label for="ta-item">What is it</label><input class="input" id="ta-item" placeholder="Excavator spare parts, 2 boxes"></div>
      <div class="mini"><label for="ta-cust">Customer name</label><input class="input" id="ta-cust"></div>
      <div class="mini"><label for="ta-phone">Customer phone</label><input class="input" id="ta-phone" inputmode="tel" placeholder="63 4000000"></div>
      <div class="mini"><label for="ta-code">Tracking number (empty = made for you)</label><input class="input" id="ta-code" autocapitalize="characters" autocomplete="off"></div>
      <div class="mini"><label for="ta-status">Status</label><select class="input" id="ta-status">${trkOpts("")}</select></div>
      <div class="mini"><label for="ta-loc">Where it is now</label><input class="input" id="ta-loc" placeholder="Dubai warehouse"></div>
    </div>
    <div class="mini"><label for="ta-note">Note for the customer</label><input class="input" id="ta-note"></div>
    <div class="row-actions"><button class="btn btn-primary" id="ta-add">Add tracking</button><span class="status-msg" id="st-ta"></span></div>
    <div class="mini"><input class="input" id="ta-q" placeholder="Search tracking number, customer or phone" aria-label="Search tracking"></div>
    <div id="ta-list" class="people"><div class="empty">Loading…</div></div></div>`;
}
const TRK_ALL = ["Order received", "Processing", "Shipped", "In transit", "Arrived", "Ready for pickup", "Delivered", "Cancelled"];
const trkOpts = cur => (trkAdm.statuses.length ? trkAdm.statuses : TRK_ALL).map(x => `<option value="${esc(x)}" ${x === cur ? "selected" : ""}>${esc(x)}</option>`).join("");
function drawTrkList() {
  const box = document.getElementById("ta-list"); if (!box || !trkAdm.list) return;
  const q = trkAdm.q.trim().toLowerCase();
  const list = trkAdm.list.filter(t => !q || [t.code, t.customer, t.phone, t.item].some(x => String(x || "").toLowerCase().includes(q)));
  box.innerHTML = list.length ? list.map(t => trkAdm.edit === t.id ? `<div class="trk-admin-row" data-trkid="${t.id}">
      <div class="trk-top"><div><small>Tracking number</small><b class="num" data-no-i18n>${esc(t.code)}</b></div></div>
      <div class="grid2">
        <div class="mini"><label>Status</label><select class="input" data-f="status">${trkOpts(t.status)}</select></div>
        <div class="mini"><label>Where it is now</label><input class="input" data-f="location" value="${esc(t.location)}"></div>
        <div class="mini"><label>What is it</label><input class="input" data-f="item" value="${esc(t.item)}"></div>
        <div class="mini"><label>Customer name</label><input class="input" data-f="customer" value="${esc(t.customer)}"></div>
        <div class="mini"><label>Customer phone</label><input class="input" data-f="phone" inputmode="tel" value="${esc(t.phone)}"></div>
      </div>
      <div class="mini"><label>Note for the customer</label><input class="input" data-f="note" value="${esc(t.note)}"></div>
      <div class="row-actions"><button class="btn btn-primary" data-trksave>Update</button><button class="btn btn-ghost" data-trkcancel>Cancel</button><button class="btn btn-ghost" data-trkdel style="margin-inline-start:auto;color:var(--danger)">Delete</button><span class="status-msg"></span></div></div>`
    : `<div class="trk-admin-row" data-trkid="${t.id}">
      <div class="trk-top"><div><small>Tracking number</small><b class="num" data-no-i18n>${esc(t.code)}</b></div><span class="trk-status s${Math.max(TRACK_STEPS.indexOf(t.status), 0)}">${esc(t.status)}</span></div>
      <small>${esc(t.item || "")}${t.customer ? ` · <span data-no-i18n>${esc(t.customer)}</span>` : ""}${t.phone ? ` · <span class="num">${esc(t.phone)}</span>` : ""}${t.location ? ` · <span data-no-i18n>${esc(t.location)}</span>` : ""}</small>
      <small class="trk-upd">Last update: ${when(t.updated_at)} · ${t.history.length} update${t.history.length === 1 ? "" : "s"}</small>
      <div class="row-actions"><button class="btn btn-ghost" data-trkedit>Update tracking</button></div></div>`).join("")
    : `<div class="empty">${trkAdm.list.length ? "Nothing matches." : "No tracking numbers yet."}</div>`;
  box.querySelectorAll("[data-trkedit]").forEach(b => b.onclick = () => { trkAdm.edit = Number(b.closest("[data-trkid]").dataset.trkid); drawTrkList(); });
  box.querySelectorAll("[data-trkcancel]").forEach(b => b.onclick = () => { trkAdm.edit = null; drawTrkList(); });
  box.querySelectorAll("[data-trksave]").forEach(b => b.onclick = async () => {
    const row = b.closest("[data-trkid]"), st = row.querySelector(".status-msg"), body = {};
    row.querySelectorAll("[data-f]").forEach(f => body[f.dataset.f] = f.value);
    b.disabled = true; st.textContent = "Saving…";
    try { const r = await api(`/api/admin/service-page/${encodeURIComponent(trkAdm.svc)}/tracking/${row.dataset.trkid}`, { method: "PUT", body });
      trkAdm.list = trkAdm.list.map(t => t.id === r.tracking.id ? r.tracking : t); trkAdm.edit = null; drawTrkList(); msg("#st-ta", `Updated ${r.tracking.code}. The customer sees it now.`, "ok"); }
    catch (e) { st.textContent = e.message; st.className = "status-msg bad"; b.disabled = false; }
  });
  box.querySelectorAll("[data-trkdel]").forEach(b => b.onclick = async () => {
    const row = b.closest("[data-trkid]"); if (!confirm(window.SarrifI18n ? SarrifI18n.t("Delete this tracking number?") : "Delete this tracking number?")) return;
    try { await api(`/api/admin/service-page/${encodeURIComponent(trkAdm.svc)}/tracking/${row.dataset.trkid}`, { method: "DELETE" }); trkAdm.list = trkAdm.list.filter(t => t.id !== Number(row.dataset.trkid)); trkAdm.edit = null; drawTrkList(); }
    catch (e) { alert(e.message); }
  });
}
function bindTrkAdmin(id) {
  drawTrkList();
  const q = $("#ta-q"); if (q) { q.value = trkAdm.q; q.oninput = () => { trkAdm.q = q.value; drawTrkList(); }; }
  const add = $("#ta-add"); if (!add) return;
  add.onclick = async () => {
    add.disabled = true; msg("#st-ta", "Saving…");
    try {
      const r = await api(`/api/admin/service-page/${encodeURIComponent(id)}/tracking`, { body: { item: $("#ta-item").value, customer: $("#ta-cust").value, phone: $("#ta-phone").value, code: $("#ta-code").value, status: $("#ta-status").value, location: $("#ta-loc").value, note: $("#ta-note").value } });
      trkAdm.list = [r.tracking, ...(trkAdm.list || [])];
      ["#ta-item", "#ta-cust", "#ta-phone", "#ta-code", "#ta-loc", "#ta-note"].forEach(k => $(k).value = "");
      drawTrkList(); msg("#st-ta", `Added. Tracking number: ${r.tracking.code}`, "ok");
    } catch (e) { msg("#st-ta", e.message, "bad"); } finally { add.disabled = false; }
  };
}
function renderSvcDash(fromLoad) {
  const m = mode(), id = currentService(), name = serviceName(id), sv = allServices.find(x => x.id === id) || hubServices().find(x => x.id === id);
  const el = $("#svcdash");
  if (id === "suuq" && m === "svc-admin" && SUUQ.adminTab !== "agents") return SUUQ.renderAdmin(el);
  if (id === "visa" && m === "svc-admin" && SUUQ.visaTab !== "agents") return SUUQ.renderVisaAdmin(el);
  if (id === "scholarship" && m === "svc-admin" && SUUQ.scholarTab !== "agents") return SUUQ.renderScholarAdmin(el);
  if (m === "svc-agent") {
    el.innerHTML = `<div class="admin-head"><div><span class="label">${esc(name)} agent</span><h2>${esc(name)} requests</h2><p>No requests yet. ${esc(name)} is still being built; its customer requests will appear here once it opens.</p></div></div>
      <div class="panel empty">Nothing to handle right now.</div>`;
    return;
  }
  if (!fromLoad) { el.innerHTML = `<div class="panel empty">Loading…</div>`; loadSvcAgents(); return; }
  el.innerHTML = (id === "suuq" ? `<div class="admin-head"><div><span class="label">Suuq admin</span><h2>Suuq dashboard</h2><p>Sellers, their products and the subscription plans.</p></div></div>${SUUQ.adminTabs()}<div hidden>`
    : id === "visa" ? `<div class="admin-head"><div><span class="label">Visa admin</span><h2>Visa dashboard</h2><p>Visas that sellers list, and the words they can show instead of a price.</p></div></div>${SUUQ.visaTabs()}<div hidden>`
    : id === "scholarship" ? `<div class="admin-head"><div><span class="label">Scholarship admin</span><h2>Scholarship dashboard</h2><p>Scholarships that travel agencies post, and which agencies may post them.</p></div></div>${SUUQ.scholarTabs()}<div hidden>` : "") + `<div class="admin-head"><div><span class="label">${esc(name)} admin</span><h2>${esc(name)} dashboard</h2><p>${(svcPage?.videos || []).length ? "Customers see this service's videos page, with your Call, WhatsApp and TikTok buttons." : `This service is ${sv?.ready ? "open" : "still being built. Customers see it as “Coming soon”"}. You can already set up its agents.`}</p></div></div>
    ${sv ? `<div class="sup-card" style="max-width:420px"><span class="hub-art">${ART(sv.art, sv.photo)}</span></div>` : ""}
    ${m === "svc-admin" && !["suuq", "visa", "scholarship", "ibedel"].includes(id) ? `<div id="safe-desk"><div class="panel empty">Loading…</div></div>` : ""}
    ${svcPage ? `<div class="panel">
      <div class="panel-head"><div><h3>${esc(name)} videos page</h3><p>With videos, customers see a page like YouTube instead of “Coming soon”. Only admins can change it.</p></div></div>
      <div class="mini"><label for="sp-videos">Videos: one per line, the YouTube link then the title</label>
        <textarea class="input" id="sp-videos" rows="5" placeholder="https://youtu.be/… Our new shop">${esc(videoLines(svcPage))}</textarea></div>
      <div class="grid2">
        <div class="mini"><label for="sp-phone">Phone for the Call button</label><input class="input" id="sp-phone" inputmode="tel" value="${esc(svcPage.phone)}" placeholder="0634000000"></div>
        <div class="mini"><label for="sp-merchant">Merchant number (for "Pay to shop")</label><input class="input" id="sp-merchant" inputmode="numeric" value="${esc(svcPage.merchant || "")}" placeholder="500123"></div>
        <div class="mini"><label for="sp-wa">WhatsApp number</label><input class="input" id="sp-wa" inputmode="tel" value="${esc(svcPage.whatsapp)}" placeholder="252634000000"></div>
        <div class="mini"><label for="sp-tiktok">TikTok link</label><input class="input" id="sp-tiktok" inputmode="url" value="${esc(svcPage.tiktok)}" placeholder="https://www.tiktok.com/@…"></div>
      </div>
      <div class="row-actions"><button class="btn btn-primary" id="sp-save">Save page</button><span class="status-msg" id="st-sp"></span></div>
      <h3 style="font-size:15px;margin-top:8px">Moving pictures (${(svcPage.gallery || []).length})</h3>
      <p class="note" style="margin:0">They move on the ${esc(name)} tile and at the top of its page. Up to 40 photos.</p>
      <div class="gal-admin">${(svcPage.gallery || []).map(g => `<div class="gal-item"><img src="${esc(g.src)}" alt="${esc(g.title)}" loading="lazy"><button class="icon-btn" data-galrm="${esc(g.src.split("/").pop())}" aria-label="Remove ${esc(g.title || "photo")}">✕</button>${g.title ? `<small>${esc(g.title)}</small>` : ""}</div>`).join("")}</div>
      <div class="row-actions"><label class="btn btn-ghost">Add photos<input type="file" id="sp-gal" accept="image/jpeg,image/png,image/webp" multiple hidden></label><span class="status-msg" id="st-gal"></span></div>
    </div>` : ""}
    ${svcPage ? trkAdminPanel(id, name) : ""}
    ${id === "technician" ? `<div class="panel" id="mk-review"><div class="empty">Loading…</div></div>` : ""}
    ${id === "ticket" ? `<div class="panel" id="tk-admin-agency"><div class="empty">Loading…</div></div>` : ""}
    ${svcPage && !["suuq", "visa", "scholarship", "ticket", "ibedel"].includes(id) && (svcPage.videos || []).length ? `<div class="panel" id="svc-admin-docs" data-svc="${esc(id)}"><div class="empty">Loading…</div></div><div class="panel" id="svc-admin-chats" data-svc="${esc(id)}"><div class="empty">Loading…</div></div>` : ""}
    ${svcPage && !["suuq", "visa", "scholarship", "ticket", "ibedel"].includes(id) ? SUUQ.itemsPanel(id, name) : ""}
    ${svcPage && !["suuq", "visa", "scholarship", "ticket", "ibedel"].includes(id) ? (SUUQ.deskName(name), SUUQ.deskPanel(id, name)) : ""}
    <div class="panel">
      <div class="panel-head"><div><h3>Add a ${esc(name)} agent</h3><p>Agents only see ${esc(name)} work.</p></div></div>
      <div class="grid2">
        <div class="mini"><label for="sg-name">Full name</label><input class="input" id="sg-name"></div>
        <div class="mini"><label for="sg-phone">Phone number</label><input class="input" id="sg-phone" inputmode="tel" placeholder="63 4000000"></div>
        <div class="mini"><label for="sg-pin">4-digit PIN</label><input class="input" id="sg-pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password"></div>
      </div>
      <div class="row-actions"><button class="btn btn-primary" id="sg-add">Add agent</button><span class="status-msg" id="st-sg"></span></div>
    </div>
    <div class="panel"><div class="panel-head"><div><h3>${esc(name)} agents</h3></div></div><div class="people" id="sg-list">${svcAgents.length ? svcAgents.map(u => personCard(u)).join("") : `<div class="empty">No agents yet.</div>`}</div></div>`;
  if (id === "suuq" || id === "visa" || id === "scholarship") { const extra = el.querySelector("div[hidden]"); if (extra) { const head = extra.querySelector(".admin-head"); if (head) head.remove(); const art = extra.querySelector(".sup-card"); if (art) art.remove(); extra.hidden = false; } if (id === "suuq") SUUQ.bindAdminTabs(el); else if (id === "visa") SUUQ.bindVisaTabs(el); else SUUQ.bindScholarTabs(el); }
  bindPeople($("#sg-list"), loadSvcAgents);
  if (id === "ticket") loadTicketAgency();
  loadSvcDocs(); loadDeskChats();
  if (document.getElementById("safe-desk")) SUUQ.renderSafeDesk(document.getElementById("safe-desk"));
  if (id === "technician") SUUQ.marketReviewPanel(document.getElementById("mk-review"), "technician", "service");
  if (svcPage) bindTrkAdmin(id);
  const galIn = $("#sp-gal");
  if (galIn) galIn.onchange = async () => {
    const files = [...galIn.files]; if (!files.length) return;
    msg("#st-gal", `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`);
    try {
      for (let k = 0; k < files.length; k += 5) { // a few at a time
        const images = await Promise.all(files.slice(k, k + 5).map(f => compressImage(f, 600_000)));
        svcPage = await api(`/api/admin/service-page/${encodeURIComponent(id)}/gallery`, { body: { images, titles: files.slice(k, k + 5).map(f => f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 60)) } });
      }
      renderSvcDash(true); msg("#st-gal", "Photos added. They are moving on the services page now.", "ok");
    } catch (e) { renderSvcDash(true); msg("#st-gal", e.message, "bad"); }
  };
  el.querySelectorAll("[data-galrm]").forEach(b => b.onclick = async () => {
    try { svcPage = await api(`/api/admin/service-page/${encodeURIComponent(id)}/gallery/${encodeURIComponent(b.dataset.galrm)}`, { method: "DELETE" }); renderSvcDash(true); msg("#st-gal", "Photo removed.", "ok"); }
    catch (e) { msg("#st-gal", e.message, "bad"); }
  });
  const spSave = $("#sp-save");
  if (spSave) spSave.onclick = async () => {
    spSave.disabled = true; msg("#st-sp", "Saving…");
    try {
      svcPage = await api(`/api/admin/service-page/${encodeURIComponent(id)}`, { method: "PUT", body: { videos: $("#sp-videos").value, phone: $("#sp-phone").value, merchant: $("#sp-merchant").value, whatsapp: $("#sp-wa").value, tiktok: $("#sp-tiktok").value } });
      $("#sp-videos").value = videoLines(svcPage);
      msg("#st-sp", `Saved. Customers see the ${name} page now.`, "ok");
    } catch (e) { msg("#st-sp", e.message, "bad"); } finally { spSave.disabled = false; }
  };
  $("#sg-add").onclick = async () => {
    try { await api("/api/admin/agents", { body: { name: $("#sg-name").value, phone: $("#sg-phone").value, pin: $("#sg-pin").value, service: id } }); await loadSvcAgents(); msg("#st-sg", "Agent added.", "ok"); }
    catch (e) { msg("#st-sg", e.message, "bad"); }
  };
}

/* ---------- start ---------- */
(async function start() {
  if (I18N && !I18N.lang) setTimeout(showLanguages, 0);
  // A shared product link looks like /?p=<product>&ref=<affiliate code>. Remember it until the person buys.
  const qs = new URLSearchParams(location.search), linkP = qs.get("p"), linkRef = qs.get("ref");
  if (linkP) { try { if (linkRef) localStorage.setItem("sarrif.ref." + linkP, linkRef.toUpperCase()); localStorage.setItem("sarrif.open", linkP); } catch {} history.replaceState(null, "", location.pathname); }
  try { settings = await api("/api/settings"); } catch {}
  try { const me = await api("/api/me"); if (me.user) await loggedIn(me.user); } catch {}
  try { await resumeAfterCamera(); } catch {}
  render();
})();
