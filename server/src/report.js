"use strict";
// Reports as PDF and Word (.docx) files, with no outside libraries.
// A report: { title, subtitle, kpis: [[label, value]], head: [..], rows: [[..]], foot: [..], expHead: [..], expenses: [[..]] }
// All values are already-formatted text. Both makers return a Uint8Array.

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
function readReport(r) {
  r = r && typeof r === "object" ? r : {};
  const arr = (a, n) => (Array.isArray(a) ? a : []).slice(0, n);
  const row = (a, n) => arr(a, n).map(x => clean(x, 120));
  return {
    title: clean(r.title, 120) || "Report", subtitle: clean(r.subtitle, 200),
    kpis: arr(r.kpis, 8).map(k => [clean(k?.[0], 60), clean(k?.[1], 60)]),
    head: row(r.head, 8), rows: arr(r.rows, 500).map(x => row(x, 8)), foot: row(r.foot, 8),
    expHead: row(r.expHead, 6), expenses: arr(r.expenses, 500).map(x => row(x, 6)),
    footer: clean(r.footer, 120),
  };
}

/* ---------- PDF ---------- */
// Helvetica (built into every PDF reader), A4 portrait. Letters outside Latin-1 become "?".
const W_HELV = { " ": 278, ",": 278, ".": 278, "-": 333, "/": 278, ":": 278, "$": 556, "(": 333, ")": 333, "·": 278, "%": 889 };
function textWidth(s, size, bold) {
  let w = 0;
  for (const ch of s) w += W_HELV[ch] ?? (/[0-9]/.test(ch) ? 556 : /[A-Z]/.test(ch) ? (bold ? 722 : 667) : /[ijlt]/.test(ch) ? 260 : /[mw]/.test(ch) ? 833 : (bold ? 580 : 540));
  return w * size / 1000;
}
const latin = s => String(s).replace(/[−–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, "...").replace(/[^\n\x20-\xff]/g, "?");
const pdfStr = s => "(" + latin(s).replace(/[\\()]/g, c => "\\" + c) + ")";

function makePdf(input) {
  const r = readReport(input);
  const PW = 595, PH = 842, M = 42, pages = [];
  let ops = [], y = PH - M;
  const newPage = () => { if (ops.length) pages.push(ops.join("\n")); ops = []; y = PH - M; };
  const text = (s, x, yy, size, bold, rgb) => ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${rgb || "0.06 0.15 0.14"} rg ${x.toFixed(1)} ${yy.toFixed(1)} Td ${pdfStr(s)} Tj ET`);
  const line = (x1, y1, x2, y2, gray = 0.83) => ops.push(`${gray} G 0.6 w ${x1} ${y1.toFixed(1)} m ${x2} ${y2.toFixed(1)} l S`);
  const fill = (x, yy, w, h, rgb) => ops.push(`${rgb} rg ${x} ${yy.toFixed(1)} ${w} ${h} re f`);
  const need = h => { if (y - h < M) newPage(); };
  const fit = (s, max, size, bold) => { s = latin(s); if (textWidth(s, size, bold) <= max) return s; while (s.length > 1 && textWidth(s + "...", size, bold) > max) s = s.slice(0, -1); return s + "..."; };

  // Title
  text(r.title, M, y - 20, 18, true); y -= 30;
  if (r.subtitle) { text(fit(r.subtitle, PW - 2 * M, 10, false), M, y - 12, 10, false, "0.29 0.38 0.36"); y -= 22; }
  line(M, y, PW - M, y, 0.75); y -= 14;
  // Summary (two per row)
  if (r.kpis.length) {
    const cw = (PW - 2 * M) / 2;
    for (let i = 0; i < r.kpis.length; i += 2) {
      need(40);
      for (let j = 0; j < 2 && i + j < r.kpis.length; j++) {
        const [l, v] = r.kpis[i + j], x = M + j * cw;
        fill(x, y - 36, cw - 8, 34, "0.95 0.97 0.96");
        text(fit(l.toUpperCase(), cw - 24, 7.5, true), x + 8, y - 13, 7.5, true, "0.29 0.38 0.36");
        text(fit(v, cw - 24, 13, true), x + 8, y - 29, 13, true);
      }
      y -= 42;
    }
    y -= 6;
  }
  // A table: first column on the left, the others on the right.
  function table(head, rows, foot) {
    if (!head.length) return;
    const n = head.length, total = PW - 2 * M, first = n > 2 ? total * 0.3 : total * 0.5, other = (total - first) / Math.max(1, n - 1);
    const xs = [M], ws = [first]; for (let i = 1; i < n; i++) { xs.push(M + first + (i - 1) * other); ws.push(other); }
    const cell = (s, i, yy, size, bold, rgb) => {
      const t = fit(s, ws[i] - 10, size, bold);
      if (i === 0) text(t, xs[i] + 5, yy, size, bold, rgb); else text(t, xs[i] + ws[i] - 5 - textWidth(t, size, bold), yy, size, bold, rgb);
    };
    const drawHead = () => { fill(M, y - 18, total, 18, "0.93 0.95 0.94"); head.forEach((h, i) => cell(h, i, y - 12.5, 8, true, "0.29 0.38 0.36")); y -= 18; };
    need(40); drawHead();
    for (const rw of rows) {
      if (y - 17 < M) { newPage(); drawHead(); }
      rw.forEach((v, i) => cell(v, i, y - 12, 9, false, /^[−-]/.test(v) && i > 0 ? "0.70 0.15 0.12" : null)); y -= 17; line(M, y, PW - M, y);
    }
    if (foot.length) { need(20); foot.forEach((v, i) => cell(v, i, y - 13, 9, true)); y -= 20; }
    y -= 12;
  }
  table(r.head, r.rows, r.foot);
  if (r.expenses.length) { need(40); text("Expenses", M, y - 12, 12, true); y -= 22; table(r.expHead, r.expenses, []); }
  newPage();

  // Assemble the file.
  const objs = [];
  const add = s => { objs.push(s); return objs.length; };
  const catalog = add(""), pagesObj = add(""), f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"), f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  pages.forEach((content, i) => {
    const foot = `BT /F1 8 Tf 0.48 0.55 0.53 rg ${M} 22 Td ${pdfStr((r.footer ? r.footer + "   ·   " : "") + `Page ${i + 1} of ${pages.length}`)} Tj ET`;
    const body = latin(content + "\n" + foot);
    const c = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const u = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u[i] = out.charCodeAt(i) & 255;
  return u;
}

/* ---------- Word (.docx) ---------- */
const xml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const run = (t, o = {}) => `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}<w:sz w:val="${o.sz || 20}"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
const para = (t, o = {}) => `<w:p><w:pPr>${o.right ? '<w:jc w:val="right"/>' : ""}<w:spacing w:after="${o.after ?? 80}"/></w:pPr>${run(t, o)}</w:p>`;
function docxTable(head, rows, foot) {
  if (!head.length) return "";
  const n = head.length, total = 9300, first = n > 2 ? 2800 : 4650, other = Math.floor((total - first) / Math.max(1, n - 1));
  const widths = head.map((_, i) => i === 0 ? first : other);
  const tc = (t, i, o = {}) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>${o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : ""}</w:tcPr>${para(t, { right: i > 0, b: o.b, sz: o.sz || 18, color: o.color, after: 0 })}</w:tc>`;
  const tr = (cells, o) => `<w:tr>${cells.map((c, i) => tc(c, i, { ...o, color: o.neg && i > 0 && /^[−-]/.test(c) ? "B3261E" : o.color })).join("")}</w:tr>`;
  const border = s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D5DFDA"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr>
<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>
${tr(head, { b: true, fill: "EEF3F1", color: "4B605B", sz: 16 })}${rows.map(r => tr(r, { neg: true })).join("")}${foot.length ? tr(foot, { b: true, fill: "F3F7F5" }) : ""}</w:tbl>${para("", { after: 120 })}`;
}
function makeDocx(input) {
  const r = readReport(input);
  const body = [
    para(r.title, { b: true, sz: 36, after: 60 }),
    r.subtitle ? para(r.subtitle, { sz: 20, color: "4B605B", after: 200 }) : "",
    ...r.kpis.map(([l, v]) => `<w:p><w:pPr><w:spacing w:after="40"/></w:pPr>${run(l + ":  ", { color: "4B605B", sz: 20 })}${run(v, { b: true, sz: 22 })}</w:p>`),
    para("", { after: 120 }),
    docxTable(r.head, r.rows, r.foot),
    r.expenses.length ? para("Expenses", { b: true, sz: 26, after: 100 }) + docxTable(r.expHead, r.expenses, []) : "",
    r.footer ? para(r.footer, { sz: 16, color: "7A8C87" }) : "",
  ].join("");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1100" w:bottom="1000" w:left="1100" w:header="600" w:footer="600" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml", doc],
  ];
  return zipStore(files.map(([n, t]) => [n, new TextEncoder().encode(t)]));
}

// A ZIP file with the files stored as they are (no compression): enough for a small .docx.
let CRC_T = null;
function crc32(u) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const parts = [], central = []; let off = 0;
  const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const [name, data] of entries) {
    const nb = new TextEncoder().encode(name), crc = crc32(data);
    const common = [...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    const local = new Uint8Array([...u32(0x04034b50), ...common, ...nb]);
    parts.push(local, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off), ...nb]));
    off += local.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(cdSize), ...u32(off), ...u16(0)]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

module.exports = { makePdf, makeDocx };
