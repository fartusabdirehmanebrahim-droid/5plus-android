"use strict";
/* Suuq marketplace, wallet and affiliate screens for customers and sellers, plus the Suuq admin
   dashboard and the super admin's Wallets tab. Uses helpers defined in app.js (api, esc, fmt, S, render, $, msg, ICON). */
const SUUQ = (() => {
  const st = {
    tab: "shop", q: "", products: [], product: null, orders: [], chats: [], chat: null, messages: [],
    wallet: null, aff: null, shop: undefined, plans: [], sell: "report", myProducts: [], sellerOrders: [],
    edit: null, orderSheet: null, loading: false, finance: null, adminTab: "shops", admin: null,
    market: "suuq", visaTab: "visas", visaAdmin: null, paySheet: null,
  };
  // Suuq and Visa share these screens: same shop, orders and chats; the listings are filtered by market.
  const inMarket = () => S.service === "suuq" || S.service === "visa" || S.service === "scholarship";
  const MNAMES = { suuq: "Suuq", visa: "Visa", scholarship: "Scholarship" };
  const marketName = () => MNAMES[st.market] || "Suuq";
  // Visas and scholarships are for one country each (flag + country on every listing).
  const hasCountry = m => m === "visa" || m === "scholarship";
  const scholarOpen = () => (settings.services || []).some(x => x.id === "scholarship");
  const scholarOk = () => !!st.shop?.profile?.scholar && scholarOpen();
  const visaOpen = () => (settings.services || []).some(x => x.id === "visa");
  // What this merchant may list, from the business category they registered with (null = no limit, older shops).
  const SECTION_SVCS = { suuq: ["suuq"], technician: ["technician"], ticket: ["visa", "scholarship"] };
  const allowedSvcs = () => { const pf = st.shop?.profile; return pf?.category ? SECTION_SVCS[pf.section] || ["suuq"] : null; };
  const mayList = svc => { const a = allowedSvcs(); return !a || a.includes(svc); };
  const categoryNote = () => { const pf = st.shop?.profile; if (!pf?.category) return ""; const a = allowedSvcs(), w = { suuq: "Suuq products", technician: "Technician services", visa: "visas", scholarship: "scholarships" };
    return `Your shop is registered as ${pf.category}${pf.category_sub ? ` (${pf.category_sub})` : ""}, so you can only add ${a.map(x => w[x]).join(" and ")}.`; };
  const priceWords = () => settings.priceWords?.length ? settings.priceWords : ["Contact for price"];
  // A hidden price comes back as null for shoppers; they see the seller's words instead.
  const UNIT_NAME = { night: ["night", "Nights"], day: ["day", "Days"], hour: ["hour", "Hours"], month: ["month", "Months"], trip: ["trip", "Trips"] };
  const priceText = p => p.price == null ? p.price_label || "Contact for price" : money(p.price, p.cur) + (UNIT_NAME[p.unit] ? " / " + UNIT_NAME[p.unit][0] : "");
  const CATS_NOTE = "Pay from your wallet";
  const MAX_PHOTOS = 10;

  /* ---------- helpers ---------- */
  const money = (n, c) => fmt(n, c);
  // The code in a shared link: the first sender's code if this person got the link from someone, else their own.
  const codeFor = id => {
    const p = st.product?.id === id ? st.product : (st.aff?.products || []).find(x => x.id === id);
    if (p && "share_code" in p) return p.share_code || "";
    return S.user.ref_code;
  };
  const earnFor = p => p.seller_id === S.user?.id ? "" : earnText(p);
  // The affiliate earning is always shown, even when the price is hidden (then as the seller's % or flat amount).
  const earnText = p => !(p.comm_value > 0 && p.mode === "buy") ? ""
    : p.price == null || (p.price_hidden && p.seller_id === S.user?.id) ? `Earn ${p.comm_type === "percent" ? p.comm_value + "%" : money(p.comm_value, p.cur)} by sharing`
    : `Earn ${money(p.earn, p.cur)} by sharing`;
  const asksPrice = p => p.mode === "buy" && p.price == null;
  const shareLink = (pid, code) => `${location.origin}${location.pathname}?p=${encodeURIComponent(pid)}${code ? "&ref=" + encodeURIComponent(code) : ""}`;
  const statusLabel = { paid: "Paid · waiting for seller", delivered: "Delivered", completed: "Completed", cancelled: "Cancelled", cancelled_by_seller: "Cancelled by seller",
    requested: "Booking requested", accepted: "Booking accepted", declined: "Declined", quoted: "Price sent · waiting for payment",
    awaiting_payment: "Waiting for payment confirmation", payment_rejected: "Payment not received" };
  const PAY_NAME = { wallet: "Wallet", safe: "Safe payment", shop: "Pay to shop" };
  const orderLabel = o => o.status === "declined" && o.forwarded ? "Declined · sent to another merchant"
    : o.kind === "buy" && o.status === "accepted" ? "Accepted · agree on the price in chat"
    : o.needs_price ? "Waiting for the seller's price" : statusLabel[o.status] || o.status;
  const statusTone = s => s === "completed" ? "sent" : ["cancelled", "cancelled_by_seller", "declined", "payment_rejected"].includes(s) ? "susp" : "waiting";
  const refFor = pid => { try { return localStorage.getItem("sarrif.ref." + pid) || ""; } catch { return ""; } };
  // opts.autoplay: the video starts when it scrolls into view and pauses when it scrolls away (see bindAutoplay).
  function videoEmbed(url, opts = {}) {
    if (!url) return "";
    const auto = !!opts.autoplay, title = opts.title || "Product video";
    let m, src = null, yt = false;
    if ((m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/))) {
      yt = true;
      // Videos play with sound. Browsers only start a video by itself when it is muted, so there the sound comes on
      // at the customer's first tap; inside the 5PLUS Android app it plays with sound straight away.
      // YouTube needs to know which site shows the video (origin), or it can refuse to play inside apps.
      const origin = /^https?:/.test(location.origin) ? `&origin=${encodeURIComponent(location.origin)}&widget_referrer=${encodeURIComponent(location.origin)}` : "";
      src = `https://www.youtube-nocookie.com/embed/${m[1]}?enablejsapi=1&playsinline=1&rel=0&modestbranding=1${origin}` + (auto ? `&autoplay=1&mute=${canSound() ? 0 : 1}&loop=1&playlist=${m[1]}` : "");
    }
    else if ((m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/))) src = `https://player.vimeo.com/video/${m[1]}`;
    else if ((m = url.match(/tiktok\.com\/.*\/video\/(\d+)/))) src = `https://www.tiktok.com/embed/v2/${m[1]}`;
    else if ((m = url.match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/))) src = `https://www.instagram.com/p/${m[1]}/embed`;
    else if ((m = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/))) src = `https://geo.dailymotion.com/player.html?video=${m[1]}`;
    else if (/facebook\.com|fb\.watch/.test(url)) src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
    // The demo page can't show videos from other sites inside it, so it links to them instead.
    const watch = `<a class="btn btn-ghost btn-block" href="${esc(url)}" target="_blank" rel="noopener">▶ Watch the ${auto ? "video" : "product video"}</a>`;
    const thumb = yt ? `<span class="vid-thumb" style="background-image:url('https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg')" aria-hidden="true"></span><span class="vid-play" aria-hidden="true"></span>` : "";
    // Where videos can't play inside the page (the demo page), the picture opens the video on YouTube.
    if (window.SARRIF_NO_EMBED) return yt && auto ? `<a class="vid" href="${esc(url)}" target="_blank" rel="noopener" aria-label="Watch ${esc(title)} on YouTube">${thumb}</a>` : watch;
    // An autoplaying YouTube video loads only when it first scrolls into view, so it starts right then.
    if (src && yt && auto) return `<div class="vid" data-auto="yt">${thumb}<iframe data-src="${esc(src)}" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>${soundBtn()}</div>`;
    if (src) return `<div class="vid"${yt ? ` data-auto-yt` : ""}><iframe src="${esc(src)}" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe></div>`;
    if (/\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url)) return `<div class="vid"${auto ? ` data-auto="file"` : ""}><video src="${esc(url)}" controls playsinline preload="metadata"${auto ? " muted loop" : ""}></video></div>`;
    return watch;
  }
  // Plays autoplay videos while at least half of them is on screen, and pauses them otherwise.
  // If the page is not allowed to show videos from other sites, switch to links (they open the video on YouTube).
  document.addEventListener("securitypolicyviolation", e => {
    if (window.SARRIF_NO_EMBED || !/frame|child|default/.test(e.effectiveDirective || e.violatedDirective || "")) return;
    if (!/youtube|vimeo|tiktok|facebook|instagram|dailymotion/.test(e.blockedURI || "")) return;
    window.SARRIF_NO_EMBED = true;
    if (typeof render === "function") render();
  });
  let vidObs = null;
  // Sound: on, unless the customer turned it off with the 🔊 button (remembered). In a browser it can only come on
  // after the customer has tapped the page once.
  let soundWanted = (() => { try { return localStorage.getItem("sarrif.videoSound") !== "off"; } catch { return true; } })();
  let tapped = !!window.SarrifAndroid;
  const canSound = () => soundWanted && tapped;
  const ICON_ON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
  const ICON_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>';
  const soundBtn = () => `<button type="button" class="vid-sound" data-sound aria-label="${canSound() ? "Turn sound off" : "Turn sound on"}">${canSound() ? ICON_ON : ICON_OFF}</button>`;
  function ytCommand(frame, func, args = []) { try { frame.contentWindow.postMessage(JSON.stringify({ event: "command", func, args }), "*"); } catch {} }
  function applySound(f) { if (canSound()) { ytCommand(f, "unMute"); ytCommand(f, "setVolume", [100]); } else ytCommand(f, "mute"); }
  function paintSoundButtons() {
    document.querySelectorAll("[data-sound]").forEach(b => { b.innerHTML = canSound() ? ICON_ON : ICON_OFF; b.setAttribute("aria-label", canSound() ? "Turn sound off" : "Turn sound on"); });
  }
  let playingBox = null;
  function playBox(box) {
    const f = box.querySelector("iframe"), v = box.querySelector("video");
    playingBox = box;
    if (v) { v.muted = !canSound(); v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); return; }
    if (!f) return;
    if (!f.getAttribute("src")) {
      // First time: load it. Once YouTube is ready, set the sound the way the customer wants it.
      f.addEventListener("load", () => { setTimeout(() => { if (playingBox === box) applySound(f); }, 800); setTimeout(() => { if (playingBox === box) applySound(f); }, 2000); }, { once: true });
      f.setAttribute("src", f.dataset.src);
    } else { applySound(f); ytCommand(f, "playVideo"); }
  }
  // A video that leaves the screen is paused and silenced, so its sound stops at once.
  function pauseBox(box) {
    const f = box.querySelector("iframe"), v = box.querySelector("video");
    if (playingBox === box) playingBox = null;
    if (v) v.pause(); else if (f && f.getAttribute("src")) { ytCommand(f, "mute"); ytCommand(f, "pauseVideo"); }
  }
  function setSound(on) {
    soundWanted = on; tapped = true;
    try { localStorage.setItem("sarrif.videoSound", on ? "on" : "off"); } catch {}
    paintSoundButtons();
    if (playingBox) { const f = playingBox.querySelector("iframe"), v = playingBox.querySelector("video"); if (f) applySound(f); if (v) v.muted = !canSound(); }
  }
  // In a browser the first tap anywhere lets the sound come on.
  if (!tapped) document.addEventListener("pointerdown", e => {
    if (tapped || e.target.closest?.("[data-sound]")) return;
    tapped = true; paintSoundButtons();
    if (playingBox) { const f = playingBox.querySelector("iframe"); if (f && f.getAttribute("src")) applySound(f); }
  }, { capture: true });
  // Leaving the app (or switching to another app) stops the sound.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && playingBox) { const box = playingBox; pauseBox(box); playingBox = box; }
    else if (!document.hidden && playingBox && playingBox.isConnected) playBox(playingBox);
  });
  function bindAutoplay(root) {
    if (vidObs) vidObs.disconnect();
    const boxes = root.querySelectorAll(".vid[data-auto]"); if (!boxes.length) return;
    if (!("IntersectionObserver" in window)) { boxes.forEach(playBox); return; }
    // Only one video plays at a time: the one most on screen (at least half of it showing).
    const seen = new Map(); let playing = null;
    const pick = () => {
      // Of the videos at least half on screen, the one nearest the middle of the screen plays.
      const mid = innerHeight / 2; let best = null, bestD = Infinity;
      boxes.forEach(box => {
        if ((seen.get(box) || 0) < 0.5) return;
        const r = box.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestD - 1) { best = box; bestD = d; }
      });
      if (best === playing) return;
      if (playing) pauseBox(playing);
      playing = best;
      if (best) playBox(best);
    };
    bindAutoplay.recheck = () => { if (boxes[0] && boxes[0].isConnected) pick(); };
    root.querySelectorAll("[data-sound]").forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      const box = b.closest(".vid");
      setSound(!canSound());
      if (box && playingBox !== box) { if (playing && playing !== box) pauseBox(playing); playing = box; playBox(box); }
    }));
    // Tapping a video's picture plays it at once (and pauses the one playing).
    boxes.forEach(box => box.addEventListener("click", () => {
      if (playing && playing !== box) pauseBox(playing);
      playing = box; playBox(box);
    }));
    vidObs = new IntersectionObserver(es => { es.forEach(e => seen.set(e.target, e.isIntersecting ? e.intersectionRatio : 0)); pick(); }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    boxes.forEach(b => vidObs.observe(b));
    // Thresholds alone miss a video moving from the edge to the middle, so also re-check after scrolling stops.
    clearTimeout(bindAutoplay.t);
    if (!bindAutoplay.bound) { bindAutoplay.bound = true; document.addEventListener("scroll", () => { clearTimeout(bindAutoplay.t); bindAutoplay.t = setTimeout(() => bindAutoplay.recheck && bindAutoplay.recheck(), 150); }, { passive: true, capture: true }); }
  }
  async function copy(text, btn, done = "Copied") {
    try { if (navigator.share && /Mobi/i.test(navigator.userAgent)) { await navigator.share({ url: text }); return; } } catch {}
    try { await navigator.clipboard.writeText(text); if (btn) { const o = btn.textContent; btn.textContent = done; setTimeout(() => btn.textContent = o, 1400); } }
    catch { if (btn) btn.textContent = text; }
  }
  const back = (to, label = "Back") => `<button class="back" data-sq="${to}" aria-label="${label}">${ICON.back}</button>`;

  /* ---------- data ---------- */
  async function loadWallet() { try { st.wallet = await api("/api/wallet"); } catch {} }
  async function loadProducts() {
    if (st.market === "suuq" && !st.bizCats) { try { st.bizCats = (await api("/api/suuq/plans")).categories || []; } catch { st.bizCats = []; } }
    try {
      const country = hasCountry(st.market) && st.visaCountry ? "&country=" + encodeURIComponent(st.visaCountry) : "";
      const r = await api(`/api/suuq/products?service=${st.market}&q=` + encodeURIComponent(st.q) + country);
      st.products = r.products; if (r.countries) st.visaCountries = r.countries;
    } catch (e) { st.products = []; st.err = e.message; }
  }
  async function loadOrders() { try { st.orders = (await api("/api/suuq/orders/mine")).orders; } catch {} }
  async function loadChats() { try { st.chats = (await api("/api/suuq/chats")).chats; } catch {} }
  async function loadShop() {
    try { const [a, b] = await Promise.all([api("/api/suuq/my-shop"), api("/api/suuq/plans")]); st.shop = a.shop ?? null; st.plans = b.plans; st.countries = b.countries || []; st.bizCats = b.categories || []; } catch {}
    if (st.shop) { try { const [p, o] = await Promise.all([api("/api/suuq/seller/products"), api("/api/suuq/seller/orders")]); st.myProducts = p.products; st.sellerOrders = o.orders; } catch {} }
  }
  async function loadAff() { try { st.aff = await api("/api/affiliate"); } catch {} }
  const unreadChats = () => st.chats.reduce((a, c) => a + (c.unread || 0), 0);
  const pendingSeller = () => st.sellerOrders.filter(o => ["paid", "requested", "quoted", "accepted", "delivered"].includes(o.status)).length;

  async function open(service, extra) {
    if (service === "wallet") await loadWallet();
    if (service === "affiliate") await Promise.all([loadAff(), loadWallet()]);
    if (service === "suuq" || service === "visa" || service === "scholarship") {
      st.shopView = null; st.fromHub = !!extra?.fromHub;
      if (st.market !== service) { st.market = service; st.q = ""; st.visaCountry = ""; st.products = []; if (st.tab === "shop") st.product = null; }
      if (extra?.product) { st.tab = "shop"; await openProduct(extra.product); if (st.product?.service && st.product.service !== service && st.product.service !== "ticket") { st.market = st.product.service; S.service = st.market; } }
      await Promise.all([loadProducts(), loadWallet(), loadChats(), loadShop()]);
    }
    render();
  }
  async function openProduct(id) {
    const ref = refFor(id);
    try { st.product = (await api("/api/suuq/products/" + encodeURIComponent(id) + (ref ? "?ref=" + encodeURIComponent(ref) : ""))).product; st.orderSheet = null; }
    catch (e) { st.product = null; st.err = e.message; }
  }


  /* ---------- photo viewer with zoom ---------- */
  // Full screen: pinch or double-tap to zoom, drag to move a zoomed photo, swipe to the next photo, swipe down to close.
  // Buttons: − / + / reset, arrows, and thumbnails. Keys: Esc, ← →, + −. The phone's Back button closes it.
  const zoom = (() => {
    const MAX = 5, STEP = 1.6;
    let el = null, list = [], idx = 0, title = "", z = 1, x = 0, y = 0, pushed = false;
    const ptrs = new Map(); let pinch = null, drag = null, lastTap = 0, swipe = null;
    const img = () => el && el.querySelector(".zv-img");
    function clamp() {
      const im = img(); if (!im) return;
      const r = im.parentElement.getBoundingClientRect(), w = im.offsetWidth * z, h = im.offsetHeight * z;
      const mx = Math.max(0, (w - r.width) / 2), my = Math.max(0, (h - r.height) / 2);
      x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y));
    }
    function apply(anim) {
      const im = img(); if (!im) return;
      if (z <= 1.001) { z = 1; x = 0; y = 0; } else clamp();
      im.style.transition = anim ? "transform .22s ease" : "none";
      im.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      el.classList.toggle("zoomed", z > 1);
      const pct = el.querySelector(".zv-pct"); if (pct) pct.textContent = Math.round(z * 100) + "%";
      el.querySelector("[data-zv=out]").disabled = z <= 1; el.querySelector("[data-zv=in]").disabled = z >= MAX;
    }
    // Zoom to "to" keeping the point (cx, cy) on screen still.
    function zoomAt(to, cx, cy, anim) {
      const im = img(); if (!im) return;
      to = Math.min(MAX, Math.max(1, to));
      const r = im.parentElement.getBoundingClientRect(), ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
      x = ox - (ox - x) * (to / z); y = oy - (oy - y) * (to / z); z = to; apply(anim);
    }
    const center = () => { const r = el.querySelector(".zv-stage").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    function draw() {
      const n = list.length;
      el.innerHTML = `<div class="zv-top"><span class="zv-count num">${n > 1 ? `${idx + 1} / ${n}` : ""}</span><b class="zv-title" data-no-i18n>${esc(title)}</b>
          <button class="zv-btn" data-zv="close" aria-label="Close">✕</button></div>
        <div class="zv-stage">${n > 1 ? `<button class="zv-nav prev" data-zv="prev" aria-label="Previous photo">‹</button>` : ""}
          <img class="zv-img" src="${esc(list[idx])}" alt="${esc(title)}, photo ${idx + 1} of ${n}" draggable="false">
          ${n > 1 ? `<button class="zv-nav next" data-zv="next" aria-label="Next photo">›</button>` : ""}</div>
        <div class="zv-bar"><button class="zv-btn" data-zv="out" aria-label="Zoom out">−</button><button class="zv-pct num" data-zv="reset" aria-label="Fit to screen">100%</button><button class="zv-btn" data-zv="in" aria-label="Zoom in">+</button></div>
        ${n > 1 ? `<div class="zv-thumbs">${list.map((src, i) => `<button data-zvi="${i}" aria-label="Photo ${i + 1}" aria-current="${i === idx}"><img src="${esc(src)}" alt=""></button>`).join("")}</div>` : ""}
        <p class="zv-hint">Pinch or double-tap to zoom</p>`;
      z = 1; x = 0; y = 0; apply(false);
      el.querySelector(`[data-zvi="${idx}"]`)?.scrollIntoView({ block: "nearest", inline: "center" });
    }
    function go(i) { if (!list.length) return; idx = (i + list.length) % list.length; draw(); onChange && onChange(idx); }
    let onChange = null;
    function close(fromBack) {
      if (!el) return;
      el.remove(); el = null; document.body.classList.remove("zv-open"); document.removeEventListener("keydown", onKey);
      if (pushed && !fromBack) { pushed = false; history.back(); } pushed = false;
    }
    const onPop = () => { if (el) close(true); };
    window.addEventListener("popstate", onPop);
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(idx + (document.dir === "rtl" ? -1 : 1));
      else if (e.key === "ArrowLeft") go(idx + (document.dir === "rtl" ? 1 : -1));
      else if (e.key === "+" || e.key === "=") zoomAt(z * STEP, ...center(), true);
      else if (e.key === "-") zoomAt(z / STEP, ...center(), true);
    }
    function open(images, start = 0, name = "", changed = null) {
      list = (images || []).filter(Boolean); if (!list.length) return;
      idx = Math.min(Math.max(0, start), list.length - 1); title = name; onChange = changed;
      if (!el) {
        el = document.createElement("div"); el.className = "zv"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Photo viewer");
        document.body.appendChild(el); document.body.classList.add("zv-open"); document.addEventListener("keydown", onKey);
        try { history.pushState({ zv: 1 }, ""); pushed = true; } catch {}
        el.addEventListener("click", e => {
          const b = e.target.closest("[data-zv],[data-zvi]"); if (!b) return;
          const a = b.dataset.zv;
          if (b.dataset.zvi) go(+b.dataset.zvi);
          else if (a === "close") close();
          else if (a === "prev") go(idx - 1); else if (a === "next") go(idx + 1);
          else if (a === "in") zoomAt(z * STEP, ...center(), true);
          else if (a === "out") zoomAt(z / STEP, ...center(), true);
          else if (a === "reset") zoomAt(z > 1 ? 1 : 2.5, ...center(), true);
        });
        el.addEventListener("wheel", e => { if (!e.target.closest(".zv-stage")) return; e.preventDefault(); zoomAt(z * Math.exp(-e.deltaY / 300), e.clientX, e.clientY, false); }, { passive: false });
        el.addEventListener("pointerdown", e => {
          if (!e.target.closest(".zv-stage") || e.target.closest("button")) return;
          e.preventDefault(); el.querySelector(".zv-stage").setPointerCapture?.(e.pointerId);
          ptrs.set(e.pointerId, [e.clientX, e.clientY]);
          if (ptrs.size === 2) {
            const [a, b] = [...ptrs.values()];
            pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, x, y }; drag = swipe = null;
          } else if (ptrs.size === 1) {
            const now = Date.now();
            if (now - lastTap < 280) { zoomAt(z > 1 ? 1 : 2.5, e.clientX, e.clientY, true); lastTap = 0; return; }
            lastTap = now;
            if (z > 1) drag = { sx: e.clientX, sy: e.clientY, x, y }; else swipe = { sx: e.clientX, sy: e.clientY, t: now };
          }
        });
        el.addEventListener("pointermove", e => {
          if (!ptrs.has(e.pointerId)) return;
          ptrs.set(e.pointerId, [e.clientX, e.clientY]);
          const im = img(); if (!im) return;
          if (pinch && ptrs.size >= 2) {
            const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
            z = pinch.z; x = pinch.x + (cx - pinch.cx); y = pinch.y + (cy - pinch.cy);
            zoomAt(pinch.z * d / pinch.d, cx, cy, false);
          } else if (drag) { x = drag.x + e.clientX - drag.sx; y = drag.y + e.clientY - drag.sy; apply(false); }
          else if (swipe) {
            const dx = e.clientX - swipe.sx, dy = e.clientY - swipe.sy;
            im.style.transition = "none";
            im.style.transform = Math.abs(dy) > Math.abs(dx) && dy > 0 ? `translateY(${dy}px) scale(${1 - Math.min(dy, 300) / 1200})` : `translateX(${dx}px)`;
            el.style.backgroundColor = `rgba(0,0,0,${Math.abs(dy) > Math.abs(dx) && dy > 0 ? (1 - Math.min(dy, 300) / 400).toFixed(3) : 1})`;
          }
        });
        const up = e => {
          if (!ptrs.has(e.pointerId)) return;
          ptrs.delete(e.pointerId);
          if (pinch && ptrs.size < 2) { pinch = null; if (ptrs.size === 1) { const [p] = [...ptrs.values()]; drag = z > 1 ? { sx: p[0], sy: p[1], x, y } : null; } apply(true); return; }
          if (swipe && !ptrs.size) {
            const dx = e.clientX - swipe.sx, dy = e.clientY - swipe.sy; swipe = null; el.style.backgroundColor = "";
            if (dy > 110 && Math.abs(dy) > Math.abs(dx)) return close();
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && list.length > 1) return go(idx + ((dx < 0) !== (document.dir === "rtl") ? 1 : -1));
            apply(true);
          }
          if (!ptrs.size) drag = null;
        };
        el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      }
      draw();
    }
    return { open, close, get isOpen() { return !!el; } };
  })();
  /* ---------- ringing alerts for merchants ---------- */
  // A new request, booking or chat rings for 25 seconds with Accept / Reject; a paid order rings for 10 seconds with
  // "See order". The sound is made in the page (no sound file), and the phone vibrates too.
  // 40 ringtones made in the page (no sound files). Each is a short phrase of notes repeated while it rings.
  // Customers and merchants pick one in Account; admins and the super admin always hear the special staff tone.
  const NOTE = n => 440 * Math.pow(2, (n - 69) / 12);
  const TONE_NAMES = ["Classic", "Chime", "Marimba", "Bells", "Harp", "Pulse", "Beacon", "Sunrise", "Breeze", "Raindrop",
    "Crystal", "Echo", "Twinkle", "Ripple", "Horizon", "Spark", "Gallop", "Flute", "Signal", "Zen",
    "Hargeisa", "Berbera", "Sahan", "Dhalool", "Laas Geel", "Camel bell", "Oud", "Drum", "Market", "Desert wind",
    "Morning", "Night", "Bright", "Soft", "Rapid", "Rising", "Falling", "Double", "Triple", "Digital"];
  const PHRASES = [[76, 72, 76, 72], [84, 79, 76], [72, 76, 79, 84], [88, 83, 79, 76], [67, 71, 74, 79, 83], [81, 81, 81], [79, 0, 79, 0],
    [72, 74, 76, 79, 81], [76, 79, 83, 79], [91, 86, 91], [96, 91, 88], [79, 74, 79, 74], [84, 88, 91, 88], [74, 77, 81, 77], [67, 72, 76, 72],
    [93, 0, 93], [76, 76, 79, 76, 76, 79], [79, 81, 83, 86], [86, 0, 86, 0, 86], [64, 71, 76], [74, 76, 78, 81, 83], [69, 73, 76, 81], [71, 74, 78, 74],
    [77, 81, 84], [62, 69, 74, 69], [90, 0, 90], [67, 70, 74, 70], [55, 55, 62, 55], [72, 72, 79, 79, 81], [65, 69, 72, 77],
    [76, 81, 85, 88], [69, 64, 69, 64], [88, 91, 96], [72, 76], [84, 84, 84, 84], [72, 76, 79, 84, 88], [88, 84, 79, 76, 72], [79, 79, 0, 79, 79], [76, 76, 76, 0], [96, 100, 96, 100]];
  const WAVES = ["sine", "triangle", "sine", "triangle", "sine", "square", "sine", "triangle", "sine", "sine"];
  const TONES = TONE_NAMES.map((name, i) => ({ name, notes: PHRASES[i], wave: WAVES[i % WAVES.length], step: [0.18, 0.14, 0.22, 0.12][i % 4], vol: WAVES[i % WAVES.length] === "square" ? 0.18 : 0.45 }));
  // Staff (admins, super admin, iBedel staff): a two-tone siren nobody else uses.
  const STAFF_TONE = { name: "Staff alert", notes: [88, 81, 88, 81, 88, 81], wave: "sawtooth", step: 0.13, vol: 0.2 };
  const TONE_KEY = "sarrif.ringtone";
  const myTone = () => { if (S.user && S.user.role !== "customer") return STAFF_TONE; let i = 0; try { i = Number(localStorage.getItem(TONE_KEY)) || 0; } catch {} return TONES[i] || TONES[0]; };
  const alarm = (() => {
    let ac = null, loop = null, stopT = null, cur = null, cdT = null;
    const queue = [];
    const unlock = () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === "suspended") ac.resume(); } catch {} };
    ["pointerdown", "touchstart", "keydown"].forEach(e => document.addEventListener(e, unlock, { passive: true }));
    function burst(tone) {
      if (!ac) return;
      const t = ac.currentTime, tn = tone || myTone();
      tn.notes.forEach((n, k) => {
        if (!n) return;
        const d = k * tn.step, o = ac.createOscillator(), g = ac.createGain();
        o.type = tn.wave; o.frequency.value = NOTE(n); o.connect(g); g.connect(ac.destination);
        g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(tn.vol, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + tn.step * 0.95);
        o.start(t + d); o.stop(t + d + tn.step);
      });
      return tn.notes.length * tn.step;
    }
    // Plays a tone once (the Account page's ▶ button).
    function preview(i) { unlock(); stopSound(); setTimeout(() => burst(TONES[i] || TONES[0]), 30); }
    function stopSound() { clearInterval(loop); clearTimeout(stopT); loop = stopT = null; try { navigator.vibrate && navigator.vibrate(0); } catch {} }
    function startSound(secs) {
      unlock(); stopSound(); const tn = myTone(), len = (tn.notes.length * tn.step) * 1000;
      burst(tn); loop = setInterval(() => burst(tn), Math.max(900, len + 450)); stopT = setTimeout(stopSound, secs * 1000);
      try { navigator.vibrate && navigator.vibrate(Array.from({ length: Math.ceil(secs / 1.4) }, (_, i) => i % 2 ? 600 : 800)); } catch {}
    }
    function close() { stopSound(); clearInterval(cdT); document.getElementById("ring")?.remove(); cur = null; if (queue.length) show(queue.shift()); }
    function show(a) {
      if (cur) { if (!queue.some(x => x.key === a.key) && cur.key !== a.key) queue.push(a); return; }
      cur = a; startSound(a.secs);
      const el = document.createElement("div"); el.id = "ring"; el.className = "ring " + (a.tone || ""); el.setAttribute("role", "alertdialog"); el.setAttribute("aria-live", "assertive");
      el.innerHTML = `<div class="ring-card"><div class="ring-top"><span class="ring-bell" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></span>
          <div class="ring-t"><b>${esc(a.title)}</b><small class="ring-cd num" data-no-i18n>${a.secs}s</small></div><button class="ring-x" data-ring="x" aria-label="Close">✕</button></div>
        <p class="ring-body">${a.body}</p>
        <div class="ring-acts">${a.actions.map((x, i) => `<button class="btn ${x.cls || "btn-ghost"}" data-ring="${i}">${esc(x.label)}</button>`).join("")}</div></div>`;
      document.body.appendChild(el);
      let left = a.secs; const cd = el.querySelector(".ring-cd");
      cdT = setInterval(() => { left--; if (cd) cd.textContent = left > 0 ? left + "s" : ""; if (left <= 0) { clearInterval(cdT); el.classList.add("quiet"); } }, 1000);
      el.addEventListener("click", async e => {
        const b = e.target.closest("[data-ring]"); if (!b) return;
        const act = b.dataset.ring === "x" ? null : a.actions[+b.dataset.ring];
        stopSound();
        if (act?.fn) { b.disabled = true; try { await act.fn(); } catch (err) { b.disabled = false; alert(err.message || err); return; } }
        close();
      });
    }
    return { show, close, stopSound, preview, TONES, TONE_KEY, get ringing() { return !!loop; } };
  })();
  async function goSellerOrders() {
    S.service = "suuq"; S.drawer = false; st.tab = "sell"; st.sell = "orders"; st.chat = null; st.product = null;
    await open("suuq"); render(); scrollTo(0, 0);
  }
  const seenOrder = {};
  function ringFor(o) {
    if (!o || !o.buyer_name || seenOrder[o.id] === o.status) return; // only the merchant's copy, once per change
    seenOrder[o.id] = o.status;
    const what = `<b>${esc(o.product_name)} × ${o.qty}</b> · ${esc(o.buyer_name)}${o.book_at ? `<br>📅 ${esc(o.book_at)}` : ""}${o.note ? `<br><span class="ring-note">“${esc(o.note)}”</span>` : ""}`;
    const act = a => api(`/api/suuq/orders/${o.id}/action`, { body: { action: a } });
    if (o.status === "requested") alarm.show({ key: o.id + o.status, secs: 25, tone: "req",
      title: o.kind === "book" ? "New booking" : o.from_order ? "New request (passed on to you)" : "New price request", body: what,
      actions: [{ label: "Accept", cls: "btn-primary", fn: async () => { await act("accept"); await goSellerOrders(); } },
        { label: "Reject", cls: "btn-danger", fn: async () => { await act("decline"); await goSellerOrders(); } }] });
    else if (o.status === "paid") alarm.show({ key: o.id + o.status, secs: 10, tone: "paid", title: "Order paid successfully",
      body: `${what}<br>${esc(money(o.total, o.cur))}${o.pay_method && o.pay_method !== "wallet" ? ` · ${esc(PAY_NAME[o.pay_method])}` : ""}`,
      actions: [{ label: "See order", cls: "btn-primary", fn: goSellerOrders }] });
    else if (o.status === "awaiting_payment" && o.pay_method === "shop") alarm.show({ key: o.id + o.status, secs: 10, tone: "paid", title: "A buyer is paying you",
      body: `${what}<br>${esc(money(o.total - (o.pay_discount || 0) + o.pay_fee, o.cur))} · ${esc(PAY_NAME.shop)}. Confirm when the money arrives.`,
      actions: [{ label: "See order", cls: "btn-primary", fn: goSellerOrders }] });
  }
  function ringChat(m) {
    if (!m.new_chat || m.sender_id === S.user?.id) return;
    alarm.show({ key: "chat" + m.conv_id, secs: 25, tone: "req", title: "New chat",
      body: `<b>${esc(m.from_name || "")}</b>${m.product_name ? ` · ${esc(m.product_name)}` : ""}<br><span class="ring-note">“${esc(m.preview || m.body)}”</span>`,
      actions: [{ label: "Accept", cls: "btn-primary", fn: async () => { S.service = "suuq"; S.drawer = false; await open("suuq"); await openChat(m.conv_id); } },
        { label: "Reject", cls: "btn-danger", fn: null }] });
  }

  /* ---------- technician categories (home services) ---------- */
  // A technician's category is one of these; sections group them on the Technician page.
  const TI = d => `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const TECH_ICONS = {
    clean: TI('<path d="M14 3l-4 9M7 12h8l2 9H5z"/><path d="M8 16v5M12 16v5M16 16v5"/>'),
    plumb: TI('<path d="M4 7h9a3 3 0 0 1 3 3v2"/><path d="M4 4v6M16 12h3v3h-3zM17.5 15v2M17.5 19v.5"/>'),
    elec: TI('<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>'),
    hair: TI('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>'),
    carp: TI('<path d="M3 21l9-9M14 4l6 6-3 3-6-6zM12 12l-2 2"/>'),
    paint: TI('<rect x="3" y="3" width="14" height="6" rx="1"/><path d="M17 6h3v5h-8v3M12 14v7"/>'),
    ac: TI('<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9"/>'),
    build: TI('<path d="M3 21h18M5 21V10h14v11M5 14h14M9 10V7h6v3"/>'),
    tailor: TI('<path d="M7 3l5 4 5-4 4 4-3 3v11H6V10L3 7z"/>'),
    mech: TI('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  };
  // Category chips at the top (a chip can open a whole section).
  const TECH_CHIPS = [["Cleaner", "clean", "Cleaning Services"], ["Plumber", "plumb"], ["Electrician", "elec"], ["Hair", "hair"], ["Carpenter", "carp"], ["Painter", "paint"], ["AC Repair", "ac"], ["Builder", "build"], ["Tailor", "tailor"], ["Mechanic", "mech"]];
  const TECH_GROUPS = [
    { name: "Cleaning Services", cats: [["Home Cleaning", "clean"], ["Bathroom Cleaning", "clean"], ["Disinfection", "clean"]] },
    { name: "Home Repairs", cats: [["Plumber", "plumb"], ["Carpenter", "carp"], ["Electrician", "elec"], ["Painter", "paint"], ["AC Repair", "ac"]] },
    { name: "Building & Construction", cats: [["Builder", "build"], ["Tiling", "build"], ["Welding", "mech"]] },
    { name: "Personal Care & Tailoring", cats: [["Hair", "hair"], ["Tailor", "tailor"]] },
    { name: "Vehicles", cats: [["Mechanic", "mech"], ["Auto Electrician", "elec"]] },
  ];
  const TECH_CATS = TECH_GROUPS.flatMap(g => g.cats.map(c => c[0]));
  // Real photos used as the icon of each category (public/photos/tech).
  const TECH_PHOTO_FILE = { Cleaner: "cleaning", "Home Cleaning": "home-cleaning", "Bathroom Cleaning": "bathroom", Disinfection: "disinfection", Plumber: "plumber", Carpenter: "carpenter", Electrician: "electrician", Painter: "painter", "AC Repair": "ac", Builder: "builder", Tiling: "tiling", Welding: "welding", Hair: "hair", Tailor: "tailor", Mechanic: "mechanic", "Auto Electrician": "auto-electric" };
  const techPhoto = cat => TECH_PHOTO_FILE[cat] ? `/photos/tech/${TECH_PHOTO_FILE[cat]}.jpg` : null;

  /* ---------- service listings (admin): rooms, technicians, cars… ---------- */
  const ITEM_WORDS = { hotels: ["Rooms", "room", "night"], technician: ["Technicians", "technician", ""], "car-rent": ["Cars", "car", "day"], "school-bus": ["Routes", "route", "month"], restaurant: ["Menu", "dish", ""] };
  const itemWords = id => ITEM_WORDS[id] || ["Listings", "listing", ""];
  let items = { id: null, list: null, edit: null };
  function itemsPanel(id, name) {
    if (items.id !== id) items = { id, list: null, edit: null };
    if (!items.list) setTimeout(async () => { try { items.list = (await api(`/api/admin/service-items/${encodeURIComponent(id)}`)).items; } catch { items.list = []; } drawItems(); }, 0);
    return `<div class="panel" id="items-panel"></div>`;
  }
  function drawItems() {
    const el = document.getElementById("items-panel"); if (!el || !items.list) return;
    const [plural, one, unit] = itemWords(items.id), e = items.edit;
    const form = x => `<div class="offer-form" data-itemform="${x ? x.id : "new"}">
        <b style="font-size:14px">${x ? "Edit " + esc(x.name) : "Add a " + one}</b>
        <div class="grid2">
          <div class="mini"><label>Name</label><input class="input" data-f="name" value="${esc(x?.name || "")}" placeholder="${items.id === "technician" ? "Abdi Yusuf" : items.id === "hotels" ? "Deluxe double room" : items.id === "restaurant" ? "Rice with goat meat" : ""}"></div>
          ${items.id === "technician" ? `<div class="mini"><label>Category</label><select class="input" data-f="category">${TECH_GROUPS.map(g => `<optgroup label="${esc(g.name)}">${g.cats.map(([n]) => `<option ${x?.category === n ? "selected" : ""}>${esc(n)}</option>`).join("")}</optgroup>`).join("")}</select></div>`
            : `<div class="mini"><label>Category</label><input class="input" data-f="category" list="cat-list" value="${esc(x?.category || "")}" placeholder="${items.id === "hotels" ? "Double room" : items.id === "restaurant" ? "Dinner" : ""}"></div>`}
          <div class="mini"><label>Price</label><div class="suffix"><select data-f="cur">${CURS.map(c => `<option ${(x?.cur || "USD") === c ? "selected" : ""}>${c}</option>`).join("")}</select><input data-f="price" inputmode="decimal" value="${esc(x && !x.price_hidden ? x.price : "")}"></div></div>
          <div class="mini"><label>Per</label><select class="input" data-f="unit">${["", "night", "day", "hour", "trip", "month"].map(u => `<option value="${u}" ${(x ? x.unit : unit) === u ? "selected" : ""}>${u ? u : "each"}</option>`).join("")}</select></div>
          <div class="mini"><label>How many available (empty = no limit)</label><input class="input" data-f="stock" inputmode="numeric" value="${esc(x && x.stock >= 0 ? x.stock : "")}"></div>
          <div class="mini"><label class="chk"><input type="checkbox" data-f="price_hidden" ${x?.price_hidden ? "checked" : ""}>Ask for the price (agree it first)</label></div>
          <div class="mini"><label class="chk"><input type="checkbox" data-f="on" ${x?.admin_hidden ? "" : "checked"}>Available now (customers can see and order it)</label></div>
        </div>
        <div class="mini"><label>Description</label><textarea class="input" data-f="description" rows="2">${esc(x?.description || "")}</textarea></div>
        <div class="row-actions"><label class="btn btn-ghost">${x ? "Change photo" : "Add photo"}<input type="file" data-f="photo" accept="image/jpeg,image/png,image/webp" hidden></label><span class="note" data-photonote></span></div>
        <div class="row-actions"><button class="btn btn-primary" data-itemsave>${x ? "Save" : "Add " + one}</button>${x ? `<button class="btn btn-ghost" data-itemcancel>Cancel</button><button class="btn btn-danger" data-itemdel style="margin-inline-start:auto">Delete</button>` : ""}<span class="status-msg"></span></div></div>`;
    el.innerHTML = `<div class="panel-head"><div><h3>${esc(plural)}</h3><p>Customers see these on the service page with photo, name and category, and order them with the app's payments and charges.${unit === "night" ? " Rooms that are booked are held until the stay is finished or cancelled." : ""}</p></div></div>
      <datalist id="cat-list">${(items.id === "technician" ? ["Electrician", "Plumber", "AC repair", "Car mechanic", "Carpenter", "Painter", "Phone repair", "Welder", "Tailor", "Builder", "Satellite dish"] : items.id === "hotels" ? ["Single room", "Double room", "Family room", "Suite"] : items.id === "restaurant" ? ["Breakfast", "Lunch", "Dinner", "Snacks", "Sweets", "Drinks"] : []).map(c => `<option value="${c}">`).join("")}</datalist>
      <div class="svc-items">${items.list.map(x => e === x.id ? form(x) : `<div class="svc-item"><img src="${esc(x.images[0] || "")}" alt=""><div class="t"><b>${esc(x.name)}</b>${x.category ? `<span class="cat-chip">${esc(x.category)}</span>` : ""}<small>${x.price_hidden ? "Ask for the price" : esc(money(x.price, x.cur) + (UNIT_NAME[x.unit] ? " / " + UNIT_NAME[x.unit][0] : ""))}${x.stock >= 0 ? ` · ${x.stock} available` : ""}${x.admin_hidden ? " · not available now" : ""}</small></div><button class="btn btn-ghost" data-itemedit="${x.id}">Edit</button></div>`).join("") || `<div class="empty">No ${esc(plural.toLowerCase())} yet.</div>`}</div>
      ${e ? "" : form(null)}`;
    el.querySelectorAll("[data-itemedit]").forEach(b => b.onclick = () => { items.edit = b.dataset.itemedit; drawItems(); });
    el.querySelectorAll("[data-itemcancel]").forEach(b => b.onclick = () => { items.edit = null; drawItems(); });
    el.querySelectorAll("[data-itemform]").forEach(f => {
      const fid = f.dataset.itemform, photo = f.querySelector('[data-f="photo"]'); let img = null;
      photo.onchange = async () => { if (photo.files[0]) { img = await compressImage(photo.files[0], 600_000); f.querySelector("[data-photonote]").textContent = photo.files[0].name; } };
      const st2 = f.querySelector(".status-msg");
      f.querySelector("[data-itemsave]").onclick = async ev => {
        const v = k => f.querySelector(`[data-f="${k}"]`);
        const body = { name: v("name").value, category: v("category").value, cur: v("cur").value, price: v("price").value.replace(/[^\d.]/g, ""), unit: v("unit").value, stock: v("stock").value.trim() === "" ? -1 : v("stock").value, price_hidden: v("price_hidden").checked, off: !v("on").checked, description: v("description").value, ...(img ? { images: [img] } : {}) };
        ev.target.disabled = true;
        try { const path = `/api/admin/service-items/${encodeURIComponent(items.id)}${fid === "new" ? "" : "/" + fid}`;
          await api(path, { method: fid === "new" ? "POST" : "PUT", body }); items.list = (await api(`/api/admin/service-items/${encodeURIComponent(items.id)}`)).items; items.edit = null; drawItems(); }
        catch (err) { ev.target.disabled = false; st2.textContent = err.message; st2.className = "status-msg bad"; }
      };
      const del = f.querySelector("[data-itemdel]"); if (del) del.onclick = async () => {
        if (!confirm(window.SarrifI18n ? SarrifI18n.t("Delete this?") : "Delete this?")) return;
        try { await api(`/api/admin/service-items/${encodeURIComponent(items.id)}/${fid}`, { method: "DELETE" }); items.list = items.list.filter(x => x.id !== fid); items.edit = null; drawItems(); } catch (err) { st2.textContent = err.message; }
      };
    });
  }

  /* ---------- service desk orders (for the service's admins) ---------- */
  let desk = { id: null, data: null };
  const DESK_ST = { requested: "New request", accepted: "Accepted · send the agreed price", quoted: "Price sent · waiting for payment", awaiting_payment: "Waiting for payment confirmation",
    paid: "Paid · money held", delivered: "Work done · waiting for the customer", completed: "Finished · money released", cancelled: "Cancelled", declined: "Rejected", payment_rejected: "Payment not received", cancelled_by_seller: "Cancelled" };
  async function loadDesk(id) { const name = desk.name; try { desk = { id, name, data: await api(`/api/admin/service-orders/${encodeURIComponent(id)}`) }; } catch (e) { desk = { id, name, data: { orders: [], balances: {}, held: {}, err: e.message } }; } }
  function deskPanel(id, name) {
    if (desk.id !== id || !desk.data) { setTimeout(async () => { await loadDesk(id); drawDesk(); }, 0); return `<div class="panel" id="desk-panel"><div class="empty">Loading orders…</div></div>`; }
    return `<div class="panel" id="desk-panel">${deskHtml(name)}</div>`;
  }
  function deskHtml(name) {
    const d = desk.data, pend = d.orders.filter(o => !["completed", "cancelled", "declined", "payment_rejected", "cancelled_by_seller"].includes(o.status));
    const card = o => `<div class="person"><div class="person-top"><div class="avatar">${esc((o.buyer_name || "?")[0].toUpperCase())}</div>
        <div class="t"><b>${esc(o.product_name)} × ${o.qty}</b><small>${esc(o.buyer_name)} · +252 ${esc(o.buyer_phone)} · ${new Date(o.created_at).toLocaleString()} · Ref ${esc(o.ref)}</small>
          ${o.book_at ? `<small class="onote book-at">📅 ${esc(o.book_at)}</small>` : ""}${o.note ? `<small class="onote">“${esc(o.note)}”</small>` : ""}${o.offer_desc ? `<small class="onote">${esc(o.offer_desc)}</small>` : ""}
          ${o.total ? `<small>${esc(money(o.total, o.cur))}${o.pay_method && o.pay_method !== "wallet" ? ` · ${esc(PAY_NAME[o.pay_method])}` : ""}</small>` : ""}</div>
        <span class="pill ${statusTone(o.status)}">${esc(DESK_ST[o.status] || o.status)}</span></div>
      <div class="person-actions">
        ${o.status === "requested" ? `<button class="btn btn-primary" data-dact="accept" data-did="${o.id}">Accept</button><button class="btn btn-danger" data-dact="decline" data-did="${o.id}">Reject</button>` : ""}
        ${o.status === "accepted" ? `<div class="offer-form" style="width:100%"><b style="font-size:14px">Send the agreed price</b>
          <input class="input" id="dn-${o.id}" value="${esc(o.product_name)}" aria-label="Item name">
          <textarea class="input" id="dd-${o.id}" rows="2" placeholder="What is included, dates…" aria-label="Description"></textarea>
          <div class="quote-row"><div class="suffix"><span>USD</span><input id="dq-${o.id}" inputmode="decimal" aria-label="Total price"></div><button class="btn btn-primary" data-dquote="${o.id}">Send price</button></div>
          <button class="btn btn-danger" data-dact="decline" data-did="${o.id}">Reject</button></div>` : ""}
        ${o.status === "awaiting_payment" && o.pay_method === "shop" ? `<button class="btn btn-primary" data-dact="money_received" data-did="${o.id}">Money received</button><button class="btn btn-ghost" data-dact="decline" data-did="${o.id}">Not received</button>` : ""}
        ${o.status === "awaiting_payment" && o.pay_method === "safe" ? `<small class="note">The super admin confirms the safe payment. Don't start yet.</small>` : ""}
        ${o.status === "paid" ? `<button class="btn btn-primary" data-dact="deliver" data-did="${o.id}">Work done</button>` : ""}
        ${o.status === "delivered" ? `<small class="note">Waiting for the customer to confirm the work is finished. The money is held until then.</small>` : ""}
      </div></div>`;
    return `<div class="panel-head"><div><h3>${esc(name)} orders</h3><p>Customers ask for ${esc(name)}. Accept, agree the price with them (call or WhatsApp), then send the price. They pay by wallet, safe payment or straight to your numbers; the money is held until they confirm the work is finished.</p></div></div>
      <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">${CURS.map(c => `<div class="kpi warn"><span class="label">Held ${c}</span><b class="num">${money(d.held?.[c] || 0, c)}</b></div>`).join("")}${CURS.map(c => `<div class="kpi"><span class="label">Service account ${c}</span><b class="num">${money(d.balances?.[c] || 0, c)}</b></div>`).join("")}</div>
      <h3 style="font-size:15px">Open (${pend.length})</h3><div class="people">${pend.length ? pend.map(card).join("") : `<div class="empty">No open orders.</div>`}</div>
      ${d.orders.length > pend.length ? `<details><summary>Finished and closed (${d.orders.length - pend.length})</summary><div class="people">${d.orders.filter(o => !pend.includes(o)).map(card).join("")}</div></details>` : ""}
      <span class="status-msg" id="st-desk"></span>`;
  }
  function drawDesk() {
    const el = document.getElementById("desk-panel"); if (!el || !desk.data) return;
    const name = el.dataset.name || ""; el.innerHTML = deskHtml(desk.name || name);
    const go = async (oid, body, b) => { b.disabled = true; try { await api(`/api/admin/service-orders/${encodeURIComponent(desk.id)}/${oid}`, { body }); await loadDesk(desk.id); drawDesk(); } catch (e) { b.disabled = false; const m = document.getElementById("st-desk"); if (m) { m.textContent = e.message; m.className = "status-msg bad"; } } };
    el.querySelectorAll("[data-dact]").forEach(b => b.onclick = () => go(b.dataset.did, { action: b.dataset.dact }, b));
    el.querySelectorAll("[data-dquote]").forEach(b => b.onclick = () => { const id = b.dataset.dquote;
      go(id, { action: "quote", amount: Number(String(document.getElementById("dq-" + id).value).replace(/[^\d.]/g, "")), name: document.getElementById("dn-" + id).value, description: document.getElementById("dd-" + id).value }, b); });
  }
  async function deskAction(id, oid, action) { await api(`/api/admin/service-orders/${encodeURIComponent(id)}/${oid}`, { body: { action } }); await loadDesk(id); drawDesk(); }
  function onDeskOrder(o) {
    if (desk.id === o.desk) loadDesk(o.desk).then(drawDesk);
    if (seenOrder["d" + o.id] === o.status) return; seenOrder["d" + o.id] = o.status;
    const what = `<b>${esc(o.product_name)} × ${o.qty}</b> · ${esc(o.buyer_name)}${o.book_at ? `<br>📅 ${esc(o.book_at)}` : ""}${o.note ? `<br><span class="ring-note">“${esc(o.note)}”</span>` : ""}`;
    if (o.status === "requested") alarm.show({ key: "d" + o.id + o.status, secs: 25, tone: "staff", title: "New service request", body: what,
      actions: [{ label: "Accept", cls: "btn-primary", fn: () => deskAction(o.desk, o.id, "accept") }, { label: "Reject", cls: "btn-danger", fn: () => deskAction(o.desk, o.id, "decline") }] });
    else if (o.status === "paid") alarm.show({ key: "d" + o.id + o.status, secs: 10, tone: "staff", title: "Service order paid", body: `${what}<br>${esc(money(o.total, o.cur))} · money held`, actions: [{ label: "OK", cls: "btn-primary", fn: null }] });
    else if (o.status === "awaiting_payment" && o.pay_method === "shop") alarm.show({ key: "d" + o.id + o.status, secs: 10, tone: "staff", title: "A customer is paying you", body: `${what}<br>${esc(money(o.total - (o.pay_discount || 0) + o.pay_fee, o.cur))}. Confirm when the money arrives.`, actions: [{ label: "OK", cls: "btn-primary", fn: null }] });
  }

  /* ---------- top-up by USSD ---------- */
  // Builds *880*<number>*<amount># from the super admin's settings; the Send button is a tel: link so the phone dials it.
  const topupNum = cur => { const cfg = st.wallet?.topupCfg; return String(cfg?.numbers?.[cur] || cfg?.number || "").replace(/\D/g, ""); };
  const topupReady = cur => cur ? !!topupNum(cur) : CURS.some(c => topupNum(c));
  // Inside the 5PLUS app the code is dialled straight away, like iBedel; in a browser the tel: link opens the dialer.
  const dialCode = (e, code) => { if (window.SarrifAndroid?.call) { e?.preventDefault(); window.SarrifAndroid.call(code); } };
  function topupCode(cur, amount) {
    const cfg = st.wallet?.topupCfg, num = topupNum(cur);
    let pre = String(cfg?.ussd?.[cur] || "").trim(), amt = Number(amount);
    if (!num || !pre || !(amt > 0)) return null;
    if (!pre.startsWith("*")) pre = "*" + pre;
    if (!pre.endsWith("*")) pre += "*";
    return `${pre}${num}*${cur === "SLSH" ? Math.round(amt) : Math.round(amt * 100) / 100}#`;
  }
  const telHref = code => "tel:" + code.replace(/#/g, "%23");
  const topupLabel = { pending: "Pending", approved: "Added to wallet", rejected: "Not added" };
  function topupList(list) {
    if (!list?.length) return "";
    return `<div class="hist">${list.map(t => `<div class="hist-item"><div class="t"><b>${t.purpose === "subscription" ? "Subscription payment" : "Top-up"}</b><small>${new Date(t.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · Ref ${esc(t.ref)}${t.note ? " · " + esc(t.note) : ""}</small>
      <span class="pill ${t.status === "approved" ? "sent" : t.status === "rejected" ? "susp" : "waiting"}" style="align-self:flex-start">${topupLabel[t.status]}</span></div>
      <div class="a num">${money(t.amount, t.cur)}${t.status === "pending" ? `<br><button class="copy" data-tpcancel="${esc(t.id)}">Cancel</button>` : ""}</div></div>`).join("")}</div>`;
  }
  // A "Send" link that dials the code; clicking it also records the request (the phone leaves to the dialer).
  async function recordTopup(body, statusEl) {
    try { await api("/api/wallet/topup", { body }); await loadWallet(); if (S.service === "wallet") render(); else if (statusEl) statusEl.textContent = "Sent. It shows as pending until support confirms it."; return true; }
    catch (e) { if (statusEl) { statusEl.textContent = e.message; statusEl.className = "err"; } return false; }
  }

  /* ---------- customer views ---------- */
  function walletChip() {
    const b = st.wallet?.balances; if (!b) return "";
    return `<button class="wal-chip" data-svcgo="wallet" aria-label="Open wallet">${ICON_W}<span>${money(b.USD, "USD")}</span><span>${money(b.SLSH, "SLSH")}</span></button>`;
  }
  const ICON_W = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/></svg>';

  function view() {
    if (S.service === "wallet") return vWallet();
    if (S.service === "affiliate") return vAffiliate();
    return vSuuq();
  }
  function vWallet() {
    const w = st.wallet, wa = String(w?.support?.whatsapp || settings.support?.whatsapp || "").replace(/\D/g, "");
    return `<div class="view">
      <div class="svc-bar">${back("hub")}<b>Wallet</b></div>
      <div class="wal-cards">${CURS.map(c => { const p = pendingTopup(w, c); return `<div class="wal-card ${c}"><span class="label">${c === "USD" ? "US Dollar" : "Somaliland Shilling"}</span><b class="num">${money(w?.balances?.[c] || 0, c)}</b>${p ? `<small class="wal-pend num">+${money(p, c)} pending</small>` : ""}</div>`; }).join("")}</div>
      ${vTopupForm()}
      ${(w?.topups || []).length ? `<h3 style="font-size:16px">Top-ups</h3>${topupList(w.topups)}` : ""}
      <div class="leg"><b style="font-family:var(--display)">Withdraw</b>
        <p class="note" style="margin:0">To take money out of your wallet, contact our support team. You can use your wallet in Suuq and the other services (not iBedel).</p>
        ${wa ? `<a class="btn wa-btn btn-block" href="https://wa.me/${wa}" target="_blank" rel="noopener">${ICON.wa}Contact support on WhatsApp</a>` : ""}</div>
      <h3 style="font-size:16px">History</h3>
      <div class="hist">${(w?.tx || []).length ? w.tx.map(t => `<div class="hist-item"><div class="t"><b>${esc(t.label)}</b><small>${new Date(t.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}${t.note ? " · " + esc(t.note) : ""}${t.ref ? " · " + esc(t.ref) : ""}</small></div>
        <div class="a num" style="color:${t.amount < 0 ? "var(--danger)" : "var(--green)"}">${t.amount < 0 ? "−" : "+"}${money(Math.abs(t.amount), t.cur)}</div></div>`).join("") : `<div class="empty">No wallet activity yet.</div>`}</div>
    </div>`;
  }
  // Top-ups sent but not yet confirmed by the super admin.
  const pendingTopup = (w, c) => (w?.topups || []).filter(t => t.status === "pending" && t.cur === c && t.purpose !== "subscription").reduce((a, t) => a + Number(t.amount), 0);
  const topupHint = (cur, amount) => Number(amount) > 0 ? `After you send, <b class="num">${esc(money(Number(amount), cur))}</b> shows as pending until support confirms it and adds it to your wallet.` : "Type the amount, then press Send.";
  function vTopupForm() {
    const t = st.topup || (st.topup = { cur: "USD", amount: "" });
    const code = topupCode(t.cur, t.amount), ready = topupReady();
    if (!ready) return `<div class="leg"><b style="font-family:var(--display)">Top up</b><p class="note" style="margin:0">Top-up isn't set up yet. Contact support to add money.</p></div>`;
    return `<div class="leg"><b style="font-family:var(--display)">Top up</b>
      <div class="cur-toggle" style="grid-template-columns:1fr 1fr">${CURS.map(c => `<button class="${c}" data-tpcur="${c}" aria-pressed="${t.cur === c}">${c === "USD" ? "USD · Dollar" : "SLSH · Shilling"}</button>`).join("")}</div>
      <div class="amount-box"><span>${t.cur === "USD" ? "$" : "SLSH"}</span><input id="tp-amount" inputmode="decimal" placeholder="0" value="${esc(t.amount)}" aria-label="Top-up amount"></div>
      <p class="note" style="margin:0" id="tp-code">${topupHint(t.cur, t.amount)}</p>
      <a class="btn btn-primary btn-block ${code ? "" : "is-off"}" id="tp-send" href="${code ? esc(telHref(code)) : "#"}" aria-disabled="${!code}">Send</a>
      <span class="note" id="tp-status"></span></div>`;
  }
  // Earnings: what has collected, the amount the person withdraws at (with a progress bar), and Withdraw.
  function vEarnings(a) {
    if (!a) return "";
    const e = a.earnings || { USD: 0, SLSH: 0 }, lim = a.withdraw_at || { USD: 0, SLSH: 0 }, isSet = (lim.USD || 0) > 0 || (lim.SLSH || 0) > 0;
    // Each currency on its own; when it reaches the amount, send it with iBedel to ZAAD, eDahab, Soltelco or Premier.
    const row = c => {
      const bal = Number(e[c]) || 0, l = Number(lim[c]) || 0, pct = l > 0 ? Math.min(100, Math.round(bal / l * 100)) : bal > 0 ? 100 : 0, ready = bal > 0 && (l === 0 || bal >= l);
      if (c === "SLSH" && !bal && !l) return "";
      return `<div class="earn-row"><div class="earn-top"><span><small>${c === "USD" ? "US Dollar" : "Shilling"}</small><b class="num">${money(bal, c)}</b></span>
          ${ready ? `<button class="btn btn-primary" data-ebedel="${c}">Send with iBedel</button>` : `<button class="btn btn-ghost" disabled>Send with iBedel</button>`}</div>
        <div class="earn-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <small class="note">${l > 0 ? (ready ? "Ready: send it to your ZAAD, eDahab, Soltelco or Premier with iBedel." : `Withdraw at ${money(l, c)} · ${money(Math.max(0, l - bal), c)} to go`) : "Withdraw any time."}</small></div>`;
    };
    return `<div class="earn-card"><div class="earn-head"><b>Your earnings</b>${isSet ? `<small class="note">Withdraw at ${["USD", "SLSH"].filter(c => lim[c]).map(c => money(lim[c], c)).join(" · ")}</small>` : ""}</div>
      ${!isSet ? `<div class="earn-edit"><span class="label">Choose your withdraw amounts (once — they can't be changed later)</span>
        <label for="ew-usd">Withdraw at (USD)</label><div class="suffix"><span>$</span><input id="ew-usd" inputmode="decimal" placeholder="50"></div>
        <label for="ew-slsh">Withdraw at (SLSH)</label><div class="suffix"><span>SLSH</span><input id="ew-slsh" inputmode="numeric" placeholder="500000"></div>
        <button class="btn btn-primary" id="ew-save">Save</button></div>` : ""}
      ${row("USD")}${row("SLSH")}
      ${(a.pending || []).length ? `<small class="note">On the way: ${a.pending.map(r => money(r.total, r.cur)).join(" · ")}. It is added when the order is completed (the buyer confirms they received it).</small>` : ""}
      <span class="status-msg ${st.earnMsg ? "ok" : ""}" id="st-earn">${esc(st.earnMsg || "")}</span></div>`;
  }
  function vAffiliate() {
    const a = st.aff, code = a?.code || S.user.ref_code;
    const sum = arr => (arr || []).map(r => money(r.total, r.cur)).join(" · ") || "—";
    return `<div class="view">
      <div class="svc-bar">${back("hub")}<b>Affiliate program</b></div>
      <div class="aff-hero"><span class="label" style="color:inherit;opacity:.85">Share products · earn money</span>
        <div class="aff-code"><span>Your code</span><b class="num">${esc(code || "—")}</b></div></div>
      <div class="kpis" style="grid-template-columns:1fr 1fr"><div class="kpi"><span class="label">Earned</span><b class="num" style="font-size:16px">${sum(a?.earned)}</b></div><div class="kpi warn"><span class="label">On the way</span><b class="num" style="font-size:16px">${sum(a?.pending)}</b></div></div>
      ${vEarnings(a)}
      <h3 style="font-size:16px">Products you can share</h3>
      <div class="aff-list">${(a?.products || []).length ? a.products.map(p => `<div class="aff-item">
          ${p.images[0] ? `<img src="${esc(p.images[0])}" alt="">` : `<span class="noimg">▶</span>`}
          <div class="t"><b>${esc(p.name)}</b><small>${esc(priceText(p))}${p.service === "visa" ? " · Visa" : ""} · ${p.first_sender ? "Shared with you first by someone else, so they earn" : `<span class="earn">${esc(earnText(p))}</span>`}</small></div>
          <button class="btn btn-primary" data-share="${esc(p.id)}">Copy link</button></div>`).join("") : `<div class="empty">No products with affiliate earnings yet.</div>`}</div>
      <h3 style="font-size:16px">Earning history</h3>
      <div class="hist">${(a?.list || []).length ? a.list.map(o => `<div class="hist-item"><div class="t"><b>${esc(o.product_name)} × ${o.qty}</b><small>${new Date(o.created_at).toLocaleDateString()} · ${esc(statusLabel[o.status] || o.status)}</small></div><div class="a num">${o.status === "completed" ? "+" : ""}${money(o.commission, o.cur)}</div></div>`).join("") : `<div class="empty">Share a link to start earning.</div>`}</div>
    </div>`;
  }

  function vSuuq() {
    if (st.product) return vProduct();
    if (st.chat) return vThread();
    if (st.shopView) return vShopPage();
    const merchant = S.user.account_type === "merchant";
    if (!merchant && st.tab === "sell" && st.shop === null && !st.becoming) st.becoming = true;
    const tabs = [["shop", st.market === "visa" ? "Visas" : st.market === "scholarship" ? "Scholarships" : "Shop"], ["orders", "My orders"], ["chats", "Chats" + (unreadChats() ? ` (${unreadChats()})` : "")]];
    if (merchant) tabs.push(["sell", "My shop" + (pendingSeller() ? ` (${pendingSeller()})` : "")]);
    if (!merchant && st.tab === "sell") tabs.push(["sell", "Become a merchant"]);
    const body = st.tab === "shop" ? vShop() : st.tab === "orders" ? vOrders() : st.tab === "chats" ? vChats() : vSell();
    return `<div class="view">
      <div class="svc-bar">${back("hub", "Back to services")}<b>${marketName()}</b><span style="flex:1"></span>${walletChip()}</div>
      <div class="sq-tabs" role="group" aria-label="${marketName()}">${tabs.map(([k, l]) => `<button data-sqtab="${k}" aria-pressed="${st.tab === k}">${esc(l)}</button>`).join("")}</div>
      ${body}${st.multi ? vMultiSheet() : ""}</div>`;
  }
  // One shop's page: opened from search or from "Sold by" on a product.
  async function openShop(id) {
    try { const r = await api(`/api/suuq/shops/${id}`); st.shopView = r; st.product = null; st.chat = null; if (!inMarket()) S.service = "suuq"; }
    catch (e) { st.shopView = { error: e.message, shop: null, products: [] }; }
    if (!st.wallet) await loadWallet();
    render(); window.scrollTo(0, 0);
  }
  function vShopPage() {
    const v = st.shopView, s = v.shop;
    return `<div class="view">
      <div class="svc-bar">${back("closeshop")}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s ? s.name : "Shop")}</b>${walletChip()}</div>
      ${s ? `<div class="shop-card"><span class="hm-ic shop">${ICON_SHOP}</span><div><b>${esc(s.name)}</b>
          <small>${s.kind === "company" ? "Company" : "Shop"} number <b class="num">${esc(s.shop_no)}</b></small>
          <small>${s.owner_name ? esc(s.owner_name) : ""}${s.city ? " · " + esc(s.city) : ""}${s.country ? ", " + esc(s.country) : ""}</small></div></div>
        ${v.products.length ? `<div class="pgrid">${v.products.map(productCard).join("")}</div>` : `<div class="empty">This shop has no products right now.</div>`}`
        : `<div class="empty">${esc(v.error || "This shop is not open right now.")}</div>`}
    </div>`;
  }
  const ICON_SHOP = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 14a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 11z"/><path d="M5 13.5V20h14v-6.5M10 20v-4h4v4"/></svg>';
  // A country's flag, from its English name (the browser knows the names). No flag when it doesn't know it.
  let FLAGS = null;
  function flagOf(name) {
    if (!name) return "";
    if (!FLAGS) {
      FLAGS = {};
      try {
        const dn = new Intl.DisplayNames(["en"], { type: "region" }), A = 65;
        for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
          const code = String.fromCharCode(A + i, A + j), n = dn.of(code);
          if (n && n !== code) FLAGS[n.toLowerCase()] = String.fromCodePoint(0x1f1e6 + i, 0x1f1e6 + j);
        }
        Object.assign(FLAGS, { "türkiye": FLAGS["turkey"] || FLAGS["türkiye"], "turkey": FLAGS["türkiye"] || FLAGS["turkey"], "côte d'ivoire": FLAGS["côte d’ivoire"], "czechia": FLAGS["czechia"] || FLAGS["czech republic"], "vatican city": FLAGS["vatican city"], "congo": FLAGS["congo - brazzaville"] || FLAGS["congo"], "democratic republic of the congo": FLAGS["congo - kinshasa"], "myanmar": FLAGS["myanmar (burma)"] || FLAGS["myanmar"], "palestine": FLAGS["palestinian territories"] || FLAGS["palestine"], "micronesia": FLAGS["micronesia"] || FLAGS["micronesia, federated states of"] });
      } catch {}
    }
    return FLAGS[String(name).toLowerCase()] || "";
  }
  const countryTag = c => c ? `${flagOf(c) ? flagOf(c) + " " : ""}${esc(c)}` : "";
  /* ---------- TikTok on every product ---------- */
  // A product whose video is a TikTok link opens that video. Any other product is shared to TikTok: its link
  // (with your affiliate code) is copied and TikTok opens, so you can paste it in your video or bio and earn.
  const TT_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.6 2h-3.3v13.2a2.9 2.9 0 1 1-2.9-2.9c.3 0 .6 0 .9.1V9a6.3 6.3 0 1 0 5.3 6.2V8.5a7.9 7.9 0 0 0 4.4 1.4V6.6a4.6 4.6 0 0 1-4.4-4.6z"/></svg>';
  const isTikTok = u => /^https:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i.test(String(u || ""));
  const ttButton = (p, cls = "p-tt") => isTikTok(p.video)
    ? `<a class="${cls}" href="${esc(p.video)}" target="_blank" rel="noopener" aria-label="Watch ${esc(p.name)} on TikTok">${TT_ICON}${cls === "p-tt" ? "" : "<span>TikTok</span>"}</a>`
    : `<button class="${cls}" data-ptt="${esc(p.id)}" aria-label="Share ${esc(p.name)} on TikTok">${TT_ICON}${cls === "p-tt" ? "" : "<span>TikTok</span>"}</button>`;
  function openOut(url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.hidden = true; document.body.appendChild(a); a.click(); a.remove(); }
  function ttNote(text) {
    let n = document.getElementById("tt-note"); if (!n) { n = document.createElement("div"); n.id = "tt-note"; n.className = "tt-note"; n.setAttribute("role", "status"); document.body.appendChild(n); }
    n.textContent = text; n.classList.add("show"); clearTimeout(ttNote.t); ttNote.t = setTimeout(() => n.classList.remove("show"), 3200);
  }
  async function shareTikTok(pid) {
    const link = shareLink(pid, codeFor(pid));
    let copied = false;
    try { await navigator.clipboard.writeText(link); copied = true; } catch {}
    if (!copied) try { const t = document.createElement("textarea"); t.value = link; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); copied = document.execCommand("copy"); t.remove(); } catch {}
    ttNote(copied ? "Link copied. Paste it in your TikTok video or bio. You earn when someone buys." : link);
    setTimeout(() => openOut("https://www.tiktok.com/"), 500);
  }
  function bindTikTok(root) {
    (root || document).querySelectorAll("[data-ptt]").forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); shareTikTok(b.dataset.ptt); });
  }
  /* ---------- Buy several products together (no cart) ---------- */
  // Tick the circle on product cards; a bar shows how many are chosen and the total; Buy now pays for all of them at once.
  const picked = new Map(); // product id → { p, qty }
  const canPick = p => p && p.mode === "buy" && !asksPrice(p) && p.service !== "ticket" && !p.pause && S.user && p.seller_id !== S.user.id && S.user.role === "customer";
  const PICK_IC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const pickBtn = p => canPick(p) ? `<button class="pick-btn" data-pick="${esc(p.id)}" aria-pressed="${picked.has(p.id)}" aria-label="Choose ${esc(p.name)} to buy">${picked.has(p.id) ? PICK_IC : "+"}</button>` : "";
  const pickTotals = () => { const t = {}; for (const { p, qty } of picked.values()) t[p.cur] = (t[p.cur] || 0) + p.price * qty; return t; };
  function syncPickBar() {
    let bar = document.getElementById("pick-bar");
    if (!picked.size || st.multi) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "pick-bar"; bar.className = "pick-bar"; bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Chosen products"); document.body.appendChild(bar); }
    const t = pickTotals(), mixed = Object.keys(t).length > 1;
    bar.innerHTML = `<span class="pb-t"><b>${picked.size} chosen</b><small class="num">${Object.entries(t).map(([c, v]) => money(v, c)).join(" · ")}${mixed ? ` · <span style="color:var(--danger)">${esc("Choose products in one currency")}</span>` : ""}</small></span>
      <button class="btn btn-ghost" data-pickclear>Clear</button><button class="btn btn-primary" data-pickbuy ${mixed ? "disabled" : ""}>Buy now</button>`;
  }
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-pick], [data-pickclear], [data-pickbuy]"); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.pick) {
      const id = b.dataset.pick;
      if (picked.has(id)) picked.delete(id);
      else { let p = [...(st.products || []), ...(st.favs || []), ...(st.shopView?.products || []), ...((typeof S !== "undefined" && S.techMk) || []), st.product].find(x => x && x.id === id);
        if (p) picked.set(id, { p, qty: 1 });
        else api(`/api/suuq/products/${encodeURIComponent(id)}`).then(r => { picked.set(id, { p: r.product, qty: 1 }); syncPickBar(); }).catch(() => {}); }
      document.querySelectorAll(`[data-pick="${CSS.escape(id)}"]`).forEach(x => { const on = picked.has(id); x.setAttribute("aria-pressed", on); x.innerHTML = on ? PICK_IC : "+"; });
      syncPickBar();
    } else if (b.hasAttribute("data-pickclear")) { picked.clear(); document.querySelectorAll("[data-pick]").forEach(x => { x.setAttribute("aria-pressed", false); x.innerHTML = "+"; }); syncPickBar(); }
    else openMulti();
  }, true);
  async function openMulti() {
    if (!picked.size) return;
    st.multi = { items: [...picked.values()].map(x => ({ p: x.p, qty: x.qty })), method: "wallet", pin: "", note: "", err: "" };
    syncPickBar();
    if (!inMarket()) { st.tab = "shop"; st.product = null; st.chat = null; S.service = "suuq"; await open("suuq"); }
    await loadWallet(); render();
  }
  function vMultiSheet() {
    const m = st.multi;
    if (m.done) {
      const d = m.done, cur = d.orders[0]?.cur || "USD";
      return `<div class="sheet"><div class="sheet-card"><div class="receipt"><div class="tick">${ICON.tick}</div>
        <h3 style="font-size:20px">${d.orders.length > 1 ? `${d.orders.length} orders placed` : "Order placed"}</h3>
        <p class="note" style="margin:0">${d.pay_ussd ? `Your phone is dialling to pay <b class="num">${esc(money(d.total + d.fee, cur))}</b> for everything. The money is held safely and each seller gets paid after you confirm you received their product.` : `We took <b class="num">${esc(money(d.total, cur))}</b> from your wallet and hold it safely. Each seller gets paid after you confirm you received their product.`}</p>
        <div class="multi-done">${d.orders.map(o => `<span>${esc(o.product_name)} × ${o.qty} · <span class="num">${esc(o.ref)}</span></span>`).join("")}</div></div>
        <button class="btn btn-primary btn-block" data-sq="multiorders">See my orders</button><button class="btn btn-ghost btn-block" data-sq="closemulti">Keep shopping</button></div></div>`;
    }
    const cur = m.items[0]?.p.cur || "USD", total = m.items.reduce((a, x) => a + x.p.price * x.qty, 0), bal = st.wallet?.balances?.[cur] ?? 0;
    const safeOk = payOptions({}, null).safe.ok; if (!safeOk) m.method = "wallet";
    const wal = m.method === "wallet", low = wal && bal < total, fee = wal ? 0 : payFeeOf(cur, total);
    return `<div class="sheet"><div class="sheet-card">
      <h3 style="font-size:19px">Buy ${m.items.length} product${m.items.length > 1 ? "s" : ""}</h3>
      <div class="multi-list">${m.items.map((x, i) => `<div class="mi"><span class="mi-img">${x.p.images[0] ? `<img src="${esc(x.p.images[0])}" alt="">` : ""}</span>
        <span class="mi-t"><b>${esc(x.p.name)}</b><small>${esc(x.p.shop_name)} · <span class="num">${money(x.p.price, cur)}</span></small></span>
        <span class="qty mini"><button class="icon-btn" data-mqty="${i}:-1" aria-label="Less">−</button><b class="num">${x.qty}</b><button class="icon-btn" data-mqty="${i}:1" aria-label="More">+</button></span>
        <button class="icon-btn mi-rm" data-mrm="${i}" aria-label="Remove ${esc(x.p.name)}">✕</button></div>`).join("")}</div>
      <div class="field"><label for="ms-note">Delivery address or note</label><input class="input" id="ms-note" maxlength="300" value="${esc(m.note)}"></div>
      <div class="summary"><div class="sum-row total"><span>Total</span><b class="num">${money(total, cur)}</b></div>
        ${wal ? `<div class="sum-row"><span>Your wallet</span><b class="num" style="color:${low ? "var(--danger)" : "var(--ink)"}">${money(bal, cur)}</b></div>` : `<div class="sum-row"><span>Charge</span><b class="num">${money(fee, cur)}</b></div><div class="sum-row total"><span>You pay</span><b class="num">${money(total + fee, cur)}</b></div>`}</div>
      ${safeOk ? `<div class="paym" role="radiogroup" aria-label="How do you want to pay?"><b class="paym-h">How do you want to pay?</b>
        ${["wallet", "safe"].map(k => `<button class="paym-opt" role="radio" data-mpaym="${k}" aria-checked="${m.method === k}"><span class="paym-ic ${k}">${PAY_IC[k]}</span><span class="paym-t"><b>${PAY_NAME[k]}</b><small>${k === "wallet" ? `Balance ${money(bal, cur)} · held safely until you receive it` : "One payment by phone for everything · held safely until you receive it"}</small></span><span class="paym-dot"></span></button>`).join("")}</div>` : ""}
      ${low ? topupInline(cur, total, m) : `<div class="field"><label for="ms-pin">Enter your PIN to place the order</label>${pinInput("ms-pin", m.pin)}</div>`}
      <div class="err" role="alert">${esc(m.err || "")}</div>
      ${low ? "" : `<button class="btn btn-primary btn-block" data-sq="multipay" ${(m.pin || "").length === 4 ? "" : "disabled"}>Pay ${money(wal ? total : total + fee, cur)}</button>`}
      <button class="btn btn-ghost btn-block" data-sq="closemulti">Cancel</button></div></div>`;
  }
  async function placeMulti() {
    const m = st.multi; if (!m) return;
    m.note = (document.getElementById("ms-note") || {}).value ?? m.note;
    if ((m.pin || "").length !== 4) { m.err = "Enter your PIN to place the order."; return render(); }
    try {
      const r = await api("/api/suuq/orders/multi", { body: { items: m.items.map(x => ({ product_id: x.p.id, qty: x.qty, ref: refFor(x.p.id) })), method: m.method, note: m.note, pin: m.pin } });
      m.done = r; picked.clear(); if (r.balances && st.wallet) st.wallet.balances = r.balances;
      if (r.pay_ussd) dialNow(r.pay_ussd);
    } catch (e) { m.err = e.message; m.pin = ""; }
    render();
  }
  function productCard(p) {
    return `<div class="pcard-w">${ttButton(p)}${pickBtn(p)}<button class="pcard" data-prod="${esc(p.id)}">
      <span class="pimg">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy">` : `<span class="noimg">▶ Video</span>`}<span class="mode ${p.mode}">${p.mode === "buy" ? "Buy" : "Book"}</span>${p.pause ? `<span class="pause-tag">${p.pause === "salah" ? "Salah time" : "Sleep time"}</span>` : ""}</span>
      <span class="pbody">${hasCountry(p.service) && p.country ? `<span class="visa-country">${countryTag(p.country)}</span>` : ""}<b>${esc(p.name)}</b><span class="price ${p.price == null ? "hidden-price" : "num"}">${esc(priceText(p))}</span><small>${p.service === "scholarship" ? `<span class="by-agency">${PLANE_S}${esc(p.shop_name)}</span>` : `${esc(p.shop_name)}${p.shop_no ? ` · no. ${esc(p.shop_no)}` : ""}`}</small>${earnFor(p) ? `<span class="earn">${esc(earnFor(p))}</span>` : ""}</span></button></div>`;
  }
  // Visas: a "Rounded Horizontal Feature Card" at the top (icon, title, subtitle), and each visa as a horizontal card:
  // photo on the left; name, country, price and agency on the right.
  function visaFeature() {
    const sv = (settings.services || []).find(x => x.id === "visa") || { name: "Visa", sub: "Travel visas" };
    return `<div class="feat-card"><span class="feat-ic"><img src="/photos/services/visa-icon.jpg" alt=""></span>
      <span class="feat-t"><b>${esc(sv.name)}</b><small>${esc(sv.sub || "")}</small></span></div>`;
  }
  function visaCard(p) {
    return `<div class="hcard-w"><button class="hcard" data-prod="${esc(p.id)}">
      <span class="hcard-img">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy">` : `<img src="/photos/services/visa-icon.jpg" alt="">`}</span>
      <span class="hcard-t"><b>${esc(p.name)}</b>
        ${p.country ? `<small class="hcard-country">${countryTag(p.country)}</small>` : ""}
        <span class="price ${p.price == null ? "hidden-price" : "num"}">${esc(priceText(p))}</span>
        <small class="hcard-by">${PLANE_S}${esc(p.shop_name)}</small>
        ${earnFor(p) ? `<span class="earn">${esc(earnFor(p))}</span>` : ""}</span>
      <span class="hcard-go" aria-hidden="true">›</span></button>${ttButton(p)}</div>`;
  }
  // Suuq by business category: a bar of categories, then a row of products for each one.
  const CAT_EMOJI = { "Supermarket": "🛒", "Dukan": "🏪", "Clothes": "👕", "Electronics": "📺", "Mobile Phones": "📱", "Shoes": "👟", "Bags": "👜", "Cosmetics": "💄",
    "Perfumes": "🌸", "Jewelry": "💍", "Furniture": "🛋️", "Home Appliances": "🔌", "Car Spare Parts": "⚙️", "Car Dealership": "🚗", "Hardware Store": "🔨",
    "Building Materials": "🧱", "Bookshop": "📚", "Stationery": "✏️", "Cargo Services": "📦", "Computer Shop": "💻", "Fuel Station": "⛽", "Real Estate": "🏠",
    "Sports & Fitness": "⚽", "Toys & Kids Products": "🧸" };
  const catEmoji = n => CAT_EMOJI[n] || "🏷️";
  // Suuq categories are tiles on the home screen; one opens Suuq showing that category.
  const CAT_COLORS = { "Supermarket": ["#2E7D32", "#81C784"], "Dukan": ["#6D4C41", "#BCAAA4"], "Clothes": ["#AD1457", "#F48FB1"], "Electronics": ["#1565C0", "#64B5F6"], "Mobile Phones": ["#0277BD", "#81D4FA"],
    "Shoes": ["#37474F", "#B0BEC5"], "Bags": ["#8E24AA", "#CE93D8"], "Cosmetics": ["#C2185B", "#F8BBD0"], "Perfumes": ["#5D4037", "#D7CCC8"], "Jewelry": ["#B8860B", "#FFE082"], "Furniture": ["#795548", "#D7CCC8"],
    "Home Appliances": ["#00838F", "#80DEEA"], "Car Spare Parts": ["#424242", "#BDBDBD"], "Car Dealership": ["#B71C1C", "#EF9A9A"], "Hardware Store": ["#E65100", "#FFCC80"], "Building Materials": ["#8D6E63", "#EFEBE9"],
    "Bookshop": ["#283593", "#9FA8DA"], "Stationery": ["#F9A825", "#FFF59D"], "Cargo Services": ["#4E342E", "#A1887F"], "Computer Shop": ["#455A64", "#CFD8DC"], "Fuel Station": ["#1B5E20", "#A5D6A7"],
    "Real Estate": ["#00695C", "#80CBC4"], "Sports & Fitness": ["#33691E", "#C5E1A5"], "Toys & Kids Products": ["#EF6C00", "#FFE0B2"] };
  const catTile = name => { const [a, b] = CAT_COLORS[name] || ["#0E7A55", "#8FD3B6"];
    return `<button class="hub-tile is-ready cat-tile" data-catgo="${esc(name)}"><span class="hub-art cat-art" style="background:linear-gradient(135deg,${a},${b})"><span class="cat-emo" aria-hidden="true">${catEmoji(name)}</span></span><span class="hub-body"><b>${esc(name)}</b><small>Suuq</small></span></button>`; };
  async function openCategory(name) { st.suuqCat = name; st.tab = "shop"; st.product = null; st.shopView = null; st.chat = null; S.service = "suuq"; await open("suuq"); window.scrollTo(0, 0); }
  function vSuuqBrowse() {
    const cur = st.suuqCat || "";
    if (!cur) return st.products.length ? `<div class="pgrid">${st.products.map(productCard).join("")}</div>` : `<div class="empty">${st.q ? "Nothing matches your search." : "No products yet."}</div>`;
    const list = st.products.filter(p => p.category === cur);
    return `<div class="cat-head"><span class="cat-emo-s" aria-hidden="true">${catEmoji(cur)}</span><b>${esc(cur)}</b><button class="btn btn-ghost" data-scat="">All products</button></div>`
      + (list.length ? `<div class="pgrid">${list.map(productCard).join("")}</div>` : `<div class="empty">${st.q ? "Nothing matches your search." : "No products in this category yet."}</div>`);
  }
  function vShop() {
    const visa = st.market === "visa", scholar = st.market === "scholarship";
    if (st.market === "suuq") return `<div class="sq-search"><input class="input" id="sq-q" placeholder="Search products or shops" value="${esc(st.q)}" aria-label="Search"></div>${vSuuqBrowse()}`;
    const cs = hasCountry(st.market) ? st.visaCountries || [] : [];
    return `${visa ? visaFeature() : ""}<div class="sq-search"><input class="input" id="sq-q" placeholder="${visa ? "Search visas, countries or agencies" : scholar ? "Search scholarships, countries or agencies" : "Search products or shops"}" value="${esc(st.q)}" aria-label="Search"></div>
      ${cs.length ? `<div class="country-chips" role="group" aria-label="Countries"><button data-vcountry="" aria-pressed="${!st.visaCountry}">🌍 All countries</button>${cs.map(c => `<button data-vcountry="${esc(c.name)}" aria-pressed="${st.visaCountry === c.name}">${countryTag(c.name)} <span>${c.n}</span></button>`).join("")}</div>` : ""}
      ${st.products.length ? (visa ? `<div class="hlist">${st.products.map(visaCard).join("")}</div>` : `<div class="pgrid">${st.products.map(productCard).join("")}</div>`) : `<div class="empty">${st.q ? "Nothing matches your search." : visa ? "No visas yet. Sellers will post them here soon." : scholar ? "No scholarships yet. Travel agencies will post them here soon." : "No products yet. Sellers will post here soon."}</div>`}`;
  }
  const HEART = '<svg width="22" height="22" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.9 4.5 6.7 4.5c2.2 0 3.6 1.3 5.3 3.3 1.7-2 3.1-3.3 5.3-3.3 3.8 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>';
  function vProduct() {
    const p = st.product, mine = p.seller_id === S.user.id, os = st.orderSheet;
    const code = S.user.ref_code;
    return `<div class="view">
      <div class="svc-bar">${back("closeprod")}<b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</b>${walletChip()}</div>
      ${p.images.length ? `<div class="gal-wrap"><div class="gallery" id="gallery">${p.images.map((src, i) => `<button class="gal-img" data-zoomimg="${i}" aria-label="Open photo ${i + 1} of ${p.images.length} full screen"><img src="${esc(src)}" alt="${esc(p.name)}, photo ${i + 1} of ${p.images.length}"></button>`).join("")}</div>
        ${p.images.length > 1 ? `<span class="gal-count num" id="gal-count">1 / ${p.images.length}</span>` : ""}
        <button class="gal-zoom" data-zoomimg="cur" aria-label="Zoom photo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M10.5 7.5v6M7.5 10.5h6"/></svg></button></div>` : ""}
      ${p.images.length > 1 ? `<div class="thumbs" role="group" aria-label="Photos">${p.images.map((src, i) => `<button data-thumb="${i}" aria-label="Show photo ${i + 1}" aria-current="${i === 0}"><img src="${esc(src)}" alt=""></button>`).join("")}</div>` : ""}
      ${videoEmbed(p.video)}
      <div>${hasCountry(p.service) && p.country ? `<span class="visa-country big">${countryTag(p.country)}</span>` : ""}<div class="ptitle-row"><h2 style="font-size:21px">${esc(p.name)}</h2>${mine ? "" : `<button class="fav-btn" data-fav="${esc(p.id)}" aria-pressed="${!!p.fav}" aria-label="${p.fav ? "Remove from favourites" : "Add to favourites"}">${HEART}</button>`}${ttButton(p, "tt-btn")}</div><div class="price ${p.price == null ? "hidden-price" : "num"}" style="font-size:22px">${esc(priceText(p))}</div>
        ${mine && p.price_hidden ? `<small class="note">Price hidden: customers see “${esc(p.price_label)}”.</small>` : ""}
        <small class="note">Sold by <button class="link-btn" data-openshop="${esc(p.shop_id)}">${esc(p.shop_name)}${p.shop_no ? ` (no. ${esc(p.shop_no)})` : ""}</button> · ${asksPrice(p) ? "Ask for the price, then pay from your wallet" : p.mode === "buy" ? "Buy now, pay from your wallet" : "Book now, pay the seller later"}</small></div>
      ${p.description ? `<p style="margin:0;white-space:pre-wrap">${esc(p.description)}</p>` : ""}
      ${mine ? `<div class="earn-box"><div><b>Share your product</b><small>Your link has no affiliate code, so when someone buys through it you keep the whole price.</small></div><button class="btn btn-ghost" data-share="${esc(p.id)}">Copy link</button></div>`
        : p.first_sender && earnText(p) ? `<div class="earn-box"><div><b>Share this product</b><small>You opened it from someone's link. They shared it first, so they earn when you or people you send it to buy it.</small></div><button class="btn btn-ghost" data-share="${esc(p.id)}">Copy link</button></div>`
        : earnFor(p) ? `<div class="earn-box"><div><b>${esc(earnFor(p))}</b><details class="earn-more"><summary>How it works</summary><small>Share your link. When someone buys and the order is completed, you get ${p.comm_type === "percent" ? p.comm_value + "% of the price" : money(p.comm_value, p.cur) + " per item"}.</small><small>You also earn it when you buy it yourself.</small></details></div><button class="btn btn-ghost" data-share="${esc(p.id)}">Copy my link</button></div>` : ""}
      ${mine ? `<div class="instr">${p.approval === "pending" ? "Waiting for admin approval. Customers can't see it yet. " : p.approval === "rejected" ? `Not approved: ${esc(p.review_note)}. ` : ""}This is your product. Edit it from My shop → Products.</div>` : `
        ${p.pause ? `<div class="pause-note ${p.pause}" role="status"><b>${p.pause === "salah" ? "Salah time" : "Sleep time"}</b><span>${p.pause === "salah" ? "This seller is at prayer. Orders open again when they finish. You can still chat with them." : "This seller is closed for the night. Orders open again in the morning. You can still chat with them."}</span></div>` : ""}
        <div class="row-actions" style="gap:8px">
          <button class="btn btn-primary" data-order style="flex:1" ${p.pause ? "disabled" : ""}>${asksPrice(p) ? "Ask for price" : p.mode === "buy" ? "Buy now" : "Book now"}</button>
          ${String(p.service).startsWith("svc:") ? "" : `<button class="btn btn-ghost" data-chat="${esc(p.id)}" style="flex:1">Chat with seller</button>`}</div>`}
      ${os ? vOrderSheet(p, os) : ""}
    </div>`;
  }
  /* ---------- choosing how to pay: Wallet, Safe payment or Pay to shop ---------- */
  const PAY_IC = {
    wallet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7V6a2 2 0 0 1 2-2h11"/><circle cx="16.5" cy="13.5" r="1.3"/></svg>',
    safe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
    shop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9l1.5-5h13L20 9"/><path d="M4 9h16v2a3 3 0 0 1-5.3 2 3 3 0 0 1-5.4 0A3 3 0 0 1 4 11z"/><path d="M5 13v7h14v-7"/><path d="M10 20v-4h4v4"/></svg>',
  };
  const payFeeOf = (cur, amt) => { for (const r of settings.tiers?.[cur] || []) if (r.upTo == null || amt <= Number(r.upTo)) { const f = Number(r.fee) || 0; return cur === "SLSH" ? Math.round(f) : f; } return 0; };
  // Pay to shop: { mode: "wallet" | "discount" | "none", discount }. "none": the merchant's wallet can't cover the
  // earning of the person who shared the link, so Pay to shop isn't offered. "discount": the buyer earns it, so they
  // pay the price minus their earning.
  function shopInfoOf(p, qty) {
    const per = Number(p.earn) || 0;
    if (!(per > 0) || p.price == null || qty <= (p.shop_cover ?? 100)) return { mode: "wallet", discount: 0 };
    return p.earn_mine ? { mode: "discount", discount: Math.round(per * qty * 100) / 100 } : { mode: "none", discount: 0 };
  }
  const dialBase = (box, total, shop) => box.method === "shop" && shop?.mode === "discount" ? Math.max(0, total - shop.discount) : total;
  function payOptions(payShop, shop) {
    const sp = settings.safePay || {}, ps = payShop || {};
    return { wallet: { merchant: false, number: false, ok: true }, safe: { merchant: !!sp.merchant, number: !!sp.number, ok: !!(sp.merchant || sp.number) }, shop: { merchant: !!ps.merchant, number: !!ps.number, ok: !!(ps.merchant || ps.number) && shop?.mode !== "none" } };
  }
  function payChooser(box, cur, total, payShop, shop) {
    const opts = payOptions(payShop, shop);
    if (!box.method || !opts[box.method].ok) box.method = "wallet";
    const bal = st.wallet?.balances?.[cur] ?? 0;
    const sub = { wallet: `Balance ${money(bal, cur)} · held safely until you receive it`, safe: "Pay to the money processor · held safely until you receive it", shop: "Pay straight to the merchant" };
    const o = opts[box.method];
    if (box.method !== "wallet") { if (!box.via || !o[box.via === "normal" ? "number" : "merchant"]) box.via = o.merchant ? "merchant" : "normal"; }
    const disc = box.method === "shop" && shop?.mode === "discount" ? shop.discount : 0, base = Math.max(0, total - disc);
    const fee = payFeeOf(cur, base);
    return `<div class="paym" role="radiogroup" aria-label="How do you want to pay?"><b class="paym-h">How do you want to pay?</b>
      ${["wallet", "safe", "shop"].filter(m => opts[m].ok).map(m => `<button class="paym-opt" role="radio" data-paym="${m}" aria-checked="${box.method === m}"><span class="paym-ic ${m}">${PAY_IC[m]}</span><span class="paym-t"><b>${PAY_NAME[m]}</b><small>${sub[m]}</small></span><span class="paym-dot" aria-hidden="true"></span></button>`).join("")}
      ${box.method !== "wallet" ? `${o.merchant && o.number ? `<div class="paym-via" role="group" aria-label="Number to pay"><button data-payvia="merchant" aria-pressed="${box.via === "merchant"}">Merchant number</button><button data-payvia="normal" aria-pressed="${box.via === "normal"}">Normal number</button></div>` : ""}
        <div class="summary"><div class="sum-row"><span>Price</span><b class="num">${money(total, cur)}</b></div><div class="sum-row"><span>Charge</span><b class="num">${money(fee, cur)}</b></div>
          ${disc ? `<div class="sum-row earn-row"><span>Your earnings</span><b class="num">− ${money(disc, cur)}</b></div>` : ""}
          <div class="sum-row total"><span>You pay</span><b class="num">${money(base + fee, cur)}</b></div></div>
        ${box.method === "safe" ? `<p class="note" style="margin:0">Your phone dials the money processor straight away. Sarrif holds the money and releases it to the seller after checking with you that you received the item.</p>` : ""}` : ""}
    </div>`;
  }
  // The order didn't go through: show the error, then Try again with the merchant number or the normal number.
  function ussdButton(box, cur, total, act, payShop) {
    if (box.err) {
      const v = box.method === "safe" ? { merchant: !!settings.safePay?.merchant, number: !!settings.safePay?.number } : payShop || {};
      return `<div class="err" role="alert">${esc(box.err)}</div><div class="retry-row"><small>Try again with:</small>
        ${v.merchant ? `<button class="btn btn-primary" data-sq="${act}" data-via="merchant">Merchant number</button>` : ""}
        ${v.number ? `<button class="btn btn-primary" data-sq="${act}" data-via="normal">Normal number</button>` : ""}</div>`;
    }
    return `<button class="btn btn-primary btn-block" data-sq="${act}">${SVC_TOPUP}Pay ${money(total + payFeeOf(cur, total), cur)}</button>`;
  }
  const dialNow = code => { if (code) dialUssd(code); };


  // Every order is placed with the PIN (the server checks it).
  const orderPin = os => `<div class="field"><label for="sq-pin">Enter your PIN to place the order</label>${pinInput("sq-pin", os.pin)}</div>`;
  function vOrderSheet(p, os) {
    if (os.done && os.done.status === "awaiting_payment") return `<div class="sheet"><div class="sheet-card"><div class="receipt"><div class="tick">${ICON.tick}</div>
      <h3 style="font-size:20px">Order placed</h3>
      <p class="note" style="margin:0">Your phone is dialling to pay <b class="num">${esc(money(os.done.total - (os.done.pay_discount || 0) + os.done.pay_fee, os.done.cur))}</b>. ${os.done.pay_method === "safe" ? "When Sarrif confirms the money arrived, the seller delivers. The money is held until Sarrif checks with you that you received it." : "When the seller confirms the money arrived, they deliver."}</p>
      <p class="note" style="margin:0">Ref <span class="num">${esc(os.done.ref)}</span></p></div>
      <button class="btn btn-ghost btn-block" data-sq="myorders">See my orders</button><button class="btn btn-ghost btn-block" data-sq="closesheet">Keep shopping</button></div></div>`;
    if (os.done) return `<div class="sheet"><div class="sheet-card"><div class="receipt"><div class="tick">${ICON.tick}</div>
      <h3 style="font-size:20px">${asksPrice(p) ? "Request sent" : p.mode === "buy" ? "Order placed" : "Booking sent"}</h3>
      <p class="note" style="margin:0">${asksPrice(p) ? "The seller will send you the price. You pay from your wallet only after that. Follow it in My orders." : p.mode === "buy" ? `We took ${money(os.done.total, os.done.cur)} from your wallet and hold it safely. The seller gets it after you confirm you received the product.` : "The seller will accept or decline your booking. Follow it in My orders."}</p>
      <p class="note" style="margin:0">Ref <span class="num">${esc(os.done.ref)}</span></p></div>
      <button class="btn btn-primary btn-block" data-sq="myorders">See my orders</button><button class="btn btn-ghost btn-block" data-sq="closesheet">Keep shopping</button></div></div>`;
    if (asksPrice(p)) return `<div class="sheet"><div class="sheet-card">
      <h3 style="font-size:19px">Ask for the price of ${esc(p.name)}</h3>
      <div class="qty"><span>${UNIT_NAME[p.unit] ? UNIT_NAME[p.unit][1] : "Quantity"}</span><button class="icon-btn" data-qty="-1" aria-label="Less">−</button><b class="num">${os.qty}</b><button class="icon-btn" data-qty="1" aria-label="More">+</button></div>
      <div class="field"><label for="sq-note">Note for the seller</label><input class="input" id="sq-note" maxlength="300" value="${esc(os.note || "")}" placeholder="${st.product?.service === "ticket" ? "From, to, travel date and number of people…" : st.market === "visa" ? "Travel dates, number of people…" : st.market === "scholarship" ? "Your level of study and the subject you want…" : "Anything the seller should know"}"></div>
      <p class="note" style="margin:0">The seller sends you the price in My orders. Nothing is paid now.</p>
      ${orderPin(os)}<div class="err" role="alert">${esc(os.err || "")}</div>
      <button class="btn btn-primary btn-block" data-sq="book" data-needpin ${(os.pin || "").length === 4 ? "" : "disabled"}>Send request</button>
      <button class="btn btn-ghost btn-block" data-sq="closesheet">Cancel</button></div></div>`;
    const total = p.price * os.qty, bal = st.wallet?.balances?.[p.cur] ?? 0;
    const shopI = shopInfoOf(p, os.qty);
    if (p.mode === "buy" && (!os.method || !payOptions(p.pay_shop, shopI)[os.method].ok)) os.method = "wallet";
    const wal = os.method === "wallet", low = p.mode === "buy" && wal && bal < total;
    return `<div class="sheet"><div class="sheet-card">
      <h3 style="font-size:19px">${p.mode === "buy" ? "Buy" : "Book"} ${esc(p.name)}</h3>
      <div class="qty"><span>${UNIT_NAME[p.unit] ? UNIT_NAME[p.unit][1] : "Quantity"}</span><button class="icon-btn" data-qty="-1" aria-label="Less">−</button><b class="num">${os.qty}</b><button class="icon-btn" data-qty="1" aria-label="More">+</button></div>
      ${p.mode === "book" ? `<div class="grid2 book-when"><div class="field"><label for="sq-bdate">${p.unit === "night" ? "Check-in date" : "Date"}</label><input class="input" ${SarrifDate.attrs} id="sq-bdate" value="${esc(SarrifDate.disp(os.bdate || ""))}"></div>
        <div class="field"><label for="sq-btime">Time</label><input class="input" type="time" id="sq-btime" value="${esc(os.btime || "")}"></div></div>` : ""}
      <div class="field"><label for="sq-note">${p.unit === "night" ? "Check-in date and number of guests" : String(p.service).startsWith("svc:") ? "Where and when, and what you need" : p.mode === "buy" ? "Delivery address or note" : "Where, and what you need (optional)"}</label><input class="input" id="sq-note" maxlength="300" value="${esc(os.note || "")}"></div>
      <div class="summary"><div class="sum-row total"><span>Total</span><b class="num">${money(total, p.cur)}</b></div>
        ${p.mode === "buy" && wal ? `<div class="sum-row"><span>Your wallet</span><b class="num" style="color:${low ? "var(--danger)" : "var(--ink)"}">${money(bal, p.cur)}</b></div>` : ""}</div>
      ${p.mode === "buy" ? payChooser(os, p.cur, total, p.pay_shop, shopI) : ""}
      ${low ? topupInline(p.cur, total, os) : ""}
      ${low ? "" : orderPin(os)}
      ${p.mode === "buy" && !wal ? (os.err && !/PIN/i.test(os.err) ? ussdButton(os, p.cur, dialBase(os, total, shopI), "payussd", p.pay_shop) : `<div class="err" role="alert">${esc(os.err || "")}</div>` + ussdButton({ ...os, err: "" }, p.cur, dialBase(os, total, shopI), "payussd", p.pay_shop).replace("<button ", `<button data-needpin ${(os.pin || "").length === 4 ? "" : "disabled"} `))
        : p.mode === "buy" ? (low ? "" : `<div class="err" role="alert">${esc(os.err || "")}</div>
        <button class="btn btn-primary btn-block" data-sq="pay" data-needpin ${(os.pin || "").length === 4 ? "" : "disabled"}>Pay ${money(total, p.cur)}</button>`)
        : `<div class="err" role="alert">${esc(os.err || "")}</div><button class="btn btn-primary btn-block" data-sq="book" data-needpin ${(os.pin || "").length === 4 ? "" : "disabled"}>Send booking request</button>`}
      <button class="btn btn-ghost btn-block" data-sq="closesheet">Cancel</button></div></div>`;
  }
  function vOrders() {
    if (!st.orders.length) return `<div class="empty">You haven't ordered anything yet.</div>`;
    return `<div class="olist">${st.orders.map(o => `<div class="ocard">
      ${o.image ? `<img src="${esc(o.image)}" alt="">` : `<span class="noimg">▶</span>`}
      <div class="t"><b>${esc(o.product_name)} × ${o.qty}</b><small>${esc(o.shop_name)} · ${new Date(o.created_at).toLocaleDateString()} · Ref ${esc(o.ref)}</small>
        <div class="orow"><span class="pill ${statusTone(o.status)}">${esc(orderLabel(o))}</span><b class="num">${o.needs_price ? "—" : money(o.total, o.cur)}</b></div>
        ${o.book_at ? `<small class="onote book-at">📅 ${esc(o.book_at)}</small>` : ""}${o.offer_desc ? `<small class="onote">${esc(o.offer_desc)}</small>` : ""}
        ${o.my_earn > 0 ? `<span class="earn">${o.status === "completed" ? `You earned ${esc(money(o.my_earn, o.cur))} · added to your earnings` : ["cancelled", "cancelled_by_seller", "declined", "payment_rejected"].includes(o.status) ? "" : `You earn ${esc(money(o.my_earn, o.cur))} when you confirm you received it`}</span>` : ""}
        ${o.kind === "buy" && o.pay_method !== "wallet" && o.pay_ussd ? `<small class="note">${esc(PAY_NAME[o.pay_method])} · <span class="num">${esc(money(o.total - (o.pay_discount || 0) + o.pay_fee, o.cur))}</span>${o.pay_discount ? ` · your earnings ${esc(money(o.pay_discount, o.cur))} taken off` : ""}</small>` : ""}
        ${o.status === "awaiting_payment" ? `<small class="note">${o.pay_method === "safe" ? "Sarrif confirms the money arrived, then the seller delivers." : "The seller confirms the money arrived, then delivers."}</small>` : ""}
        ${o.status === "payment_rejected" ? `<small class="note" style="color:var(--danger)">${o.pay_method === "safe" ? "Sarrif didn't receive this payment. Contact support if you paid." : "The seller didn't receive this payment. Chat with them if you paid."}</small>` : ""}
        <div class="req-actions">
          ${o.status === "awaiting_payment" ? `<button class="btn btn-ghost" data-oact="cancel" data-oid="${o.id}">Cancel</button>` : ""}
          ${o.status === "quoted" ? `<button class="btn btn-primary" data-payorder="${o.id}">Pay ${money(o.total, o.cur)}</button>` : ""}
          ${o.kind === "buy" && ["requested", "accepted", "quoted"].includes(o.status) ? `<button class="btn btn-ghost" data-oact="cancel" data-oid="${o.id}">${o.status === "requested" ? "Cancel" : "Reject"}</button>` : ""}
          ${o.kind === "buy" && ["paid", "delivered"].includes(o.status) && o.pay_method === "safe" && o.buyer_ok ? `<small class="note">Thank you. Sarrif will check with you and release the payment to the seller.</small>`
            : o.kind === "buy" && ["paid", "delivered"].includes(o.status) ? `<button class="btn btn-primary" data-oact="received" data-oid="${o.id}">${String(o.service).startsWith("svc:") ? "Work finished · I received it" : "I received it"}</button>` : ""}
          ${(o.kind === "buy" && o.status === "paid") || (o.kind === "book" && ["requested", "accepted"].includes(o.status)) ? `<button class="btn btn-ghost" data-oact="cancel" data-oid="${o.id}">Cancel${o.kind === "buy" && o.pay_method !== "shop" ? " and refund" : ""}</button>` : ""}
          <button class="btn btn-ghost" data-chat="${esc(o.product_id)}">Chat</button>
        </div></div></div>`).join("")}</div>${vPaySheet()}`;
  }
  // Not enough money in the wallet: top up right here. The amount starts at what is missing; the phone dials
  // *880*<agent number>*<amount># (USD) or *220*<agent number>*<amount># (SLSH).
  function topupInline(cur, need, box) {
    const bal = st.wallet?.balances?.[cur] ?? 0, pend = pendingTopup(st.wallet, cur), miss = Math.max(0, need - bal - pend);
    if (box.tpAmt === undefined) box.tpAmt = miss > 0 ? String(cur === "SLSH" ? Math.ceil(miss) : Math.ceil(miss * 100) / 100) : "";
    if (!topupReady(cur)) return `<p class="note" style="margin:0;color:var(--danger)">Your wallet doesn't have enough ${cur}. Contact support to top up your wallet.</p>`;
    const code = topupCode(cur, box.tpAmt);
    return `<div class="tp-inline">
      <p class="note" style="margin:0;color:var(--danger)">${bal > 0 ? `Your wallet doesn't have enough ${cur}.` : "Your wallet is empty."} Top up to continue.</p>
      <div class="amount-box"><span>${cur === "USD" ? "$" : "SLSH"}</span><input id="tpi-amount" data-tpicur="${cur}" inputmode="decimal" value="${esc(box.tpAmt)}" aria-label="Top-up amount"></div>
      <a class="btn btn-primary btn-block ${code ? "" : "is-off"}" id="tpi-send" data-tpicur="${cur}" href="${code ? esc(telHref(code)) : "#"}" aria-disabled="${!code}">${SVC_TOPUP}Top up</a>
      <p class="note" style="margin:0" id="tpi-note">${pend > 0 ? `Waiting for support to confirm <b class="num">${esc(money(pend, cur))}</b>. You can pay as soon as it arrives.` : code ? "Press Top up to pay this amount by phone." : "Type the amount, then press Top up."}</p></div>`;
  }
  const SVC_TOPUP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="margin-inline-end:6px;vertical-align:-3px"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z"/></svg>';
  function bindTopupInline(box) {
    const byId = id => document.getElementById(id);
    const inp = byId("tpi-amount"), a = byId("tpi-send"); if (!inp || !a) return;
    const cur = inp.dataset.tpicur;
    inp.oninput = () => {
      box.tpAmt = inp.value.replace(/[^\d.]/g, ""); if (inp.value !== box.tpAmt) inp.value = box.tpAmt;
      const code = topupCode(cur, box.tpAmt);
      a.href = code ? telHref(code) : "#"; a.classList.toggle("is-off", !code); a.setAttribute("aria-disabled", !code);
      byId("tpi-note").innerHTML = code ? "Press Top up to pay this amount by phone." : "Type the amount, then press Top up.";
    };
    a.onclick = e => {
      const code = topupCode(cur, box.tpAmt);
      if (!code) { e.preventDefault(); return; }
      dialCode(e, code);
      const body = { cur, amount: box.tpAmt };
      setTimeout(async () => { if (await recordTopup(body, byId("tpi-note"))) { box.tpAmt = undefined; render(); } }, 0);
    };
  }
  // Paying a price the seller sent (hidden-price requests).
  function vPaySheet() {
    const ps = st.paySheet; if (!ps) return "";
    const o = st.orders.find(x => x.id === ps.id); if (!o) return "";
    const bal = st.wallet?.balances?.[o.cur] ?? 0;
    const shopI = { mode: o.shop_mode || "wallet", discount: o.shop_discount || 0 };
    if (!ps.method || !payOptions(ps.pay_shop, shopI)[ps.method].ok) ps.method = "wallet";
    const wal = ps.method === "wallet", low = wal && bal < o.total;
    return `<div class="sheet"><div class="sheet-card">
      <h3 style="font-size:19px">Pay for ${esc(o.product_name)} × ${o.qty}</h3>
      <div class="summary"><div class="sum-row total"><span>Price from the seller</span><b class="num">${money(o.total, o.cur)}</b></div>
        ${wal ? `<div class="sum-row"><span>Your wallet</span><b class="num" style="color:${low ? "var(--danger)" : "var(--ink)"}">${money(bal, o.cur)}</b></div>` : ""}</div>
      ${payChooser(ps, o.cur, o.total, ps.pay_shop, shopI)}
      ${!wal ? ussdButton(ps, o.cur, dialBase(ps, o.total, shopI), "payquotedussd", ps.pay_shop) : low ? topupInline(o.cur, o.total, ps)
        : `<p class="note" style="margin:0">The money is held safely until you confirm you received it.</p>
        <div class="field"><label for="pay-pin">Confirm with your PIN</label>${pinInput("pay-pin", ps.pin)}</div><div class="err" role="alert">${esc(ps.err || "")}</div>
        <button class="btn btn-primary btn-block" id="pay-go" ${(ps.pin || "").length === 4 ? "" : "disabled"}>Pay ${money(o.total, o.cur)}</button>`}
      <button class="btn btn-ghost btn-block" data-sq="closepay">Cancel</button></div></div>`;
  }
  const PLANE_S = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-2px;margin-inline-end:4px"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
  const PLANE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';
  /* ---------- chat kit: pictures, voice messages, files, call (customers and service admins) ---------- */
  const CI = {
    clip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.6 8.6a2 2 0 0 1-2.8-2.8L15 7.5"/></svg>',
    cam: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>',
    mic: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/></svg>',
    stop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>',
    call: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    doc: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  };
  const fmtDur = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  // readAt: when the other person last opened this chat. My messages show one tick (sent) or two green ticks (read).
  const TICK1 = '<svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l3 3 6.5-7"/></svg>';
  const TICK2 = '<svg width="20" height="12" viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 6.5l3 3 6.5-7"/><path d="M8.5 9.5l.5.5 6.5-7.5"/></svg>';
  const ticks = (m, readAt) => { const read = readAt && m.created_at <= readAt; return `<span class="ticks ${read ? "read" : ""}" data-at="${m.created_at}" role="img" aria-label="${read ? "Read" : "Sent"}">${read ? TICK2 : TICK1}</span>`; };
  const CALL_IC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';
  function msgHtml(m, readAt) {
    const a = m.att, t = new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // A call record: answered (and how long), declined, or missed.
    if (a && a.kind === "call") {
      const dur = `${Math.floor(a.secs / 60)}:${String(a.secs % 60).padStart(2, "0")}`;
      const label = a.status === "answered" ? "Voice call" : a.status === "declined" ? "Call declined" : m.mine ? "No answer" : "Missed call";
      return `<div class="msg-call ${m.mine ? "mine" : ""} ${a.status}"><span class="mc-ic">${CALL_IC}</span><span class="mc-t"><b>${label}</b><small>${a.status === "answered" ? `<span class="num">${dur}</span> · ` : ""}${t}</small></span></div>`;
    }
    const att = !a ? "" : a.kind === "image" ? `<button class="msg-img" data-chatimg="${esc(a.url)}" aria-label="Open picture"><img src="${esc(a.url)}" alt="" loading="lazy"></button>`
      : a.kind === "voice" ? `<audio class="msg-voice" controls preload="none" src="${esc(a.url)}"></audio>`
      : `<a class="msg-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.name)}">${CI.doc}<span>${esc(a.name)}</span></a>`;
    return `<div class="msg ${m.mine ? "mine" : ""} ${a ? "has-att" : ""}">${att}${m.body ? `<span>${esc(m.body)}</span>` : ""}<small>${t}${m.mine ? ticks(m, readAt) : ""}</small></div>`;
  }
  // The message box: text, a picture or file, or a voice message (tap the mic, tap again to send).
  const composerHtml = (id = "composer") => `<form class="composer chat-comp" id="${id}">
    <label class="icon-btn comp-btn" aria-label="Send a picture or file">${CI.clip}<input type="file" data-chatfile accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx,application/pdf" hidden></label>
    <input class="input" data-chatin placeholder="Write a message" maxlength="1000" autocomplete="off" aria-label="Message">
    <button type="button" class="icon-btn comp-btn" data-chatmic aria-label="Record a voice message">${CI.mic}</button>
    <button class="btn btn-primary comp-send" type="submit" aria-label="Send">${CI.send}</button>
    <div class="rec-bar" hidden><span class="rec-dot"></span><b data-recclock>0:00</b><span class="note">Recording…</span><button type="button" class="btn btn-ghost" data-reccancel>Cancel</button><button type="button" class="btn btn-primary" data-recstop>${CI.stop} Send</button></div>
    <small class="err" data-chaterr></small></form>`;
  const readAsUrl = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
  async function shrinkImage(f) { // big phone photos: max 1600 px, JPEG
    const url = await readAsUrl(f);
    try { const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)); if (k === 1 && f.size < 1.5e6) return url;
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.85); } catch { return url; }
  }
  let rec = null;
  function bindComposer(form, sendFn) {
    if (!form) return;
    const inp = form.querySelector("[data-chatin]"), err = form.querySelector("[data-chaterr]"), bar = form.querySelector(".rec-bar");
    const go = async payload => { err.textContent = ""; try { await sendFn(payload); } catch (e) { err.textContent = e.message; } };
    form.onsubmit = async e => { e.preventDefault(); const body = inp.value.trim(); if (!body) return; inp.value = ""; await go({ body }); const n = document.querySelector("[data-chatin]"); if (n) n.focus(); };
    const fileIn = form.querySelector("[data-chatfile]");
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
      if (f.size > 10 * 1024 * 1024) { err.textContent = "Files must be 10 MB or smaller."; return; }
      const isImg = /^image\//.test(f.type);
      if (!isImg && !/\.(pdf|docx?)$/i.test(f.name)) { err.textContent = "Send a picture, PDF or Word file."; return; }
      err.textContent = "Sending…";
      const data = isImg ? await shrinkImage(f) : await readAsUrl(f);
      await go({ body: inp.value.trim(), att: { kind: isImg ? "image" : "file", name: f.name, data } }); inp.value = "";
    };
    const mic = form.querySelector("[data-chatmic]");
    const stopRec = send => { if (!rec) return; rec.send = send; try { rec.mr.stop(); } catch {} };
    mic.onclick = async () => {
      if (rec) return stopRec(true);
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { err.textContent = "Voice messages don't work on this phone."; return; }
      let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { err.textContent = "Allow the microphone to send voice messages."; return; }
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"].find(t => MediaRecorder.isTypeSupported?.(t)) || "";
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : {}), chunks = [], t0 = Date.now();
      rec = { mr, send: true }; bar.hidden = false; form.classList.add("recording");
      const clock = form.querySelector("[data-recclock]"), tick = setInterval(() => { clock.textContent = fmtDur((Date.now() - t0) / 1000); if (Date.now() - t0 > 300000) stopRec(true); }, 250);
      mr.ondataavailable = e => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        clearInterval(tick); stream.getTracks().forEach(t => t.stop()); bar.hidden = true; form.classList.remove("recording");
        const send = rec?.send; rec = null; if (!send || !chunks.length) return;
        const blob = new Blob(chunks, { type: (mr.mimeType || "audio/webm").split(";")[0] }), dur = (Date.now() - t0) / 1000;
        if (dur < 1) { err.textContent = "Hold on a little longer to record."; return; }
        err.textContent = "Sending…"; await go({ att: { kind: "voice", name: "voice", data: await readAsUrl(blob), dur } });
      };
      mr.start();
    };
    form.querySelector("[data-recstop]").onclick = () => stopRec(true);
    form.querySelector("[data-reccancel]").onclick = () => stopRec(false);
  }
  function bindMsgs(box) {
    if (!box) return;
    box.querySelectorAll("[data-chatimg]").forEach(b => b.onclick = () => zoom.open([b.dataset.chatimg], 0, "Picture"));
    box.scrollTop = box.scrollHeight;
  }
  // Call: an internet call inside 5PLUS (like WhatsApp), no airtime. If it can't connect, the phone number is offered.
  const callBtn = (convId, name, phone) => convId ? `<button type="button" class="btn btn-ghost chat-call" data-netcall="${esc(convId)}" data-callname="${esc(name || "")}" data-callphone="${esc(phone || "")}" aria-label="Call ${esc(name || "")}">${CI.call}Call</button>` : "";

  /* ---------- Internet calls ---------- */
  // Voice goes straight between the two phones (WebRTC). The server rings the other person (and Firebase rings a closed
  // app), and passes the connection details between the phones.
  const CALL = (() => {
    let k = null, box = null, audio = null, tone = null, tick = null, endTimer = null;
    const IC = {
      mic: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
      micOff: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.9-.7"/><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3"/></svg>',
      spk: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
      end: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 9c-3.2 0-6.2.8-8.8 2.3-.8.5-1.1 1.4-.8 2.2l.9 2c.3.7 1.1 1.1 1.9.9l3-.8c.6-.2 1.1-.8 1.1-1.5v-1.6a12 12 0 0 1 5.4 0v1.6c0 .7.5 1.3 1.1 1.5l3 .8c.8.2 1.6-.2 1.9-.9l.9-2c.3-.8 0-1.7-.8-2.2A17.3 17.3 0 0 0 12 9z"/></svg>',
      ans: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    };
    const android = () => window.SarrifAndroid && typeof window.SarrifAndroid.callAudio === "function";
    const setAudio = (on, spk) => { try { if (android()) window.SarrifAndroid.callAudio(!!on, !!spk); } catch {} };
    const post = (path, body) => api(path, { body: body || {} });
    // Sounds: the ring for an incoming call, and the "ringing" tone the caller hears.
    function playTone(kind) {
      stopTone();
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)(), g = ctx.createGain(); g.connect(ctx.destination); g.gain.value = 0;
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.frequency.value = kind === "ring" ? 880 : 425; o2.frequency.value = kind === "ring" ? 660 : 425;
        o1.connect(g); o2.connect(g); o1.start(); o2.start();
        const beat = () => { const t = ctx.currentTime, v = kind === "ring" ? 0.18 : 0.07;
          if (kind === "ring") { [0, 0.5].forEach(d => { g.gain.setValueAtTime(v, t + d); g.gain.setValueAtTime(0, t + d + 0.35); }); }
          else { g.gain.setValueAtTime(v, t); g.gain.setValueAtTime(0, t + 1); } };
        beat(); const iv = setInterval(beat, kind === "ring" ? 2000 : 3000);
        if (kind === "ring" && navigator.vibrate) navigator.vibrate([800, 400, 800, 400, 800, 400, 800, 400, 800]);
        tone = { stop() { clearInterval(iv); try { ctx.close(); } catch {} if (navigator.vibrate) navigator.vibrate(0); } };
      } catch { tone = null; }
    }
    function stopTone() { if (tone) { tone.stop(); tone = null; } }
    const clock = () => { const s = Math.max(0, Math.floor((Date.now() - (k?.start || Date.now())) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    const STATUS = { starting: "Starting the call…", calling: "Calling…", ringing: "Ringing…", incoming: "Incoming call…", connecting: "Connecting…" };
    const ENDED = { ended: "Call ended", cancelled: "Call ended", declined: "They declined the call", missed: "No answer", taken: "Answered on another phone", failed: "The call couldn't connect", busy: "On another call", error: "" };
    function draw() {
      if (!k) { if (box) { box.remove(); box = null; } return; }
      if (!box) { box = document.createElement("div"); box.className = "call-ui"; box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); document.body.appendChild(box);
        box.addEventListener("click", onClick); }
      box.setAttribute("aria-label", `Call with ${k.name}`);
      const st = k.state, live = st === "active", ended = st === "ended";
      const status = ended ? (k.msg || ENDED[k.reason] || "Call ended") : live ? clock() : STATUS[st] || "";
      box.innerHTML = `<div class="call-top">${LOCK_S}<span>5PLUS call · free over the internet</span></div>
        <div class="call-who"><div class="call-av ${st === "incoming" || st === "ringing" || st === "calling" ? "pulse" : ""}" aria-hidden="true">${esc((k.name || "?")[0].toUpperCase())}</div>
          <b data-no-i18n>${esc(k.name || "")}</b><span class="call-st num" aria-live="polite">${esc(status)}</span>${k.topic ? `<small data-no-i18n>${esc(k.topic)}</small>` : ""}
          ${ended && k.reason === "failed" && k.phone ? `<a class="btn btn-ghost call-phone" href="tel:${esc(k.phone)}">${IC.ans}Call by phone instead</a>` : ""}</div>
        <div class="call-acts">${st === "incoming"
          ? `<div class="call-act"><button class="call-b red" data-cl="decline" aria-label="Decline">${IC.end}</button><span>Decline</span></div><div class="call-act"><button class="call-b green" data-cl="answer" aria-label="Answer">${IC.ans}</button><span>Answer</span></div>`
          : ended ? `<div class="call-act"><button class="call-b grey" data-cl="close" aria-label="Close">✕</button><span>Close</span></div>`
          : `<div class="call-act"><button class="call-b ${k.muted ? "on" : "grey"}" data-cl="mute" aria-pressed="${!!k.muted}" aria-label="Mute">${k.muted ? IC.micOff : IC.mic}</button><span>${k.muted ? "Unmute" : "Mute"}</span></div>
             ${android() ? `<div class="call-act"><button class="call-b ${k.speaker ? "on" : "grey"}" data-cl="speaker" aria-pressed="${!!k.speaker}" aria-label="Speaker">${IC.spk}</button><span>Speaker</span></div>` : ""}
             <div class="call-act"><button class="call-b red" data-cl="hangup" aria-label="End call">${IC.end}</button><span>End</span></div>`}</div>`;
    }
    const LOCK_S = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    function onClick(e) {
      const b = e.target.closest("[data-cl]"); if (!b || !k) return;
      const a = b.dataset.cl;
      if (a === "answer") answer(); else if (a === "decline") { post(`/api/call/${k.id}/end`, { reason: "declined" }).catch(() => {}); finish(null, true, true); }
      else if (a === "hangup") { if (k.id) post(`/api/call/${k.id}/end`, {}).catch(() => {}); finish("ended", true); }
      else if (a === "mute") { k.muted = !k.muted; (k.stream?.getAudioTracks() || []).forEach(t => t.enabled = !k.muted); draw(); }
      else if (a === "speaker") { k.speaker = !k.speaker; setAudio(true, k.speaker); draw(); }
      else if (a === "close") finish(null, true, true);
    }
    async function media() {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("Internet calls don't work on this phone. Update the app or the phone's browser.");
      try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch { throw new Error("Allow the microphone to make calls."); }
    }
    function makePc(ice) {
      const pc = new RTCPeerConnection({ iceServers: ice });
      pc.onicecandidate = e => { if (!e.candidate || !k) return; const c = e.candidate.toJSON(); if (k.id) post(`/api/call/${k.id}/ice`, { candidate: c }).catch(() => {}); else k.outIce.push(c); };
      pc.ontrack = e => { if (!audio) { audio = document.createElement("audio"); audio.autoplay = true; audio.setAttribute("playsinline", ""); document.body.appendChild(audio); } audio.srcObject = e.streams[0]; audio.play().catch(() => {}); };
      pc.onconnectionstatechange = () => {
        if (!k || k.pc !== pc) return;
        if (pc.connectionState === "connected" && k.state !== "active") { k.state = "active"; k.start = Date.now(); stopTone(); clearInterval(tick); tick = setInterval(() => { if (k?.state === "active") { const s = box?.querySelector(".call-st"); if (s) s.textContent = clock(); } }, 1000); draw(); }
        if (pc.connectionState === "failed") { if (k.id) post(`/api/call/${k.id}/end`, {}).catch(() => {}); finish("failed", true); }
      };
      return pc;
    }
    function teardown() {
      stopTone(); clearInterval(tick); tick = null;
      if (k) { try { k.pc?.close(); } catch {} (k.stream?.getTracks() || []).forEach(t => t.stop()); }
      if (audio) { audio.srcObject = null; audio.remove(); audio = null; }
      setAudio(false, false);
    }
    // Ends the call on this phone; the screen says why for a moment.
    function finish(reason, local, now) {
      if (!k) return;
      teardown(); clearTimeout(endTimer);
      if (now || !reason) { k = null; return draw(); }
      k.state = "ended"; k.reason = reason; k.pc = null; draw();
      endTimer = setTimeout(() => { if (k && k.state === "ended") { k = null; draw(); } }, reason === "failed" ? 12000 : 2200);
    }
    async function start(convId, name, phone) {
      if (k && k.state !== "ended") return;
      clearTimeout(endTimer);
      k = { id: null, convId, name, phone, state: "starting", outIce: [], caller: true }; draw();
      try {
        const cfg = await api("/api/call/config");
        k.stream = await media(); if (!k) return;
        const pc = k.pc = makePc(cfg.iceServers);
        k.stream.getTracks().forEach(t => pc.addTrack(t, k.stream));
        await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
        const r = await post("/api/call/start", { conv_id: convId, offer: { type: "offer", sdp: pc.localDescription.sdp } });
        if (!k || k.pc !== pc) { post(`/api/call/${r.call.id}/end`, {}).catch(() => {}); return; }
        k.id = r.call.id; k.state = "ringing"; k.topic = r.call.topic;
        for (const c of k.outIce.splice(0)) post(`/api/call/${k.id}/ice`, { candidate: c }).catch(() => {});
        setAudio(true, false); playTone("ringback"); draw();
      } catch (e) { if (k) { k.msg = e.message; finish("error", true); } }
    }
    function incoming(d) {
      if (k && k.state !== "ended") return; // already in a call: it keeps ringing on their other phones, or is missed
      clearTimeout(endTimer);
      k = { id: d.id, convId: d.conv_id, name: d.from_name, topic: d.topic, state: "incoming", outIce: [], caller: false };
      playTone("ring"); draw();
    }
    async function answer() {
      if (!k || k.state !== "incoming") return;
      stopTone(); k.state = "connecting"; draw();
      try {
        const r = await api(`/api/call/${k.id}`);
        if (!r.call || r.call.state !== "ringing") return finish(r.call ? "taken" : "cancelled", true);
        k.stream = await media(); if (!k) return;
        const pc = k.pc = makePc(r.iceServers);
        k.stream.getTracks().forEach(t => pc.addTrack(t, k.stream));
        await pc.setRemoteDescription(r.call.offer);
        for (const c of r.call.ice || []) { try { await pc.addIceCandidate(c); } catch {} }
        await pc.setLocalDescription(await pc.createAnswer());
        await post(`/api/call/${k.id}/answer`, { answer: { type: "answer", sdp: pc.localDescription.sdp } });
        setAudio(true, false);
      } catch (e) { if (k) { if (k.id) post(`/api/call/${k.id}/end`, {}).catch(() => {}); k.msg = e.message; finish("error", true); } }
    }
    // Live news about a call, from the server.
    async function onEvent(d) {
      if (d.type === "ring") return incoming(d);
      if (!k || k.id !== d.id) return;
      if (d.type === "answer" && k.caller && k.pc) { stopTone(); k.state = "connecting"; draw(); try { await k.pc.setRemoteDescription(d.answer); } catch { finish("failed", true); } }
      else if (d.type === "ice" && k.pc) { try { await k.pc.addIceCandidate(d.candidate); } catch {} }
      else if (d.type === "end") finish(d.reason === "cancelled" || d.reason === "ended" ? "ended" : d.reason, false);
    }
    // Opened from the "Incoming call" notification.
    async function openFromPush(id) {
      try { const r = await api(`/api/call/${encodeURIComponent(id)}`);
        if (r.call && r.call.state === "ringing" && !r.call.caller) incoming({ id: r.call.id, conv_id: r.call.conv_id, from_name: r.call.from_name, topic: r.call.topic });
        else if (!k) { k = { name: r.call?.from_name || "", state: "ended", reason: r.call ? "taken" : "missed" }; draw(); endTimer = setTimeout(() => { if (k?.state === "ended") { k = null; draw(); } }, 2500); }
      } catch {}
    }
    document.addEventListener("click", e => { const b = e.target.closest && e.target.closest("[data-netcall]"); if (b) { e.preventDefault(); start(b.dataset.netcall, b.dataset.callname, b.dataset.callphone); } });
    window.addEventListener("pagehide", () => { if (k && k.id && k.state !== "ended") navigator.sendBeacon?.(`/api/call/${k.id}/end`, new Blob(["{}"], { type: "application/json" })); });
    return { start, onEvent, openFromPush, get active() { return !!k && k.state !== "ended"; } };
  })();
  // A small banner when a message arrives while you are somewhere else in the app.
  function msgBanner(m, open) {
    document.getElementById("msg-banner")?.remove();
    const d = document.createElement("button"); d.id = "msg-banner"; d.className = "msg-banner";
    d.innerHTML = `<b>${esc(m.from_name || "New message")}</b><span>${esc(m.preview || m.body || "")}</span>`;
    d.onclick = () => { d.remove(); open(); }; document.body.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  }

  function vChats() {
    if (!st.chats.length) return `<div class="empty">No chats yet. Open a product and tap “Chat with seller”.</div>`;
    return `<div class="olist">${st.chats.map(c => `<button class="ccard" data-openchat="${esc(c.id)}">
      ${c.image ? `<img src="${esc(c.image)}" alt="">` : `<span class="noimg">▶</span>`}
      <span class="t"><b>${esc(c.with_name)} <small class="role">${c.i_am === "buyer" ? "seller" : "buyer"}</small></b><small>${esc(c.product_name)}</small><small class="last">${c.last ? esc(c.last.body) : "No messages yet"}</small></span>
      ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}</button>`).join("")}</div>`;
  }
  function vThread() {
    const c = st.chat;
    return `<div class="view thread-view">
      <div class="svc-bar">${back("closechat")}<div style="min-width:0;flex:1"><b>${esc(c.with_name)}</b><small class="note" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.with_calls_off ? `<span class="calls-off-note">${callsOffText(c.with_calls_off, true)}</span>` : `${esc(c.product_name)} · only you two can see this chat`}</small></div>${c.with_calls_off ? "" : callBtn(c.id, c.with_name, c.with_phone)}</div>
      <div class="msgs" id="msgs" data-conv="${esc(c.id)}">${st.messages.length ? st.messages.map(m => msgHtml(m, c.other_read_at)).join("") : `<div class="empty">Say hello and ask about ${esc(c.product_name)}.</div>`}</div>
      ${composerHtml()}
    </div>`;
  }

  /* ---------- seller dashboard ---------- */
  function vSell() {
    if (st.shop === undefined) return `<div class="empty">Loading…</div>`;
    const s = st.shop;
    if (!s || !s.active) return vOpenShop(s);
    const tabs = [["report", "Report"], ["products", "Products"], ["orders", "Orders" + (pendingSeller() ? ` (${pendingSeller()})` : "")], ["sub", "Subscription"]];
    const body = st.sell === "report" ? `<div id="sq-fin"></div>` : st.sell === "products" ? vMyProducts() : st.sell === "orders" ? vSellerOrders() : vSubscription();
    const pi = s.plan_info, lim = Number(pi?.maxProducts);
    const pf = s.profile || {};
    return `<div class="shop-brand"><span class="agency-logo big">${pf.logo ? `<img src="/media/${esc(pf.logo)}" alt="">` : PLANE}</span>
        <div class="shop-brand-acts"><label class="btn btn-ghost">${pf.logo ? "Change logo" : "Add logo"}<input type="file" id="shop-logo" accept="image/jpeg,image/png,image/webp" hidden></label>
        <label class="chk"><input type="checkbox" id="shop-travel" ${pf.travel ? "checked" : ""}>Travel agency: list my business in Ticket</label></div></div>
      ${pf.travel ? `<div class="ticket-earn"><label for="te-value">Ticket earning for people who share or buy</label>
        <div class="te-row"><select class="input" id="te-type"><option value="percent" ${(pf.ticket_comm?.type || "percent") === "percent" ? "selected" : ""}>% of the price</option><option value="flat" ${pf.ticket_comm?.type === "flat" ? "selected" : ""}>USD per ticket</option></select>
        <input class="input" id="te-value" inputmode="decimal" value="${esc(pf.ticket_comm?.value ?? 5)}"><button class="btn btn-ghost" id="te-save">Save</button></div></div>` : ""}
      <div class="shop-head"><b>${esc(s.name)}</b>${s.shop_no ? `<small class="shop-no">Shop number <b class="num">${esc(s.shop_no)}</b> · customers can search for it</small>` : ""}<small><span class="tier-pill tier-${esc(s.plan || "")}">${esc(pi?.name || "Plan")}</span> until ${new Date(s.sub_until).toLocaleDateString()} · ${s.product_count}${lim ? "/" + lim : ""} products</small></div>
      <div class="sq-tabs sub" role="group" aria-label="Seller dashboard">${tabs.map(([k, l]) => `<button data-selltab="${k}" aria-pressed="${st.sell === k}">${esc(l)}</button>`).join("")}</div>${body}`;
  }
  const paidPlans = () => st.plans.filter(p => p.id !== "free");
  const limitText = p => Number(p.maxProducts) ? `Up to ${p.maxProducts} products` : "Unlimited products";
  function planList(sel) {
    const cur = st.shop?.plan;
    return `<div class="plans">${paidPlans().map(p => `<label class="plan tier-${esc(p.id)}"><input type="radio" name="plan" value="${esc(p.id)}" ${p.id === sel ? "checked" : ""}>
      <span><b>${esc(p.name)}${p.id === cur ? ` <small class="cur-plan">current</small>` : ""}</b><small>${limitText(p)} · ${p.days} days</small></span><b class="num">${money(p.price, p.cur)}</b></label>`).join("")}</div>`;
  }
  const defaultPlan = () => (paidPlans().find(p => p.id === st.shop?.plan) || paidPlans()[0])?.id;
  // Seller registration form (new sellers fill it in before paying; it can be edited later).
  const PF_FIELDS = ["full_name", "birth_date", "country", "city", "kind", "category", "category_sub", "business_name", "address", "phone", "zaad_merchant", "edahab_merchant", "shop_phone"];
  function pfDraft() {
    if (!st.pf) st.pf = { country: "Somaliland", kind: "shop", phone: S.user?.phone || "", full_name: S.user?.name || "", ...(st.shop?.profile || {}) };
    return st.pf;
  }
  async function loadCountries() { try { const r = await api("/api/suuq/plans"); st.countries = r.countries; st.plans = r.plans; st.bizCats = r.categories || []; } catch { st.countries = ["Somaliland"]; } }
  // Business categories, grouped under the section the super admin put them in (Suuq, Technician…).
  function catSelect(d) {
    const cats = st.bizCats || [], names = Object.fromEntries((settings.services || []).map(x => [x.id, x.name]));
    const groups = []; for (const c of cats) { let g = groups.find(x => x.id === c.section); if (!g) groups.push(g = { id: c.section, items: [] }); g.items.push(c); }
    const cur = cats.find(c => c.name === d.category);
    return `<div class="field"><label for="pf-category">Business category</label><select class="input" id="pf-category" data-pfcat><option value="">Choose your category</option>
        ${groups.map(g => `<optgroup label="${esc(names[g.id] || g.id)}">${g.items.map(c => `<option value="${esc(c.name)}" ${c.name === d.category ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`).join("")}</select></div>
      ${cur && (cur.subs || []).length ? `<div class="field"><label>Which kind?</label><div class="cur-toggle" style="grid-template-columns:repeat(${Math.min(cur.subs.length, 3)},1fr)">${cur.subs.map(x => `<button type="button" data-pfsub="${esc(x)}" aria-pressed="${d.category_sub === x}">${esc(x)}</button>`).join("")}</div><input type="hidden" id="pf-category_sub" value="${esc(d.category_sub || "")}"></div>` : `<input type="hidden" id="pf-category_sub" value="">`}`;
  }
  function bindPfCat(root) {
    root.querySelectorAll("[data-pfcat]").forEach(i => i.onchange = () => { keepPf(); pfDraft().category_sub = ""; render(); const n = document.getElementById("pf-category"); if (n) n.focus(); });
    root.querySelectorAll("[data-pfsub]").forEach(b => b.onclick = () => { keepPf(); pfDraft().category_sub = b.dataset.pfsub; render(); });
  }
  function bindPf(root) { root.querySelectorAll("[data-pfkind]").forEach(b => b.onclick = () => { keepPf(); pfDraft().kind = b.dataset.pfkind; render(); }); bindPfCat(root); }
  function keepPf() { const d = pfDraft(); for (const k of PF_FIELDS) { const el = document.getElementById("pf-" + k); if (el) d[k] = k === "birth_date" ? SarrifDate.iso(el.value) || el.value : el.value; } }
  // The form is in three parts. The merchant sign-up shows one part per step (step = 1, 2 or 3);
  // everywhere else all three parts are shown together.
  const PF_STEPS = ["About you", "Your business", "Phone and merchant numbers"];
  function profileForm(signup, step) {
    const d = pfDraft(), biz = d.kind === "company" ? "company" : "shop";
    const maxBirth = new Date(Date.now() - 18 * 365.25 * 86400000).toISOString().slice(0, 10);
    const f = (k, label, attrs = "", hint = "") => `<div class="field"><label for="pf-${k}">${label}</label><input class="input" id="pf-${k}" value="${esc(d[k] || "")}" ${attrs}>${hint ? `<small class="note">${hint}</small>` : ""}</div>`;
    const head = i => step ? "" : `<b class="pf-h">${PF_STEPS[i]}</b>`;
    const parts = [
      () => `${head(0)}
      ${f("full_name", "Full name", 'maxlength="80" autocomplete="name"')}
      <div class="field"><label for="pf-birth_date">Birth date</label><input class="input" id="pf-birth_date" value="${esc(SarrifDate.disp(d.birth_date || ""))}" ${SarrifDate.attrs}><small class="note">You must be at least 18.</small></div>
      <div class="grid2" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="pf-country">Country</label><select class="input" id="pf-country">${(st.countries || ["Somaliland"]).map(c => `<option ${c === d.country ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>
        ${f("city", "City", 'maxlength="60" placeholder="Hargeisa"')}</div>`,
      () => `${head(1)}
      <div class="field"><label>Shop or company</label><div class="cur-toggle" style="grid-template-columns:1fr 1fr"><button type="button" class="USD" data-pfkind="shop" aria-pressed="${d.kind === "shop"}">Shop</button><button type="button" class="SLSH" data-pfkind="company" aria-pressed="${d.kind === "company"}">Company</button></div><input type="hidden" id="pf-kind" value="${esc(d.kind)}"></div>
      ${catSelect(d)}
      ${f("business_name", `Name of the ${biz}`, 'maxlength="60" placeholder="' + (biz === "company" ? "Asha Trading Ltd" : "Asha Electronics") + '"')}
      ${f("address", "Address", 'maxlength="160" placeholder="Street, district"')}`,
      () => `${head(2)}
      ${f("phone", signup ? "Phone (you log in with this)" : "Phone", 'inputmode="tel" maxlength="15" placeholder="63 4123456"')}
      ${f("zaad_merchant", "Merchant number ZAAD", 'inputmode="numeric" maxlength="15"')}
      ${f("edahab_merchant", "Merchant number eDahab", 'inputmode="numeric" maxlength="15"', "Add at least one merchant number.")}
      ${f("shop_phone", `Normal ${biz} number`, 'inputmode="tel" maxlength="15"', "Optional.")}`,
    ];
    return `<div class="pf">${(step ? [parts[step - 1]] : parts).map(x => x()).join("")}</div>`;
  }
  // Checks one part of the form in the browser (the server checks everything again). Returns an error or "".
  function pfCheck(step) {
    const d = pfDraft(), t = k => String(d[k] || "").trim(), n = k => String(d[k] || "").replace(/\D/g, "");
    if (step === 1) {
      if (t("full_name").length < 3) return "Enter your full name.";
      const bd = /^\d{4}-\d{2}-\d{2}$/.test(t("birth_date")) ? new Date(t("birth_date") + "T00:00:00") : null;
      if (!bd || isNaN(bd)) return "Enter your birth date.";
      const age = (Date.now() - bd.getTime()) / (365.25 * 86400000);
      if (age < 18) return "Sellers must be at least 18 years old.";
      if (age > 120) return "Check your birth date.";
      if (st.countries && !st.countries.includes(t("country"))) return "Choose your country from the list.";
      if (t("city").length < 2) return "Enter your city.";
    }
    if (step === 2) {
      if (!["shop", "company"].includes(d.kind)) return "Choose Shop or Company.";
      const cat = (st.bizCats || []).find(c => c.name === d.category);
      // A new merchant must choose one; a shop registered before categories existed may add it later.
      if ((st.bizCats || []).length && !cat && S.user?.account_type !== "merchant") return "Choose your business category.";
      if (cat && (cat.subs || []).length && !cat.subs.includes(d.category_sub)) return `Choose the kind of ${cat.name.toLowerCase()}.`;
      if (t("business_name").length < 2) return `Enter the name of your ${d.kind === "company" ? "company" : "shop"}.`;
      if (t("address").length < 4) return "Enter your address.";
    }
    if (step === 3) {
      if (n("phone").length < 7 || n("phone").length > 15) return "Enter a valid phone number.";
      for (const [k, label] of [["zaad_merchant", "ZAAD merchant number"], ["edahab_merchant", "eDahab merchant number"], ["shop_phone", "shop phone number"]])
        if (n(k) && (n(k).length < 4 || n(k).length > 15)) return `Check the ${label}.`;
      if (!n("zaad_merchant") && !n("edahab_merchant")) return "Enter at least one merchant number (ZAAD or eDahab).";
    }
    return "";
  }
  function vOpenShop(s) {
    if (s?.suspended) return `<div class="leg"><b style="font-family:var(--display);font-size:17px">Your shop is suspended</b><p class="note" style="margin:0">Contact support to reopen your shop.</p></div>`;
    if (!s) return `<div class="leg"><b style="font-family:var(--display);font-size:17px">Become a merchant</b>
      <p class="note" style="margin:0">Fill in your shop or company details. After that you choose a subscription plan and start posting products.</p>
      ${profileForm()}<span class="err" id="shop-err"></span>
      <button class="btn btn-primary btn-block" data-sq="becomemerchant">Register as merchant</button></div>`;
    return `<div class="leg"><b style="font-family:var(--display);font-size:17px">${s.sub_until ? "Renew your subscription" : "Choose your subscription"}</b>
      <p class="note" style="margin:0">${s.sub_until ? `Your ${esc(s.name)} subscription has ended. Renew it to post and sell again.` : `Welcome, ${esc(s.name)}. Pay a plan to open your shop and start posting products.`}</p>
      ${planList(defaultPlan())}
      <div class="sum-row"><span>Your wallet</span><b class="num">${money(st.wallet?.balances?.USD || 0, "USD")} · ${money(st.wallet?.balances?.SLSH || 0, "SLSH")}</b></div>
      <span class="err" id="shop-err"></span>
      <button class="btn btn-primary btn-block" data-sq="openshop">Pay from wallet</button>
      ${topupReady() ? `<div class="or-sep"><span>or pay by phone</span></div>
      <a class="btn btn-ghost btn-block" id="sub-ussd" href="#">Pay by phone</a>
      <span class="note" id="sub-status">Your phone dials the code with the plan price. When support confirms the payment, your shop is renewed.</span>` : ""}</div>
      ${pendingSub()}
    <div class="leg"><b style="font-family:var(--display);font-size:16px">Registration details</b>${detailRows(s.profile || {})}</div>`;
  }
  function pendingSub() {
    const list = (st.wallet?.topups || []).filter(t => t.purpose === "subscription").slice(0, 5);
    return list.length ? `<div class="leg"><b style="font-family:var(--display);font-size:15px">Subscription payments</b>${topupList(list)}</div>` : "";
  }
  function selectedPlan() { const id = (document.querySelector('input[name="plan"]:checked') || {}).value; return paidPlans().find(p => p.id === id) || paidPlans()[0]; }
  function syncSubLink() {
    const a = document.getElementById("sub-ussd"), p = selectedPlan(); if (!a || !p) return;
    const code = topupCode(p.cur, p.price);
    if (code) { a.href = telHref(code); a.textContent = "Pay by phone"; }
  }
  function detailRows(p) {
    const rows = [["Full name", p.full_name], ["Birth date", p.birth_date], ["Country", p.country], ["City", p.city], ["Type", p.kind === "company" ? "Company" : p.kind === "shop" ? "Shop" : ""],
      [p.kind === "company" ? "Company name" : "Shop name", p.business_name], ["Address", p.address], ["Phone", p.phone], ["Merchant ZAAD", p.zaad_merchant], ["Merchant eDahab", p.edahab_merchant], [p.kind === "company" ? "Company number" : "Shop number", p.shop_phone]];
    return rows.filter(r => r[1]).map(([k, v]) => `<div class="sum-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  }
  function vSubscription() {
    const s = st.shop, p = s.profile || {};
    if (st.editPf) return `<div class="leg"><b style="font-family:var(--display);font-size:17px">Edit your details</b>${profileForm()}<span class="err" id="pf-err"></span>
      <button class="btn btn-primary btn-block" data-sq="savepf">Save details</button><button class="btn btn-ghost btn-block" data-sq="cancelpf">Cancel</button></div>`;
    return `<div class="leg"><div class="sum-row"><span>Shop</span><b>${esc(s.name)}</b></div><div class="sum-row"><span>Current plan</span><b>${esc(s.plan_info?.name || "—")} · ${s.plan_info ? limitText(s.plan_info) : ""}</b></div><div class="sum-row"><span>Active until</span><b>${new Date(s.sub_until).toLocaleDateString()}</b></div>
      <p class="note" style="margin:0">${s.plan === "free" ? "You're on the free month. Choose a plan to keep selling after it ends." : "Renewing or upgrading adds the plan's days to your current end date. A new plan's product limit applies straight away."}</p>
      <div class="field"><label>Plan</label>${planList(defaultPlan())}</div>
      <span class="err" id="shop-err"></span>
      <button class="btn btn-primary btn-block" data-sq="openshop">Pay from wallet and renew</button>
      ${topupReady() ? `<div class="or-sep"><span>or pay by phone</span></div>
      <a class="btn btn-ghost btn-block" id="sub-ussd" href="#">Pay by phone</a>
      <span class="note" id="sub-status">Your phone dials the code with the plan price. When support confirms the payment, your shop is renewed.</span>` : ""}</div>
      ${pendingSub()}
    <div class="leg"><b style="font-family:var(--display);font-size:16px">Registration details</b>${detailRows(p) || `<p class="note" style="margin:0">No details yet.</p>`}
      <button class="btn btn-ghost btn-block" data-sq="editpf">Edit details</button></div>`;
  }
  function vMyProducts() {
    if (st.edit) return vEditProduct();
    return `<div class="row-actions" style="gap:8px">${mayList("suuq") ? `<button class="btn btn-primary" style="flex:1" data-sq="newprod">+ Add product</button>` : ""}${mayList("technician") && allowedSvcs() ? `<button class="btn btn-primary" style="flex:1" data-sq="newtech">+ Add service</button>` : ""}${visaOpen() && mayList("visa") ? `<button class="btn btn-primary" style="flex:1" data-sq="newvisa">+ Add visa</button>` : ""}${scholarOk() && mayList("scholarship") ? `<button class="btn btn-primary" style="flex:1" data-sq="newscholar">+ Add scholarship</button>` : ""}</div>
      ${categoryNote() ? `<p class="note" style="margin:0">${esc(categoryNote())}</p>` : ""}
      ${st.flash ? `<div class="instr flash">${esc(st.flash)}</div>` : ""}
      ${st.myProducts.length ? `<div class="olist">${st.myProducts.map(p => `<div class="ocard ${p.hidden || p.admin_hidden || p.approval !== "approved" ? "off" : ""}">
        ${p.images[0] ? `<img src="${esc(p.images[0])}" alt="">` : `<span class="noimg">▶</span>`}
        <div class="t"><b>${esc(p.name)}</b><small>${p.service === "visa" ? `<span class="mk-tag">Visa</span> ` : p.service === "scholarship" ? `<span class="mk-tag">Scholarship</span> ` : ""}${money(p.price, p.cur)}${p.price_hidden ? ` · shown as “${esc(p.price_label)}”` : ""} · ${p.mode === "buy" ? "Buy" : "Book"} · ${p.sold} sold${p.admin_hidden ? ` · hidden by ${MNAMES[p.service] || "Suuq"} admin` : p.hidden ? " · hidden" : ""}</small>
          ${earnText(p) ? `<span class="earn">${esc(earnText(p))}</span>` : ""}
          ${p.approval === "pending" ? `<span class="pill waiting" style="align-self:flex-start">Waiting for admin approval</span>` : ""}
          ${p.approval === "rejected" ? `<span class="pill susp" style="align-self:flex-start">Not approved</span><small class="note" style="color:var(--danger)">${esc(p.review_note)} · Edit and save to send it again.</small>` : ""}
          <div class="req-actions"><button class="btn btn-ghost" data-editprod="${esc(p.id)}">Edit</button>
            <button class="btn btn-ghost" data-hideprod="${esc(p.id)}" data-to="${p.hidden ? 0 : 1}">${p.hidden ? "Show" : "Hide"}</button>
            <button class="btn btn-ghost" data-viewprod="${esc(p.id)}">View</button></div></div></div>`).join("")}</div>` : `<div class="empty">No products yet.</div>`}`;
  }
  function vEditProduct() {
    const e = st.edit;
    return `<div class="leg">
      <b style="font-family:var(--display);font-size:17px">${e.id ? (e.service === "visa" ? "Edit visa" : e.service === "scholarship" ? "Edit scholarship" : "Edit product") : (e.service === "visa" ? "New visa" : e.service === "scholarship" ? "New scholarship" : "New product")}</b>
      ${(() => { const opts = [["suuq", "Suuq"], ...(visaOpen() ? [["visa", "Visa"]] : []), ...(scholarOk() || e.service === "scholarship" ? [["scholarship", "Scholarship"]] : []), ...((settings.services || []).some(x => x.id === "technician") || e.service === "technician" ? [["technician", "Technician"]] : [])].filter(([k]) => mayList(k) || e.service === k);
        return opts.length > 1 ? `<div class="field"><label>List it in</label><div class="cur-toggle" style="grid-template-columns:repeat(${opts.length},1fr)">${opts.map(([k, l], i) => `<button class="${i % 2 ? "SLSH" : "USD"}" data-pesvc="${k}" aria-pressed="${(e.service || "suuq") === k}">${l}</button>`).join("")}</div></div>` : ""; })()}
      ${hasCountry(e.service) ? `<div class="field"><label for="pe-country">${e.service === "scholarship" ? "Country of the scholarship" : "Country of the visa"}</label><select class="input" id="pe-country"><option value="">Choose a country…</option>${(st.countries || []).filter(c => c !== "Somaliland").map(c => `<option ${c === e.country ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>` : ""}
      <div class="field"><label for="pe-name">Short name</label><input class="input" id="pe-name" maxlength="60" value="${esc(e.name)}" placeholder="${e.service === "visa" ? "Tourist visa, 30 days" : e.service === "scholarship" ? "Bachelor's degree, full scholarship" : e.service === "technician" ? "Plumbing repair, one visit" : "Samsung A15 128GB"}"></div>
      <div class="grid2" style="grid-template-columns:1fr 110px"><div class="field"><label for="pe-price">Price</label><input class="input" id="pe-price" inputmode="decimal" value="${esc(e.price)}"></div>
        <div class="field"><label for="pe-cur">Currency</label><select class="input" id="pe-cur">${CURS.map(c => `<option ${c === e.cur ? "selected" : ""}>${c}</option>`).join("")}</select></div></div>
      <div class="field"><label>Show the price to customers?</label><div class="cur-toggle" style="grid-template-columns:1fr 1fr"><button class="USD" data-pehide="0" aria-pressed="${!e.price_hidden}">Show price</button><button class="SLSH" data-pehide="1" aria-pressed="${!!e.price_hidden}">Hide price</button></div>
        ${e.price_hidden ? `<label for="pe-label" style="margin-top:6px">Show these words instead</label><select class="input" id="pe-label">${priceWords().map(w => `<option ${w === e.price_label ? "selected" : ""}>${esc(w)}</option>`).join("")}</select>
        <small class="note">Customers tap “Ask for price”. You send them the price in Orders, then they pay from their wallet. The affiliate earning is still shown.</small>` : ""}</div>
      <div class="field"><label>Customers can</label><div class="cur-toggle" style="grid-template-columns:1fr 1fr"><button class="USD" data-pemode="buy" aria-pressed="${e.mode === "buy"}">Buy</button><button class="SLSH" data-pemode="book" aria-pressed="${e.mode === "book"}">Book</button></div></div>
      <div class="field"><label>Photos (up to ${MAX_PHOTOS}) · ${e.images.length} added</label><div class="pe-imgs">${e.images.map((src, i) => `<span class="pe-img ${i === 0 ? "main" : ""}"><img src="${esc(src)}" alt=""><button data-rmimg="${i}" aria-label="Remove photo ${i + 1}">✕</button>${i === 0 ? `<em>Main</em>` : `<button class="mk-main" data-mainimg="${i}" aria-label="Make photo ${i + 1} the main photo">★</button>`}</span>`).join("")}
        ${e.images.length < MAX_PHOTOS ? `<label class="pe-add" for="pe-file">+ Add photos</label>` : ""}</div><input type="file" id="pe-file" accept="image/jpeg,image/png,image/webp,image/*" multiple hidden>
        <small class="note">Use real photos of the product. The first photo is the one customers see in the list. You can pick several at once.</small>${e.photoErr ? `<small class="err">${esc(e.photoErr)}</small>` : ""}</div>
      <div class="field"><label for="pe-video">Video link (YouTube, TikTok, Facebook, Instagram, Vimeo or a video file). A TikTok link opens from the TikTok icon.</label><input class="input" id="pe-video" value="${esc(e.video)}" placeholder="https://…"></div>
      <div class="field"><label for="pe-desc">Description</label><textarea class="input" id="pe-desc" maxlength="600" style="min-height:80px">${esc(e.description)}</textarea></div>
      <div class="field"><label>Affiliate earning (what a sharer earns per sale)</label>
        <div class="cur-toggle" style="grid-template-columns:1fr 1fr"><button class="USD" data-pecomm="percent" aria-pressed="${e.comm_type === "percent"}">Percentage</button><button class="SLSH" data-pecomm="flat" aria-pressed="${e.comm_type === "flat"}">Flat amount</button></div>
        <div class="suffix">${e.comm_type === "flat" ? `<span>${e.cur}</span>` : ""}<input id="pe-comm" inputmode="decimal" value="${esc(e.comm_value)}" aria-label="Affiliate earning">${e.comm_type === "percent" ? "<span>%</span>" : ""}</div>
        <small class="note">Set 0 for no affiliate earning. It is paid from your sale when the order is completed.</small></div>
      <span class="err" id="pe-err"></span>
      <button class="btn btn-primary btn-block" data-sq="saveprod">${e.id ? "Save changes" : "Post product"}</button>
      ${e.id ? (e.confirmDel ? `<button class="btn btn-danger btn-block" data-sq="delprodyes">Delete for good</button>` : `<button class="btn btn-ghost btn-block" data-sq="delprod">Delete product</button>`) : ""}
      <button class="btn btn-ghost btn-block" data-sq="canceledit">Cancel</button></div>`;
  }
  function vSellerOrders() {
    const pend = st.sellerOrders.filter(o => ["paid", "requested", "quoted", "accepted", "delivered", "awaiting_payment"].includes(o.status));
    const done = st.sellerOrders.filter(o => !pend.includes(o));
    const card = o => `<div class="ocard">
      ${o.image ? `<img src="${esc(o.image)}" alt="">` : `<span class="noimg">▶</span>`}
      <div class="t"><b>${esc(o.product_name)} × ${o.qty}</b><small>${esc(o.buyer_name)} · +252 ${esc(o.buyer_phone)} · ${new Date(o.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>
        ${o.book_at ? `<small class="onote book-at">📅 ${esc(o.book_at)}</small>` : ""}${o.note ? `<small class="onote">“${esc(o.note)}”</small>` : ""}
        <div class="orow"><span class="pill ${statusTone(o.status)}">${esc(o.status === "accepted" ? (o.kind === "buy" ? "Accepted · send the agreed price" : "Booking accepted") : o.needs_price ? "Price requested" : o.status === "declined" && o.forwarded ? "Rejected · sent to another merchant" : statusLabel[o.status] || o.status)}</span><b class="num">${o.needs_price ? "—" : money(o.total, o.cur)}</b></div>
        ${o.status === "requested" ? `<div class="req-actions"><button class="btn btn-primary" data-oact="accept" data-oid="${o.id}">Accept</button><button class="btn btn-danger" data-oact="decline" data-oid="${o.id}">Reject</button></div>
          <small class="note">Accept, then agree the price with the buyer in chat. If you reject, the request goes to another merchant who sells the same thing.</small>` : ""}
        ${o.status === "accepted" ? `<div class="offer-form">
          <b style="font-size:14px">Send the agreed price</b>
          <div class="mini"><label for="qn-${o.id}">Item name</label><input class="input" id="qn-${o.id}" value="${esc(o.product_name)}"></div>
          <div class="mini"><label for="qd-${o.id}">Description</label><textarea class="input" id="qd-${o.id}" rows="2" placeholder="What is included, delivery, dates…"></textarea></div>
          <div class="quote-row"><div class="suffix"><span>${o.cur}</span><input id="qt-${o.id}" inputmode="decimal" value="${esc(o.suggested || "")}" aria-label="Total price for this order"></div>
            <button class="btn btn-primary" data-quote="${o.id}">Send price</button></div>
          <small class="note">Total for ${o.qty}. The buyer then pays it${o.has_affiliate ? "; the affiliate earning comes out of it" : ""}.</small>
          <div class="req-actions"><button class="btn btn-ghost" data-chat-seller="${esc(o.product_id)}" data-buyer="${esc(o.buyer_name)}">Chat with buyer</button><button class="btn btn-danger" data-oact="decline" data-oid="${o.id}">Reject</button></div></div>` : ""}
        ${o.status === "quoted" ? `<small class="note">Waiting for the buyer to pay. You get ${money(o.net, o.cur)}${o.commission ? ` · affiliate ${money(o.commission, o.cur)}` : ""}.</small>` : ""}
        ${o.kind === "buy" && !o.needs_price && o.status !== "quoted" ? `<small class="note">You get ${money(o.net, o.cur)}${o.commission ? ` · affiliate ${money(o.commission, o.cur)}` : ""}</small>` : ""}
        ${o.kind === "buy" && o.pay_method !== "wallet" ? `<small class="note">${esc(PAY_NAME[o.pay_method])}${o.pay_ussd ? ` · <span class="num">${esc(o.pay_ussd)}</span> (${esc(money(o.total - (o.pay_discount || 0) + o.pay_fee, o.cur))})` : ""}${o.pay_method === "shop" ? " · paid to you directly" : ""}</small>` : ""}
        ${o.status === "awaiting_payment" && o.pay_method === "safe" ? `<small class="note">Waiting for Sarrif to confirm the buyer's payment. Don't deliver yet.</small>` : ""}
        <div class="req-actions">
          ${o.status === "awaiting_payment" && o.pay_method === "shop" ? `<button class="btn btn-primary" data-oact="money_received" data-oid="${o.id}">Money received</button><button class="btn btn-ghost" data-oact="decline" data-oid="${o.id}">Not received</button>` : ""}
          ${o.kind === "buy" && o.status === "paid" ? `<button class="btn btn-primary" data-oact="deliver" data-oid="${o.id}">Mark delivered</button><button class="btn btn-ghost" data-oact="cancel" data-oid="${o.id}">${o.pay_method === "shop" ? "Cancel" : "Cancel and refund"}</button>` : ""}
          ${o.kind === "book" && o.status === "accepted" ? `<button class="btn btn-primary" data-oact="complete" data-oid="${o.id}">Mark done</button>` : ""}
          ${o.status === "delivered" ? `<small class="note">${o.pay_method === "shop" ? "Waiting for the buyer to confirm they received it." : "Waiting for the buyer to confirm. Then the money reaches your wallet."}</small>` : ""}
          <button class="btn btn-ghost" data-chat-seller="${esc(o.product_id)}" data-buyer="${esc(o.buyer_name)}">Chats</button>
        </div></div></div>`;
    return `<h3 style="font-size:15px">Pending (${pend.length})</h3>${pend.length ? `<div class="olist">${pend.map(card).join("")}</div>` : `<div class="empty">No pending orders.</div>`}
      <h3 style="font-size:15px">Sales and past orders</h3>${done.length ? `<div class="olist">${done.map(card).join("")}</div>` : `<div class="empty">Nothing yet.</div>`}`;
  }

  /* ---------- events ---------- */
  async function reloadAndRender(fn) { await fn(); render(); }
  function bind(root) {
    const q = sel => root.querySelectorAll(sel), one = id => root.querySelector("#" + id);
    q("[data-sq]").forEach(b => b.onclick = () => action(b.dataset.sq, b));
    q("[data-sqtab]").forEach(b => b.onclick = async () => { st.tab = b.dataset.sqtab; st.edit = null;
      if (st.tab === "orders") await loadOrders(); if (st.tab === "chats") await loadChats(); if (st.tab === "shop") await loadProducts(); if (st.tab === "sell") await loadShop(); render(); });
    q("[data-selltab]").forEach(b => b.onclick = async () => { st.sell = b.dataset.selltab; st.edit = null; st.flash = ""; await loadShop(); render(); });
    q("[data-prod]").forEach(b => b.onclick = async () => { await openProduct(b.dataset.prod); render(); });
    q("[data-vcountry]").forEach(b => b.onclick = async () => { st.visaCountry = b.dataset.vcountry; await loadProducts(); render(); });
    q("[data-openshop]").forEach(b => b.onclick = () => openShop(Number(b.dataset.openshop)));
    q("[data-viewprod]").forEach(b => b.onclick = async () => { await openProduct(b.dataset.viewprod); render(); });
    q("[data-share]").forEach(b => b.onclick = () => copy(shareLink(b.dataset.share, codeFor(b.dataset.share)), b, "Link copied"));
    q("[data-fav]").forEach(b => b.onclick = async () => {
      const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", on); b.setAttribute("aria-label", on ? "Remove from favourites" : "Add to favourites");
      if (st.product && st.product.id === b.dataset.fav) st.product.fav = on;
      try { await api(`/api/suuq/favorites/${encodeURIComponent(b.dataset.fav)}`, { body: { on } }); } catch { b.setAttribute("aria-pressed", !on); if (st.product) st.product.fav = !on; }
    });
    bindTikTok(root);
    const ews = one("ew-save"); if (ews) ews.onclick = async () => {
      try { const r = await api("/api/earnings/limit", { method: "PUT", body: { USD: one("ew-usd").value.replace(/[^\d.]/g, ""), SLSH: one("ew-slsh").value.replace(/[^\d]/g, "") } }); st.aff.withdraw_at = r.withdraw_at; render(); }
      catch (e) { const m = one("st-earn"); if (m) { m.textContent = e.message; m.className = "status-msg bad"; } }
    };
    q("[data-ebedel]").forEach(b => b.onclick = async () => { await loadWallet(); S.earnPay = { cur: b.dataset.ebedel, to: null, err: "" }; openService("ibedel"); });
    q("[data-chat]").forEach(b => b.onclick = () => startChat(b.dataset.chat));
    q("[data-chat-seller]").forEach(b => b.onclick = async () => { st.tab = "chats"; await loadChats(); render(); });
    q("[data-openchat]").forEach(b => b.onclick = () => openChat(b.dataset.openchat));
    q("[data-oact]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api(`/api/suuq/orders/${b.dataset.oid}/action`, { body: { action: b.dataset.oact } }); } catch (e) { alertNote(b, e.message); return; }
      await Promise.all([loadOrders(), loadShop(), loadWallet()]); render();
    });
    const logoIn = one("shop-logo");
    if (logoIn) logoIn.onchange = async () => {
      const f = logoIn.files[0]; if (!f) return;
      try { const image = await compressImage(f, 600_000); st.shop = (await api("/api/suuq/shop/logo", { body: { image } })).shop; render(); }
      catch (e) { alertNote(logoIn.parentElement, e.message || "That photo could not be used."); }
    };
    const teSave = one("te-save");
    if (teSave) teSave.onclick = async () => { try { st.shop = (await api("/api/suuq/shop/ticket-earn", { body: { type: one("te-type").value, value: one("te-value").value } })).shop; render(); } catch (e) { alertNote(teSave, e.message); } };
    const trav = one("shop-travel");
    if (trav) trav.onchange = async () => { try { st.shop = (await api("/api/suuq/shop/travel", { body: { on: trav.checked } })).shop; render(); } catch (e) { trav.checked = !trav.checked; alertNote(trav.parentElement, e.message); } };
    const sq = one("sq-q"); if (sq) { let t; sq.oninput = () => { st.q = sq.value; clearTimeout(t); t = setTimeout(async () => { await loadProducts(); render(); const i = document.getElementById("sq-q"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 300); }; }
    q("[data-order]").forEach(b => b.onclick = () => { st.orderSheet = { qty: 1, pin: "", note: "" }; render(); });
    const bd = one("sq-bdate"), bt = one("sq-btime");
    if (bd) bd.onchange = bd.oninput = () => { st.orderSheet.bdate = bd.value; }; if (bt) bt.onchange = bt.oninput = () => { st.orderSheet.btime = bt.value; };
    q("[data-qty]").forEach(b => b.onclick = () => { const os = st.orderSheet; os.note = (one("sq-note") || {}).value || os.note; os.qty = Math.min(100, Math.max(1, os.qty + Number(b.dataset.qty))); os.tpAmt = undefined; render(); });
    const note = one("sq-note"); if (note) note.oninput = () => st.orderSheet.note = note.value;
    if (st.orderSheet || st.paySheet) bindTopupInline(st.paySheet || st.orderSheet);
    q("[data-paym]").forEach(b => b.onclick = () => { const box = st.paySheet || st.orderSheet; if (!box) return; box.method = b.dataset.paym; box.err = ""; render(); });
    q("[data-payvia]").forEach(b => b.onclick = () => { const box = st.paySheet || st.orderSheet; if (!box) return; box.via = b.dataset.payvia; render(); });
    pinOn("sq-pin", v => { st.orderSheet.pin = v; st.orderSheet.err = ""; }, v => root.querySelectorAll("[data-needpin]").forEach(b => b.disabled = v.length !== 4), () => { if ((st.orderSheet.pin || "").length === 4) placeOrder(); });
    if (st.multi && !st.multi.done) {
      const m = st.multi, keepNote = () => { const n = one("ms-note"); if (n) m.note = n.value; };
      q("[data-mpaym]").forEach(b => b.onclick = () => { keepNote(); m.method = b.dataset.mpaym; m.err = ""; render(); });
      q("[data-mqty]").forEach(b => b.onclick = () => { keepNote(); const [i, d] = b.dataset.mqty.split(":").map(Number); m.items[i].qty = Math.min(100, Math.max(1, m.items[i].qty + d)); m.tpAmt = undefined; render(); });
      q("[data-mrm]").forEach(b => b.onclick = () => { keepNote(); const x = m.items.splice(Number(b.dataset.mrm), 1)[0]; if (x) picked.delete(x.p.id); if (!m.items.length) st.multi = null; render(); syncPickBar(); });
      pinOn("ms-pin", v => { m.pin = v; m.err = ""; }, v => { const b = root.querySelector('[data-sq="multipay"]'); if (b) b.disabled = v.length !== 4; }, () => { if ((m.pin || "").length === 4) placeMulti(); });
      bindTopupInline(m);
    }
    syncPickBar();
    bindComposer(one("composer"), sendMsg);
    bindMsgs(one("msgs"));
    // product editor
    q("[data-pemode]").forEach(b => b.onclick = () => { keepEdit(); st.edit.mode = b.dataset.pemode; render(); });
    q("[data-scat]").forEach(b => b.onclick = () => { st.suuqCat = b.dataset.scat; render(); window.scrollTo(0, 0); });
    q("[data-pesvc]").forEach(b => b.onclick = () => { keepEdit(); st.edit.service = b.dataset.pesvc; render(); });
    q("[data-pehide]").forEach(b => b.onclick = () => { keepEdit(); st.edit.price_hidden = b.dataset.pehide === "1"; if (!st.edit.price_label) st.edit.price_label = priceWords()[0]; render(); });
    q("[data-payorder]").forEach(b => b.onclick = async () => { await loadWallet(); const o = st.orders.find(x => x.id === b.dataset.payorder); let pay_shop = null;
      try { pay_shop = (await api("/api/suuq/products/" + encodeURIComponent(o.product_id))).product.pay_shop; } catch {}
      st.paySheet = { id: b.dataset.payorder, pin: "", pay_shop }; render(); const i = document.getElementById("pay-pin"); if (i) i.focus(); });
    q("[data-quote]").forEach(b => b.onclick = async () => {
      const inp = root.querySelector(`#qt-${b.dataset.quote}`), amount = Number(String(inp?.value || "").replace(/[^\d.]/g, ""));
      b.disabled = true;
      const nm = root.querySelector(`#qn-${b.dataset.quote}`), ds = root.querySelector(`#qd-${b.dataset.quote}`);
      try { await api(`/api/suuq/orders/${b.dataset.quote}/action`, { body: { action: "quote", amount, name: nm ? nm.value : "", description: ds ? ds.value : "" } }); } catch (e) { alertNote(b, e.message); return; }
      await loadShop(); render();
    });
    pinOn("pay-pin", v => { st.paySheet.pin = v; st.paySheet.err = ""; }, v => { const g = one("pay-go"); if (g) g.disabled = v.length !== 4; }, () => payQuoted());
    const pg = one("pay-go"); if (pg) pg.onclick = () => payQuoted();
    q("[data-pecomm]").forEach(b => b.onclick = () => { keepEdit(); st.edit.comm_type = b.dataset.pecomm; render(); });
    q("[data-rmimg]").forEach(b => b.onclick = () => { keepEdit(); st.edit.images.splice(+b.dataset.rmimg, 1); render(); });
    // Product photos: tap a thumbnail to show that photo; swiping the big photo updates the thumbnails.
    const gal = one("gallery");
    if (gal) {
      let cur = 0;
      const mark = i => { cur = i; q("[data-thumb]").forEach(t => t.setAttribute("aria-current", String(+t.dataset.thumb === i))); const c = one("gal-count"); if (c) c.textContent = `${i + 1} / ${gal.children.length}`; };
      const show = (i, smooth) => { gal.scrollTo({ left: gal.children[i].offsetLeft - gal.offsetLeft, behavior: smooth ? "smooth" : "auto" }); mark(i); };
      q("[data-thumb]").forEach(t => t.onclick = () => show(+t.dataset.thumb, true));
      gal.onscroll = () => { const w = gal.clientWidth || 1; mark(Math.min(gal.children.length - 1, Math.round(Math.abs(gal.scrollLeft) / (w + 8)))); };
      q("[data-zoomimg]").forEach(b => b.onclick = () => zoom.open(st.product.images, b.dataset.zoomimg === "cur" ? cur : +b.dataset.zoomimg, st.product.name, i => show(i, false)));
    }
    q("[data-mainimg]").forEach(b => b.onclick = () => { keepEdit(); const [x] = st.edit.images.splice(+b.dataset.mainimg, 1); st.edit.images.unshift(x); render(); });
    const pf = one("pe-file"); if (pf) pf.onchange = async () => {
      keepEdit();
      const skipped = [];
      for (const f of [...pf.files].slice(0, MAX_PHOTOS - st.edit.images.length)) {
        if (!/^image\//.test(f.type)) { skipped.push(f.name); continue; }
        try { st.edit.images.push(await compressImage(f, 900000)); } catch { skipped.push(f.name); }
      }
      st.edit.photoErr = skipped.length ? `Not a photo, skipped: ${skipped.join(", ")}` : (pf.files.length > MAX_PHOTOS ? `Only ${MAX_PHOTOS} photos per product.` : "");
      render();
    };
    const cur = one("pe-cur"); if (cur) cur.onchange = () => { keepEdit(); render(); };
    q("[data-editprod]").forEach(b => b.onclick = () => { const p = st.myProducts.find(x => x.id === b.dataset.editprod); st.edit = { ...p, images: [...p.images] }; render(); });
    q("[data-hideprod]").forEach(b => b.onclick = async () => { try { await api(`/api/suuq/products/${b.dataset.hideprod}`, { method: "PUT", body: { hidden: b.dataset.to === "1" } }); } catch {} await loadShop(); render(); });
    const fin = one("sq-fin"); if (fin) mountFinance(fin);
    q("[data-pfkind]").forEach(b => b.onclick = () => { keepPf(); pfDraft().kind = b.dataset.pfkind; render(); }); bindPfCat(root);
    q("[data-tpcur]").forEach(b => b.onclick = () => { st.topup.cur = b.dataset.tpcur; render(); });
    const ta = one("tp-amount");
    if (ta) ta.oninput = () => {
      st.topup.amount = ta.value.replace(/[^\d.]/g, ""); if (ta.value !== st.topup.amount) ta.value = st.topup.amount;
      const code = topupCode(st.topup.cur, st.topup.amount), a = one("tp-send");
      a.href = code ? telHref(code) : "#"; a.classList.toggle("is-off", !code); a.setAttribute("aria-disabled", !code);
      one("tp-code").innerHTML = topupHint(st.topup.cur, st.topup.amount);
    };
    const ts = one("tp-send");
    if (ts) ts.onclick = e => {
      const code = topupCode(st.topup.cur, st.topup.amount);
      if (!code) { e.preventDefault(); return; }
      dialCode(e, code);
      const body = { cur: st.topup.cur, amount: st.topup.amount }, el = one("tp-status");
      st.topup.amount = "";
      setTimeout(() => recordTopup(body, el), 0);
    };
    q("[data-tpcancel]").forEach(b => b.onclick = async () => { try { await api(`/api/wallet/topup/${b.dataset.tpcancel}/cancel`, { body: {} }); } catch {} await loadWallet(); render(); });
    q('input[name="plan"]').forEach(r => r.onchange = syncSubLink); syncSubLink();
    const su = one("sub-ussd");
    if (su) su.onclick = e => {
      const p = selectedPlan(), code = p && topupCode(p.cur, p.price);
      if (!code) { e.preventDefault(); return; }
      dialCode(e, code);
      setTimeout(async () => { await recordTopup({ cur: p.cur, amount: p.price, plan_id: p.id }, one("sub-status")); await loadWallet(); if (inMarket() && st.tab === "sell") render(); }, 0);
    };
  }
  function alertNote(b, text) { b.disabled = false; const s = document.createElement("small"); s.className = "err"; s.textContent = text; b.after(s); }
  function keepEdit() {
    const e = st.edit, v = id => (document.getElementById(id) || {}).value;
    if (!e) return;
    e.name = v("pe-name") ?? e.name; e.price = v("pe-price") ?? e.price; e.cur = v("pe-cur") ?? e.cur; e.video = v("pe-video") ?? e.video;
    e.description = v("pe-desc") ?? e.description; e.comm_value = v("pe-comm") ?? e.comm_value; e.price_label = v("pe-label") ?? e.price_label;
    e.country = v("pe-country") ?? e.country;
  }
  function mountFinance(el) {
    const counts = st.myProducts.reduce((m, p) => (m[p.cur] = (m[p.cur] || 0) + 1, m), {});
    st.finance = window.SarrifFinance.mount(el, {
      canEdit: true, cur: (counts.USD || 0) >= (counts.SLSH || 0) ? "USD" : "SLSH",
      reportTitle: `${st.shop?.name || "My shop"} · ${window.SarrifI18n ? SarrifI18n.t("Sales report") : "Sales report"}`, reportName: `${st.shop?.name || "shop"} sales report`,
      labels: { revenueSub: "What you keep from completed sales", count: "Sales completed", countCol: "Sales" },
      load: (fromMs, toMs, fromDate, toDate) => api(`/api/suuq/seller/report?fromMs=${fromMs}&toMs=${toMs}&fromDate=${fromDate}&toDate=${toDate}`),
      addExpense: e => api("/api/suuq/seller/expenses", { body: e }),
      deleteExpense: id => api(`/api/suuq/seller/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
    });
  }
  async function action(a, b) {
    if (a === "hub") { S.service = null; st.product = null; st.chat = null; st.shopView = null; st.fromHub = false; render(); return; }
    if (a === "closeshop") { st.shopView = null; if (st.fromHub) { st.fromHub = false; S.service = null; } render(); return; }
    if (a === "closeprod") {
      st.product = null; st.orderSheet = null;
      if (st.fromTicket) { st.fromTicket = false; S.service = "ticket"; render(); return; }
      if (st.fromSvc) { S.service = st.fromSvc; st.fromSvc = null; render(); return; }
      if (st.fromFavs) { st.fromFavs = false; S.service = "favs"; render(); return; }
      if (st.fromHub && !st.shopView) { st.fromHub = false; S.service = null; render(); return; } // back to the search results
      await loadProducts(); render(); return;
    }
    if (a === "closechat") { st.chat = null; if (st.fromTicket) { st.fromTicket = false; S.service = "ticket"; render(); return; } if (st.fromSvcChat) { S.service = st.fromSvcChat; st.fromSvcChat = null; render(); return; } await loadChats(); render(); return; }
    if (a === "closesheet") { st.orderSheet = null; render(); return; }
    if (a === "myorders") { st.product = null; st.orderSheet = null; st.tab = "orders"; await loadOrders(); render(); return; }
    if (a === "book" || a === "pay") { if (b) b.disabled = true; return placeOrder(); }
    if (a === "payussd" || a === "payquotedussd") {
      const box = a === "payussd" ? st.orderSheet : st.paySheet;
      if (box && b?.dataset.via) { box.via = b.dataset.via; box.err = ""; }
      if (b) b.disabled = true;
      return a === "payussd" ? placeOrder() : payQuotedUssd();
    }
    if ((a === "newprod" || a === "newvisa" || a === "newscholar" || a === "newtech") && !mayList(a === "newvisa" ? "visa" : a === "newscholar" ? "scholarship" : a === "newtech" ? "technician" : "suuq")) { st.edit = null; st.flash = categoryNote(); render(); return; }
    if (a === "newprod" || a === "newvisa" || a === "newscholar" || a === "newtech") { st.flash = ""; st.edit = { id: null, service: a === "newvisa" ? "visa" : a === "newscholar" ? "scholarship" : a === "newtech" ? "technician" : "suuq", price_hidden: false, price_label: priceWords()[0], name: "", price: "", cur: "USD", mode: "buy", images: [], video: "", description: "", comm_type: "percent", comm_value: 5 }; render(); return; }
    if (a === "multipay") { if (b) b.disabled = true; return placeMulti(); }
    if (a === "closemulti") { st.multi = null; render(); syncPickBar(); return; }
    if (a === "multiorders") { st.multi = null; st.tab = "orders"; await loadOrders(); render(); return; }
    if (a === "closepay") { st.paySheet = null; render(); return; }
    if (a === "gowallet") { st.paySheet = null; S.service = "wallet"; st.topup = { cur: "USD", amount: "" }; await open("wallet"); return; }
    if (a === "canceledit") { st.edit = null; render(); return; }
    if (a === "delprod") { keepEdit(); st.edit.confirmDel = true; render(); return; }
    if (a === "delprodyes") { try { await api(`/api/suuq/products/${st.edit.id}`, { method: "DELETE" }); st.edit = null; await loadShop(); } catch {} render(); return; }
    if (a === "saveprod") return saveProduct(b);
    if (a === "openshop") {
      const plan = (document.querySelector('input[name="plan"]:checked') || {}).value;
      if (document.getElementById("pf-full_name")) keepPf();
      const pl = (st.plans || []).find(x => x.id === plan);
      const pin = await askPin("Pay from your wallet", pl ? `${pl.name} · ${money(pl.price, pl.cur)}` : ""); if (!pin) return;
      b.disabled = true;
      try { const r = await api("/api/suuq/shop", { body: { plan_id: plan, pin } }); st.shop = r.shop; st.pf = null; st.sell = "products"; await Promise.all([loadShop(), loadWallet()]); render(); }
      catch (e) { b.disabled = false; const el = document.getElementById("shop-err"); el.textContent = e.message; el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
    if (a === "becomemerchant") {
      keepPf(); b.disabled = true;
      try { const r = await api("/api/suuq/become-merchant", { body: pfDraft() }); S.user = r.user; st.pf = null; await loadShop(); render(); }
      catch (e) { b.disabled = false; const el = document.getElementById("shop-err"); el.textContent = e.message; el.scrollIntoView({ block: "center", behavior: "smooth" }); }
      return;
    }
    if (a === "editpf") { st.pf = null; pfDraft(); st.editPf = true; render(); return; }
    if (a === "cancelpf") { st.editPf = false; st.pf = null; render(); return; }
    if (a === "savepf") {
      keepPf(); b.disabled = true;
      try { const r = await api("/api/suuq/shop/profile", { method: "PUT", body: pfDraft() }); st.shop = r.shop; st.editPf = false; st.pf = null; render(); }
      catch (e) { b.disabled = false; const el = document.getElementById("pf-err"); el.textContent = e.message; el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    }
  }
  async function saveProduct(b) {
    keepEdit();
    const e = st.edit, err = document.getElementById("pe-err");
    if (hasCountry(e.service) && !e.country) { err.textContent = e.service === "visa" ? "Choose the country this visa is for." : "Choose the country of the scholarship."; return; }
    const body = { service: e.service || "suuq", country: hasCountry(e.service) ? e.country : "", price_hidden: !!e.price_hidden, price_label: e.price_hidden ? (e.price_label || priceWords()[0]) : "", name: e.name, price: e.price, cur: e.cur, mode: e.mode, video: e.video, description: e.description, comm_type: e.comm_type, comm_value: e.comm_value || 0,
      keepImages: e.images.filter(x => x.startsWith("/media/")), newImages: e.images.filter(x => x.startsWith("data:")) };
    b.disabled = true; b.textContent = "Saving…";
    try {
      if (e.id) await api(`/api/suuq/products/${e.id}`, { method: "PUT", body }); else await api("/api/suuq/products", { body });
      st.flash = `“${e.name}” was sent to the admin. Customers see it after it is approved.`;
      st.edit = null; await loadShop(); render();
    } catch (x) { b.disabled = false; b.textContent = e.id ? "Save changes" : "Post product"; err.textContent = x.message; }
  }
  async function placeOrder() {
    const p = st.product, os = st.orderSheet;
    // The PIN first, for every order (before the phone dials anything).
    if ((os.pin || "").length !== 4) { os.err = "Enter your PIN to place the order."; return render(); }
    try { await api("/api/auth/check-pin", { body: { pin: os.pin } }); }
    catch (e) { os.err = e.message; os.pin = ""; return render(); }
    if (p.mode === "book") {
      os.bdate = (document.getElementById("sq-bdate") || {}).value || os.bdate || ""; os.btime = (document.getElementById("sq-btime") || {}).value || os.btime || "";
      if (!SarrifDate.iso(os.bdate) || !os.btime) { os.err = "Choose the date and time you want it."; return render(); }
    }
    try {
      const ussd = p.mode === "buy" && !asksPrice(p) && os.method && os.method !== "wallet";
      const r = await api("/api/suuq/orders", { body: { pin: os.pin, product_id: p.id, qty: os.qty, note: os.note, ref: refFor(p.id), ...(p.mode === "book" ? { book_at: `${SarrifDate.iso(os.bdate)} ${os.btime}` } : {}), ...(ussd ? { method: os.method, via: os.via } : {}) } });
      os.done = r.order; if (r.balances && st.wallet) st.wallet.balances = r.balances;
      if (r.order.pay_ussd) dialNow(r.order.pay_ussd);
      try { localStorage.removeItem("sarrif.ref." + p.id); } catch {}
    } catch (e) { os.err = e.message; os.pin = ""; }
    render();
  }
  async function payQuotedUssd() {
    const ps = st.paySheet; if (!ps) return;
    try { await api(`/api/suuq/orders/${ps.id}/action`, { body: { action: "pay", method: ps.method, via: ps.via } }); }
    catch (e) { ps.err = e.message; return render(); }
    st.paySheet = null; await loadOrders();
    const o = st.orders.find(x => x.id === ps.id); if (o?.pay_ussd) dialNow(o.pay_ussd);
    render();
  }
  async function payQuoted() {
    const ps = st.paySheet; if (!ps || (ps.pin || "").length !== 4) return;
    try { await api("/api/auth/check-pin", { body: { pin: ps.pin } }); await api(`/api/suuq/orders/${ps.id}/action`, { body: { action: "pay", pin: ps.pin } }); }
    catch (e) { ps.err = e.message; ps.pin = ""; return render(); }
    st.paySheet = null; await Promise.all([loadOrders(), loadWallet()]); render();
  }
  async function startChat(pid) {
    try { const r = await api("/api/suuq/chat/start", { body: { product_id: pid } }); await openChat(r.chat.id); } catch {}
  }
  async function openChat(id) {
    try { const r = await api(`/api/suuq/chats/${id}/messages`); st.chat = r.chat; st.messages = r.messages; st.product = null; } catch {}
    render(); const i = document.querySelector("#composer [data-chatin]"); if (i) i.focus();
  }
  async function sendMsg(payload) {
    const r = await api(`/api/suuq/chats/${st.chat.id}/messages`, { body: payload });
    if (!st.messages.some(m => m.id === r.message.id)) st.messages.push(r.message);
    const typed = (document.querySelector("#composer [data-chatin]") || {}).value; render();
    const i = document.querySelector("#composer [data-chatin]"); if (i) i.value = typed || "";
  }
  // "Not taking calls until 9:30 PM" (other = said about the person you chat with).
  function callsOffText(until, other) {
    if (!until) return "";
    if (until === -1) return other ? "Not taking calls right now" : "Paused · until you turn calls back on";
    const d = new Date(until), today = d.toDateString() === new Date().toDateString();
    const when = d.toLocaleString([], today ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    return other ? `Not taking calls until ${when}` : `Paused until ${when}`;
  }
  // The other person opened the chat: my ticks turn green.
  function onChatRead(d) {
    if (st.chat && st.chat.id === d.conv_id) st.chat.other_read_at = Math.max(st.chat.other_read_at || 0, d.at);
    document.querySelectorAll(`[data-conv="${CSS.escape(d.conv_id)}"] .ticks:not(.read)`).forEach(el => { if (Number(el.dataset.at) <= d.at) { el.classList.add("read"); el.innerHTML = TICK2; el.setAttribute("aria-label", "Read"); } });
  }
  function onChat(m) {
    if (!m.calllog) ringChat(m);
    if (st.chat && m.conv_id === st.chat.id) {
      if (!st.messages.some(x => x.id === m.id)) st.messages.push({ ...m, mine: m.sender_id === S.user.id });
      if (inMarket() && !m.mine) api(`/api/suuq/chats/${st.chat.id}/messages`).catch(() => {});
      if (inMarket() && !rec) { const typed = (document.querySelector("#composer [data-chatin]") || {}).value; render(); const i = document.querySelector("#composer [data-chatin]"); if (i) { i.value = typed || ""; i.focus(); } }
    } else {
      loadChats().then(() => { if (inMarket() && !st.orderSheet && !st.paySheet && !st.edit && !rec) render(); });
      if (m.sender_id !== S.user?.id && !m.new_chat && !m.calllog && S.user?.role === "customer") msgBanner(m, () => openChatById(m.conv_id));
    }
  }
  function onOrder(d) { ringFor(d); if (document.getElementById("pf-full_name")) keepPf(); Promise.all([loadOrders(), loadShop()]).then(() => { if (inMarket() && !st.orderSheet && !st.paySheet && !st.edit && !st.chat) render(); }); }
  function onWallet(d) { if (document.getElementById("pf-full_name")) keepPf(); if (st.wallet) st.wallet.balances = d.balances; else st.wallet = { balances: d.balances, tx: [] }; if ((S.service === "wallet" || S.service === "affiliate") ) loadWallet().then(render); else if (inMarket() && !st.orderSheet && !st.paySheet && !st.edit && !st.chat) render(); else if (!S.service) render(); else if (document.getElementById("tpi-send")) { for (const x of [st.orderSheet, st.paySheet]) if (x) x.tpAmt = undefined; render(); } }

  /* ---------- product approval (Suuq and Visa admins) ---------- */
  const approvalPill = p => p.approval === "pending" ? `<span class="pill waiting">Waiting for approval</span>`
    : p.approval === "rejected" ? `<span class="pill susp">Rejected</span>`
    : `<span class="pill ${p.admin_hidden ? "susp" : "active"}">${p.admin_hidden ? "Hidden by admin" : p.hidden ? "Hidden by seller" : "Approved · live"}</span>`;
  const pendingCount = list => (list || []).filter(p => p.approval === "pending").length;
  function reviewCard(p, word) {
    return `<div class="person ${p.approval === "pending" ? "to-review" : ""} ${p.admin_hidden ? "susp" : ""}"><div class="person-top">
        ${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" style="width:56px;height:56px;border-radius:10px;object-fit:cover">` : `<div class="avatar">▶</div>`}
        <div class="t"><b>${hasCountry(p.service) && p.country ? countryTag(p.country) + " · " : ""}${esc(p.name)}</b><small>${esc(p.shop_name)} · ${money(p.price, p.cur)}${p.price_hidden ? ` · customers see “${esc(p.price_label)}”` : ""} · ${p.mode === "buy" ? "Buy" : "Book"}${p.comm_value > 0 && p.mode === "buy" ? ` · affiliate ${p.comm_type === "percent" ? p.comm_value + "%" : money(p.comm_value, p.cur)}` : ""}</small>
          ${p.description ? `<small class="rv-desc">${esc(p.description)}</small>` : ""}
          ${p.video ? `<small><a href="${esc(p.video)}" target="_blank" rel="noopener">Video link</a></small>` : ""}</div>
        ${approvalPill(p)}</div>
      ${p.images.length > 1 ? `<div class="rv-imgs">${p.images.slice(1).map(src => `<img src="${esc(src)}" alt="">`).join("")}</div>` : ""}
      ${p.approval === "rejected" && p.review_note ? `<small class="note">Reason sent to the seller: “${esc(p.review_note)}”</small>` : ""}
      <div class="person-actions">
        ${p.approval !== "approved" ? `<button class="btn btn-primary" data-review="${esc(p.id)}" data-decision="approve">Approve</button>` : ""}
        ${p.approval === "pending" ? `<input class="input rv-note" id="rn-${esc(p.id)}" maxlength="200" placeholder="Reason, if you reject" aria-label="Reason for the seller"><button class="btn btn-danger" data-review="${esc(p.id)}" data-decision="reject">Reject</button>` : ""}
        ${p.approval === "approved" ? `<button class="btn ${p.admin_hidden ? "btn-primary" : "btn-danger"}" data-prodhide="${esc(p.id)}" data-to="${p.admin_hidden ? 0 : 1}">${p.admin_hidden ? `Show ${word}` : `Hide ${word}`}</button>` : ""}
      </div></div>`;
  }
  function bindReview(el, reload) {
    el.querySelectorAll("[data-review]").forEach(b => b.onclick = async () => {
      const note = (el.querySelector(`#rn-${CSS.escape(b.dataset.review)}`) || {}).value || "";
      b.disabled = true;
      try { await api(`/api/suuq/admin/products/${b.dataset.review}/review`, { body: { decision: b.dataset.decision, note } }); }
      catch (e) { alertNote(b, e.message); return; }
      await reload();
    });
    el.querySelectorAll("[data-prodhide]").forEach(b => b.onclick = async () => { try { await api(`/api/suuq/admin/products/${b.dataset.prodhide}/hide`, { body: { hidden: b.dataset.to === "1" } }); } catch {} await reload(); });
  }
  // A service market with its own admin (Technician): approve the services sellers list.
  async function marketReviewPanel(el, m, word) {
    if (!el) return;
    let list; try { list = (await api(`/api/market/${m}/admin/products`)).products; } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const n = pendingCount(list);
    el.innerHTML = `<div class="panel-head"><div><h3>Services from sellers${n ? ` <span class="pill warn">${n} to approve</span>` : ""}</h3><p>Sellers list their own services here (like Suuq). Approve them so customers can buy or book them.</p></div></div>
      <div class="people">${list.length ? list.map(p => reviewCard(p, word)).join("") : `<div class="empty">No services from sellers yet.</div>`}</div>`;
    bindReview(el, () => marketReviewPanel(el, m, word));
  }
  // A product was sent for approval, or approved/rejected: the admin screens reload their lists.
  function onReview() { st.admin = null; st.visaAdmin = null; st.scholarAdmin = null; }
  // The admin approved or rejected one of this merchant's products.
  function onProduct(d) {
    st.flash = d.approval === "approved" ? `“${d.name}” was approved. Customers can see it now.` : `“${d.name}” was not approved: ${d.note}. Edit it and save to send it again.`;
    loadShop().then(() => { if (inMarket() && !st.orderSheet && !st.paySheet && !st.edit && !st.chat) render(); });
  }

  /* ---------- Visa admin dashboard ---------- */
  /* ---------- Scholarship admin: approve scholarships, choose which travel agencies may post them ---------- */
  function scholarTabs() {
    const n = pendingCount(st.scholarAdmin?.products);
    return `<div class="agent-tabs" role="group" aria-label="Scholarship admin">${[["list", n ? `Scholarships (${n} to approve)` : "Scholarships"], ["agencies", "Travel agencies"], ["safe", "Safe payments"], ["agents", "Agents"]].map(([k, l]) => `<button data-scholadm="${k}" aria-pressed="${(st.scholarTab || "list") === k}">${l}</button>`).join("")}</div>`;
  }
  function bindScholarTabs(el) { el.querySelectorAll("[data-scholadm]").forEach(b => b.onclick = () => { st.scholarTab = b.dataset.scholadm; window.renderSvcDash ? window.renderSvcDash() : renderScholarAdmin(el); }); }
  async function renderScholarAdmin(el) {
    if (!st.scholarAdmin) { el.innerHTML = `<div class="panel empty">Loading…</div>`; try { st.scholarAdmin = await api("/api/scholar/admin/overview"); } catch (e) { st.scholarAdmin = { error: e.message }; } }
    const a = st.scholarAdmin, tab = st.scholarTab || "list";
    let body = "";
    if (tab === "list") body = `<div class="kpis"><div class="kpi ${pendingCount(a.products) ? "warn" : ""}"><span class="label">Waiting for approval</span><b>${pendingCount(a.products)}</b></div><div class="kpi"><span class="label">Scholarships listed</span><b>${(a.products || []).length}</b></div><div class="kpi"><span class="label">Agencies allowed</span><b>${(a.agencies || []).filter(x => x.allowed).length}</b></div></div>
      <div class="people">${(a.products || []).length ? a.products.map(p => reviewCard(p, "scholarship")).join("") : `<div class="empty">No scholarships yet. Allow travel agencies in the Travel agencies tab; they post from My shop → Products → Add scholarship.</div>`}</div>`;
    if (tab === "agencies") body = `<div class="panel"><div class="panel-head"><div><h3>Who may post scholarships</h3><p>Travel agencies (shops that list visas or are listed in Ticket). Allow the ones you trust; every scholarship they post still waits for your approval.</p></div></div>
      <div class="people">${(a.agencies || []).length ? a.agencies.map(g => `<div class="person"><div class="person-top"><span class="agency-logo">${g.logo ? `<img src="${esc(g.logo)}" alt="">` : PLANE}</span>
        <div class="t"><b>${esc(g.name)}</b><small>${esc([g.city, g.country].filter(Boolean).join(", "))}${g.shop_no ? ` · no. ${esc(g.shop_no)}` : ""} · ${esc(g.owner_name)} · <span class="num">+252 ${esc(g.owner_phone)}</span></small></div>
        <span class="pill ${g.allowed ? "active" : "hidden-pill"}">${g.allowed ? "Allowed" : "Not allowed"}</span></div>
        <div class="person-actions"><button class="btn ${g.allowed ? "btn-ghost" : "btn-primary"}" data-allow="${g.id}" data-on="${g.allowed ? 0 : 1}">${g.allowed ? "Stop" : "Allow to post scholarships"}</button></div></div>`).join("") : `<div class="empty">No travel agencies yet.</div>`}</div></div>`;
    if (tab === "safe") body = `<div id="safe-desk"><div class="panel empty">Loading…</div></div>`;
    el.innerHTML = `<div class="admin-head"><div><span class="label">Scholarship admin</span><h2>Scholarship dashboard</h2><p>Scholarships that travel agencies post, and which agencies may post them.</p></div></div>${scholarTabs()}${a.error ? `<div class="panel empty">${esc(a.error)}</div>` : body}`;
    bindScholarTabs(el); if (tab === "safe") renderSafeDesk(el.querySelector("#safe-desk")); bindReview(el, () => { st.scholarAdmin = null; renderScholarAdmin(el); });
    el.querySelectorAll("[data-allow]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await api(`/api/scholar/admin/agencies/${b.dataset.allow}`, { body: { allow: b.dataset.on === "1" } }); st.scholarAdmin = null; renderScholarAdmin(el); }
      catch (e) { b.disabled = false; alertNote(b, e.message); }
    });
  }
  function visaTabs() {
    const n = pendingCount(st.visaAdmin?.products);
    return `<div class="agent-tabs" role="group" aria-label="Visa admin">${[["visas", n ? `Visas (${n} to approve)` : "Visas"], ["words", "Price words"], ["safe", "Safe payments"], ["agents", "Agents"]].map(([k, l]) => `<button data-visadm="${k}" aria-pressed="${st.visaTab === k}">${l}</button>`).join("")}</div>`;
  }
  function bindVisaTabs(el) { el.querySelectorAll("[data-visadm]").forEach(b => b.onclick = () => { st.visaTab = b.dataset.visadm; st.wordDraft = null; window.renderSvcDash ? window.renderSvcDash() : renderVisaAdmin(el); }); }
  async function loadVisaAdmin() { try { st.visaAdmin = await api("/api/visa/admin/overview"); } catch (e) { st.visaAdmin = { error: e.message }; } }
  function renderVisaAdmin(el) {
    const a = st.visaAdmin;
    if (!a) { el.innerHTML = `<div class="panel empty">Loading…</div>`; loadVisaAdmin().then(() => renderVisaAdmin(el)); return; }
    let body = "";
    if (st.visaTab === "visas") body = `<div class="kpis"><div class="kpi ${pendingCount(a.products) ? "warn" : ""}"><span class="label">Waiting for approval</span><b>${pendingCount(a.products)}</b></div><div class="kpi"><span class="label">Visas listed</span><b>${(a.products || []).length}</b></div><div class="kpi"><span class="label">Price hidden</span><b>${(a.products || []).filter(p => p.price_hidden).length}</b></div></div>
      <div class="people">${(a.products || []).length ? a.products.map(p => reviewCard(p, "visa")).join("") : `<div class="empty">No visas listed yet. Merchants add them from My shop → Products → Add visa.</div>`}</div>`;
    if (st.visaTab === "words") {
      const w = st.wordDraft || (st.wordDraft = [...(a.priceWords || [])]);
      body = `<div class="panel"><div class="panel-head"><div><h3>Words instead of a price</h3><p>Sellers who hide a price choose one of these. Customers see it where the price would be.</p></div>
          <div class="row-actions"><span class="status-msg" id="st-words"></span><button class="btn btn-primary" id="save-words">Save</button></div></div>
        <div class="plan-edit">${w.map((x, i) => `<div class="grid2" style="grid-template-columns:1fr auto;align-items:end"><div class="mini"><label for="pw-${i}">Choice ${i + 1}</label><input class="input" id="pw-${i}" data-pw="${i}" maxlength="40" value="${esc(x)}"></div>
          <button class="icon-btn" data-pwrm="${i}" aria-label="Remove">✕</button></div>`).join("")}</div>
        <button class="btn-link" id="add-word" style="align-self:flex-start">+ Add words</button></div>`;
    }
    if (st.visaTab === "safe") body = `<div id="safe-desk"><div class="panel empty">Loading…</div></div>`;
    el.innerHTML = `<div class="admin-head"><div><span class="label">Visa admin</span><h2>Visa dashboard</h2><p>Visas that sellers list, and the words they can show instead of a price.</p></div></div>${visaTabs()}${a.error ? `<div class="panel empty">${esc(a.error)}</div>` : body}`;
    bindVisaTabs(el); if (st.visaTab === "safe") renderSafeDesk(el.querySelector("#safe-desk"));
    bindReview(el, async () => { await loadVisaAdmin(); renderVisaAdmin(el); });
    const keep = () => el.querySelectorAll("[data-pw]").forEach(i => st.wordDraft[+i.dataset.pw] = i.value);
    el.querySelectorAll("[data-pwrm]").forEach(b => b.onclick = () => { keep(); st.wordDraft.splice(+b.dataset.pwrm, 1); renderVisaAdmin(el); });
    const add = el.querySelector("#add-word"); if (add) add.onclick = () => { keep(); st.wordDraft.push(""); renderVisaAdmin(el); const i = el.querySelector(`#pw-${st.wordDraft.length - 1}`); if (i) i.focus(); };
    const save = el.querySelector("#save-words"); if (save) save.onclick = async () => {
      keep();
      try { const r = await api("/api/visa/admin/price-words", { method: "PUT", body: { words: st.wordDraft } }); a.priceWords = r.priceWords; st.wordDraft = null; settings.priceWords = r.priceWords; renderVisaAdmin(el); msg("#st-words", "Saved.", "ok"); }
      catch (e) { msg("#st-words", e.message, "bad"); }
    };
  }

  /* ---------- Suuq admin dashboard ---------- */
  async function loadAdmin() { try { st.admin = await api("/api/suuq/admin/overview"); } catch (e) { st.admin = { error: e.message }; } }
  function adminTabs() {
    const n = pendingCount(st.admin?.products);
    return `<div class="agent-tabs" role="group" aria-label="Suuq admin">${[["shops", "Sellers"], ["products", n ? `Products (${n} to approve)` : "Products"], ["plans", "Subscription plans"], ["safe", "Safe payments"], ["agents", "Agents"]].map(([k, l]) => `<button data-sqadm="${k}" aria-pressed="${st.adminTab === k}">${l}</button>`).join("")}</div>`;
  }
  function renderAdmin(el) {
    const a = st.admin;
    if (!a) { el.innerHTML = `<div class="panel empty">Loading…</div>`; loadAdmin().then(() => renderAdmin(el)); return; }
    const subTotal = (a.subs || []).map(r => money(r.total, r.cur)).join(" · ") || "—";
    let body = "";
    if (st.adminTab === "shops") body = `<div class="kpis"><div class="kpi"><span class="label">Sellers</span><b>${a.shops.length}</b></div><div class="kpi"><span class="label">Active shops</span><b>${a.shops.filter(s => s.active).length}</b></div><div class="kpi"><span class="label">Subscription income</span><b style="font-size:15px">${subTotal}</b></div></div>
      <div class="people">${a.shops.length ? a.shops.map(s => `<div class="person ${s.suspended ? "susp" : ""}"><div class="person-top">${faceAvatar(s.owner_id, s.owner_name || s.name, s.owner_face)}
        <div class="t"><b>${esc(s.name)}</b>${s.profile?.category ? `<span class="cat-tag">${esc(s.profile.category)}${s.profile.category_sub ? " · " + esc(s.profile.category_sub) : ""}</span>` : ""}<small>${esc(s.owner_name)} · +252 ${esc(s.owner_phone)} · ${s.products} products · ${s.sales} sales</small></div>
        <span class="pill ${s.suspended ? "susp" : s.active ? "active" : "waiting"}">${s.suspended ? "Suspended" : s.active ? "Active until " + new Date(s.sub_until).toLocaleDateString() : "Subscription ended"}</span></div>
        <details class="pf-details"><summary>Registration details</summary>${detailRows(s.profile || {}) || `<p class="note">No details.</p>`}</details>
        <div class="person-actions"><button class="btn ${s.suspended ? "btn-primary" : "btn-danger"}" data-shopsusp="${s.id}" data-to="${s.suspended ? 0 : 1}">${s.suspended ? "Reopen shop" : "Suspend shop"}</button></div></div>`).join("") : `<div class="empty">No sellers yet.</div>`}</div>`;
    if (st.adminTab === "products") body = `<div class="kpis"><div class="kpi ${pendingCount(a.products) ? "warn" : ""}"><span class="label">Waiting for approval</span><b>${pendingCount(a.products)}</b></div><div class="kpi"><span class="label">Products</span><b>${a.products.length}</b></div></div>
      <div class="people">${a.products.length ? a.products.map(p => reviewCard(p, "product")).join("") : `<div class="empty">No products yet.</div>`}</div>`;
    if (st.adminTab === "plans") body = `<div class="panel"><div class="panel-head"><div><h3>Merchant plans</h3><p>Free, Basic, Business and Business+. Merchants pay from their wallet or by USSD; the money goes to the super admin as income.</p></div>
        <div class="row-actions"><span class="status-msg" id="st-plans"></span><button class="btn btn-primary" id="save-plans">Save plans</button></div></div>
      <div class="plan-edit">${(st.planDraft || (st.planDraft = structuredClone(a.plans))).map((p, i) => `<div class="grid2 plan-row" style="grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;align-items:end">
        <div class="mini"><label>Name</label><input class="input" data-pl="${i}:name" value="${esc(p.name)}"></div>
        <div class="mini"><label>Days</label><input class="input" data-pl="${i}:days" inputmode="numeric" value="${esc(p.days)}"></div>
        <div class="mini"><label>Price</label><input class="input" data-pl="${i}:price" inputmode="decimal" value="${esc(p.price)}" ${p.id === "free" ? "disabled title=\"The free plan is always 0\"" : ""}></div>
        <div class="mini"><label>Currency</label><select class="input" data-pl="${i}:cur">${CURS.map(c => `<option ${c === p.cur ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="mini"><label>Max products</label><input class="input" data-pl="${i}:maxProducts" inputmode="numeric" value="${esc(p.maxProducts ?? 0)}" title="0 = unlimited"></div>
        <button class="icon-btn" data-plrm="${i}" aria-label="Remove plan" ${p.id === "free" ? "disabled" : ""}>✕</button></div>`).join("")}</div>
      <p class="note" style="margin:0">Free is given once to every new merchant when they register. Max products 0 means unlimited.</p>
      <button class="btn-link" id="add-plan" style="align-self:flex-start">+ Add plan</button>
</div>`;
    if (st.adminTab === "safe") body = `<div id="safe-desk"><div class="panel empty">Loading…</div></div>`;
    el.innerHTML = `<div class="admin-head"><div><span class="label">Suuq admin</span><h2>Suuq dashboard</h2><p>Sellers, their products, the subscription plans and safe payments.</p></div></div>${adminTabs()}${a.error ? `<div class="panel empty">${esc(a.error)}</div>` : body}`;
    bindAdminTabs(el); if (st.adminTab === "safe") renderSafeDesk(el.querySelector("#safe-desk"));
    el.querySelectorAll("[data-shopsusp]").forEach(b => b.onclick = async () => { try { await api(`/api/suuq/admin/shops/${b.dataset.shopsusp}/suspend`, { body: { suspended: b.dataset.to === "1" } }); } catch {} await loadAdmin(); renderAdmin(el); });
    bindReview(el, async () => { await loadAdmin(); renderAdmin(el); });
    el.querySelectorAll("[data-pl]").forEach(i => i.oninput = i.onchange = () => { const [ix, f] = i.dataset.pl.split(":"); st.planDraft[+ix][f] = i.value; });
    el.querySelectorAll("[data-plrm]").forEach(b => b.onclick = () => { st.planDraft.splice(+b.dataset.plrm, 1); renderAdmin(el); });
    const ap = el.querySelector("#add-plan"); if (ap) ap.onclick = () => { st.planDraft.push({ id: "", name: "New plan", days: 30, price: 10, cur: "USD", maxProducts: 50 }); renderAdmin(el); };
    const sp = el.querySelector("#save-plans"); if (sp) sp.onclick = async () => {
      try { const r = await api("/api/suuq/admin/plans", { method: "PUT", body: { plans: st.planDraft } }); st.admin.plans = r.plans; st.planDraft = structuredClone(r.plans); renderAdmin(el); msg("#st-plans", "Saved. Sellers see the new plans.", "ok"); }
      catch (e) { msg("#st-plans", e.message, "bad"); }
    };
  }
  function bindAdminTabs(el) {
    el.querySelectorAll("[data-sqadm]").forEach(b => b.onclick = async () => { st.adminTab = b.dataset.sqadm; st.planDraft = null; if (st.adminTab !== "agents") await loadAdmin(); renderSvcDash(); });
  }

  /* ---------- super admin: wallets and income ---------- */
  let found = null, income = null;
  let topupsTab = "pending", topups = null, tpCfg = null, safeTab = "pending", safeList = null, spCfg = null;
  // Safe payments: buyers dial the money processor; the super admin confirms the money arrived (then it is held until
  // the buyer confirms they received the item) or says it never came.
  // Held safely: Safe payments Sarrif is holding. The admin calls the customer, asks if they received the item (or
  // the work is finished), then releases: the seller gets the price minus the earning, the earning goes to the wallet
  // of whoever shared the link (or the buyer).
  const ICON_CALL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>';
  let heldList = null, heldTotals = {}, safeHost = null, spOwn = null;
  // Where the panels live: the super admin's Wallets tab, or a part admin's dashboard (Suuq, Technician…).
  const safeRefresh = () => safeHost ? renderSafeDesk(safeHost) : renderSuperWallets();
  // One safe payment, spelled out: who bought, what the seller's price is, and who earns what.
  function safeFacts(o) {
    const m = v => `<b class="num">${money(v, o.cur)}</b>`;
    const earn = o.earner === "buyer" ? `The buyer earns ${m(o.commission)} (bought with their own link)`
      : o.earner === "linker" ? `<span data-no-i18n>${esc(o.earner_name)}</span>${o.earner_phone ? ` · <a href="tel:+252${esc(o.earner_phone)}" class="num">+252 ${esc(o.earner_phone)}</a>` : ""} earns ${m(o.commission)} (shared the link)`
      : "No earning on this order";
    return `<dl class="safe-facts">
      <div><dt>Buyer</dt><dd><span data-no-i18n>${esc(o.buyer_name)}</span> · <a href="tel:+252${esc(o.buyer_phone)}" class="num">+252 ${esc(o.buyer_phone)}</a></dd></div>
      <div><dt>Item</dt><dd><span data-no-i18n>${esc(o.product_name)}</span> × ${o.qty} · Ref <span class="num">${esc(o.ref)}</span></dd></div>
      <div><dt>Seller</dt><dd>${o.seller_face ? faceAvatar(o.seller_id, o.seller_name, true, "face-sm") + " " : ""}<span data-no-i18n>${esc(o.shop_name)}${o.seller_name && o.seller_name !== o.shop_name ? " · " + esc(o.seller_name) : ""}</span>${o.seller_phone ? ` · <a href="tel:+252${esc(o.seller_phone)}" class="num">+252 ${esc(o.seller_phone)}</a>` : ""}</dd></div>
      <div><dt>Seller's price</dt><dd>${m(o.total)}${o.qty > 1 ? ` (${money(o.unit_price, o.cur)} × ${o.qty})` : ""}</dd></div>
      <div><dt>Paid</dt><dd>${m(o.paid_amount)} = price ${money(o.total, o.cur)} + charge ${money(o.pay_fee, o.cur)} · to ${esc(o.paid_to)}</dd></div>
      ${o.group_count > 1 ? `<div><dt>One payment</dt><dd>${m(o.group_paid)} for ${o.group_count} products bought together · confirming one confirms them all</dd></div>` : ""}
      <div><dt>Earning</dt><dd>${earn}</dd></div>
      <div><dt>Seller gets</dt><dd>${m(o.net)}${o.commission > 0 ? ` (price − earning)` : ""}</dd></div></dl>`;
  }
  function heldPanel() {
    const tot = Object.entries(heldTotals).map(([c, v]) => money(v, c)).join(" · ");
    return `<div class="panel" id="held-panel"><div class="panel-head"><div><h3>Held safely${heldList.length ? ` <span class="pill warn">${heldList.length}</span>` : ""}</h3>
      <p>Money from Safe payments, kept until the customer has the item. Call the customer, ask if they received it, then release. ${tot ? `Held now: <b class="num">${esc(tot)}</b>` : ""}</p></div></div>
      <div class="people">${heldList.length ? heldList.map(o => `<div class="person ${o.buyer_ok ? "to-review" : ""}"><div class="person-top">${faceAvatar(o.buyer_id, o.buyer_name, o.buyer_face)}
        <div class="t"><b><span data-no-i18n>${esc(o.buyer_name)}</span> · ${money(o.paid_amount, o.cur)}</b><small>${new Date(o.updated_at).toLocaleString()}</small></div>
        <span class="pill ${o.buyer_ok ? "ok" : ""}">${o.buyer_ok ? "Customer says received" : o.status === "delivered" ? "Delivered" : "Paid"}</span></div>
        ${safeFacts(o)}
        <div class="person-actions"><a class="btn btn-ghost" href="tel:+252${esc(o.buyer_phone)}">${ICON_CALL}Call +252 ${esc(o.buyer_phone)}</a>
          <button class="btn btn-primary" data-release="${esc(o.id)}">Release</button></div></div>`).join("")
        : `<div class="empty">Nothing is held right now.</div>`}</div><span class="status-msg" id="st-held"></span></div>`;
  }
  function bindHeldPanel() {
    const el = document.getElementById("held-panel"); if (!el) return;
    el.querySelectorAll("[data-release]").forEach(b => b.onclick = async () => {
      const o = heldList.find(x => x.id === b.dataset.release); if (!o) return;
      if (!confirm(`Release ${money(o.total, o.cur)} for ${o.product_name}? Do this only after the customer told you they received it.`)) return;
      b.disabled = true;
      try { await api(`/api/super/held/${o.id}/release`, { body: {} }); heldList = null; await safeRefresh(); msg("#st-held", "Released. The seller and the earner have the money in their wallets.", "ok"); }
      catch (e) { b.disabled = false; msg("#st-held", e.message, "bad"); }
    });
  }
  function safePanel() {
    const pend = safeTab === "pending", c = spCfg?.codes || {}, own = safeHost ? spOwn : null;
    return `<div class="panel" id="safe-panel"><div class="panel-head"><div><h3>Safe payments${safeList.length && pend ? ` <span class="pill warn">${safeList.length}</span>` : ""}</h3><p>${own
      ? `When a buyer chooses Safe payment for a <span data-no-i18n>${esc(own.name || "")}</span> item, the whole amount (the seller's price plus the charge) comes to your numbers below. Check you received it, then confirm. Keep it until the customer has the item, then release it in Held safely: the seller gets their price minus the earning, and the earning goes to the buyer or to the person who shared the link.`
      : "Buyers pay the item price plus the charge by USSD: to the admin of that part (Suuq, Technician…) when that admin set their numbers, otherwise to the main money processor. Check the money arrived, then confirm. It is held until the customer has the item, then released from Held safely."}</p></div></div>
        <div class="agent-tabs" role="group"><button data-spt="pending" aria-pressed="${pend}">Pending</button><button data-spt="done" aria-pressed="${!pend}">Done</button></div>
        <div class="people">${safeList.length ? safeList.map(o => `<div class="person"><div class="person-top">${faceAvatar(o.buyer_id, o.buyer_name, o.buyer_face)}
          <div class="t"><b><span data-no-i18n>${esc(o.buyer_name)}</span> · ${money(o.paid_amount, o.cur)}</b><small>Dialled <span class="num">${esc(o.pay_ussd)}</span> · ${new Date(o.updated_at).toLocaleString()}</small></div>
          <span class="pill ${statusTone(o.status)}">${esc(orderLabel(o))}</span></div>
          ${safeFacts(o)}
          ${o.status === "awaiting_payment" ? `<div class="person-actions"><button class="btn btn-primary" data-spok="${esc(o.id)}">Money received · confirm</button><button class="btn btn-danger" data-spno="${esc(o.id)}">Not received</button></div>` : ""}</div>`).join("") : `<div class="empty">${pend ? "No safe payments waiting." : "Nothing yet."}</div>`}</div>
        <span class="status-msg" id="st-sp"></span>
        ${own ? `<h3 style="font-size:15px;margin-top:6px">Your numbers for safe payments</h3>
        <div class="grid2">
          <div class="mini"><label for="spo-merchant">Merchant number</label><input class="input" id="spo-merchant" inputmode="tel" value="${esc(own.merchant || "")}" placeholder="e.g. 500123"></div>
          <div class="mini"><label for="spo-number">Phone number</label><input class="input" id="spo-number" inputmode="tel" value="${esc(own.number || "")}" placeholder="634000000"></div></div>
        <p class="note" style="margin:0">${own.merchant || own.number ? "Safe payments for your items come to these numbers." : "Add at least one number. Until then, safe payments for your items go to the main money processor."}</p>
        <div class="row-actions"><button class="btn btn-primary" id="spo-save">Save</button><span class="status-msg" id="st-spo"></span></div></div>` : `
        <h3 style="font-size:15px;margin-top:6px">Main money processor</h3>
        <div class="grid2">
          <div class="mini"><label for="sp-merchant">Merchant number (*223* SLSH, *883* USD)</label><input class="input" id="sp-merchant" inputmode="tel" value="${esc(spCfg?.merchant || "")}" placeholder="e.g. 500123"></div>
          <div class="mini"><label for="sp-number">Normal number (*220* SLSH, *880* USD)</label><input class="input" id="sp-number" inputmode="tel" value="${esc(spCfg?.number || "")}" placeholder="634000000"></div>
          <div class="mini"><label for="sp-c-sm"><span class="cur cur-SLSH">SLSH</span> merchant code</label><input class="input" id="sp-c-sm" value="${esc(c.SLSH?.merchant || "*223*")}"></div>
          <div class="mini"><label for="sp-c-sn"><span class="cur cur-SLSH">SLSH</span> normal code</label><input class="input" id="sp-c-sn" value="${esc(c.SLSH?.normal || "*220*")}"></div>
          <div class="mini"><label for="sp-c-um"><span class="cur cur-USD">USD</span> merchant code</label><input class="input" id="sp-c-um" value="${esc(c.USD?.merchant || "*883*")}"></div>
          <div class="mini"><label for="sp-c-un"><span class="cur cur-USD">USD</span> normal code</label><input class="input" id="sp-c-un" value="${esc(c.USD?.normal || "*880*")}"></div></div>
        <p class="note" style="margin:0">The charge is the iBedel charge for that amount. "Pay to shop" uses the same codes with the merchant's own numbers (the merchant number for *223* / *883*, the shop phone for *220* / *880*).</p>
        <div class="row-actions"><button class="btn btn-primary" id="sp-save">Save</button><span class="status-msg" id="st-spcfg"></span></div></div>`}`;
  }
  function bindSafePanel() {
    const el = document.getElementById("safe-panel"); if (!el) return;
    el.querySelectorAll("[data-spt]").forEach(b => b.onclick = () => { safeTab = b.dataset.spt; safeList = null; safeRefresh(); });
    const decide = async (id, d, b) => { b.disabled = true; try { await api(`/api/super/safepay/${id}/${d}`, { body: {} }); safeList = null; heldList = null; await safeRefresh(); msg("#st-sp", d === "confirm" ? "Confirmed. The order is paid; the seller can deliver now." : "Marked not received.", "ok"); } catch (e) { b.disabled = false; msg("#st-sp", e.message, "bad"); } };
    el.querySelectorAll("[data-spok]").forEach(b => b.onclick = () => decide(b.dataset.spok, "confirm", b));
    el.querySelectorAll("[data-spno]").forEach(b => b.onclick = () => decide(b.dataset.spno, "reject", b));
    const so = document.getElementById("spo-save");
    if (so) so.onclick = async () => {
      so.disabled = true;
      try { const r = await api("/api/admin/safepay-numbers", { method: "PUT", body: { merchant: $("#spo-merchant").value, number: $("#spo-number").value } }); spOwn = { ...spOwn, ...r.own }; await safeRefresh(); msg("#st-spo", "Saved.", "ok"); }
      catch (e) { so.disabled = false; msg("#st-spo", e.message, "bad"); }
    };
    const ss = document.getElementById("sp-save"); if (ss) ss.onclick = async () => {
      try { const r = await api("/api/super/safepay-settings", { method: "PUT", body: { merchant: $("#sp-merchant").value, number: $("#sp-number").value,
        codes: { SLSH: { merchant: $("#sp-c-sm").value, normal: $("#sp-c-sn").value }, USD: { merchant: $("#sp-c-um").value, normal: $("#sp-c-un").value } } } }); spCfg = r.settings; msg("#st-spcfg", "Saved.", "ok"); }
      catch (e) { msg("#st-spcfg", e.message, "bad"); }
    };
  }
  // A part admin's dashboard: the safe payments sent to them, and the money they hold.
  async function renderSafeDesk(el) {
    if (!el) return; safeHost = el;
    if (!safeList) { try { const r = await api("/api/super/safepay?status=" + safeTab); safeList = r.orders; spOwn = r.own || { merchant: "", number: "" }; } catch { safeList = []; } }
    if (!heldList) { try { const r = await api("/api/super/held"); heldList = r.orders; heldTotals = r.totals || {}; } catch { heldList = []; } }
    if (safeHost !== el || !el.isConnected) return;
    el.innerHTML = safePanel() + heldPanel();
    bindSafePanel(); bindHeldPanel();
    // On a phone the tab row scrolls: keep the chosen tab in view.
    document.querySelectorAll(".agent-tabs").forEach(nav => { const t = nav.querySelector('[aria-pressed="true"]'); if (t && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, t.offsetLeft - nav.offsetLeft - 16); });
  }
  async function renderSuperWallets() {
    const el = document.getElementById("sup-wallets"); if (!el) return;
    safeHost = null;
    if (!safeList) { try { const r = await api("/api/super/safepay?status=" + safeTab); safeList = r.orders; spCfg = r.settings; } catch { safeList = []; } }
    if (!heldList) { try { const r = await api("/api/super/held"); heldList = r.orders; heldTotals = r.totals || {}; } catch { heldList = []; } }
    if (!income) { try { income = await api("/api/super/income"); } catch { income = { balances: {}, customerMoney: {}, tx: [] }; } }
    if (!topups) { try { const r = await api("/api/super/topups?status=" + topupsTab); topups = r.topups; tpCfg = r.settings; } catch { topups = []; } }
    const pend = topupsTab === "pending";
    el.innerHTML = `<div class="panel"><div class="panel-head"><div><h3>Top-up requests</h3><p>People send money by USSD, then it appears here. Each one stays pending until you check your account received it and release it. Releasing adds the money to the customer's or seller's wallet; a subscription payment also renews their shop.</p></div></div>
        <div class="agent-tabs" role="group"><button data-tpt="pending" aria-pressed="${pend}">Pending</button><button data-tpt="done" aria-pressed="${!pend}">Done</button></div>
        <div class="people">${topups.length ? topups.map(t => `<div class="person"><div class="person-top"><div class="avatar">${esc((t.name || "?")[0].toUpperCase())}</div>
          <div class="t"><b>${esc(t.name)} · ${money(t.amount, t.cur)}</b> <span class="tag-acct">${t.account_type === "merchant" ? "Seller" : "Customer"}</span><small>+252 ${esc(t.phone)} · ${new Date(t.created_at).toLocaleString()} · Ref ${esc(t.ref)}<br>${t.purpose === "subscription" ? "Suuq subscription payment" : "Wallet top-up"} · dialed <span class="num">${esc(t.ussd || "")}</span></small></div>
          <span class="pill ${t.status === "approved" ? "sent" : t.status === "rejected" ? "susp" : "waiting"}">${t.status === "pending" ? "Pending" : t.status === "approved" ? "Released" : "Rejected"}</span></div>
          ${t.status === "pending" ? `<div class="person-actions"><button class="btn btn-primary" data-tpapprove="${esc(t.id)}">Money received · release to wallet</button><button class="btn btn-danger" data-tpreject="${esc(t.id)}">Not received · reject</button></div>` : (t.note ? `<small class="note">${esc(t.note)}</small>` : "")}</div>`).join("") : `<div class="empty">${pend ? "No pending top-ups." : "Nothing yet."}</div>`}</div>
        <span class="status-msg" id="st-tp"></span></div>
      <div class="panel"><div class="panel-head"><div><h3>Top-up agents and USSD codes</h3><p>Assign the agent number that receives each currency. When someone tops up, their phone dials the code, the agent number and the amount by itself, for example *880*634000000*25# for dollars and *220*634000000*100000# for shillings.</p></div>
          <div class="row-actions"><span class="status-msg" id="st-tpcfg"></span><button class="btn btn-primary" id="tpcfg-save">Save</button></div></div>
        <div class="grid2">
          <div class="mini"><label for="tpcfg-num-usd"><span class="cur cur-USD">USD</span> agent number</label><div class="suffix"><input id="tpcfg-num-usd" inputmode="tel" value="${esc(tpCfg?.numbers?.USD || tpCfg?.number || "")}" placeholder="634000000"></div></div>
          <div class="mini"><label for="tpcfg-usd"><span class="cur cur-USD">USD</span> code</label><div class="suffix"><input id="tpcfg-usd" value="${esc(tpCfg?.ussd?.USD || "")}" placeholder="*880*"></div></div>
          <div class="mini"><label for="tpcfg-num-slsh"><span class="cur cur-SLSH">SLSH</span> agent number</label><div class="suffix"><input id="tpcfg-num-slsh" inputmode="tel" value="${esc(tpCfg?.numbers?.SLSH || tpCfg?.number || "")}" placeholder="634000000"></div></div>
          <div class="mini"><label for="tpcfg-slsh"><span class="cur cur-SLSH">SLSH</span> code</label><div class="suffix"><input id="tpcfg-slsh" value="${esc(tpCfg?.ussd?.SLSH || "")}" placeholder="*220*"></div></div></div>
        <p class="note" style="margin:0" id="tpcfg-preview"></p></div>
      <div class="panel"><div class="panel-head"><div><h3>Top up or withdraw for a person</h3><p>Find the person by phone number. Use this after they pay you or collect cash from you.</p></div></div>
        <div class="inline-form"><input class="input" id="wl-phone" inputmode="tel" placeholder="Phone number, e.g. 63 4123456" value="${esc(found?.user?.phone || "")}"><button class="btn btn-primary" id="wl-find">Find</button></div>
        <span class="status-msg" id="st-wl"></span>
        ${found ? `<div class="leg"><div class="person-top">${faceAvatar(found.user.id, found.user.name, found.user.has_face)}<div class="t"><b>${esc(found.user.name)}</b><small>+252 ${esc(found.user.phone)} · ${esc(found.user.role)}</small></div></div>
          <div class="wal-cards">${CURS.map(c => `<div class="wal-card ${c}"><span class="label">${c}</span><b class="num">${money(found.balances[c], c)}</b></div>`).join("")}</div>
          <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
            <div class="mini"><label for="wl-type">Action</label><select class="input" id="wl-type"><option value="topup">Top up (add)</option><option value="withdraw">Withdraw (take out)</option></select></div>
            <div class="mini"><label for="wl-cur">Currency</label><select class="input" id="wl-cur"><option>USD</option><option>SLSH</option></select></div>
            <div class="mini"><label for="wl-amt">Amount</label><input class="input" id="wl-amt" inputmode="decimal"></div>
            <div class="mini"><label for="wl-note">Note</label><input class="input" id="wl-note" maxlength="120" placeholder="Cash received at office"></div></div>
          <div class="row-actions"><button class="btn btn-primary" id="wl-go">Save</button><span class="status-msg" id="st-wl2"></span></div>
          <div class="hist">${found.tx.map(t => `<div class="hist-item"><div class="t"><b>${esc(t.label)}</b><small>${new Date(t.created_at).toLocaleString()}${t.note ? " · " + esc(t.note) : ""}</small></div><div class="a num" style="color:${t.amount < 0 ? "var(--danger)" : "var(--green)"}">${t.amount < 0 ? "−" : "+"}${money(Math.abs(t.amount), t.cur)}</div></div>`).join("") || `<div class="empty">No activity yet.</div>`}</div></div>` : ""}
      </div>
      <div class="panel"><div class="panel-head"><div><h3>Super admin income</h3><p>Suuq seller subscriptions.</p></div></div>
        <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">${CURS.map(c => `<div class="kpi"><span class="label">Income ${c}</span><b>${money(income.balances[c] || 0, c)}</b></div>`).join("")}
          ${CURS.map(c => `<div class="kpi"><span class="label">In customer wallets ${c}</span><b>${money(income.customerMoney[c] || 0, c)}</b></div>`).join("")}</div>
        <div class="hist">${income.tx.map(t => `<div class="hist-item"><div class="t"><b>${esc(t.label)}</b><small>${new Date(t.created_at).toLocaleString()} · ${esc(t.note)}</small></div><div class="a num" style="color:var(--green)">+${money(t.amount, t.cur)}</div></div>`).join("") || `<div class="empty">No income yet.</div>`}</div></div>`;
    el.insertAdjacentHTML("afterbegin", safePanel()); bindSafePanel();
    el.insertAdjacentHTML("afterbegin", heldPanel()); bindHeldPanel();
    el.querySelectorAll("[data-tpt]").forEach(b => b.onclick = () => { topupsTab = b.dataset.tpt; topups = null; renderSuperWallets(); });
    const decide = async (id, d) => {
      try { const r = await api(`/api/super/topups/${id}/${d}`, { body: {} }); topups = null; income = null; await renderSuperWallets(); msg("#st-tp", d === "approve" ? (r.subscribed ? "Released. Money added and the shop was renewed." : "Released. Money added to the wallet.") : "Rejected.", "ok"); }
      catch (e) { msg("#st-tp", e.message, "bad"); }
    };
    el.querySelectorAll("[data-tpapprove]").forEach(b => b.onclick = () => { b.disabled = true; decide(b.dataset.tpapprove, "approve"); });
    el.querySelectorAll("[data-tpreject]").forEach(b => b.onclick = () => { b.disabled = true; decide(b.dataset.tpreject, "reject"); });
    $("#tpcfg-save").onclick = async () => {
      try { const r = await api("/api/super/wallet-settings", { method: "PUT", body: { number: "", numbers: { USD: $("#tpcfg-num-usd").value, SLSH: $("#tpcfg-num-slsh").value }, ussd: { USD: $("#tpcfg-usd").value, SLSH: $("#tpcfg-slsh").value } } }); tpCfg = r.settings; msg("#st-tpcfg", "Saved. Top-ups dial the new numbers now.", "ok"); }
      catch (e) { msg("#st-tpcfg", e.message, "bad"); }
    };
    const preview = () => {
      const code = (c, n, amt) => { let pre = $(c).value.trim(), num = $(n).value.replace(/\D/g, ""); if (!pre || !num) return "—"; if (!pre.startsWith("*")) pre = "*" + pre; if (!pre.endsWith("*")) pre += "*"; return `${pre}${num}*${amt}#`; };
      $("#tpcfg-preview").innerHTML = `USD: <span class="num">${esc(code("#tpcfg-usd", "#tpcfg-num-usd", 25))}</span> · SLSH: <span class="num">${esc(code("#tpcfg-slsh", "#tpcfg-num-slsh", 100000))}</span>`;
    };
    ["#tpcfg-num-usd", "#tpcfg-usd", "#tpcfg-num-slsh", "#tpcfg-slsh"].forEach(k => $(k).oninput = preview); preview();
    const find = async () => { try { found = await api("/api/super/wallet?phone=" + encodeURIComponent($("#wl-phone").value)); renderSuperWallets(); } catch (e) { found = null; msg("#st-wl", e.message, "bad"); } };
    $("#wl-find").onclick = find; $("#wl-phone").onkeydown = e => { if (e.key === "Enter") find(); };
    const go = document.getElementById("wl-go");
    if (go) go.onclick = async () => {
      try {
        await api("/api/super/wallet/adjust", { body: { user_id: found.user.id, type: $("#wl-type").value, cur: $("#wl-cur").value, amount: $("#wl-amt").value, note: $("#wl-note").value } });
        found = await api("/api/super/wallet?phone=" + encodeURIComponent(found.user.phone)); income = null; await renderSuperWallets(); msg("#st-wl2", "Saved.", "ok");
      } catch (e) { msg("#st-wl2", e.message, "bad"); }
    };
  }

  function onTopup() { Promise.all([loadWallet(), st.shop !== undefined ? loadShop() : null]).then(() => { if (["wallet", "suuq"].includes(S.service) && !st.orderSheet && !st.paySheet && !st.edit && !st.chat && !document.getElementById("pf-full_name")) render(); if (!S.service) render(); else if (document.getElementById("tpi-send")) { for (const x of [st.orderSheet, st.paySheet]) if (x) x.tpAmt = undefined; render(); } }); }
  function reset() {
    Object.assign(st, { tab: "shop", q: "", products: [], product: null, orders: [], chats: [], chat: null, messages: [], wallet: null, aff: null,
      shop: undefined, sell: "report", myProducts: [], sellerOrders: [], edit: null, orderSheet: null, pf: null, editPf: false, admin: null, adminTab: "shops", planDraft: null,
      market: "suuq", visaTab: "visas", visaAdmin: null, paySheet: null, wordDraft: null, flash: "", shopView: null, fromHub: false });
  }
  // Ticket: open the agency's ticket item (ask for the price, then pay), or copy a share link to it.
  // A service run by its admins (Technician, Hotels…): its request item opens like a product; Back returns to the service.
  async function openSvcItem(pid, svcId) { st.fromSvc = svcId; st.tab = "shop"; st.shopView = null; st.chat = null; S.service = "suuq"; await Promise.all([openProduct(pid), loadWallet()]); render(); }
  async function openServiceRequest(svcId) {
    try { const r = await api(`/api/services/${encodeURIComponent(svcId)}/request`); st.fromSvc = svcId; st.tab = "shop"; st.shopView = null; st.chat = null; S.service = "suuq"; await Promise.all([openProduct(r.product_id), loadWallet()]); render(); }
    catch (e) { alert(e.message); }
  }
  async function openTicket(pid) { st.fromTicket = true; st.tab = "shop"; st.shopView = null; st.chat = null; S.service = "suuq"; await Promise.all([openProduct(pid), loadWallet()]); render(); }
  async function shareTicket(pid, btn) { try { const p = (await api("/api/suuq/products/" + encodeURIComponent(pid))).product; await copy(shareLink(pid, p.share_code), btn, "Link copied"); } catch {} }
  const earnLabel = (type, value, cur = "USD") => Number(value) > 0 ? `Earn ${type === "percent" ? value + "%" : money(value, cur)} by sharing` : "";
  // From a push notification: the customer's orders, or the chats list.
  async function openFavProduct(pid) { st.fromFavs = true; st.tab = "shop"; st.shopView = null; st.chat = null; S.service = "suuq"; await Promise.all([openProduct(pid), loadWallet()]); render(); }
  // Technician: add your own service (a product in the Technician market). Opens the product editor in My shop.
  async function newTechProduct() {
    S.service = "suuq"; st.fromSvc = "technician"; st.tab = "sell"; st.sell = "products"; st.product = null; st.chat = null; st.shopView = null;
    await open("suuq"); await loadShop();
    if (st.shop && st.shop.active) await action("newtech"); else render();
  }
  async function openChatById(id) { st.tab = "chats"; st.product = null; st.shopView = null; S.service = "suuq"; S.drawer = false; await open("suuq"); await openChat(id); }
  // Chat with a service (Saba…): Back returns to the service page.
  async function openSvcChat(svcId) {
    try { const r = await api(`/api/services/${encodeURIComponent(svcId)}/chat`, { body: {} }); st.fromSvcChat = svcId; st.tab = "chats"; st.product = null; st.shopView = null; S.service = "suuq"; await openChat(r.chat.id); st.chat = { ...st.chat, with_name: r.chat.with_name, product_name: r.chat.product_name }; render(); }
    catch (e) { alert(e.message); }
  }
  async function openMyOrders() { S.service = "suuq"; S.drawer = false; st.tab = "orders"; st.chat = null; st.product = null; st.shopView = null; await open("suuq"); render(); }
  async function openChats() { S.service = "suuq"; S.drawer = false; st.tab = "chats"; st.chat = null; st.product = null; st.shopView = null; await open("suuq"); render(); }
  async function openTicketChat(chatId) { st.fromTicket = true; st.tab = "chats"; st.product = null; st.shopView = null; S.service = "suuq"; await openChat(chatId); render(); }
  function onEarnings() { if (S.service === "affiliate") loadAff().then(render); else if (!S.service) loadWallet().then(render); }
  return { syncPickBar, catTile, openCategory, CALL, onChatRead, callsOffText, renderSafeDesk, resetSafe() { safeList = null; heldList = null; }, goSafeTab(id) { if (id === "suuq") st.adminTab = "safe"; else if (id === "visa") st.visaTab = "safe"; else if (id === "scholarship") st.scholarTab = "safe"; }, marketReviewPanel, newTechProduct, openChatById, openSvcChat, CHAT: { msgHtml, composerHtml, bindComposer, bindMsgs, callBtn, CI }, openFavProduct, orderLabel, goSellerOrders, openMyOrders, openChats, techPhoto, TECH_ICONS, TECH_CHIPS, TECH_GROUPS, TECH_CATS, openSvcItem, itemsPanel, UNIT_NAME, deskPanel, onDeskOrder, deskName(n) { desk.name = n; }, openServiceRequest, onEarnings, alarm, zoom, bindTikTok, openTicket, shareTicket, earnLabel, renderScholarAdmin, scholarTabs, bindScholarTabs, get scholarTab() { return st.scholarTab || "list"; }, openTicketChat, PLANE, videoEmbed, bindAutoplay, productCard, openShop, onReview, onProduct, renderVisaAdmin, visaTabs, bindVisaTabs, get visaTab() { return st.visaTab; }, onTopup, reset, profileForm, pfCheck, PF_STEPS, pfDraft, keepPf, bindPf, loadCountries, resetPf() { st.pf = null; }, view, bind, open, onChat, onOrder, onWallet, loadWallet, walletChip, renderAdmin, adminTabs, bindAdminTabs,
    get adminTab() { return st.adminTab; }, renderSuperWallets, resetSuper() { income = null; topups = null; safeList = null; heldList = null; }, state: st };
})();
