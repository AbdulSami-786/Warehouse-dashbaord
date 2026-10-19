// CSV, JSON backup, printable reports, thermal receipts and PDF bills.

import { money, fmtDate, qtySummary } from './format.js';

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Excel runs a cell starting with = + - @ as a formula, so a party or item
  // named "=HYPERLINK(...)" would execute when the export is opened. A leading
  // apostrophe shows it as text. Plain numbers, negatives included, are left alone.
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvText(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeName(s) {
  return String(s || 'export').replace(/[^\w-]+/g, '_');
}

/** Download a CSV that Excel opens with Urdu and Rs signs intact (BOM). */
export function exportCSV(name, headers, rows, meta = []) {
  const out = [];
  meta.forEach((m) => out.push([m]));
  if (meta.length) out.push([]);
  out.push(headers);
  rows.forEach((r) => out.push(r));
  download(`${safeName(name)}_${stamp()}.csv`, '﻿' + csvText(out), 'text/csv;charset=utf-8;');
}

export function exportBackup(data, shopName = 'SGA_Balloon_Merchant') {
  const body = {
    _backup: {
      shop: shopName, generatedAt: new Date().toISOString(), version: 2,
      note: 'Full dataset backup. Keep this file safe — it restores every record.',
    },
    ...data,
  };
  download(`${safeName(shopName)}_FullBackup_${stamp()}.json`, JSON.stringify(body, null, 2), 'application/json');
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1F2937; margin: 28px; font-size: 12.5px; line-height: 1.5;
  }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 18px 0 8px; }
  .muted { color: #6B7280; }
  .head { display: flex; justify-content: space-between; align-items: flex-start;
          border-bottom: 2px solid #1E293B; padding-bottom: 12px; margin-bottom: 16px; }
  .head .right { text-align: right; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  th { background: #F3F4F6; text-align: left; padding: 7px 9px; font-size: 10.5px;
       text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #D1D5DB; }
  td { padding: 7px 9px; border-bottom: 1px solid #F1F3F5; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; border-top: 2px solid #D1D5DB; background: #F9FAFB; }
  .totals { margin-left: auto; width: 290px; }
  .totals td { padding: 5px 9px; }
  .totals tr.grand td { font-size: 15px; font-weight: 700; border-top: 2px solid #1E293B; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px;
          font-size: 10.5px; font-weight: 700; border: 1px solid; }
  .pill-paid    { background:#DCFCE7; color:#15803D; border-color:#BBF7D0; }
  .pill-partial { background:#FEF3C7; color:#B45309; border-color:#FDE68A; }
  .pill-due     { background:#FEE2E2; color:#B91C1C; border-color:#FECACA; }
  .pill-voided  { background:#F3F4F6; color:#6B7280; border-color:#E5E7EB; }
  .sign { display: flex; justify-content: space-between; gap: 30px; margin-top: 60px; }
  .sign div { flex: 1; border-top: 1px solid #1F2937; padding-top: 6px; text-align: center; font-size: 11px; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #E5E7EB;
          font-size: 10.5px; color: #6B7280; text-align: center; }
  @media print { body { margin: 12mm; } .no-print { display: none; } }
`;

/** Open a print window with the given HTML body. */
export function printHTML(title, html, { css = null, width = 900 } = {}) {
  const w = window.open('', '_blank', `width=${width},height=700`);
  if (!w) {
    alert('Please allow pop-ups for this site to print or export PDF.');
    return;
  }
  w.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${css || BASE_CSS}</style>
</head>
<body>${html}
<script>
  window.onload = function () { window.print(); };
<\/script>
</body>
</html>`);
  w.document.close();
}

export const RECEIPT_WIDTHS = [
  { value: 72, label: '80mm paper — standard (72mm print)' },
  { value: 68, label: '80mm paper — slightly narrow (68mm)' },
  { value: 64, label: '80mm paper — portable / mini (64mm)' },
  { value: 48, label: '58mm paper (48mm print)' },
];
const DEFAULT_RECEIPT_MM = 72;

export function receiptWidth(settings = {}) {
  const mm = Number(settings.receiptWidthMm);
  return mm >= 40 && mm <= 80 ? mm : DEFAULT_RECEIPT_MM;
}

function receiptCSS(mm, { pageMm = mm } = {}) {
  const fitted = pageMm === mm;
  const scale = mm / 72;
  const px = (n) => `${Math.max(9, Math.round(n * scale * 2) / 2)}px`;
  const indent = mm < 60 ? 1.5 : 3;
  return `
  * { box-sizing: border-box; }
  @page { size: ${pageMm}mm auto; margin: 0; }
  body {
    /* A monospace stack keeps the money column aligned down the receipt. */
    font-family: "Menlo", "Consolas", "Liberation Mono", monospace;
    color: #000; background: #fff;
    width: ${pageMm}mm; margin: 0; padding: ${fitted ? '0 1.5mm' : '0'};
    font-size: ${px(13)}; line-height: 1.45;
    /* Bold throughout — thermal heads under-burn thin strokes. */
    font-weight: 700;
  }
  .center { text-align: center; }
  .shop { font-size: ${px(18)}; font-weight: 700; letter-spacing: .02em; word-break: break-word; }
  .sub { font-size: ${px(12)}; }
  hr { border: 0; border-top: 1px dashed #000; margin: 7px 0; }
  .kv { display: flex; justify-content: space-between; gap: 6px; }
  .kv .k { flex: 0 0 auto; }
  .kv .v { text-align: right; word-break: break-word; }
  .li { margin: 6px 0; }
  .li .nm { font-weight: 700; }
  .li .calc { display: flex; justify-content: space-between; gap: 4px; padding-left: ${indent}mm; }
  .li .calc span:last-child { white-space: nowrap; }
  .li .dlv { padding-left: ${indent}mm; font-size: ${px(11.5)}; }
  .tot { display: flex; justify-content: space-between; gap: 4px; }
  .tot span:last-child { white-space: nowrap; }
  .tot.grand { font-size: ${px(16)}; font-weight: 700; }
  .tot.due { font-weight: 700; }
  .status { font-weight: 700; letter-spacing: .04em; }
  .foot { font-size: ${px(12)}; margin-top: 6px; }
  ${fitted ? 'body, body * { max-width: 100%; overflow-wrap: anywhere; }' : 'body * { overflow-wrap: anywhere; }'}
  @media print { .no-print { display: none; } }
`;
}

/** A5 PDF of a bill, saved straight to the downloads folder. */
export async function billPDF({ bill, lines, party, payments, settings, state, delivery = null }) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a5' });
  const W = 148;
  const L = 12;
  const R = W - L;
  const BOTTOM = 196;
  let y = 16;
  const font = (size, style = 'normal') => { doc.setFont('helvetica', style); doc.setFontSize(size); };
  const grey = () => doc.setTextColor(110);
  const ink = () => doc.setTextColor(17);
  const n2 = (v) => (Number(v) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const room = (h = 8) => { if (y + h > BOTTOM) { doc.addPage(); y = 16; } };
  const rule = (dashed = false) => {
    room();
    doc.setDrawColor(dashed ? 190 : 150);
    if (dashed && doc.setLineDashPattern) doc.setLineDashPattern([0.7, 0.7], 0);
    doc.setLineWidth(0.2);
    doc.line(L, y, R, y);
    if (dashed && doc.setLineDashPattern) doc.setLineDashPattern([], 0);
    y += 4.5;
  };
  const kv = (k, v, { size = 9.5, style = 'normal', gap = 5 } = {}) => {
    room(gap + 2);
    font(size, style);
    grey();
    doc.text(String(k), L, y);
    ink();
    doc.setFont('helvetica', style === 'normal' ? 'bold' : style);
    doc.text(String(v), R, y, { align: 'right' });
    y += gap;
  };

  font(15, 'bold');
  ink();
  doc.text(String(settings.shopName || 'SGA Balloon Merchant'), W / 2, y, { align: 'center' });
  y += 5.5;
  font(8);
  grey();
  [settings.address, settings.phone].filter(Boolean).forEach((t) => {
    room(4);
    doc.text(String(t), W / 2, y, { align: 'center' });
    y += 3.8;
  });
  y += 2;
  rule();
  kv('Bill', bill.billNo, { style: 'bold' });
  kv('Date', fmtDate(bill.date));
  kv('Party', party?.name || '');
  if (party?.phone) kv('Phone', party.phone);
  if (state.due > 0 && bill.dueDate) kv('Due date', fmtDate(bill.dueDate));
  kv('Status', String(state.status).toUpperCase(), { style: 'bold' });
  if (delivery?.state === 'partial') kv('Delivery', 'PARTLY DELIVERED', { style: 'bold' });
  else if (state.delivery === 'pending') kv('Delivery', 'NOT DELIVERED', { style: 'bold' });
  rule();
  lines.forEach((l, i) => {
    const q = Number(l.qty) || 0;
    const price = Number(l.price) || 0;
    font(9.5, 'bold');
    ink();
    const name = doc.splitTextToSize(`${i + 1}. ${l.itemName || 'Item'}`, R - L);
    room(name.length * 4.2 + 6);
    doc.text(name, L, y);
    y += name.length * 4.2;
    font(9);
    grey();
    doc.text(`${q} ${l.unit || ''} x ${n2(price)}`.trim(), L + 4, y);
    font(9, 'bold');
    ink();
    doc.text(n2(q * price), R, y, { align: 'right' });
    y += 6;
    if (delivery?.state === 'partial' && l.delivered !== undefined && l.delivered < q - 0.0001) {
      font(8.5, 'bold');
      grey();
      doc.text(`Sent ${+Number(l.delivered).toFixed(3)} - PENDING ${+(q - l.delivered).toFixed(3)}`, L + 4, y - 1.5);
      y += 3.5;
    }
  });
  rule();
  kv(`${lines.length} item${lines.length === 1 ? '' : 's'}`, qtySummary(lines) || '');
  rule();
  kv('Subtotal', n2(bill.subtotal));
  if (Number(bill.roundOff) !== 0) kv('Round off', n2(bill.roundOff));
  if (state.returned > 0) kv('Returns', `- ${n2(state.returned)}`);
  y += 1;
  room(12);
  doc.setDrawColor(17);
  doc.setLineWidth(0.5);
  doc.line(L, y, R, y);
  y += 6;
  font(13, 'bold');
  ink();
  doc.text('TOTAL', L, y);
  doc.text(n2(state.net), R, y, { align: 'right' });
  y += 7;
  kv('Paid', n2(state.paid));
  room(10);
  doc.setDrawColor(190);
  doc.setLineWidth(0.2);
  doc.line(L, y, R, y);
  y += 5.5;
  font(11, 'bold');
  ink();
  doc.text('BALANCE DUE', L, y);
  doc.text(n2(state.due), R, y, { align: 'right' });
  y += 7;
  if (payments && payments.length) {
    rule(true);
    font(8, 'bold');
    grey();
    room();
    doc.text('PAYMENTS', L, y);
    y += 4.5;
    payments.forEach((p) => kv(p.method + (p.note ? ` (${p.note})` : ''), n2(p.amount), { size: 9 }));
  }
  y += 3;
  rule(true);
  font(8);
  grey();
  room(8);
  doc.text('Thank you for your business.', W / 2, y, { align: 'center' });
  y += 4;
  const footer = [settings.shopName, settings.phone].filter(Boolean).join(' - ');
  if (footer) doc.text(footer, W / 2, y, { align: 'center' });
  const slug = (s) => String(s || '').replace(/[^\w\d-]+/g, '-').replace(/^-+|-+$/g, '');
  doc.save(`${['Bill', slug(bill.billNo), slug(party?.name)].filter(Boolean).join('-')}.pdf`);
}

/** Thermal receipt for an 80mm / 58mm printer. */
export function printBill({ bill, lines, party, payments, settings, state, delivery = null }) {
  const partial = delivery?.state === 'partial';
  const summary = qtySummary(lines);
  const kv = (k, v, cls = '') => `<div class="kv ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const items = lines.map((l, i) => `
    <div class="li">
      <div class="nm">${i + 1}. ${esc(l.itemName)}</div>
      <div class="calc">
        <span>${esc(l.qty)} ${esc(l.unit)} &times; ${money(l.price)}</span>
        <span>${money(l.qty * l.price)}</span>
      </div>
      ${partial && l.delivered !== undefined && l.delivered < l.qty - 0.0001
        ? `<div class="dlv">Sent ${+Number(l.delivered).toFixed(3)} &middot; PENDING ${+(l.qty - l.delivered).toFixed(3)}</div>` : ''}
    </div>`).join('');
  const pays = payments.length
    ? `<hr/><div class="sub">PAYMENTS</div>
       ${payments.map((p) => kv(esc(p.method) + (p.note ? ` <span class="sub">(${esc(p.note)})</span>` : ''), money(p.amount))).join('')}`
    : '';
  const html = `
    <div class="center">
      <div class="shop">${esc(settings.shopName || 'SGA Balloon Merchant')}</div>
      ${settings.address ? `<div class="sub">${esc(settings.address)}</div>` : ''}
      ${settings.phone ? `<div class="sub">${esc(settings.phone)}</div>` : ''}
    </div>

    <hr/>
    ${kv('Bill', `<strong>${esc(bill.billNo)}</strong>`)}
    ${kv('Date', esc(fmtDate(bill.date)))}
    ${kv('Party', `<strong>${esc(party?.name || '')}</strong>`)}
    ${party?.phone ? kv('Phone', esc(party.phone)) : ''}
    ${state.due > 0 && bill.dueDate ? kv('Due date', esc(fmtDate(bill.dueDate))) : ''}
    ${kv('Status', `<span class="status">${esc(String(state.status).toUpperCase())}</span>`)}
    ${partial ? kv('Delivery', '<span class="status">PARTLY DELIVERED</span>')
      : state.delivery === 'pending' ? kv('Delivery', '<span class="status">NOT DELIVERED</span>') : ''}

    <hr/>
    ${items}
    <hr/>

    ${kv(`${lines.length} item${lines.length === 1 ? '' : 's'}`, summary ? `<strong>${esc(summary)}</strong>` : '')}
    <hr/>

    <div class="tot"><span>Subtotal</span><span>${money(bill.subtotal)}</span></div>
    ${Number(bill.roundOff) !== 0 ? `<div class="tot"><span>Round off</span><span>${money(bill.roundOff, { showSign: true })}</span></div>` : ''}
    ${state.returned > 0 ? `<div class="tot"><span>Returns</span><span>- ${money(state.returned)}</span></div>` : ''}
    <hr/>
    <div class="tot grand"><span>TOTAL</span><span>${money(state.net)}</span></div>
    <div class="tot"><span>Paid</span><span>${money(state.paid)}</span></div>
    <div class="tot due"><span>BALANCE DUE</span><span>${money(state.due)}</span></div>

    ${pays}

    <hr/>
    <div class="center foot">
      Thank you for your business.<br/>
      ${esc(settings.shopName || '')}${settings.phone ? ` · ${esc(settings.phone)}` : ''}
    </div>`;
  printHTML(`Bill ${bill.billNo}`, html, { css: receiptCSS(receiptWidth(settings)), width: 380 });
}

/** A ruler slip that shows which width a thermal printer actually prints. */
export function printWidthTest(settings = {}) {
  const mm = receiptWidth(settings);
  const bars = [44, 48, 52, 56, 60, 64, 68, 72, 76, 80].map((w) => `
    <div style="width:${w}mm;border-right:2.5mm solid #000;margin:3px 0;
                text-align:right;padding-right:1mm;white-space:nowrap">${w}</div>`).join('');
  const sample = `
    <div style="width:${mm}mm;padding:0 1.5mm">
      <div class="li">
        <div class="nm">1. Sample item with a long name to check wrapping</div>
        <div class="calc"><span>1000 Piece &times; ${money(1000)}</span><span>${money(1e6)}</span></div>
      </div>
      <hr/>
      <div class="tot grand"><span>TOTAL</span><span>${money(1e6)}</span></div>
      <div class="tot due"><span>BALANCE DUE</span><span>${money(1e6)}</span></div>
    </div>`;
  const html = `
    <div style="width:${mm}mm;padding:0 1.5mm" class="center">
      <div class="shop">${esc(settings.shopName || 'SGA Balloon Merchant')}</div>
      <div class="sub">Receipt width test</div>
    </div>
    <hr/>
    <div style="width:${mm}mm;padding:0 1.5mm" class="sub">
      The biggest number you can fully read, with its black bar, is your printer's width in mm.
    </div>
    ${bars}
    <hr/>
    <div style="width:${mm}mm;padding:0 1.5mm" class="sub">Sample bill at the current setting (${mm}mm):</div>
    ${sample}
    <hr/>
    <div style="width:${mm}mm;padding:0 1.5mm" class="center foot">
      If the right edge of the total is cut, pick a narrower width in Settings.
    </div>`;
  printHTML('Receipt width test', html, { css: receiptCSS(mm, { pageMm: 80 }), width: 380 });
}

/** A printable table report with the shop's header. */
export function printReport({ title, subtitle, shopName, headers, rows, totals = null, meta = [], footerHtml = '' }) {
  const head = `<tr>${headers.map((h) => `<th class="${h.align === 'r' ? 'r' : ''}">${esc(h.label ?? h)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td class="${headers[i]?.align === 'r' ? 'r' : ''}">${cell(c)}</td>`).join('')}</tr>`).join('');
  const foot = totals
    ? `<tfoot><tr>${totals.map((c, i) => `<td class="${headers[i]?.align === 'r' ? 'r' : ''}">${cell(c)}</td>`).join('')}</tr></tfoot>`
    : '';
  const html = `
    <div class="head">
      <div>
        <h1>${esc(shopName || 'SGA Balloon Merchant')}</h1>
        <div class="muted">${esc(subtitle || '')}</div>
      </div>
      <div class="right">
        <h1>${esc(title)}</h1>
        <div class="muted">Generated ${fmtDate(new Date())}</div>
      </div>
    </div>
    ${meta.length ? `<div class="muted" style="margin-bottom:10px">${meta.map(esc).join(' &nbsp;·&nbsp; ')}</div>` : ''}
    <table><thead>${head}</thead><tbody>${body}</tbody>${foot}</table>
    ${footerHtml}
    <div class="foot">${esc(shopName || '')} — ${esc(title)}</div>`;
  printHTML(title, html);
}

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const RAW = Symbol('rawHTML');

/** Mark a report cell as trusted HTML (a pill, a line break) instead of text. */
export function raw(html) {
  return { [RAW]: String(html ?? '') };
}

function cell(v) {
  if (v == null) return '';
  return typeof v === 'object' && RAW in v ? v[RAW] : esc(v);
}
