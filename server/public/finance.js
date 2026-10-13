"use strict";
/* Finance view for the Sarrif admin: revenue (service charges on sent transfers), expenses and profit,
   grouped by day, week or month over a chosen date range. Shared by the demo page and the real app.
   mount(root, {load(fromMs, toMs, fromDate, toDate) -> {revenue:[{at,cur,fee}], expenses:[{id,date,cur,amount,category,note}]},
                addExpense(e), deleteExpense(id), canEdit}) */
(function () {
  const CATS = ["Rent", "Salaries", "Airtime & data", "Transport", "Utilities", "Bank & wallet fees", "Marketing", "Other"];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  // Week starts on Saturday (Somaliland working week).
  const weekStart = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 1) % 7)); };
  const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmt(n, cur) {
    if (!isFinite(n)) n = 0;
    const neg = n < 0 ? "−" : ""; n = Math.abs(n);
    if (cur === "USD") return neg + "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return neg + Math.round(n).toLocaleString("en-US") + " SLSH";
  }
  function short(n, cur) {
    const a = Math.abs(n), p = cur === "USD" ? "$" : "";
    if (a >= 1e6) return p + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
    if (a >= 1e3) return p + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
    return p + (cur === "USD" ? (Math.round(n * 100) / 100) : Math.round(n));
  }
  function niceMax(v) { if (v <= 0) return 1; const e = Math.pow(10, Math.floor(Math.log10(v))); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e; }

  const CSS = `
  .fin{display:flex;flex-direction:column;gap:16px;--rev:#0E7A55;--exp:#8A56D8}
  @media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .fin{--rev:#24A876;--exp:#9A74E8}}
  :root[data-theme="dark"] .fin{--rev:#24A876;--exp:#9A74E8}
  .fin-filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  .fin-seg{display:inline-flex;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:3px}
  .fin-seg button{border:0;background:none;padding:7px 12px;border-radius:9px;font-weight:600;font-size:13.5px;color:var(--ink-2)}
  .fin-seg button[aria-pressed="true"]{background:var(--ink);color:var(--ground)}
  .fin-dates{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:3px 8px}
  .fin-dates input{border:0;background:none;font:inherit;font-size:13.5px;padding:5px 2px;color:var(--ink)}
  .fin-dates span{color:var(--ink-3);font-size:13px}
  .fin-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  @media (max-width:760px){.fin-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .fin-kpi{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
  .fin-kpi b{font-family:var(--display);font-size:21px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .fin-kpi small{color:var(--ink-3);font-size:12px}
  .fin-key{display:inline-flex;align-items:center;gap:6px}
  .fin-key i{width:10px;height:10px;border-radius:3px;display:inline-block}
  .fin-chart{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:14px 14px 8px}
  .fin-chart-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:6px}
  .fin-chart-head b{font-family:var(--display);font-size:15px}
  .fin-legend{display:flex;gap:14px;font-size:13px;color:var(--ink-2)}
  .fin-svg-wrap{overflow-x:auto}
  .fin-svg-wrap svg{display:block;min-width:100%}
  .fin-tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--ground);border-radius:10px;padding:8px 10px;font-size:12.5px;line-height:1.5;white-space:nowrap;transform:translateX(-50%);z-index:3;box-shadow:0 8px 20px -8px rgba(0,0,0,.4)}
  .fin-tip b{font-family:var(--mono)}
  .fin-table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
  .fin-table{border-collapse:collapse;width:100%;min-width:520px;font-size:13.5px}
  .fin-table th,.fin-table td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
  .fin-table th:first-child,.fin-table td:first-child{text-align:left}
  .fin-table thead th{background:var(--surface-2);color:var(--ink-2);font-size:12px;font-weight:600}
  .fin-table tfoot td{font-weight:700;border-bottom:0}
  .fin-table td.neg{color:var(--danger)}
  .fin-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end}
  .fin-form .input{padding:10px 12px;font-size:14.5px}
  .fin-exp-list{display:flex;flex-direction:column;gap:8px}
  .fin-exp{display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:12px;padding:9px 12px;background:var(--surface);flex-wrap:wrap}
  .fin-exp .t{flex:1;min-width:160px}
  .fin-exp .t b{display:block;font-size:14px}
  .fin-exp .t small{color:var(--ink-3);font-size:12.5px}
  .fin-exp .amt{font-family:var(--mono);font-weight:600}
  .fin-exp button{border:1px solid var(--line);background:var(--surface-2);border-radius:9px;padding:5px 10px;font-size:12.5px;font-weight:600;color:var(--ink-2)}
  .fin-empty{color:var(--ink-3);text-align:center;padding:18px;font-size:14px}`;

  function mount(root, api) {
    if (!document.getElementById("fin-css")) { const st = document.createElement("style"); st.id = "fin-css"; st.textContent = CSS; document.head.appendChild(st); }
    const L = { revenueSub: "Service charges on sent transfers", count: "Transfers sent", countCol: "Transfers", ...(api.labels || {}) };
    const today = new Date();
    const st = { preset: "month", from: ymd(monthStart(today)), to: ymd(today), group: "day", cur: api.cur || "SLSH", data: { revenue: [], expenses: [] }, confirmDel: null };

    root.innerHTML = `<div class="fin">
      <div class="fin-filters">
        <div class="fin-seg" role="group" aria-label="Date range">
          <button data-preset="today">Today</button><button data-preset="week">This week</button><button data-preset="month">This month</button><button data-preset="custom">Custom</button>
        </div>
        <label class="fin-dates"><input type="date" id="fin-from" aria-label="From date"><span>to</span><input type="date" id="fin-to" aria-label="To date"></label>
        <div class="fin-seg" role="group" aria-label="Group by"><button data-group="day">Per day</button><button data-group="week">Per week</button><button data-group="month">Per month</button></div>
        <div class="fin-seg" role="group" aria-label="Currency"><button data-fcur="SLSH">SLSH</button><button data-fcur="USD">USD</button></div>
      </div>
      <div class="fin-kpis" id="fin-kpis"></div>
      <div class="fin-chart"><div class="fin-chart-head"><b id="fin-chart-title">Revenue and expenses</b>
        <div class="fin-legend"><span class="fin-key"><i style="background:var(--rev)"></i>Revenue</span><span class="fin-key"><i style="background:var(--exp)"></i>Expenses</span></div></div>
        <div class="fin-svg-wrap" id="fin-svg"></div><div class="fin-tip" id="fin-tip" hidden></div></div>
      <div class="fin-table-wrap"><table class="fin-table" id="fin-table"></table></div>
      <div class="panel">
        <div class="panel-head"><div><h3>Add an expense</h3><p>Record money the business spends. It is taken off revenue to show profit.</p></div></div>
        <div class="fin-form">
          <div class="mini"><label for="fx-date">Date</label><input class="input" type="date" id="fx-date"></div>
          <div class="mini"><label for="fx-cat">Category</label><select class="input" id="fx-cat">${CATS.map(c => `<option>${c}</option>`).join("")}</select></div>
          <div class="mini"><label for="fx-note">Description</label><input class="input" id="fx-note" maxlength="120" placeholder="Office rent for September"></div>
          <div class="mini"><label for="fx-cur">Currency</label><select class="input" id="fx-cur"><option>SLSH</option><option>USD</option></select></div>
          <div class="mini"><label for="fx-amt">Amount</label><input class="input" id="fx-amt" inputmode="decimal" placeholder="0"></div>
          <div class="mini"><button class="btn btn-primary" id="fx-add" style="min-height:44px">Add expense</button></div>
        </div>
        <span class="status-msg" id="fx-msg"></span>
      </div>
      <div class="panel">
        <div class="panel-head"><div><h3 id="fin-exp-title">Expenses in this period</h3></div></div>
        <div class="fin-exp-list" id="fin-exp-list"></div>
      </div>
    </div>`;
    const $ = s => root.querySelector(s);
    $("#fx-date").value = ymd(today);

    function setPreset(p) {
      st.preset = p; const t = new Date();
      if (p === "today") { st.from = st.to = ymd(t); st.group = "day"; }
      if (p === "week") { st.from = ymd(weekStart(t)); st.to = ymd(t); st.group = "day"; }
      if (p === "month") { st.from = ymd(monthStart(t)); st.to = ymd(t); st.group = "day"; }
      load();
    }
    root.querySelectorAll("[data-preset]").forEach(b => b.onclick = () => { if (b.dataset.preset === "custom") { st.preset = "custom"; paint(); $("#fin-from").focus(); } else setPreset(b.dataset.preset); });
    root.querySelectorAll("[data-group]").forEach(b => b.onclick = () => { st.group = b.dataset.group; paint(); });
    root.querySelectorAll("[data-fcur]").forEach(b => b.onclick = () => { st.cur = b.dataset.fcur; $("#fx-cur").value = st.cur; paint(); });
    const onDate = () => {
      let f = $("#fin-from").value, t = $("#fin-to").value; if (!f || !t) return;
      if (f > t) [f, t] = [t, f];
      st.from = f; st.to = t; st.preset = "custom"; load();
    };
    $("#fin-from").onchange = onDate; $("#fin-to").onchange = onDate;

    $("#fx-add").onclick = async () => {
      const amt = parseFloat(String($("#fx-amt").value).replace(/,/g, "")), date = $("#fx-date").value, cur = $("#fx-cur").value;
      const m = (t, k) => { const el = $("#fx-msg"); el.textContent = t; el.className = "status-msg " + (k || ""); };
      if (!date) return m("Choose the date of the expense.", "bad");
      if (!(amt > 0)) return m("Enter an amount above 0.", "bad");
      const e = { date, cur, amount: cur === "SLSH" ? Math.round(amt) : Math.round(amt * 100) / 100, category: $("#fx-cat").value, note: $("#fx-note").value.trim().slice(0, 120) };
      $("#fx-add").disabled = true;
      try { await api.addExpense(e); $("#fx-amt").value = ""; $("#fx-note").value = ""; m(`Added ${fmt(e.amount, cur)} for ${e.category}.`, "ok"); await load(); }
      catch (err) { m(err.message || "Couldn't save the expense. Try again.", "bad"); }
      $("#fx-add").disabled = false;
    };

    async function load() {
      const f = parseYmd(st.from), t = addDays(parseYmd(st.to), 1);
      try { st.data = await api.load(f.getTime(), t.getTime() - 1, st.from, st.to); } catch { st.data = { revenue: [], expenses: [] }; }
      paint();
    }

    function buckets() {
      const f = parseYmd(st.from), t = parseYmd(st.to), out = [];
      const startOf = st.group === "day" ? d => new Date(d.getFullYear(), d.getMonth(), d.getDate()) : st.group === "week" ? weekStart : monthStart;
      const next = st.group === "day" ? d => addDays(d, 1) : st.group === "week" ? d => addDays(d, 7) : d => new Date(d.getFullYear(), d.getMonth() + 1, 1);
      for (let d = startOf(f); d <= t && out.length < 400; d = next(d)) {
        const s = d, e = next(d);
        const label = st.group === "day" ? `${d.getDate()} ${MON[d.getMonth()]}` : st.group === "week" ? `Week of ${d.getDate()} ${MON[d.getMonth()]}` : `${MON[d.getMonth()]} ${d.getFullYear()}`;
        const tick = st.group === "day" ? `${d.getDate()} ${MON[d.getMonth()]}` : st.group === "week" ? `${d.getDate()} ${MON[d.getMonth()]}` : `${MON[d.getMonth()]}`;
        out.push({ s: s.getTime(), e: e.getTime(), sY: ymd(s), eY: ymd(addDays(e, -1)), label, tick, rev: 0, exp: 0, n: 0 });
      }
      const fromMs = f.getTime(), toMs = addDays(t, 1).getTime();
      for (const r of st.data.revenue) if (r.cur === st.cur && r.at >= fromMs && r.at < toMs) { const b = out.find(b => r.at >= b.s && r.at < b.e); if (b) { b.rev += Number(r.fee) || 0; b.n++; } }
      for (const x of st.data.expenses) if (x.cur === st.cur && x.date >= st.from && x.date <= st.to) { const b = out.find(b => x.date >= b.sY && x.date <= b.eY); if (b) b.exp += Number(x.amount) || 0; }
      return out;
    }

    function paint() {
      root.querySelectorAll("[data-preset]").forEach(b => b.setAttribute("aria-pressed", b.dataset.preset === st.preset));
      root.querySelectorAll("[data-group]").forEach(b => b.setAttribute("aria-pressed", b.dataset.group === st.group));
      root.querySelectorAll("[data-fcur]").forEach(b => b.setAttribute("aria-pressed", b.dataset.fcur === st.cur));
      $("#fin-from").value = st.from; $("#fin-to").value = st.to;
      const B = buckets(), cur = st.cur;
      const rev = B.reduce((a, b) => a + b.rev, 0), exp = B.reduce((a, b) => a + b.exp, 0), n = B.reduce((a, b) => a + b.n, 0), net = rev - exp;
      const rangeTxt = st.from === st.to ? parseYmd(st.from).toDateString() : `${parseYmd(st.from).toDateString()} – ${parseYmd(st.to).toDateString()}`;
      $("#fin-kpis").innerHTML = `
        <div class="fin-kpi"><span class="label fin-key"><i style="background:var(--rev)"></i>Revenue</span><b>${fmt(rev, cur)}</b><small>${esc(L.revenueSub)}</small></div>
        <div class="fin-kpi"><span class="label fin-key"><i style="background:var(--exp)"></i>Expenses</span><b>${fmt(exp, cur)}</b><small>${st.data.expenses.filter(x => x.cur === cur && x.date >= st.from && x.date <= st.to).length} entries</small></div>
        <div class="fin-kpi"><span class="label">Net profit</span><b style="color:${net < 0 ? "var(--danger)" : "var(--green)"}">${fmt(net, cur)}</b><small>${net < 0 ? "Loss for this period" : "Revenue minus expenses"}</small></div>
        <div class="fin-kpi"><span class="label">${esc(L.count)}</span><b>${n.toLocaleString()}</b><small>${esc(rangeTxt)}</small></div>`;
      $("#fin-chart-title").textContent = `Revenue and expenses ${st.group === "day" ? "per day" : st.group === "week" ? "per week" : "per month"} · ${cur}`;
      drawChart(B, cur);
      $("#fin-table").innerHTML = `<thead><tr><th>${st.group === "day" ? "Day" : st.group === "week" ? "Week (from Saturday)" : "Month"}</th><th>${esc(L.countCol)}</th><th>Revenue</th><th>Expenses</th><th>Net profit</th></tr></thead>
        <tbody>${B.slice().reverse().map(b => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${fmt(b.rev, cur)}</td><td>${fmt(b.exp, cur)}</td><td class="${b.rev - b.exp < 0 ? "neg" : ""}">${fmt(b.rev - b.exp, cur)}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${n}</td><td>${fmt(rev, cur)}</td><td>${fmt(exp, cur)}</td><td class="${net < 0 ? "neg" : ""}">${fmt(net, cur)}</td></tr></tfoot>`;
      const ex = st.data.expenses.filter(x => x.date >= st.from && x.date <= st.to).sort((a, b) => b.date.localeCompare(a.date));
      $("#fin-exp-title").textContent = `Expenses in this period (${ex.length})`;
      $("#fin-exp-list").innerHTML = ex.length ? ex.map(x => `<div class="fin-exp"><div class="t"><b>${esc(x.category)}${x.note ? " · " + esc(x.note) : ""}</b><small>${parseYmd(x.date).toDateString()}</small></div>
        <span class="amt">${fmt(x.amount, x.cur)}</span>
        ${api.canEdit ? (st.confirmDel === x.id ? `<button data-delyes="${esc(x.id)}" style="color:var(--danger)">Delete for good</button><button data-delno="1">Keep</button>` : `<button data-del="${esc(x.id)}">Delete</button>`) : ""}</div>`).join("")
        : `<div class="fin-empty">No expenses recorded for these dates.</div>`;
      root.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { st.confirmDel = b.dataset.del; paint(); });
      root.querySelectorAll("[data-delno]").forEach(b => b.onclick = () => { st.confirmDel = null; paint(); });
      root.querySelectorAll("[data-delyes]").forEach(b => b.onclick = async () => { try { await api.deleteExpense(b.dataset.delyes); } catch {} st.confirmDel = null; load(); });
    }

    function drawChart(B, cur) {
      const wrap = $("#fin-svg"), tip = $("#fin-tip");
      const H = 240, padL = 56, padR = 10, padT = 12, padB = 30;
      const avail = (wrap.clientWidth || 600) - padL - padR;
      const slot = Math.max(28, avail / Math.max(1, B.length));
      const W = padL + padR + slot * B.length;
      const max = niceMax(Math.max(1, ...B.map(b => Math.max(b.rev, b.exp))));
      const y = v => padT + (H - padT - padB) * (1 - v / max);
      const bw = Math.max(4, Math.min(28, (slot - 8) / 2.4));
      const every = Math.ceil(B.length / Math.floor((W - padL) / 64));
      let g = "";
      for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); g += `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--ink-3)">${short(v, cur)}</text>`; }
      const bar = (x, v, color) => { if (v <= 0) return ""; const top = y(v), h = y(0) - top, r = Math.min(4, bw / 2, h); return `<path d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z" fill="${color}"/>`; };
      B.forEach((b, i) => {
        const cx = padL + slot * i + slot / 2;
        g += bar(cx - bw - 1, b.rev, "var(--rev)") + bar(cx + 1, b.exp, "var(--exp)");
        if (i % every === 0) g += `<text x="${cx}" y="${H - 10}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${esc(b.tick)}</text>`;
        g += `<rect data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>`;
      });
      g += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--ink-3)" stroke-width="1"/>`;
      const empty = B.every(b => !b.rev && !b.exp);
      wrap.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue and expenses chart">${g}${empty ? `<text x="${(W + padL) / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--ink-3)">No revenue or expenses in ${cur} for these dates</text>` : ""}</svg>`;
      wrap.querySelectorAll("rect[data-i]").forEach(r => {
        r.onmouseenter = r.onclick = () => {
          const b = B[+r.dataset.i], box = wrap.getBoundingClientRect(), rb = r.getBoundingClientRect(), pb = wrap.parentElement.getBoundingClientRect();
          tip.hidden = false;
          tip.innerHTML = `${esc(b.label)}<br>Revenue <b>${fmt(b.rev, cur)}</b><br>Expenses <b>${fmt(b.exp, cur)}</b><br>Net <b>${fmt(b.rev - b.exp, cur)}</b>`;
          tip.style.left = Math.min(Math.max(rb.left + rb.width / 2 - pb.left, 90), pb.width - 90) + "px";
          tip.style.top = (box.top - pb.top + 16) + "px";
          r.setAttribute("fill", "rgba(127,127,127,.08)");
        };
        r.onmouseleave = () => { tip.hidden = true; r.setAttribute("fill", "transparent"); };
      });
    }

    let rs = null; window.addEventListener("resize", () => { clearTimeout(rs); rs = setTimeout(paint, 150); });
    setPreset("month");
    return { reload: load };
  }
  window.SarrifFinance = { mount };
})();
