"use strict";
/* Languages: Somali, Arabic, English, Amharic, French.
   The app is written in English. This file swaps every English text on screen for the chosen language as the
   screen is drawn: text, placeholders, button labels, messages and error texts from the server. Texts that contain
   names or numbers are matched by patterns ("Earn {0} by sharing"). Country names come from the phone itself.
   The dictionaries are in i18n_data.js (made from public/i18n/*.json). */
(function () {
  const LANGS = [
    { code: "so", name: "Soomaali", dir: "ltr", flag: "somaliland", country: "Somaliland" },
    { code: "ar", name: "العربية", dir: "rtl", flag: "sa", country: "Saudi Arabia" },
    { code: "en", name: "English", dir: "ltr", flag: "us", country: "United States" },
    { code: "am", name: "አማርኛ", dir: "ltr", flag: "et", country: "Ethiopia" },
    { code: "fr", name: "Français", dir: "ltr", flag: "fr", country: "France" },
  ];
  const SHAHADA = "لا إله إلا الله محمد رسول الله";
  // Flags drawn in SVG, so they look the same on every phone (Somaliland has no flag emoji).
  const FLAGS = {
    somaliland: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#fff"/><rect width="30" height="6.67" fill="#008d3f"/><rect y="13.33" width="30" height="6.67" fill="#da1f26"/>
      <text x="15" y="4.6" text-anchor="middle" font-size="2.6" fill="#fff" font-family="sans-serif">${SHAHADA}</text>
      <path d="M15 7.6l.72 2.2h2.3l-1.86 1.36.7 2.2L15 12l-1.86 1.36.7-2.2-1.86-1.36h2.3z" fill="#000"/></svg>`,
    sa: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#006c35"/><text x="15" y="9" text-anchor="middle" font-size="3.4" fill="#fff" font-family="sans-serif">${SHAHADA}</text>
      <path d="M8 13.2h13.5l1.2-.7v1.4l-1.2-.7" stroke="#fff" stroke-width=".9" fill="none"/><rect x="7.4" y="12.4" width="1.2" height="1.6" fill="#fff"/></svg>`,
    us: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#fff"/>${Array.from({ length: 7 }, (_, i) => `<rect y="${i * 20 / 6.5}" width="30" height="${20 / 13}" fill="#b22234"/>`).join("")}
      <rect width="12" height="10.77" fill="#3c3b6e"/>${Array.from({ length: 20 }, (_, i) => `<circle cx="${1.3 + (i % 5) * 2.35 + (Math.floor(i / 5) % 2) * 1.1}" cy="${1.4 + Math.floor(i / 5) * 2.6}" r=".45" fill="#fff"/>`).join("")}</svg>`,
    et: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="6.67" fill="#078930"/><rect y="6.67" width="30" height="6.67" fill="#fcdd09"/><rect y="13.33" width="30" height="6.67" fill="#da121a"/>
      <circle cx="15" cy="10" r="4.4" fill="#0f47af"/><path d="M15 6.9l.9 2.75h2.9l-2.35 1.7.9 2.75L15 12.4l-2.35 1.7.9-2.75-2.35-1.7h2.9z" fill="none" stroke="#fcdd09" stroke-width=".55"/></svg>`,
    fr: `<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="10" height="20" fill="#002395"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ed2939"/></svg>`,
  };
  const KEY = "sarrif.lang";
  let lang = null;
  try { lang = localStorage.getItem(KEY); } catch {}
  if (!LANGS.some(l => l.code === lang)) lang = null;

  // Dictionaries: exact texts, and patterns turned into regular expressions.
  const DATA = window.__I18N || {};
  const DICT = {};
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function dict(code) {
    if (DICT[code]) return DICT[code];
    const d = DATA[code] || { exact: {}, patterns: {} };
    const pats = Object.entries(d.patterns || {}).map(([en, out]) => {
      const re = new RegExp("^" + esc(en).replace(/\\\{(\d+)\\\}/g, "(.+?)") + "$");
      return [re, out];
    }).sort((a, b) => b[0].source.length - a[0].source.length); // longest (most specific) first
    return (DICT[code] = { exact: d.exact || {}, pats });
  }
  // Country names in the chosen language, from the phone's own list (Intl), matched by their English names.
  let EN_REGIONS = null;
  function countryName(name, code) {
    try {
      if (!EN_REGIONS) {
        EN_REGIONS = {};
        const en = new Intl.DisplayNames(["en"], { type: "region" });
        for (let i = 65; i < 91; i++) for (let j = 65; j < 91; j++) { const c = String.fromCharCode(i, j), n = en.of(c); if (n && n !== c) EN_REGIONS[n] = c; }
        Object.assign(EN_REGIONS, { "Türkiye": "TR", "Turkey": "TR", "Côte d'Ivoire": "CI", "Czechia": "CZ", "Congo": "CG", "Democratic Republic of the Congo": "CD", "Myanmar": "MM", "Palestine": "PS", "Vatican City": "VA" });
      }
      const c = EN_REGIONS[name]; if (!c) return null;
      const out = new Intl.DisplayNames([code], { type: "region" }).of(c);
      return out && out !== c ? out : null;
    } catch { return null; }
  }
  const missing = new Set();
  const norm = s => s.replace(/\s+/g, " ").trim();
  // Translates one text (null when there is nothing to change).
  function tr(text, code = lang) {
    if (!code || code === "en") return null;
    const k = norm(text);
    if (!k || !/[A-Za-z]/.test(k)) return null;
    const d = dict(code);
    if (Object.prototype.hasOwnProperty.call(d.exact, k)) return d.exact[k];
    if (k === "Somaliland") return code === "so" ? "Somaliland" : null;
    const fl = k.match(/^((?:[\u{1F1E6}-\u{1F1FF}]{2}|🌍)\s+)(.+)$/u);
    if (fl) { const r = tr(fl[2], code); return r == null ? null : fl[1] + r; }
    const cn = /^[A-Z][\w'’ .()-]+$/.test(k) && k.length < 40 ? countryName(k, code) : null; if (cn) return cn;
    for (const [re, out] of d.pats) {
      const m = k.match(re);
      if (m) return out.replace(/\{(\d+)\}/g, (_, i) => { const v = m[+i + 1] ?? ""; return tr(v, code) ?? v; });
    }
    const lead = k.match(/^([·•—-]\s*)(.+)$/);
    if (lead) { const r = tr(lead[2], code); if (r != null) return lead[1] + r; }
    // Texts made of parts: "Buy · Earn 5% by sharing", "Label: value".
    for (const sep of [" · ", " — ", " | "]) if (k.includes(sep)) {
      const parts = k.split(sep), t = parts.map(p => tr(p, code) ?? p);
      if (t.some((x, i) => x !== parts[i])) return t.join(sep);
    }
    const colon = k.match(/^(.+?):\s*(.*)$/);
    if (colon && colon[1].length < 40) { const a = tr(colon[1], code), b = colon[2] ? (tr(colon[2], code) ?? colon[2]) : ""; if (a) return a + ": " + b; }
    const end = k.match(/^(.*?)([.:!?…›→]+)$/);
    if (end && end[1]) { const a = tr(end[1], code); if (a) return a + end[2]; }
    missing.add(k);
    return null;
  }

  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "CODE", "PRE", "svg", "SVG"]);
  const skipEl = el => !el || SKIP.has(el.nodeName) || (el.closest && el.closest("[data-no-i18n],.num,[contenteditable]"));
  function doText(node) {
    const el = node.parentElement; if (skipEl(el)) return;
    if (node.__tr !== undefined && node.nodeValue === node.__tr) { // ours: re-translate from the English original
      const t = tr(node.__en); const v = t == null ? node.__en : keepSpace(node.__en, t);
      if (v !== node.nodeValue) { node.__tr = v; node.nodeValue = v; }
      return;
    }
    node.__en = node.nodeValue;
    const t = tr(node.__en);
    if (t != null) { const v = keepSpace(node.__en, t); node.__tr = v; node.nodeValue = v; } else node.__tr = undefined;
  }
  const keepSpace = (orig, t) => (orig.match(/^\s*/)[0]) + t + (orig.match(/\s*$/)[0]);
  function doAttrs(el) {
    if (skipEl(el)) return;
    const saved = el.__i18n || (el.__i18n = {});
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      if (saved[a] && cur === saved[a].tr) { const t = tr(saved[a].en); const v = t ?? saved[a].en; if (v !== cur) { saved[a].tr = v; el.setAttribute(a, v); } continue; }
      const t = tr(cur);
      if (t != null) { saved[a] = { en: cur, tr: t }; el.setAttribute(a, t); } else delete saved[a];
    }
  }
  function apply(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 || skipEl(root)) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => n.nodeType === 1 && SKIP.has(n.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  let busy = false;
  const obs = new MutationObserver(list => {
    if (busy || !lang || lang === "en") return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") doAttrs(m.target);
        else m.addedNodes.forEach(apply);
      }
    } finally { busy = false; }
  });
  function setDir() {
    const L = LANGS.find(l => l.code === lang) || LANGS[2];
    document.documentElement.lang = L.code; document.documentElement.dir = L.dir;
  }
  function start() {
    setDir();
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    if (lang && lang !== "en") apply(document.body);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  // Translate a text in code (for alert(), document.title and the like).
  const t = s => tr(s) ?? s;
  window.SarrifI18n = {
    LANGS, FLAGS, t, missing,
    get lang() { return lang; },
    flag: code => FLAGS[(LANGS.find(l => l.code === code) || {}).flag] || "",
    set(code) {
      if (!LANGS.some(l => l.code === code)) return;
      lang = code;
      try { localStorage.setItem(KEY, code); } catch {}
      setDir();
      busy = true; try { apply(document.body); } finally { busy = false; }
      document.dispatchEvent(new CustomEvent("sarrif-lang", { detail: code }));
    },
  };
})();
