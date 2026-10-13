"use strict";
/* Illustrated backgrounds for the service tiles on the customer home page. Each is a small inline SVG. */
(function () {
  const W = 'viewBox="0 0 200 110" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"';
  const note = (x, y, r, c1, c2, label) => `<g transform="translate(${x} ${y}) rotate(${r})">
    <rect x="0" y="0" width="84" height="42" rx="4" fill="${c1}"/><rect x="4" y="4" width="76" height="34" rx="2" fill="none" stroke="${c2}" stroke-width="1.5"/>
    <circle cx="42" cy="21" r="10" fill="${c2}" opacity=".85"/><text x="42" y="25" text-anchor="middle" font-family="Sora,sans-serif" font-weight="700" font-size="11" fill="${c1}">${label}</text>
    <text x="9" y="15" font-family="Sora,sans-serif" font-weight="700" font-size="8" fill="${c2}">${label}</text><text x="75" y="34" text-anchor="end" font-family="Sora,sans-serif" font-weight="700" font-size="8" fill="${c2}">${label}</text></g>`;
  const coin = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#E9B949"/><circle cx="${x}" cy="${y}" r="${r * .72}" fill="none" stroke="#B8861B" stroke-width="1.4"/>`;
  const ART = {
    money: `<svg ${W}><defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B6B4A"/><stop offset="1" stop-color="#138A61"/></linearGradient></defs>
      <rect width="200" height="110" fill="url(#gm)"/>
      <circle cx="170" cy="10" r="46" fill="#fff" opacity=".06"/><circle cx="20" cy="110" r="40" fill="#fff" opacity=".05"/>
      ${note(92, 18, -12, "#CFEBD9", "#2E7D57", "$")}${note(104, 44, 8, "#F3E3B5", "#9A6B12", "S")}${note(60, 52, -4, "#D8F0E3", "#1F6E4B", "$")}
      ${coin(40, 34, 11)}${coin(54, 24, 8)}${coin(28, 50, 7)}</svg>`,
    electronics: `<svg ${W}><defs><linearGradient id="ge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6B24A"/><stop offset="1" stop-color="#E68A2E"/></linearGradient></defs>
      <rect width="200" height="110" fill="url(#ge)"/><circle cx="30" cy="10" r="40" fill="#fff" opacity=".12"/>
      <g transform="translate(78 26)"><rect x="0" y="0" width="86" height="54" rx="5" fill="#1E2430"/><rect x="5" y="5" width="76" height="44" rx="2" fill="#4FA3E3"/>
        <path d="M5 40 L30 22 L48 34 L60 26 L81 42 V49 H5Z" fill="#2D6FB0"/><path d="M-10 54 H96 L90 62 H-4Z" fill="#C9CED6"/></g>
      <g transform="translate(150 40) rotate(10)"><rect x="0" y="0" width="30" height="56" rx="6" fill="#1E2430"/><rect x="3" y="6" width="24" height="42" rx="2" fill="#FFD27A"/><circle cx="15" cy="52" r="1.8" fill="#8A93A3"/></g>
      <g transform="translate(22 40)" fill="none" stroke="#1E2430" stroke-width="5" stroke-linecap="round"><path d="M4 30 V20 A20 20 0 0 1 44 20 V30"/></g>
      <rect x="20" y="62" width="12" height="20" rx="5" fill="#1E2430"/><rect x="60" y="62" width="12" height="20" rx="5" fill="#1E2430"/></svg>`,
    travel: `<svg ${W}><defs><linearGradient id="gt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3C7BD9"/><stop offset="1" stop-color="#7CB5F2"/></linearGradient></defs>
      <rect width="200" height="110" fill="url(#gt)"/>
      <g fill="#fff" opacity=".85"><ellipse cx="40" cy="80" rx="26" ry="9"/><ellipse cx="58" cy="74" rx="16" ry="10"/><ellipse cx="160" cy="30" rx="20" ry="7"/><ellipse cx="172" cy="25" rx="11" ry="7"/></g>
      <path d="M20 70 Q90 20 170 50" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="4 5" opacity=".8"/>
      <g transform="translate(120 34) rotate(-18)"><path d="M0 8 L44 4 Q52 4 52 8 Q52 12 44 12 L0 8Z" fill="#fff"/><path d="M20 7 L8 -12 L15 -12 L32 6Z" fill="#E8EEF7"/><path d="M20 9 L8 28 L15 28 L32 10Z" fill="#E8EEF7"/><path d="M2 8 L-4 0 L2 0 L8 7Z" fill="#E8EEF7"/></g>
      <g transform="translate(70 56) rotate(-6)"><rect width="38" height="50" rx="4" fill="#123B6E"/><circle cx="19" cy="20" r="8" fill="none" stroke="#E9B949" stroke-width="1.6"/><path d="M11 20 H27 M19 12 V28" stroke="#E9B949" stroke-width="1.2"/><rect x="9" y="34" width="20" height="2.5" rx="1" fill="#E9B949"/></g></svg>`,
    visa: `<svg ${W}><defs><linearGradient id="gv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F4C5C"/><stop offset="1" stop-color="#1B7F8C"/></linearGradient></defs>
      <rect width="200" height="110" fill="url(#gv)"/><circle cx="178" cy="12" r="38" fill="#fff" opacity=".07"/>
      <g transform="translate(40 18) rotate(-8)"><rect width="62" height="82" rx="6" fill="#7A1F2B"/><circle cx="31" cy="32" r="13" fill="none" stroke="#E9C46A" stroke-width="2"/><path d="M18 32 H44 M31 19 V45 M21 24 Q31 32 21 40 M41 24 Q31 32 41 40" stroke="#E9C46A" stroke-width="1.4" fill="none"/><rect x="14" y="56" width="34" height="3" rx="1.5" fill="#E9C46A"/><rect x="19" y="63" width="24" height="2.5" rx="1.2" fill="#E9C46A" opacity=".8"/></g>
      <g transform="translate(96 26) rotate(6)"><rect width="78" height="56" rx="5" fill="#F4F1E6"/><rect x="6" y="8" width="20" height="24" rx="2" fill="#C9D6E3"/><circle cx="16" cy="17" r="4.5" fill="#8BA3B8"/><path d="M9 29 Q16 21 23 29" fill="#8BA3B8"/>
        <rect x="32" y="9" width="38" height="3" rx="1.5" fill="#9AA5B1"/><rect x="32" y="16" width="30" height="3" rx="1.5" fill="#9AA5B1"/><rect x="32" y="23" width="34" height="3" rx="1.5" fill="#9AA5B1"/>
        <text x="39" y="49" text-anchor="middle" font-family="Sora,sans-serif" font-weight="700" font-size="12" fill="#1B7F8C">VISA</text></g>
      <g transform="translate(150 70) rotate(-14)" opacity=".92"><circle r="17" fill="none" stroke="#E4574B" stroke-width="2.4"/><circle r="12" fill="none" stroke="#E4574B" stroke-width="1.2"/><text y="3.5" text-anchor="middle" font-family="Sora,sans-serif" font-weight="700" font-size="8" fill="#E4574B">OK</text></g></svg>`,
    education: `<svg ${W}><defs><linearGradient id="gs" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6A45B8"/><stop offset="1" stop-color="#9168D9"/></linearGradient></defs>
      <rect width="200" height="110" fill="url(#gs)"/><circle cx="175" cy="95" r="44" fill="#fff" opacity=".08"/>
      <g transform="translate(30 60)"><rect x="0" y="22" width="70" height="12" rx="2" fill="#F2C14E"/><rect x="6" y="10" width="64" height="12" rx="2" fill="#E8EEF7"/><rect x="-2" y="-2" width="66" height="12" rx="2" fill="#4FC3A1"/></g>
      <g transform="translate(110 20)"><path d="M0 22 L40 6 L80 22 L40 38Z" fill="#1E1B2E"/><path d="M18 30 V44 Q40 56 62 44 V30 L40 38Z" fill="#2B2640"/><path d="M76 23 V44" stroke="#F2C14E" stroke-width="2"/><circle cx="76" cy="46" r="3.5" fill="#F2C14E"/></g></svg>`,
    food: `<svg ${W}><rect width="200" height="110" fill="#E8553D"/><circle cx="100" cy="62" r="34" fill="#fff"/><circle cx="100" cy="62" r="24" fill="#F6D7A7"/><circle cx="92" cy="56" r="5" fill="#E8553D"/><circle cx="108" cy="66" r="5" fill="#4FA35B"/><circle cx="100" cy="70" r="4" fill="#E8553D"/><path d="M50 30 V94 M44 30 V46 Q50 52 56 46 V30" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M150 30 Q160 50 150 62 V94" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`,
    health: `<svg ${W}><rect width="200" height="110" fill="#2FA38E"/><circle cx="100" cy="55" r="34" fill="#fff" opacity=".95"/><path d="M92 36 H108 V47 H119 V63 H108 V74 H92 V63 H81 V47 H92Z" fill="#E4574B"/><circle cx="30" cy="20" r="18" fill="#fff" opacity=".1"/><circle cx="175" cy="95" r="26" fill="#fff" opacity=".1"/></svg>`,
    shop: `<svg ${W}><rect width="200" height="110" fill="#D9487A"/><g transform="translate(62 28)"><path d="M6 14 H70 L64 70 H12Z" fill="#fff"/><path d="M24 14 V8 A14 14 0 0 1 52 8 V14" fill="none" stroke="#fff" stroke-width="4"/><circle cx="38" cy="42" r="10" fill="#D9487A"/></g><circle cx="170" cy="20" r="22" fill="#fff" opacity=".1"/></svg>`,
    car: `<svg ${W}><rect width="200" height="110" fill="#3D4A5C"/><rect y="84" width="200" height="26" fill="#2A3240"/><path d="M0 97 H200" stroke="#F2C14E" stroke-width="2" stroke-dasharray="12 10"/><g transform="translate(50 42)"><path d="M0 30 Q2 18 16 16 L30 2 H70 L86 16 Q100 18 100 30 V40 H0Z" fill="#F2C14E"/><path d="M34 6 H52 V16 H24Z M56 6 H68 L80 16 H56Z" fill="#BFE0F5"/><circle cx="22" cy="40" r="9" fill="#1E2430"/><circle cx="78" cy="40" r="9" fill="#1E2430"/></g></svg>`,
    home: `<svg ${W}><rect width="200" height="110" fill="#4F8A5B"/><g transform="translate(60 22)"><path d="M40 0 L82 34 H-2Z" fill="#E4574B"/><rect x="6" y="34" width="68" height="46" fill="#F6E7C8"/><rect x="32" y="50" width="16" height="30" fill="#8B5A2B"/><rect x="12" y="44" width="14" height="12" fill="#BFE0F5"/><rect x="54" y="44" width="14" height="12" fill="#BFE0F5"/></g></svg>`,
    general: `<svg ${W}><rect width="200" height="110" fill="#2F6F86"/><g fill="#fff" opacity=".9"><rect x="64" y="30" width="30" height="30" rx="8"/><rect x="104" y="30" width="30" height="30" rx="8" opacity=".6"/><rect x="64" y="66" width="30" height="30" rx="8" opacity=".6"/><rect x="104" y="66" width="30" height="30" rx="8"/></g></svg>`,
  };
  const LABELS = { money: "Money", electronics: "Electronics", travel: "Travel", visa: "Visa", education: "Education", food: "Food", health: "Health", shop: "Shopping", car: "Cars", home: "Homes", technician: "Technician", hotel: "Hotels", carrent: "Car rent", schoolbus: "School bus", restaurant: "Restaurant", general: "General" };
  // Every copy gets its own gradient ids, so a picture never borrows a gradient from a hidden copy.
  let n = 0;
  // Real photos for the built-in services (public/photos/services). Other services keep their drawing.
  const PHOTOS = new Set(["money", "electronics", "travel", "visa", "education", "technician", "hotel", "carrent", "schoolbus", "restaurant"]);
  // Small round icons drawn over the photo of some services.
  const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    technician: I('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
    hotel: I('<path d="M3 19V6"/><path d="M3 15h18v4"/><path d="M21 15v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="11" r="2"/>'),
    carrent: I('<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3H3z"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/><path d="M5 19v2M19 19v2"/>'),
    restaurant: I('<path d="M5 3v8a2 2 0 0 0 2 2v8M9 3v8a2 2 0 0 1-2 2M7 3v6"/><path d="M17 21V3c-2 1-3 4-3 7s1 4 3 4"/>'),
    schoolbus: I('<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 11h16M9 3v8M15 3v8"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/><path d="M6 18v3M18 18v3"/>'),
  };
  const icon = k => ICONS[k] ? `<span class="art-ic">${ICONS[k]}</span>` : "";
  const safe = u => /^\/media\/svc-[\w-]+\.(jpg|png|webp)$/.test(String(u || ""));
  const art = (k, photo) => { if (safe(photo)) return `<img class="art-photo" src="${photo}" alt="" loading="lazy" decoding="async">`;
    if (PHOTOS.has(k)) return `<img class="art-photo" src="/photos/services/${k}.jpg" alt="" loading="lazy" decoding="async">`;
    const id = "a" + (++n); return (ART[k] || ART.general).replace(/id="(\w+)"/g, `id="$1${id}"`).replace(/url\(#(\w+)\)/g, `url(#$1${id})`); };
  window.SarrifArt = { ART, LABELS, ICONS, art, icon };
})();
