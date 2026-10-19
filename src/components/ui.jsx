import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check, Info, Inbox, LoaderCircle, Plus, Search, TriangleAlert, X,
} from 'lucide-react';
import { money, norm } from '../lib/format.js';

const PILL_LABELS = {
  paid: 'Paid', partial: 'Partial', due: 'Due', overdue: 'Overdue', voided: 'Voided',
  pending: 'Pending', cleared: 'Cleared', bounced: 'Bounced', active: 'Active', archived: 'Archived',
  'cheque-pending': 'Cheque Pending', 'not-delivered': 'Not Delivered', delivered: 'Delivered',
  'part-delivered': 'Partly Delivered', received: 'Received', 'not-received': 'Not Received',
  'part-received': 'Partly Received',
};

export function Pill({ status, label, children, className = '' }) {
  const key = String(status || 'neutral').toLowerCase();
  const cls = PILL_LABELS[key] ? `pill-${key}` : 'pill-neutral';
  return (
    <span className={`pill ${cls} ${className}`}>
      <span className="dot" aria-hidden="true" />
      {children || label || PILL_LABELS[key] || status}
    </span>
  );
}

export function Money({ value, showSign = false, className = '', decimals = null }) {
  const n = Number(value) || 0;
  const tone = showSign ? (n > 0 ? 'pos' : n < 0 ? 'neg' : '') : '';
  return <span className={`money ${tone} ${className}`}>{money(n, { showSign, decimals })}</span>;
}

export function Button({ variant = '', size = '', icon: Icon, children, loading = false, className = '', block = false, ...rest }) {
  const cls = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', !children && 'btn-icon', className]
    .filter(Boolean).join(' ');
  return (
    <button className={cls} {...rest} disabled={loading || rest.disabled}>
      {loading ? <LoaderCircle size={15} className="spin" /> : Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, actions, children, tight = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="h2">{title}</h2>}
            {subtitle && <div className="small muted">{subtitle}</div>}
          </div>
          <div className="spacer" />
          {actions}
        </header>
      )}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, icon: Icon, delta, deltaLabel, onClick, tone, note, noteTone, className = '' }) {
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  return (
    <div
      className={`stat ${onClick ? 'clickable' : ''} ${className}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      } : undefined}
    >
      <div className="stat-label">
        {Icon && (
          <span className="ico" style={tone ? { background: `${tone}18`, color: tone } : undefined}>
            <Icon size={14} />
          </span>
        )}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note" style={noteTone ? { color: noteTone } : undefined}>{note}</div>}
      {delta != null && (
        <div className={`stat-delta ${dir}`}>
          {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—'}
          {Math.abs(delta).toFixed(1)}%
          {deltaLabel && <span className="muted">{deltaLabel}</span>}
        </div>
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, onClose, children, footer, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = ref.current?.querySelectorAll(FOCUSABLE);
      if (!els?.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!ref.current?.contains(document.activeElement)) {
      const els = ref.current?.querySelectorAll(FOCUSABLE);
      // Skip the close button so the first field gets focus.
      (els?.[1] || els?.[0])?.focus();
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (before instanceof HTMLElement) before.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2 className="h2">{title}</h2>
          <div className="spacer" />
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Bottom sheet of actions, used on phones. */
export function ActionSheet({ open, title, onClose, items = [] }) {
  if (!open) return null;
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        {items.map((it, i) => (
          <button
            key={i}
            className={`sheet-item ${it.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose?.();
              it.onClick?.();
            }}
          >
            {it.icon && <it.icon size={19} />}
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

export function Field({ label, hint, error, children, className = '', style }) {
  return (
    <div className={`field ${className}`} style={style}>
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <div className="hint">{hint}</div>}
      {error && <div className="err">{error}</div>}
    </div>
  );
}

/** Text input. Number inputs ignore the mouse wheel and arrow keys, so a scroll never changes a price. */
export function Input({ onWheel, onKeyDown, ...props }) {
  const ref = useRef(null);
  const isNumber = props.type === 'number';
  useEffect(() => {
    if (!isNumber) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const stop = (e) => { if (document.activeElement === el) e.preventDefault(); };
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, [isNumber]);
  const keyDown = (e) => {
    if (isNumber && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) e.preventDefault();
    onKeyDown?.(e);
  };
  return (
    <input
      {...(isNumber ? { inputMode: 'decimal' } : null)}
      {...props}
      ref={ref}
      className={`input ${props.className || ''}`}
      onKeyDown={keyDown}
      onWheel={onWheel}
    />
  );
}

export function Select({ options = [], children, className = '', ...rest }) {
  return (
    <select className={`select ${className}`.trim()} {...rest}>
      {children || options.map((o) => (typeof o === 'string'
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}

export function Textarea(props) {
  return <textarea className="textarea" {...props} />;
}

/** Search-as-you-type picker with keyboard navigation and "Add new". */
export function Typeahead({
  items = [], value = null, onChange, getLabel = (x) => x.name, getSub = () => '', placeholder = 'Search…',
  onAddNew, addNewLabel = 'Add new', autoFocus = false, disabled = false, focusRef = null,
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const wrap = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    if (!focusRef) return undefined;
    focusRef.current = input.current;
    return () => {
      if (focusRef.current === input.current) focusRef.current = null;
    };
  });

  const selected = value ? items.find((x) => x.id === value) : null;
  const matches = useMemo(() => {
    const s = norm(q);
    return s
      ? items.filter((x) => norm(getLabel(x)).includes(s) || norm(getSub(x)).includes(s)).slice(0, 50)
      : items.slice(0, 50);
  }, [q, items, getLabel, getSub]);

  useEffect(() => { setHl(0); }, [q]);
  useEffect(() => {
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const pick = useCallback((x) => {
    onChange?.(x.id, x);
    setQ('');
    setOpen(false);
    input.current?.blur();
  }, [onChange]);

  const onKey = (e) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHl((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[hl]) pick(matches[hl]);
      else if (onAddNew && q.trim()) {
        onAddNew(q.trim());
        setQ('');
        setOpen(false);
      }
    } else if (e.key === 'Escape') setOpen(false);
  };

  const iconStyle = { position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' };
  return (
    <div className="typeahead" ref={wrap}>
      <div style={{ position: 'relative' }}>
        <Search size={15} style={iconStyle} />
        <input
          ref={input}
          className="input"
          style={{ paddingLeft: 32 }}
          placeholder={selected ? getLabel(selected) : placeholder}
          value={q}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {selected && !q && (
          <button
            type="button"
            onClick={() => {
              onChange?.(null, null);
              setQ('');
              input.current?.focus();
            }}
            aria-label="Clear selection"
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--text-muted)', padding: 4 }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && (
        <div className="typeahead-menu">
          {matches.map((x, i) => (
            <div
              key={x.id}
              className={`typeahead-opt ${i === hl ? 'hl' : ''}`}
              onMouseEnter={() => setHl(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(x);
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{getLabel(x)}</div>
                {getSub(x) && <div className="sub">{getSub(x)}</div>}
              </div>
              <div className="spacer" />
              {x.id === value && <Check size={15} color="var(--accent)" />}
            </div>
          ))}
          {!matches.length && <div className="typeahead-empty">No matches for “{q}”</div>}
          {onAddNew && (
            <div className="typeahead-add">
              <div
                className="typeahead-opt"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAddNew(q.trim());
                  setQ('');
                  setOpen(false);
                }}
                style={{ color: 'var(--accent)', fontWeight: 600 }}
              >
                <Plus size={15} />
                {q.trim() ? `${addNewLabel}: “${q.trim()}”` : addNewLabel}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon: Icon = Inbox, title, message, action }) {
  return (
    <div className="empty">
      <span className="ico"><Icon size={24} /></span>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 5 }) {
  return (
    <div style={{ padding: 16 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel skel-row" style={{ width: `${88 - i * 6}%` }} />
      ))}
    </div>
  );
}

export function Toasts({ toasts = [] }) {
  const icons = { success: Check, error: TriangleAlert, info: Info };
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = icons[t.type] || Info;
        return (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon size={16} className="ico" />
            {t.message}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All' },
];

export function DateRange({ value, onChange, custom, onCustomChange, presets = PRESETS }) {
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <div className="seg">
        {presets.map((p) => (
          <button key={p.value} className={value === p.value ? 'active' : ''} onClick={() => onChange(p.value)}>{p.label}</button>
        ))}
        <button className={value === 'custom' ? 'active' : ''} onClick={() => onChange('custom')}>Custom</button>
      </div>
      {value === 'custom' && (
        <div className="row" style={{ gap: 6 }}>
          <input type="date" className="input" style={{ width: 150 }} value={custom?.from || ''} onChange={(e) => onCustomChange({ ...custom, from: e.target.value })} />
          <span className="muted small">to</span>
          <input type="date" className="input" style={{ width: 150 }} value={custom?.to || ''} onChange={(e) => onCustomChange({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…', style }) {
  return (
    <div style={{ position: 'relative', minWidth: 200, ...style }}>
      <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <input className="input" style={{ paddingLeft: 32 }} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function PageHead({ title, subtitle, children }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      <div className="spacer" />
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
