import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api.ts';

interface CaseItem { id: string; title: string; charge: string; witnessCount: number; builtin: boolean; bestScore: number | null }
interface TrialItem { id: string; caseTitle: string; status: string; createdAt: number }

export function CasesPage() {
  const navigate = useNavigate();
  const [cases, setCases] = useState<CaseItem[] | null>(null);
  const [active, setActive] = useState<TrialItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<CaseItem | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [c, t] = await Promise.all([
        api<{ cases: CaseItem[] }>('GET', '/api/cases'),
        api<{ trials: TrialItem[] }>('GET', '/api/trials'),
      ]);
      setCases(c.cases);
      setActive(t.trials.filter((x) => x.status === 'active'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load cases.');
    }
  };
  useEffect(() => { load(); }, []);

  const start = async (c: CaseItem) => {
    setStarting(c.id);
    try {
      const r = await api<{ id: string }>('POST', '/api/trials', { caseId: c.id });
      navigate(`/trial/${r.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the trial.');
      setStarting(null);
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    try {
      await api('DELETE', `/api/cases/${encodeURIComponent(confirm.id)}`);
      setConfirm(null);
      await load();
    } catch (e) {
      setConfirm(null);
      setError(e instanceof ApiError ? e.message : 'Could not delete the case.');
    }
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return setError('Import failed: the file is not valid JSON.');
    }
    try {
      await api('POST', '/api/cases/import', { case: parsed });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed.');
    }
  };

  return (
    <section>
      <div className="page-head">
        <h1>Case library</h1>
        <div className="row-actions">
          <Link to="/cases/new" className="btn primary" data-testid="case-new">New case</Link>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <label className="sr-only" htmlFor="case-import">Import case JSON file</label>
          <input
            id="case-import" ref={fileRef} type="file" accept="application/json,.json" className="file-hidden"
            tabIndex={-1} data-testid="case-import-file" onChange={onImport}
          />
        </div>
      </div>
      {error && <p className="error" role="alert" data-testid="editor-error">{error}</p>}

      {active.length > 0 && (
        <div className="resume">
          <h2>Trials in progress</h2>
          <ul>
            {active.map((t) => (
              <li key={t.id}>
                <Link to={`/trial/${t.id}`}>Resume: {t.caseTitle}</Link>
                <span className="muted"> · started {new Date(t.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!cases ? <p className="loading">Loading…</p> : (
        <ul className="case-grid">
          {cases.map((c) => (
            <li key={c.id} className="case-card" data-testid="case-item" data-case-id={c.id}>
              <div className="case-top">
                <h2 data-testid="case-title">{c.title}</h2>
                {c.builtin ? <span className="tag">Built-in</span> : <span className="tag mine">Yours</span>}
              </div>
              <p className="charge"><strong>Charge:</strong> {c.charge || '—'}</p>
              <dl className="facts">
                <div><dt>Witnesses</dt><dd>{c.witnessCount}</dd></div>
                <div><dt>Best score</dt><dd data-testid="case-best-score">{c.bestScore ?? '—'}</dd></div>
              </dl>
              <div className="card-actions">
                <button type="button" className="btn primary" data-testid="case-start" disabled={starting !== null} onClick={() => start(c)}>
                  {starting === c.id ? 'Starting…' : 'Start trial'}
                </button>
                <a className="btn small" data-testid="case-export" href={`/api/cases/${encodeURIComponent(c.id)}/export`} download={`${c.id}.json`}>
                  Export
                </a>
                {!c.builtin && (
                  <>
                    <Link className="btn small" data-testid="case-edit" to={`/cases/${encodeURIComponent(c.id)}/edit`}>Edit</Link>
                    <button type="button" className="btn small danger" data-testid="case-delete" onClick={() => setConfirm(c)}>Delete</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <div className="modal-backdrop" role="presentation" onKeyDown={(e) => e.key === 'Escape' && setConfirm(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 id="confirm-title">Delete “{confirm.title}”?</h2>
            <p>This cannot be undone.</p>
            <div className="row-actions">
              <button type="button" className="btn danger" data-testid="confirm-yes" autoFocus onClick={doDelete}>Delete</button>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
