import { CONFIG, CURRENCY } from './config.js';

/** "Rs 1,250" — two decimals only when the amount actually has paisa. */
export function money(value, opts = {}) {
  const { showSign = false, decimals = null } = opts;
  const n = Number(value);
  const v = !Number.isFinite(n) || Math.abs(n) < 0.005 ? 0 : n;
  const abs = Math.abs(v);
  const d = decimals !== null ? decimals : Math.round(abs * 100) % 100 === 0 ? 0 : 2;
  const text = abs.toLocaleString('en-PK', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = v < 0 ? '-' : showSign && v > 0 ? '+' : '';
  return `${sign}${CURRENCY} ${text}`;
}

/** Plain short money for messages: "Rs 1,250.5". */
export function rs(value) {
  return 'Rs ' + (Number(value) || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 });
}

export function num(value, decimals = 0) {
  return (Number(value) || 0).toLocaleString('en-PK', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** A quantity with only the decimals it needs: 12, 2.5, 0.25. */
export function qty(value) {
  const v = r2(value);
  const d = Number.isInteger(v) ? 0 : Math.round(v * 10) === v * 10 ? 1 : 2;
  return num(v, d);
}

/** Round to paisa. */
export function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function today() {
  return isoDate(new Date());
}

export function isoDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date)) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d)
    ? String(v)
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d)
    ? String(v)
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Whole days from `from` to `to` (positive when `from` is in the past). */
export function daysBetween(from, to = new Date()) {
  const a = new Date(from);
  const b = new Date(to);
  if (isNaN(a) || isNaN(b)) return 0;
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 864e5);
}

export function daysSince(v) {
  return v ? daysBetween(v, new Date()) : 0;
}

export function addDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + Number(days || 0));
  return isoDate(d);
}

export function ageBucket(days) {
  return days <= 7 ? '0-7' : days <= 30 ? '8-30' : '30+';
}

export const BUCKETS = ['0-7', '8-30', '30+'];
export const BUCKET_META = {
  '0-7': { label: '0–7 days', cls: 'age-0', mcls: 'due-0', tone: 'warning', color: '#F59E0B' },
  '8-30': { label: '8–30 days', cls: 'age-8', mcls: 'due-8', tone: 'warning', color: '#EA580C' },
  '30+': { label: '30+ days', cls: 'age-30', mcls: 'due-30', tone: 'danger', color: '#DC2626' },
};

/** Round a bill total by the shop's rounding rule (Settings → Billing Rules). */
export function applyRounding(amount, rule = 'nearest1') {
  const v = r2(amount);
  switch (rule) {
    case 'exact': return v;
    case 'nearest1': return Math.round(v);
    case 'nearest5': return Math.round(v / 5) * 5;
    case 'nearest10': return Math.round(v / 10) * 10;
    default: return Math.round(v);
  }
}

export const ROUNDING_OPTIONS = [
  { value: 'exact', label: 'Exact (no rounding)' },
  { value: 'nearest1', label: 'Nearest 1 Rupee' },
  { value: 'nearest5', label: 'Nearest 5 Rupees' },
  { value: 'nearest10', label: 'Nearest 10 Rupees' },
];

/** Percentage change from `prev` to `curr`. */
export function pctChange(curr, prev) {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return ((c - p) / Math.abs(p)) * 100;
}

export function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

/** Case- and space-insensitive key for duplicate-name checks. */
export function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Pakistani mobile numbers in any spelling reduced to 03xxxxxxxxx. */
export function phoneKey(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (/^92\d{10}$/.test(d)) d = '0' + d.slice(2);
  if (/^3\d{9}$/.test(d)) d = '0' + d;
  return d;
}

export function whatsappUrl(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const intl = digits.startsWith('0')
    ? '92' + digits.slice(1)
    : /^3\d{9}$/.test(digits) ? '92' + digits : digits;
  return `${intl ? `https://wa.me/${intl}` : 'https://wa.me/'}?text=${encodeURIComponent(text || '')}`;
}

export function shareUrl(token) {
  if (!token) return '';
  const base = String(CONFIG.publicUrl).replace(/\/+$/, '');
  return base
    ? `${base}/#/share/${token}`
    : `${window.location.origin}${window.location.pathname}#/share/${token}`;
}

/** Ids are `prefix_<base36 time><5 random>`. */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Quantities grouped by unit: "12 Piece + 3 Carton". */
export function qtyByUnit(lines = []) {
  const byUnit = new Map();
  lines.forEach((l) => {
    const q = Number(l?.qty) || 0;
    if (!q) return;
    const unit = String(l?.unit || '').trim();
    byUnit.set(unit, (byUnit.get(unit) || 0) + q);
  });
  return [...byUnit.entries()].map(([unit, total]) => ({
    unit,
    qty: r2(total),
    label: `${qty(total)}${unit ? ` ${unit}` : ''}`,
  }));
}

export function qtySummary(lines = []) {
  const parts = qtyByUnit(lines);
  return parts.length ? parts.map((p) => p.label).join(' + ') : '';
}

/** YYYY-MM-DD from any date shape, or '' if it is not one. */
export function dayOf(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return isoDate(d);
}

/** Date range for a preset: today / week / month / lastMonth / all / custom. */
export function rangeFor(preset, custom = {}) {
  const now = new Date();
  const from = new Date(now);
  const to = new Date(now);
  switch (preset) {
    case 'today':
      break;
    case 'week':
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
      break;
    case 'month':
      from.setDate(1);
      break;
    case 'lastMonth':
      from.setMonth(from.getMonth() - 1, 1);
      to.setDate(0);
      break;
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'custom':
      return { from: custom.from || null, to: custom.to || null, label: 'Custom' };
    default:
      break;
  }
  return { from: isoDate(from), to: isoDate(to), label: preset };
}

export function inRange(date, from, to) {
  const d = new Date(date);
  return !(isNaN(d) || (from && d < new Date(from)) || (to && d > new Date(to + 'T23:59:59')));
}

export function rangeLabel(preset, range) {
  if (preset === 'all') return 'all time';
  if (preset === 'today') return 'today';
  if (preset === 'week') return 'this week';
  if (preset === 'month') return 'this month';
  return range.from && range.to ? `${fmtDate(range.from)} — ${fmtDate(range.to)}` : 'a custom range';
}
