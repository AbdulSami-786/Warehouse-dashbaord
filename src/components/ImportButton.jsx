import { useMemo, useRef, useState } from 'react';
import {
  CircleCheck, Download, FileSpreadsheet, TriangleAlert, Upload,
} from 'lucide-react';
import { useApp } from '../lib/AppContext.jsx';
import { api } from '../lib/api.js';
import {
  SPECS, autoMap, batches, creationOps, mapRows, preview, readFile, templateCSV,
} from '../lib/importer.js';
import { exportCSV } from '../lib/exporters.js';
import { Button, Modal, Select } from './ui.jsx';

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function IssueList({ title, list, tone }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const shown = open ? list.slice(0, 200) : list.slice(0, 5);
  return (
    <div className={`imp-issues ${tone}`}>
      <div className="imp-issues-head">
        <strong>{title} ({list.length})</strong>
        {list.length > 5 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>{open ? 'Show fewer' : 'Show all'}</button>}
      </div>
      <ul>
        {shown.map((x, i) => (
          <li key={i}><span className="muted">Row {x.rows.join(', ')}{x.ref ? ` · ${x.ref}` : ''}:</span> {x.message}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Import a page's records from a file the shop already has. Super admin only:
 * the server refuses the import from anyone else.
 */
export default function ImportButton({ kind, label = 'Import' }) {
  const {
    access, data, methods, settings, refresh, toast,
  } = useApp();
  const spec = SPECS[kind];
  const fileRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [createMissing, setCreateMissing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  const opts = { methods, roundingRule: settings.roundingRule };
  const records = useMemo(() => (file ? mapRows(spec, file.rows, mapping) : []), [file, mapping, spec]);
  const plan = useMemo(() => (file ? preview(spec, records, data, opts) : null), [file, records, data, spec]); // eslint-disable-line react-hooks/exhaustive-deps
  const needCount = plan ? plan.need.parties.size + plan.need.items.size + plan.need.suppliers.size : 0;
  const missingRequired = spec.fields.filter((f) => f.required && !mapping[f.key]);

  if (!access.isSuper || !spec) return null;

  const reset = () => {
    setFile(null);
    setMapping({});
    setProgress(null);
    setResult(null);
    setErr('');
    if (fileRef.current) fileRef.current.value = '';
  };
  const close = () => {
    if (busy) return;
    setOpen(false);
    reset();
  };
  const pick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr('');
    setResult(null);
    try {
      const parsed = await readFile(f);
      setFile({ name: f.name, ...parsed });
      setMapping(autoMap(spec, parsed.headers));
    } catch (ex) {
      setErr(ex.message || 'Could not read this file');
    }
  };

  /** Send saves in batches; every result comes back, good or bad. */
  const send = async (ops, size, stage) => {
    const out = [];
    const groups = batches(ops, size);
    for (let i = 0; i < groups.length; i++) {
      setProgress({ stage, done: i, total: groups.length });
      const res = await api.importBatch(groups[i].map(({ action, payload, ref }) => ({ action, payload, ref })), spec.label);
      res.results.forEach((r, j) => out.push({ ...r, rows: groups[i][j].rows || [] }));
    }
    setProgress({ stage, done: groups.length, total: groups.length });
    return out;
  };

  const run = async () => {
    if (busy || !plan) return;
    setBusy(true);
    setErr('');
    try {
      let current = plan;
      let created = [];
      if (createMissing && needCount) {
        created = await send(creationOps(plan.need, data), 25, 'Adding missing names');
        const fresh = await refresh({ silent: true });
        current = preview(spec, records, fresh, opts);
      }
      const saved = current.ops.length ? await send(current.ops, spec.batch || 25, `Importing ${spec.label}`) : [];
      await refresh({ silent: true }).catch(() => {});
      const failed = saved.filter((r) => !r.ok).map((r) => ({ rows: r.rows, ref: r.ref, message: r.error }));
      setResult({
        ok: saved.filter((r) => r.ok).length,
        created: created.filter((r) => r.ok).length,
        failed: [...current.errors, ...failed, ...created.filter((r) => !r.ok).map((r) => ({ rows: [], ref: r.ref, message: r.error }))],
        skipped: current.skipped,
      });
      toast(`Imported ${saved.filter((r) => r.ok).length} ${spec.label}`);
    } catch (ex) {
      setErr(ex.message || 'Import stopped');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const problemsCSV = () => {
    const list = [...(result?.failed || []), ...(result?.skipped || []).map((s) => ({ ...s, message: `Skipped: ${s.message}` }))];
    exportCSV(`Import_${kind}_problems`, ['Row(s)', 'Record', 'Problem'], list.map((x) => [x.rows.join(' '), x.ref, x.message]));
  };

  return (
    <>
      <Button icon={Upload} onClick={() => setOpen(true)} title={`Import ${spec.label} from a CSV or Excel file`}>{label}</Button>
      <Modal
        open={open}
        wide
        title={`Import ${spec.title}`}
        onClose={close}
        footer={result ? (
          <>
            {(result.failed.length + result.skipped.length) > 0 && <Button icon={Download} onClick={problemsCSV}>Download report</Button>}
            <Button onClick={reset}>Import another file</Button>
            <Button variant="primary" onClick={close}>Done</Button>
          </>
        ) : (
          <>
            <Button onClick={close} disabled={busy}>Cancel</Button>
            <Button
              variant="primary"
              icon={Upload}
              loading={busy}
              onClick={run}
              disabled={!plan || missingRequired.length > 0 || (!plan.ops.length && !(createMissing && needCount))}
            >
              {plan ? `Import ${plan.ops.length || ''} ${spec.label}`.replace('  ', ' ') : 'Import'}
            </Button>
          </>
        )}
      >
        {result ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="imp-done">
              <CircleCheck size={22} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{result.ok} {spec.label} imported</div>
                <div className="small">
                  {result.created > 0 && `${result.created} missing name${result.created === 1 ? '' : 's'} added first. `}
                  {result.skipped.length > 0 && `${result.skipped.length} skipped because they were already in the system. `}
                  {result.failed.length > 0 && `${result.failed.length} could not be imported.`}
                </div>
              </div>
            </div>
            <IssueList title="Could not import" list={result.failed} tone="bad" />
            <IssueList title="Skipped — already in the system" list={result.skipped} tone="skip" />
          </div>
        ) : (
          <>
            <div className="imp-pick">
              <FileSpreadsheet size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{file ? file.name : 'Choose a CSV or Excel (.xlsx) file'}</div>
                <div className="small muted">{file ? `${file.rows.length} rows · ${file.headers.length} columns` : 'The first row must be the column headings.'}</div>
              </div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.txt" onChange={pick} hidden />
              <Button onClick={() => fileRef.current?.click()} disabled={busy}>{file ? 'Change file' : 'Choose file'}</Button>
              <Button icon={Download} onClick={() => download(`${kind}_template.csv`, templateCSV(spec))} title="A file with the right headings to fill in">Template</Button>
            </div>
            {spec.help && <div className="small muted" style={{ margin: '8px 2px 0' }}>{spec.help}</div>}
            {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
            {file && (
              <>
                <h3 className="h3" style={{ margin: '16px 0 8px' }}>Match the columns</h3>
                <div className="imp-map">
                  {spec.fields.map((f) => (
                    <label key={f.key} className="imp-map-row">
                      <span>{f.label}{f.required && <b style={{ color: 'var(--danger)' }}> *</b>}</span>
                      <Select value={mapping[f.key] || ''} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                        <option value="">— not in the file —</option>
                        {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </Select>
                    </label>
                  ))}
                </div>
                {missingRequired.length > 0 && (
                  <div className="err" style={{ marginTop: 8 }}>Choose a column for: {missingRequired.map((f) => f.label).join(', ')}</div>
                )}
                {plan && missingRequired.length === 0 && (
                  <>
                    <h3 className="h3" style={{ margin: '16px 0 8px' }}>What will happen</h3>
                    <div className="imp-summary">
                      <div className="ok"><b>{plan.ops.length}</b> {spec.label} ready to import</div>
                      <div className="skip"><b>{plan.skipped.length}</b> already in the system — skipped</div>
                      <div className="bad"><b>{plan.errors.length}</b> with a problem</div>
                    </div>
                    {needCount > 0 && (
                      <label className="imp-create">
                        <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />
                        <span>
                          Add the {needCount} missing name{needCount === 1 ? '' : 's'} first
                          {' '}({[...plan.need.parties, ...plan.need.suppliers, ...plan.need.items].slice(0, 6).join(', ')}{needCount > 6 ? '…' : ''}),
                          then import the rows that need them.
                        </span>
                      </label>
                    )}
                    <IssueList title="With a problem" list={plan.errors} tone="bad" />
                    <IssueList title="Already in the system" list={plan.skipped} tone="skip" />
                  </>
                )}
                {progress && (
                  <div className="imp-progress">
                    <div className="small" style={{ marginBottom: 5 }}>{progress.stage} — batch {Math.min(progress.done + 1, progress.total)} of {progress.total}</div>
                    <div className="bar"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 12, display: 'flex', gap: 6 }}>
                  <TriangleAlert size={13} style={{ flex: 'none', marginTop: 2 }} />
                  Each row is checked exactly as if typed into its form. Rows already in the system are skipped, so importing the same file twice does not double anything.
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
